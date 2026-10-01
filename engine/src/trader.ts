import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { env, hasRpc } from "./config.js";
import { DetailedError, log } from "./bus.js";
import { dynamicPriorityFee } from "./fees.js";
import { tipFloorSol, tipInstruction } from "./jito.js";
import { explainError, landTransaction } from "./land.js";
import { getGroup } from "./groups.js";
import {
  findPosition,
  openPositions,
  recordBuy,
  recordSell,
  type Position,
  type TradeReason,
} from "./portfolio.js";
import { buildBuy, buildSell, mintInfo, venueState } from "./pump.js";
import { checkMint } from "./safety.js";
import { getSettings } from "./settings.js";
import { isSimMint, simCoin, simPrice } from "./sim.js";
import { connection, lamports, LAMPORTS, short, sol } from "./solana.js";
import { getWallet, keypairOf } from "./wallets.js";
import type { Venue } from "./events.js";

export const PAPER_WALLET = { id: "paper", name: "Paper wallet" };

/** Live trading needs both the env hard switch and the dashboard toggle off simulation. */
export const isLive = () => env.allowLive && !getSettings().simulation;

const busy = new Set<string>();

function walletLabel(walletId: string) {
  if (walletId === PAPER_WALLET.id) return PAPER_WALLET.name;
  return getWallet(walletId)?.name ?? walletId;
}

async function tipSol(emergency: boolean): Promise<number> {
  const s = getSettings();
  if (emergency) return s.antiRug.emergencyTipSol;
  if (!s.jitoTipDynamic) return s.jitoTipSol;
  const floor = await tipFloorSol();
  return Math.min(s.jitoTipMaxSol, Math.max(s.jitoTipSol, floor ?? 0));
}

interface Landed {
  signature: string;
  bundleId: string;
  priorityFeeSol: number;
  jitoTipSol: number;
  networkFeeSol: number;
  /** SOL leaving (buy) or entering (sell) the wallet, net of fees and tip. */
  solMoved: number;
  /** Tokens (UI units) entering (buy) or leaving (sell) the wallet. */
  tokensMoved: number;
}

/**
 * Builds one transaction [CU limit, CU price, swap, (close ATA), Jito tip], simulates it, and lands it as a Jito
 * bundle. A single-transaction bundle is all-or-nothing and is never exposed to the public mempool, so a reverted
 * swap costs nothing and cannot be sandwiched.
 */
async function landSwap(opts: {
  kp: Keypair;
  mint: PublicKey;
  instructions: TransactionInstruction[];
  hotAccounts: PublicKey[];
  emergency: boolean;
  label: string;
}): Promise<Landed> {
  const s = getSettings();
  const conn = connection();
  const cuPrice = opts.emergency
    ? Math.max(s.priorityFeeMicroLamports, 1_000_000)
    : s.priorityFeeMicroLamports || (await dynamicPriorityFee(opts.hotAccounts));
  const tip = await tipSol(opts.emergency);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: opts.kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: s.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
      ...opts.instructions,
      tipInstruction(opts.kp.publicKey, lamports(tip)),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([opts.kp]);

  const priorityFeeSol = (cuPrice * s.computeUnitLimit) / 1e6 / LAMPORTS;
  const numbers = { jitoTipSol: tip, priorityFeeSol, cuPrice, computeUnitLimit: s.computeUnitLimit, slippagePct: s.slippagePct };
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "processed" });
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const balance = (await conn.getBalance(opts.kp.publicKey, "processed").catch(() => NaN)) / LAMPORTS;
    throw new DetailedError(`${opts.label} failed its pre-send simulation, nothing was sent or spent: ${explainError(sim.value.err, logs)}`, {
      stage: "simulate",
      mint: opts.mint.toBase58(),
      wallet: opts.kp.publicKey.toBase58(),
      balanceSol: balance,
      ...numbers,
      simulationError: sim.value.err,
      unitsConsumed: sim.value.unitsConsumed,
      logs: logs.slice(-15),
    });
  }
  log.info("trade", `${opts.label}: simulation OK (${sim.value.unitsConsumed ?? "?"} CU), sending with tip ${tip.toFixed(4)} SOL, CU price ${cuPrice}`, {
    mint: opts.mint.toBase58(),
  });

  const res = await landTransaction(tx, { label: opts.label, lastValidBlockHeight, mint: opts.mint.toBase58(), numbers });
  const { signature } = res;
  const bundleId = res.bundleId ?? "";
  log.success("jito", `${opts.label}: landed in slot ${res.slot ?? "?"} after ${((res.steps.at(-1)?.ms ?? 0) / 1000).toFixed(1)} s`, {
    signature,
    mint: opts.mint.toBase58(),
  });

  // Settle from the confirmed transaction so the ledger holds real amounts, not quotes.
  let parsed = null;
  for (let i = 0; i < 10 && !parsed; i++) {
    parsed = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!parsed) await new Promise((r) => setTimeout(r, 700));
  }
  if (!parsed?.meta) {
    return { signature, bundleId, priorityFeeSol, jitoTipSol: tip, networkFeeSol: 0.000005, solMoved: NaN, tokensMoved: NaN };
  }
  const meta = parsed.meta;
  const fee = meta.fee / LAMPORTS;
  const owner = opts.kp.publicKey.toBase58();
  const mintStr = opts.mint.toBase58();
  const bal = (arr: typeof meta.preTokenBalances) =>
    (arr ?? []).filter((b) => b.owner === owner && b.mint === mintStr).reduce((a, b) => a + (b.uiTokenAmount.uiAmount ?? 0), 0);
  const solDelta = (meta.preBalances[0] - meta.postBalances[0]) / LAMPORTS;
  return {
    signature,
    bundleId,
    priorityFeeSol,
    jitoTipSol: tip,
    networkFeeSol: Math.max(0, fee - priorityFeeSol),
    // Buy: positive = spent on the swap (incl. token-account rent). Sell: negative = received.
    solMoved: solDelta - fee - tip,
    tokensMoved: bal(meta.postTokenBalances) - bal(meta.preTokenBalances),
  };
}

