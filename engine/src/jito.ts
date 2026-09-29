import { PublicKey, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./config.js";
import { log } from "./bus.js";

/**
 * Jito Block Engine over its JSON-RPC HTTP API (no gRPC client needed):
 *   POST {engine}/api/v1/bundles         sendBundle (max 5 txs, all-or-nothing, executed in order)
 *   POST {engine}/api/v1/getTipAccounts
 *   POST {engine}/api/v1/getInflightBundleStatuses
 *   GET  https://bundles.jito.wtf/api/v1/bundles/tip_floor
 * Regional engines (amsterdam, frankfurt, ny, tokyo, slc, london…) are `https://<region>.mainnet.block-engine.jito.wtf`.
 */

// Published Jito tip accounts; refreshed from getTipAccounts at runtime when reachable.
let tipAccounts = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

async function rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.jitoAuthUuid) headers["x-jito-auth"] = env.jitoAuthUuid;
  const res = await fetch(`${env.jitoBlockEngineUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `Jito HTTP ${res.status}`);
  return json.result as T;
}

export async function refreshTipAccounts() {
  try {
    const accounts = await rpc<string[]>("/api/v1/getTipAccounts", "getTipAccounts", []);
    if (accounts.length) tipAccounts = accounts;
    log.info("jito", `Loaded ${tipAccounts.length} tip accounts from ${env.jitoBlockEngineUrl}`);
  } catch (e) {
    log.warn("jito", `getTipAccounts failed, using built-in list: ${(e as Error).message}`);
  }
}

export function tipInstruction(payer: PublicKey, lamports: number) {
  const to = new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports });
}

/** 75th-percentile landed tip over the last few minutes, in SOL. */
export async function tipFloorSol(): Promise<number | null> {
  try {
    const res = await fetch("https://bundles.jito.wtf/api/v1/bundles/tip_floor");
    const [row] = (await res.json()) as Array<{ landed_tips_75th_percentile?: number }>;
    return typeof row?.landed_tips_75th_percentile === "number" ? row.landed_tips_75th_percentile : null;
  } catch {
    return null;
  }
}

export async function sendBundle(txs: VersionedTransaction[]): Promise<string> {
  if (txs.length === 0 || txs.length > 5) throw new Error("A Jito bundle holds 1 to 5 transactions");
  const encoded = txs.map((t) => Buffer.from(t.serialize()).toString("base64"));
  return rpc<string>("/api/v1/bundles", "sendBundle", [encoded, { encoding: "base64" }]);
}

type InflightStatus = "Invalid" | "Pending" | "Failed" | "Landed";

/** Polls until the bundle lands, fails, or times out. Returns the final status and landed slot if any. */
export async function waitForBundle(bundleId: string, timeoutMs = 30_000): Promise<{ status: InflightStatus | "Timeout"; slot?: number }> {
  const start = Date.now();
  let last: InflightStatus = "Pending";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await rpc<{ value: Array<{ status: InflightStatus; landed_slot: number | null }> }>(
        "/api/v1/getInflightBundleStatuses",
        "getInflightBundleStatuses",
        [[bundleId]],
      );
      const v = res.value?.[0];
      if (v) {
        last = v.status;
        if (v.status === "Landed") return { status: "Landed", slot: v.landed_slot ?? undefined };
        if (v.status === "Failed") return { status: "Failed" };
      }
    } catch {
      /* transient; keep polling */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return { status: last === "Invalid" ? "Invalid" : "Timeout" };
}

export const signatureOf = (tx: VersionedTransaction) => bs58.encode(tx.signatures[0]);
