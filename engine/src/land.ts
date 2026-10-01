import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { DetailedError, log } from "./bus.js";
import * as jito from "./jito.js";
import { signatureOf, type InflightStatus } from "./jito.js";
import { connection, short } from "./solana.js";

/**
 * Lands one signed transaction and only reports failure once the chain proves it can no longer land.
 *
 * Jito alone was not enough: a bundle Jito accepts can still read "Invalid" (Jito's words: "bundle ID not in our
 * system") and never land, and the old code gave up after 30 s on Jito's word without asking the chain. Now:
 *  1. send it as a single-transaction Jito bundle (all-or-nothing, never public before it lands);
 *  2. if it has not landed after a few seconds, or Jito refused or lost it, re-broadcast the very same signed bytes
 *     through Jito's sendTransaction and the RPC. Same bytes, same signature: Solana runs a signature at most once,
 *     so this can never buy twice;
 *  3. watch the signature on chain; succeed when it confirms, fail with its on-chain error if it ran and failed,
 *     and call it "not landed" only when the blockhash has expired, so it can never land later.
 */

export interface Step {
  /** Milliseconds since the send started. */
  ms: number;
  step: string;
  result: string;
}

export interface LandResult {
  signature: string;
  bundleId: string | null;
  slot?: number;
  steps: Step[];
}

/** How long the bundle gets on its own (ms) before the same transaction is also re-broadcast. */
const BUNDLE_HEAD_START_MS = 2_500;
const POLL_MS = 700;
/** Hard stop if the RPC cannot tell us the block height. ~150 blocks of blockhash life is about 60-90 s. */
const WALL_CLOCK_CAP_MS = 120_000;

/** What landing talks to; swapped out in tests. */
export interface LandDeps {
  conn: Pick<Connection, "getSignatureStatuses" | "sendRawTransaction" | "getBlockHeight" | "getTransaction">;
  jito: Pick<typeof jito, "sendBundle" | "bundleStatus" | "sendTransaction">;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps = (): LandDeps => ({
  conn: connection(),
  jito,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
});

export async function landTransaction(
  tx: VersionedTransaction,
  ctx: { label: string; lastValidBlockHeight: number; mint: string; numbers: Record<string, unknown> },
  deps: LandDeps = defaultDeps(),
): Promise<LandResult> {
  const { conn, sleep, now } = deps;
  const signature = signatureOf(tx);
  const raw = tx.serialize();
  const t0 = now();
  const steps: Step[] = [];
  const step = (name: string, result: string) => {
    steps.push({ ms: now() - t0, step: name, result });
  };
  const fail = (stage: string, message: string, extra: Record<string, unknown> = {}) =>
    new DetailedError(message, {
      stage,
      mint: ctx.mint,
      signature,
      bundleId,
      solscan: `https://solscan.io/tx/${signature}`,
      jitoExplorer: bundleId ? `https://explorer.jito.wtf/bundle/${bundleId}` : undefined,
      lastValidBlockHeight: ctx.lastValidBlockHeight,
      ...ctx.numbers,
      ...extra,
      steps,
    });

  let bundleId: string | null = null;
  let jitoError: string | null = null;
  try {
    bundleId = await deps.jito.sendBundle([tx]);
    step("Jito sendBundle", `accepted, bundle ${bundleId}`);
    log.info("jito", `${ctx.label}: bundle ${short(bundleId)} submitted`, { signature, mint: ctx.mint });
  } catch (e) {
    jitoError = (e as Error).message;
    step("Jito sendBundle", `refused: ${jitoError}`);
    log.warn("jito", `${ctx.label}: Jito refused the bundle (${jitoError}); sending the same transaction directly`, {
      signature,
      mint: ctx.mint,
    });
  }

  let lastJito: InflightStatus | "unknown" = "unknown";
  let rebroadcasts = 0;
  let lastRebroadcast = 0;
  let blockHeight = 0;
  let lastHeightCheck = 0;
  let rpcError: string | null = null;

  const rebroadcast = async () => {
    lastRebroadcast = now();
    rebroadcasts++;
    const [viaJito, viaRpc] = await Promise.allSettled([
      deps.jito.sendTransaction(tx),
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
    ]);
    if (rebroadcasts === 1) {
      step("Jito sendTransaction", viaJito.status === "fulfilled" ? "accepted" : `refused: ${(viaJito.reason as Error).message}`);
      step("RPC sendTransaction", viaRpc.status === "fulfilled" ? "accepted" : `refused: ${(viaRpc.reason as Error).message}`);
      log.info("jito", `${ctx.label}: not landed via bundle after ${((now() - t0) / 1000).toFixed(1)} s; re-broadcasting the same signed transaction (cannot execute twice)`, {
        signature,
        mint: ctx.mint,
      });
    }
  };

  while (true) {
    const elapsed = now() - t0;

    // 1. The chain is the only source of truth for whether it ran.
    try {
      const st = (await conn.getSignatureStatuses([signature])).value[0];
      rpcError = null;
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        if (st.err) {
          const logs = await failedLogs(conn, sleep, signature);
          step("On chain", `ran and failed in slot ${st.slot}: ${JSON.stringify(st.err)}`);
          throw fail("chain", `${ctx.label} reached the chain but failed: ${explainError(st.err, logs)}. Fees and tip were charged; no tokens moved.`, {
            onChainError: st.err,
            slot: st.slot,
            logs: logs.slice(-15),
          });
        }
        step("On chain", `confirmed in slot ${st.slot}`);
        return { signature, bundleId, slot: st.slot, steps };
      }
    } catch (e) {
      if (e instanceof DetailedError) throw e;
      rpcError = (e as Error).message;
    }

    // 2. What Jito says, for the record and to decide whether to re-broadcast early.
    if (bundleId) {
      try {
        const b = await deps.jito.bundleStatus(bundleId);
        const s = b?.status ?? "Invalid";
        if (s !== lastJito) step("Jito bundle status", s === "Invalid" ? "Invalid (Jito has no record of this bundle)" : s);
        lastJito = s;
      } catch (e) {
        if (lastJito !== "unknown") step("Jito bundle status", `lookup failed: ${(e as Error).message}`);
        lastJito = "unknown";
      }
    }

    // 3. Re-broadcast the same bytes if the bundle was refused, failed, or is late, then every 2 s until it lands or
    // expires. "Invalid" alone is not enough early on: Jito reports it for a moment before it indexes a new bundle.
    const bundleLost = !bundleId || lastJito === "Failed";
    if (rebroadcasts === 0 ? bundleLost || elapsed > BUNDLE_HEAD_START_MS : now() - lastRebroadcast > 2_000) {
      await rebroadcast().catch(() => undefined);
    }

    // 4. Expired? Then it can never land, and only then is it safe to say it failed.
    if (now() - lastHeightCheck > 2_000) {
      lastHeightCheck = now();
      blockHeight = await conn.getBlockHeight("confirmed").catch(() => blockHeight);
    }
    if (blockHeight > ctx.lastValidBlockHeight) {
      // One last look including history, in case it confirmed between polls.
      const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null))?.value[0];
      if (st && !st.err) {
        step("On chain", `confirmed in slot ${st.slot}`);
        return { signature, bundleId, slot: st.slot, steps };
      }
      if (st?.err) {
        const logs = await failedLogs(conn, sleep, signature);
        step("On chain", `ran and failed in slot ${st.slot}: ${JSON.stringify(st.err)}`);
        throw fail("chain", `${ctx.label} reached the chain but failed: ${explainError(st.err, logs)}. Fees and tip were charged; no tokens moved.`, {
          onChainError: st.err,
          slot: st.slot,
          logs: logs.slice(-15),
        });
      }
      step("Blockhash", `expired at block ${ctx.lastValidBlockHeight} (now ${blockHeight}); it can no longer land`);
      throw fail(
        "not_landed",
        `${ctx.label} did not land: ${whyNotLanded(jitoError, lastJito, rebroadcasts)} The transaction has expired, so nothing was spent and it cannot land later. Try again.`,
        { jitoStatus: lastJito, jitoError, rebroadcasts, blockHeight },
      );
    }
    if (now() - t0 > WALL_CLOCK_CAP_MS) {
      step("Gave up", `no answer from the RPC for ${Math.round(WALL_CLOCK_CAP_MS / 1000)} s (${rpcError ?? "no error"})`);
      throw fail(
        "unknown",
        `${ctx.label}: could not confirm whether it landed, because the RPC stopped answering (${rpcError ?? "no answer"}). It MAY have gone through; check the transaction on Solscan before buying again.`,
        { jitoStatus: lastJito, rpcError },
      );
    }
    await sleep(POLL_MS);
  }
}