export interface BuyRequest {
  mint: string;
  walletId: string;
  sol: number;
  reason: TradeReason;
  meta?: { name?: string; symbol?: string; creator?: string };
}

/** Rough upper bound for a token account's rent (Token-2022 accounts with extensions run slightly above SPL's 0.00204). */
const ACCOUNT_RENT_SOL = 0.0021;

/**
 * Refuses a live buy the wallet cannot pay for, with the numbers, before building or sending anything. The chain
 * would reject it anyway, but only after the tip and fees were spent on a failed bundle, with a vaguer error.
 */
async function ensureFunds(walletName: string, owner: PublicKey, sol: number, mint: string) {
  const s = getSettings();
  const balance = (await connection().getBalance(owner, "confirmed")) / LAMPORTS;
  const tip = await tipSol(false);
  const priority = ((s.priorityFeeMicroLamports || 100_000) * s.computeUnitLimit) / 1e6 / LAMPORTS;
  // Pump.fun and PumpSwap take ~1.25% on top of the amount; 2% covers it with room.
  const venueFee = sol * 0.02;
  const need = sol + venueFee + tip + priority + ACCOUNT_RENT_SOL + 0.00001;
  if (balance >= need) return;
  const parts = `${sol} buy + ~${venueFee.toFixed(4)} Pump.fun fee + ${tip} Jito tip + ~${priority.toFixed(4)} priority fee + up to ${ACCOUNT_RENT_SOL} token account rent`;
  throw new DetailedError(`Not enough SOL in ${walletName}: it has ${balance.toFixed(4)} SOL, this buy needs about ${need.toFixed(4)} SOL (${parts})`, {
    stage: "balance",
    mint,
    wallet: owner.toBase58(),
    balanceSol: balance,
    neededSol: need,
    buySol: sol,
    jitoTipSol: tip,
    priorityFeeSol: priority,
    venueFeeSol: venueFee,
    accountRentSol: ACCOUNT_RENT_SOL,
  });
}

