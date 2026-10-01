import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env, hasSupabase } from "./config.js";
import { log } from "./bus.js";
import { onSave } from "./store.js";

/**
 * Supabase from the engine's side, over plain REST (no SDK):
 *  - verifies the dashboard's sign-in token and only lets the owner (OWNER_EMAIL) through;
 *  - backs the engine's data files up to `engine_files` and restores them on a fresh host.
 * The secret key goes on the `apikey` header only: new sb_secret_ keys are not JWTs and are rejected as a Bearer.
 */

class CloudError extends Error {}

async function rest<T>(p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${env.supabaseUrl}${p}`, {
    method: init.method ?? "GET",
    headers: { apikey: env.supabaseSecretKey, "content-type": "application/json", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new CloudError(`Supabase ${res.status} on ${p.split("?")[0]}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

let ownerId: string | null = null;
export const ownerUserId = () => ownerId;

/** Finds the owner's auth user id by email (Auth admin API). */
async function resolveOwner(): Promise<string> {
  for (let page = 1; page <= 20; page++) {
    const r = await rest<{ users: Array<{ id: string; email?: string }> }>(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const u = r.users.find((x) => x.email?.toLowerCase() === env.ownerEmail);
    if (u) return u.id;
    if (r.users.length < 200) break;
  }
  throw new CloudError(`No Supabase user with email ${env.ownerEmail}. Create it under Authentication > Users first.`);
}

// ---- Sign-in verification ---------------------------------------------------------------------------------------

const verified = new Map<string, { ok: boolean; until: number }>();
let verifyBudget = { windowStart: 0, used: 0 };

/** True when `token` is a live Supabase session for the owner. Results are cached for 60s per token. */
export async function verifyOwnerToken(token: string): Promise<boolean> {
  if (!hasSupabase() || !token || token.split(".").length !== 3) return false;
  const k = crypto.createHash("sha256").update(token).digest("base64");
  const hit = verified.get(k);
  if (hit && hit.until > Date.now()) return hit.ok;
  // Cap lookups so junk tokens cannot turn the engine into a Supabase request amplifier.
  const now = Date.now();
  if (now - verifyBudget.windowStart > 60_000) verifyBudget = { windowStart: now, used: 0 };
  if (++verifyBudget.used > 60) return false;
  let ok = false;
  try {
    const u = await rest<{ id: string; email?: string }>("/auth/v1/user", { headers: { authorization: `Bearer ${token}` } });
    ok = u.email?.toLowerCase() === env.ownerEmail && (!ownerId || u.id === ownerId);
  } catch (e) {
    if (!(e instanceof CloudError)) throw e; // network trouble: do not cache a negative answer
  }
  if (verified.size > 200) verified.clear();
  verified.set(k, { ok, until: now + 60_000 });
  return ok;
}

// ---- State backup -------------------------------------------------------------------------------------------------

/** Files mirrored to Supabase. keystore.json + wallets.json must travel together: one decrypts the other. */
const BACKED_UP = ["keystore.json", "wallets.json", "settings.json", "portfolio.json"] as const;
type BackedUp = (typeof BACKED_UP)[number];
const isBackedUp = (n: string): n is BackedUp => (BACKED_UP as readonly string[]).includes(n);

export const cloudStatus = { enabled: false, ownerResolved: false, lastBackupAt: 0, lastError: "" };

const pending = new Map<BackedUp, unknown>();
const timers = new Map<BackedUp, NodeJS.Timeout>();

async function upload(name: BackedUp) {
  timers.delete(name);
  if (!pending.has(name)) return;
  const data = pending.get(name);
  pending.delete(name);
  try {
    await rest("/rest/v1/engine_files?on_conflict=user_id,name", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: { user_id: ownerId, name, data, updated_at: new Date().toISOString() },
    });
    cloudStatus.lastBackupAt = Date.now();
    cloudStatus.lastError = "";
  } catch (e) {
    if (!pending.has(name)) pending.set(name, data);
    if (cloudStatus.lastError !== (e as Error).message) log.warn("engine", `Supabase backup of ${name} failed, retrying: ${(e as Error).message}`);
    cloudStatus.lastError = (e as Error).message;
    schedule(name, 30_000);
  }
}

function schedule(name: BackedUp, ms: number) {
  if (!timers.has(name)) timers.set(name, setTimeout(() => void upload(name), ms));
}

/** Uploads everything still queued. Called on shutdown so the last trades are not lost. */
export async function flushBackups() {
  for (const [name, t] of timers) {
    clearTimeout(t);
    timers.delete(name);
  }
  await Promise.all([...pending.keys()].map((n) => upload(n)));
}

/**
 * Runs before any engine module loads its JSON state. Resolves the owner, then restores whatever this host is
 * missing from the backup. Throws (so the engine refuses to start) when Supabase is configured but unreachable:
 * starting blank would mint a new keystore and overwrite the backup that can still decrypt your wallets.
 */
export async function initCloud() {
  ownerId = await resolveOwner();
  cloudStatus.ownerResolved = true;
  const rows = await rest<Array<{ name: string; data: unknown }>>(
    `/rest/v1/engine_files?user_id=eq.${ownerId}&select=name,data`,
  );
  const remote = new Map(rows.map((r) => [r.name, r.data]));
  const local = (n: string) => path.join(env.dataDir, n);
  fs.mkdirSync(env.dataDir, { recursive: true });

  const remoteKs = remote.get("keystore.json") as { salt?: string } | undefined;
  if (remoteKs && fs.existsSync(local("keystore.json"))) {
    const localKs = JSON.parse(fs.readFileSync(local("keystore.json"), "utf8")) as { salt?: string };
    if (localKs.salt !== remoteKs.salt) {
      throw new Error(
        "This host's keystore differs from the Supabase backup. Refusing to start so neither copy is overwritten. " +
          "Move engine/data aside to restore from Supabase, or delete the engine_files rows to keep this host's keys.",
      );
    }
  }
  if (remoteKs && !fs.existsSync(local("keystore.json")) && fs.existsSync(local("wallets.json"))) {
    throw new Error("engine/data has wallets.json but no keystore.json while Supabase holds a keystore. Refusing to start; fix engine/data first.");
  }
  const restore = (n: BackedUp) => {
    if (fs.existsSync(local(n)) || !remote.has(n)) return false;
    fs.writeFileSync(local(n), JSON.stringify(remote.get(n), null, 2), { mode: 0o600 });
    return true;
  };
  // Keys and the header that decrypts them come back as a pair, or not at all.
  const keysLocal = fs.existsSync(local("keystore.json")) || fs.existsSync(local("wallets.json"));
  const restored = [
    ...(!keysLocal ? (["keystore.json", "wallets.json"] as const).filter(restore) : []),
    ...(["settings.json", "portfolio.json"] as const).filter(restore),
  ];
  if (restored.length) log.success("engine", `Restored ${restored.join(", ")} from Supabase`);

  onSave((name, value) => {
    if (!isBackedUp(name)) return;
    pending.set(name, value);
    // Price ticks rewrite the portfolio constantly; keys and settings go up almost at once.
    schedule(name, name === "portfolio.json" ? 15_000 : 1_000);
  });
  // Seed the backup with anything that exists only on this host (first run against an empty project).
  for (const n of BACKED_UP) {
    if (!remote.has(n) && fs.existsSync(local(n))) {
      pending.set(n, JSON.parse(fs.readFileSync(local(n), "utf8")));
      schedule(n, 1_000);
    }
  }
  cloudStatus.enabled = true;
}

export { rest as supabaseRest };
