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

/** A Jito answer that was not a result: HTTP status, JSON-RPC error and the raw body, so the caller can say exactly what Jito said. */
export class JitoError extends Error {
  constructor(message: string, public http: number, public body: string) {
    super(message);
  }
}

async function rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.jitoAuthUuid) headers["x-jito-auth"] = env.jitoAuthUuid;
  const res = await fetch(`${env.jitoBlockEngineUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  let json: { result?: T; error?: { code?: number; message?: string } } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* plain-text body (429 pages, proxies); reported below */
  }
  if (!res.ok || json.error) {
    const why = json.error?.message ?? (text.slice(0, 200) || "empty body");
    const hint = res.status === 429 ? " (Jito rate limit: 1 request per second per IP unless JITO_AUTH_UUID is set)" : "";
    throw new JitoError(`Jito ${method} HTTP ${res.status}: ${why}${hint}`, res.status, text.slice(0, 500));
  }
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

export type InflightStatus = "Invalid" | "Pending" | "Failed" | "Landed";

/**
 * One look at a bundle. Jito's meanings: Invalid = "bundle ID not in our system (5 minute look back)", Pending = not
 * failed/landed/invalid yet, Failed = every region that received it marked it failed, Landed = on chain.
 */
export async function bundleStatus(bundleId: string): Promise<{ status: InflightStatus; slot?: number } | null> {
  const res = await rpc<{ value: Array<{ status: InflightStatus; landed_slot: number | null }> | null }>(
    "/api/v1/getInflightBundleStatuses",
    "getInflightBundleStatuses",
    [[bundleId]],
  );
  const v = res?.value?.[0];
  return v ? { status: v.status, slot: v.landed_slot ?? undefined } : null;
}

export const signatureOf = (tx: VersionedTransaction) => bs58.encode(tx.signatures[0]);
