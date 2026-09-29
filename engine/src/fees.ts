import { PublicKey } from "@solana/web3.js";
import { env } from "./config.js";
import { log } from "./bus.js";
import { connection } from "./solana.js";

const FLOOR = 50_000; // micro-lamports per CU
const CEILING = 5_000_000;

/**
 * Current compute-unit price for transactions touching `accounts`, in micro-lamports.
 * Uses Helius getPriorityFeeEstimate when the RPC is Helius (account-aware, fast), otherwise the 75th percentile
 * of getRecentPrioritizationFees for the same accounts.
 */
export async function dynamicPriorityFee(accounts: PublicKey[]): Promise<number> {
  try {
    if (env.heliusApiKey) {
      const res = await fetch(env.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getPriorityFeeEstimate",
          params: [{ accountKeys: accounts.map((a) => a.toBase58()), options: { priorityLevel: "VeryHigh" } }],
        }),
      });
      const json = (await res.json()) as { result?: { priorityFeeEstimate?: number } };
      const est = json.result?.priorityFeeEstimate;
      if (typeof est === "number") return clamp(Math.ceil(est));
    }
    const recent = await connection().getRecentPrioritizationFees({ lockedWritableAccounts: accounts });
    const fees = recent.map((r) => r.prioritizationFee).sort((a, b) => a - b);
    if (fees.length === 0) return FLOOR;
    return clamp(fees[Math.floor(fees.length * 0.75)]);
  } catch (e) {
    log.warn("trade", `Priority fee lookup failed, using floor: ${(e as Error).message}`);
    return FLOOR;
  }
}

const clamp = (n: number) => Math.min(CEILING, Math.max(FLOOR, n));
