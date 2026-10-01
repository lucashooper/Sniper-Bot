import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { DetailedError, log } from "./bus.js";
import * as jito from "./jito.js";
import { signatureOf, type InflightStatus } from "./jito.js";
import { sendViaSender } from "./sender.js";
import { connection, short } from "./solana.js";

/**
 * Lands one signed transaction and only reports failure once the chain proves it can no longer land.
 *
 * Two ways to send, picked by settings.sendMode:
 *  - "fast" (default): the transaction goes at once to Helius Sender (which routes it to Jito and to staked validator
 *    connections in parallel) and to the RPC, and is re-sent every 2 s until it lands. It can land with any leader.
 *  - "protected": a private single-transaction Jito bundle, re-submitted every 2 s while Jito has not landed it.
 *    Never public before it lands (no sandwiches), but only Jito leaders can include it and Jito may drop it.
 * Every re-send is the very same signed bytes: one signature, which Solana executes at most once, so a re-send can
 * never buy twice. Success is read from the chain, not from Jito or Helius; "not landed" is only reported once the
 * blockhash has expired, so it can never land later.
 */

export type SendMode = "fast" | "protected";

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

const RESEND_MS = 2_000;
const POLL_MS = 700;
/** Hard stop if the RPC cannot tell us the block height. ~150 blocks of blockhash life is about 60-90 s. */
const WALL_CLOCK_CAP_MS = 120_000;

/** What landing talks to; swapped out in tests. */
export interface LandDeps {
  conn: Pick<Connection, "getSignatureStatuses" | "sendRawTransaction" | "getBlockHeight" | "getTransaction">;
  jito: Pick<typeof jito, "sendBundle" | "bundleStatus">;
  sender: (tx: VersionedTransaction) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps = (): LandDeps => ({
  conn: connection(),
  jito,
  sender: sendViaSender,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
});

export async function landTransaction(
  tx: VersionedTransaction,
  ctx: { label: string; mode: SendMode; lastValidBlockHeight: number; mint: string; numbers: Record<string, unknown> },
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
      sendMode: ctx.mode,
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
  let lastJito: InflightStatus | "unknown" = "unknown";
  /** Latest answer per route, e.g. { "Helius Sender": "accepted", RPC: "refused: …" }. */
  const routes: Record<string, string> = {};
  let sends = 0;
  let lastSend = 0;
  let blockHeight = 0;
  let lastHeightCheck = 0;
  let rpcError: string | null = null;

  const record = (route: string, r: PromiseSettledResult<unknown>) => {
    const result = r.status === "fulfilled" ? "accepted" : `refused: ${(r.reason as Error).message}`;
    if (routes[route] !== result) step(route, sends > 1 ? `${result} (re-send ${sends - 1})` : result);
    routes[route] = result;
  };

  const send = async () => {
    lastSend = now();
    sends++;
    if (ctx.mode === "fast") {
      const [viaSender, viaRpc] = await Promise.allSettled([deps.sender(tx), conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })]);
      record("Helius Sender", viaSender);
      record("RPC", viaRpc);
      if (sends === 1) log.info("trade", `${ctx.label}: sent via Helius Sender + RPC`, { signature, mint: ctx.mint });
      return;
    }
    const r = await Promise.allSettled([deps.jito.sendBundle([tx])]);
    record("Jito sendBundle", r[0]);
    if (r[0].status === "fulfilled") {
      bundleId = r[0].value;
      if (sends === 1) log.info("jito", `${ctx.label}: bundle ${short(bundleId)} submitted`, { signature, mint: ctx.mint });
    }
  };

  await send();

  while (true) {

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

    // 2. Protected mode: what Jito says about the bundle, for the record.
    if (ctx.mode === "protected" && bundleId) {
      try {
        const b = await deps.jito.bundleStatus(bundleId);
        const st = b?.status ?? "Invalid";
        if (st !== lastJito) step("Jito bundle status", st === "Invalid" ? "Invalid (Jito has no record of this bundle)" : st);
        lastJito = st;
      } catch (e) {
        if (lastJito !== "unknown") step("Jito bundle status", `lookup failed: ${(e as Error).message}`);
        lastJito = "unknown";
      }
    }

    // 3. Re-send the same bytes every 2 s until it lands or expires.
    if (now() - lastSend > RESEND_MS) await send().catch(() => undefined);

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
        `${ctx.label} did not land: ${whyNotLanded(ctx.mode, routes, lastJito, sends)} The transaction has expired, so nothing was spent and it cannot land later. Try again.`,
        { routes, jitoStatus: lastJito, sends, blockHeight },
      );
    }
    if (now() - t0 > WALL_CLOCK_CAP_MS) {
      step("Gave up", `no answer from the RPC for ${Math.round(WALL_CLOCK_CAP_MS / 1000)} s (${rpcError ?? "no error"})`);
      throw fail(
        "unknown",
        `${ctx.label}: could not confirm whether it landed, because the RPC stopped answering (${rpcError ?? "no answer"}). It MAY have gone through; check the transaction on Solscan before buying again.`,
        { routes, jitoStatus: lastJito, rpcError },
      );
    }
    await sleep(POLL_MS);
  }
}