function whyNotLanded(jitoError: string | null, jito: InflightStatus | "unknown", rebroadcasts: number) {
  const parts: string[] = [];
  if (jitoError) parts.push(`Jito refused the bundle (${jitoError}).`);
  else if (jito === "Invalid") parts.push("Jito accepted the bundle but then had no record of it (Jito status \"Invalid\"), meaning it dropped it before any block.");
  else if (jito === "Failed") parts.push("Jito marked the bundle failed in every region (usually the swap would have failed at that moment, e.g. price moved past your slippage).");
  else parts.push(`Jito status was ${jito}.`);
  if (rebroadcasts) parts.push(`The same transaction was also sent directly ${rebroadcasts} time(s) and no leader included it (network congestion or a priority fee too low for that moment).`);
  return parts.join(" ");
}

async function failedLogs(conn: LandDeps["conn"], sleep: LandDeps["sleep"], signature: string): Promise<string[]> {
  for (let i = 0; i < 4; i++) {
    const tx = await conn
      .getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      .catch(() => null);
    if (tx?.meta?.logMessages) return tx.meta.logMessages;
    await sleep(500);
  }
  return [];
}

/** Turns a transaction error plus its program logs into one plain sentence, keeping the program's own words. */
export function explainError(err: unknown, logs: string[]): string {
  const anchor = logs.map((l) => l.match(/Error Message: (.+?)\.?$/)?.[1]).find(Boolean);
  const lamportsShort = logs.map((l) => l.match(/insufficient lamports (\d+), need (\d+)/)).find(Boolean);
  if (lamportsShort) {
    const [have, need] = [Number(lamportsShort[1]) / 1e9, Number(lamportsShort[2]) / 1e9];
    return `the wallet ran out of SOL mid-transaction (had ${have.toFixed(6)} SOL where ${need.toFixed(6)} SOL was needed)`;
  }
  const raw = JSON.stringify(err);
  if (anchor) {
    if (/slippage|TooMuchSol|TooLittleSol|exceed/i.test(anchor + raw)) return `${anchor} (price moved past your slippage limit)`;
    return anchor;
  }
  if (raw.includes("InsufficientFundsForRent")) return "the wallet would be left below Solana's rent-exempt minimum (keep ~0.001 SOL extra)";
  if (raw.includes('"InsufficientFundsForFee"')) return "not enough SOL to pay the transaction fee";
  if (raw.includes("BlockhashNotFound")) return "the blockhash expired before it was processed";
  const custom = raw.match(/"Custom":(\d+)/);
  if (custom) return `program error ${custom[1]} (0x${Number(custom[1]).toString(16)})${logs.length ? `; last log: ${logs[logs.length - 1]}` : ""}`;
  return raw;
}