export async function executeBuy(req: BuyRequest) {
  const s = getSettings();
  const live = isLive();
  const walletId = live ? req.walletId : req.walletId || PAPER_WALLET.id;
  const key = `${walletId}:${req.mint}`;
  if (busy.has(key)) throw new Error("A trade for this wallet and token is already in flight");
  if (!(req.sol > 0)) throw new Error("Amount must be positive");
  busy.add(key);
  try {
    if (!isSimMint(req.mint) && !hasRpc()) throw new Error("Real mints need SOLANA_RPC_URL; in simulation without RPC only synthetic launches can be traded");
    if (live) {
      // Cheapest and most common failure first: a wallet that cannot cover the buy plus tip, fees and rent.
      const fw = getWallet(walletId);
      if (!fw) throw new Error("Select a wallet for live trading");
      await ensureFunds(fw.name, keypairOf(walletId).publicKey, req.sol, req.mint);
    }
    const report = await checkMint(req.mint).catch((e) => {
      throw new DetailedError(`Safety check could not run: ${(e as Error).message}`, { stage: "safety", mint: req.mint });
    });
    if (!report.ok) {
      const failed = report.checks.filter((c) => !c.pass);
      throw new DetailedError(`Safety check failed: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}`, {
        stage: "safety",
        mint: req.mint,
        failed,
        checks: report.checks,
      });
    }

    const sc = simCoin(req.mint);
    const symbol = req.meta?.symbol ?? sc?.symbol ?? req.mint.slice(0, 4);
    const name = req.meta?.name ?? sc?.name ?? symbol;
    const walletName = walletLabel(walletId);

    if (!live) {
      let priceSol: number;
      let venue: Venue = "pump_curve";
      let creator = sc?.creator ?? req.meta?.creator ?? "";
      let decimals = 6;
      if (sc) {
        priceSol = simPrice(req.mint)!;
      } else {
        const v = await venueState(new PublicKey(req.mint));
        [priceSol, venue, creator, decimals] = [v.priceSol, v.venue, v.creator, v.decimals];
        // Dry-run the real transaction when a real wallet is selected, so simulation also proves the route works.
        if (getWallet(walletId)) {
          const kp = keypairOf(walletId);
          const built = await buildBuy(new PublicKey(req.mint), kp.publicKey, BigInt(lamports(req.sol)), s.slippagePct);
          const { blockhash } = await connection().getLatestBlockhash();
          const tx = new VersionedTransaction(
            new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: built.instructions }).compileToV0Message(),
          );
          const r = await connection().simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
          if (r.value.err) throw new Error(`On-chain dry run failed: ${JSON.stringify(r.value.err)}`);
          log.info("sim", `On-chain dry run OK (${r.value.unitsConsumed ?? "?"} CU)`, { mint: req.mint });
        }
      }
      // Model ~1% protocol fee plus up to 3% adverse fill versus the observed price.
      const fill = priceSol * (1.01 + Math.random() * 0.03);
      const tokens = req.sol / fill;
      const trade = recordBuy(
        {
          mode: "sim",
          reason: req.reason,
          walletId,
          walletName,
          mint: req.mint,
          symbol,
          venue,
          solAmount: req.sol,
          tokenAmount: tokens,
          priceSol: fill,
          priorityFeeSol: 0.0001,
          jitoTipSol: s.jitoTipSol,
          networkFeeSol: 0.000005,
        },
        { name, creator, decimals },
      );
      log.success("trade", `[SIM] Bought ${fmt(tokens)} ${symbol} for ${req.sol} SOL with ${walletName}`, { mint: req.mint });
      return trade;
    }

    const w = getWallet(walletId);
    if (!w) throw new Error("Select a wallet for live trading");
    const kp = keypairOf(walletId);
    const mint = new PublicKey(req.mint);
    const built = await buildBuy(mint, kp.publicKey, BigInt(lamports(req.sol)), s.slippagePct);
    const v = await venueState(mint).catch(() => null);
    log.info("trade", `Buying ${req.sol} SOL of ${symbol} on ${built.venue} with ${w.name}`, { mint: req.mint });
    const landed = await landSwap({ kp, mint, instructions: built.instructions, hotAccounts: built.hotAccounts, emergency: false, label: `BUY ${symbol}` });
    const tokens = Number.isFinite(landed.tokensMoved) ? landed.tokensMoved : Number(built.expectedOut) / 10 ** built.decimals;
    const spent = Number.isFinite(landed.solMoved) ? landed.solMoved : req.sol;
    return recordBuy(
      {
        mode: "live",
        reason: req.reason,
        walletId,
        walletName: w.name,
        mint: req.mint,
        symbol,
        venue: built.venue,
        solAmount: spent,
        tokenAmount: tokens,
        priceSol: spent / tokens,
        priorityFeeSol: landed.priorityFeeSol,
        jitoTipSol: landed.jitoTipSol,
        networkFeeSol: landed.networkFeeSol,
        signature: landed.signature,
        bundleId: landed.bundleId,
      },
      { name, creator: v?.creator ?? req.meta?.creator ?? "", decimals: built.decimals },
    );
  } finally {
    busy.delete(key);
  }
}