function whyNotLanded(mode: SendMode, routes: Record<string, string>, jito: InflightStatus | "unknown", sends: number) {
  const refused = Object.entries(routes).filter(([, r]) => r.startsWith("refused"));
  const parts: string[] = [];
  if (refused.length) parts.push(refused.map(([route, r]) => `${route} ${r}.`).join(" "));
  if (mode === "protected") {
    if (jito === "Invalid") parts.push("Jito accepted the bundle but then had no record of it (Jito status \"Invalid\"), meaning it dropped it before any block.");
    else if (jito === "Failed") parts.push("Jito marked the bundle failed in every region (usually the swap would have failed at that moment, e.g. price moved past your slippage).");
    parts.push("Protected mode only lands with Jito leaders; Fast mode in Snipe Config also reaches the others.");
  } else if (refused.length < Object.keys(routes).length) {
    parts.push(`It was sent ${sends} time(s) and no leader included it (network congestion, or the priority fee or tip was too low for that moment).`);
  }
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

export interface BundleLandResult {
  bundleId: string | null;
  /** Per transaction, in bundle order. */
  signatures: string[];
  slot?: number;
  steps: Step[];
}

/**
 * Lands one Jito bundle of up to 5 signed transactions (a preset buy or sell in Protected mode). A bundle is
 * all-or-nothing: either every transaction in it runs, in order, in one block, or none does. The very same bundle is
 * re-submitted every 2 s while it has not landed (same signatures, so nothing can run twice), never sent to the
 * public network, and only called failed once the shared blockhash has expired.
 */
export async function landBundle(
  txs: VersionedTransaction[],
  ctx: { label: string; lastValidBlockHeight: number; mint: string; numbers: Record<string, unknown> },
  deps: LandDeps = defaultDeps(),
): Promise<BundleLandResult> {
  const { conn, sleep, now } = deps;
  if (!txs.length || txs.length > 5) throw new Error(`A Jito bundle holds 1 to 5 transactions, got ${txs.length}`);
  const signatures = txs.map(signatureOf);
  const t0 = now();
  const steps: Step[] = [];
  const step = (name: string, result: string) => steps.push({ ms: now() - t0, step: name, result });
  let bundleId: string | null = null;
  let lastJito: InflightStatus | "unknown" = "unknown";
  let lastSendResult = "";
  let sends = 0;
  let lastSend = 0;
  let blockHeight = 0;
  let lastHeightCheck = 0;
  let rpcError: string | null = null;
  const fail = (stage: string, message: string, extra: Record<string, unknown> = {}) =>
    new DetailedError(message, {
      stage,
      sendMode: "protected",
      mint: ctx.mint,
      signatures,
      bundleId,
      solscan: `https://solscan.io/tx/${signatures[0]}`,
      jitoExplorer: bundleId ? `https://explorer.jito.wtf/bundle/${bundleId}` : undefined,
      lastValidBlockHeight: ctx.lastValidBlockHeight,
      ...ctx.numbers,
      ...extra,
      steps,
    });

  const send = async () => {
    lastSend = now();
    sends++;
    const [r] = await Promise.allSettled([deps.jito.sendBundle(txs)]);
    const result = r.status === "fulfilled" ? "accepted" : `refused: ${(r.reason as Error).message}`;
    if (result !== lastSendResult) step("Jito sendBundle", sends > 1 ? `${result} (re-send ${sends - 1})` : result);
    lastSendResult = result;
    if (r.status === "fulfilled") {
      bundleId = r.value;
      if (sends === 1) log.info("jito", `${ctx.label}: bundle ${short(bundleId)} with ${txs.length} transaction(s) submitted`, { signature: signatures[0], mint: ctx.mint });
    }
  };

  const check = async (history: boolean) => {
    const sts = (await conn.getSignatureStatuses(signatures, history ? { searchTransactionHistory: true } : undefined)).value;
    const done = sts.filter((st) => st && (history || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"));
    if (!done.length) return null;
    const bad = sts.findIndex((st) => st?.err);
    if (bad >= 0) {
      const st = sts[bad]!;
      const logs = await failedLogs(conn, sleep, signatures[bad]);
      step("On chain", `transaction ${bad + 1} ran and failed in slot ${st.slot}: ${JSON.stringify(st.err)}`);
      throw fail("chain", `${ctx.label}: transaction ${bad + 1} of the bundle reached the chain but failed: ${explainError(st.err, logs)}`, {
        onChainError: st.err,
        slot: st.slot,
        logs: logs.slice(-15),
      });
    }
    // All-or-nothing: once one is in, all are (they share a block); wait for every status before settling.
    if (done.length < signatures.length) return null;
    const slot = sts[0]!.slot;
    step("On chain", `bundle confirmed in slot ${slot}`);
    return { bundleId, signatures, slot, steps };
  };

  await send();
  while (true) {
    try {
      const r = await check(false);
      rpcError = null;
      if (r) return r;
    } catch (e) {
      if (e instanceof DetailedError) throw e;
      rpcError = (e as Error).message;
    }
    if (bundleId) {
      try {
        const b = await deps.jito.bundleStatus(bundleId);
        const st = b?.status ?? "Invalid";
        if (st !== lastJito) step("Jito bundle status", st === "Invalid" ? "Invalid (Jito has no record of this bundle)" : st);
        lastJito = st;
      } catch (e) {
        if (lastJito !== "unknown") step("Jito bundle status", `lookup failed: ${(e as Error).message}`);
        lastJito = "unknown";
      }
    }
    if (now() - lastSend > RESEND_MS) await send().catch(() => undefined);
    if (now() - lastHeightCheck > 2_000) {
      lastHeightCheck = now();
      blockHeight = await conn.getBlockHeight("confirmed").catch(() => blockHeight);
    }
    if (blockHeight > ctx.lastValidBlockHeight) {
      const r = await check(true).catch((e) => {
        if (e instanceof DetailedError) throw e;
        return null;
      });
      if (r) return r;
      step("Blockhash", `expired at block ${ctx.lastValidBlockHeight} (now ${blockHeight}); the bundle can no longer land`);
      const routes: Record<string, string> = lastSendResult.startsWith("refused") ? { "Jito sendBundle": lastSendResult } : {};
      throw fail(
        "not_landed",
        `${ctx.label} did not land: ${whyNotLanded("protected", routes, lastJito, sends)} The bundle has expired, so nothing was spent and it cannot land later. Try again.`,
        { jitoStatus: lastJito, sends, blockHeight },
      );
    }
    if (now() - t0 > WALL_CLOCK_CAP_MS) {
      step("Gave up", `no answer from the RPC for ${Math.round(WALL_CLOCK_CAP_MS / 1000)} s (${rpcError ?? "no error"})`);
      throw fail(
        "unknown",
        `${ctx.label}: could not confirm whether the bundle landed, because the RPC stopped answering (${rpcError ?? "no answer"}). It MAY have gone through; check the transactions on Solscan before trading again.`,
        { jitoStatus: lastJito, rpcError },
      );
    }
    await sleep(POLL_MS);
  }
}
