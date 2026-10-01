import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

// A fake Supabase: Auth admin + user endpoints and the engine_files table, enough to exercise the engine's side.
const OWNER = { id: "11111111-1111-1111-1111-111111111111", email: "owner@example.com" };
const SECRET = "sb_secret_test";
const files = new Map<string, unknown>();
const seen: string[] = [];
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  seen.push(`${req.method} ${url.pathname}`);
  const send = (code: number, body: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.headers.apikey !== SECRET) return send(401, { message: "bad apikey" });
  if (url.pathname === "/auth/v1/admin/users") return send(200, { users: [{ id: "x", email: "someone@else.com" }, OWNER] });
  if (url.pathname === "/auth/v1/user") {
    const t = req.headers.authorization;
    if (t === "Bearer a.owner.jwt") return send(200, OWNER);
    if (t === "Bearer a.stranger.jwt") return send(200, { id: "22222222-2222-2222-2222-222222222222", email: "stranger@example.com" });
    return send(401, { message: "invalid jwt" });
  }
  if (url.pathname === "/rest/v1/engine_files") {
    if (req.method === "GET") return send(200, [...files].map(([name, data]) => ({ name, data })));
    let raw = "";
    for await (const c of req) raw += c;
    const row = JSON.parse(raw);
    files.set(row.name, row.data);
    return res.writeHead(201).end();
  }
  send(404, {});
});

let dir: string;
before(async () => {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sniper-cloud-"));
  process.env.ENGINE_DATA_DIR = dir;
  process.env.SUPABASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.SUPABASE_SECRET_KEY = SECRET;
  process.env.OWNER_EMAIL = "Owner@Example.com";
});
after(() => fake.close());

test("restores the keystore and wallets together on a blank host", async () => {
  files.set("keystore.json", { version: 1, salt: "remote-salt", check: { iv: "", tag: "", ct: "" } });
  files.set("wallets.json", [{ id: "w1", publicKey: "pk", secret: { iv: "a", tag: "b", ct: "c" } }]);
  files.set("settings.json", { simulation: true, autoSnipe: false });
  const { initCloud, ownerUserId } = await import("./cloud.js");
  await initCloud();
  assert.equal(ownerUserId(), OWNER.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "keystore.json"), "utf8")).salt, "remote-salt");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "wallets.json"), "utf8"))[0].id, "w1");
  assert.equal((fs.statSync(path.join(dir, "wallets.json")).mode & 0o777).toString(8), "600");
});

test("refuses to start when this host's keystore differs from the backup", async () => {
  const { initCloud } = await import("./cloud.js");
  fs.writeFileSync(path.join(dir, "keystore.json"), JSON.stringify({ version: 1, salt: "other-salt" }));
  await assert.rejects(initCloud(), /differs from the Supabase backup/);
  fs.writeFileSync(path.join(dir, "keystore.json"), JSON.stringify(files.get("keystore.json")));
});

test("only the owner's session is accepted", async () => {
  const { verifyOwnerToken } = await import("./cloud.js");
  assert.equal(await verifyOwnerToken("a.owner.jwt"), true);
  assert.equal(await verifyOwnerToken("a.stranger.jwt"), false);
  assert.equal(await verifyOwnerToken("a.forged.jwt"), false);
  assert.equal(await verifyOwnerToken("not-a-jwt"), false);
  assert.equal(await verifyOwnerToken(""), false);
});

test("every save is backed up to engine_files", async () => {
  const { flushBackups } = await import("./cloud.js");
  const { saveJson } = await import("./store.js");
  saveJson("settings.json", { simulation: false, marker: 42 });
  saveJson("unrelated.json", { nope: true });
  await flushBackups();
  assert.equal((files.get("settings.json") as { marker: number }).marker, 42);
  assert.equal(files.has("unrelated.json"), false);
});

test("rejections say why", async () => {
  const { checkOwnerToken } = await import("./cloud.js");
  assert.match(String((await checkOwnerToken("a.stranger.jwt") as { reason: string }).reason), /stranger@example.com.*not the engine's OWNER_EMAIL/);
  assert.match(String((await checkOwnerToken("a.forged2.jwt") as { reason: string }).reason), /invalid or expired/);
  assert.match(String((await checkOwnerToken("") as { reason: string }).reason), /No sign-in token/);
});

test("legacy JWT keys: service_role is sent as a Bearer too, anon is refused with the fix", async () => {
  const { legacyKeyRole } = await import("./cloud.js");
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.sig`;
  assert.equal(legacyKeyRole(jwt("service_role")), "service_role");
  assert.equal(legacyKeyRole(jwt("anon")), "anon");
  assert.equal(legacyKeyRole("sb_secret_abc"), null);
});