export async function executeSell(positionKey: string, pct: number, reason: TradeReason, emergency = false) {
  const p = findPosition(positionKey);
  if (!p) throw new Error("Position not found");
  if (busy.has(positionKey)) return null;
  busy.add(positionKey);
  try {
    const s = getSettings();
    const fraction = Math.min(100, Math.max(0, pct)) / 100;
    if (p.mode === "sim") return simSell(p, fraction, reason);
    if (!isLive()) throw new Error("This is a live position; switch simulation off (and set ALLOW_LIVE_TRADING) to sell it");

    const kp = keypairOf(p.walletId);
    const mint = new PublicKey(p.mint);
    const { program, decimals } = await mintInfo(mint);
    const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, true, program);
    const onChain = BigInt((await connection().getTokenAccountBalance(ata)).value.amount);
    const raw = fraction >= 1 ? onChain : (onChain * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    if (raw === 0n) throw new Error("Nothing to sell");
    const slippage = emergency ? Math.max(s.slippagePct, 50) : s.slippagePct;
    const built = await buildSell(mint, kp.publicKey, raw, slippage);
    const ixs = [...built.instructions];
    if (raw === onChain) ixs.push(createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey, [], program));
    const label = `${emergency ? "EMERGENCY " : ""}SELL ${Math.round(fraction * 100)}% ${p.symbol}`;
    log.info("trade", `${label} (${reason})`, { mint: p.mint });
    const landed = await landSwap({ kp, mint, instructions: ixs, hotAccounts: built.hotAccounts, emergency, label });
    const tokens = Number.isFinite(landed.tokensMoved) ? -landed.tokensMoved : Number(raw) / 10 ** decimals;
    const received = Number.isFinite(landed.solMoved) ? -landed.solMoved : Number(built.expectedOut) / LAMPORTS;
    return recordSell({
      mode: "live",
      reason,
      walletId: p.walletId,
      walletName: p.walletName,
      mint: p.mint,
      symbol: p.symbol,
      venue: built.venue,
      solAmount: received,
      tokenAmount: tokens,
      priceSol: received / tokens,
      priorityFeeSol: landed.priorityFeeSol,
      jitoTipSol: landed.jitoTipSol,
      networkFeeSol: landed.networkFeeSol,
      signature: landed.signature,
      bundleId: landed.bundleId,
    });
  } finally {
    busy.delete(positionKey);
  }
}

export interface SellAllResult {
  sold: number;
  failed: number;
  results: Array<{ wallet: string; symbol: string; ok: boolean; solReceived?: number; error?: string }>;
}

/**
 * Exit fast: sells 100% of every open position matching the filters (one coin, one group, or both; neither means
 * everything). Each wallet sells in its own Jito bundle, all at once, so one wallet that fails (empty, reverted,
 * dropped) never holds up the others. A bundle is also capped at 5 transactions, which a big group would exceed.
 */
export async function sellAll(opts: { mint?: string; groupId?: string }): Promise<SellAllResult> {
  const only = opts.groupId ? new Set(getGroup(opts.groupId).walletIds) : null;
  const targets = openPositions().filter((p) => (!opts.mint || p.mint === opts.mint) && (!only || only.has(p.walletId)));
  if (!targets.length) throw new Error("No open positions to sell");
  log.warn("trade", `SELL ALL: exiting ${targets.length} position(s)${opts.mint ? ` in ${targets[0].symbol}` : ""}`);
  const settled = await Promise.allSettled(targets.map((p) => executeSell(p.key, 100, "panic")));
  const results = settled.map((r, i) => {
    const p = targets[i];
    if (r.status === "fulfilled" && r.value) return { wallet: p.walletName, symbol: p.symbol, ok: true, solReceived: r.value.solAmount };
    const error = r.status === "rejected" ? (r.reason as Error).message : "A sell for this position was already in flight";
    log.error("trade", `SELL ALL: ${p.symbol} from ${p.walletName} failed: ${error}`, { mint: p.mint });
    return { wallet: p.walletName, symbol: p.symbol, ok: false, error };
  });
  const sold = results.filter((r) => r.ok).length;
  return { sold, failed: results.length - sold, results };
}

function simSell(p: Position, fraction: number, reason: TradeReason) {
  const s = getSettings();
  const price = simPrice(p.mint) ?? p.lastPriceSol;
  const fill = price * (0.99 - Math.random() * 0.02);
  const tokens = p.tokens * fraction;
  const trade = recordSell({
    mode: "sim",
    reason,
    walletId: p.walletId,
    walletName: p.walletName,
    mint: p.mint,
    symbol: p.symbol,
    venue: p.venue,
    solAmount: tokens * fill,
    tokenAmount: tokens,
    priceSol: fill,
    priorityFeeSol: 0.0001,
    jitoTipSol: reason === "anti_rug" ? s.antiRug.emergencyTipSol : s.jitoTipSol,
    networkFeeSol: 0.000005,
  });
  const pnl = trade.realizedPnlSol;
  log[pnl >= 0 ? "success" : "warn"](
    "trade",
    `[SIM] Sold ${Math.round(fraction * 100)}% ${p.symbol} (${reason}) for ${(tokens * fill).toFixed(4)} SOL, PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL`,
    { mint: p.mint },
  );
  return trade;
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2));
