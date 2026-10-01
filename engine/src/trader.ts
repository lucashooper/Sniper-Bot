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
import { explainError, landBundle, landTransaction } from "./land.js";
import { SENDER_MIN_TIP_SOL, senderTipInstruction } from "./sender.js";
import { getGroup } from "./groups.js";
import {
  findPosition,
  openPositions,
  recordBuy,
  recordSell,
  type Position,
  type Trade,
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
  // Helius Sender only uses every route (Jito plus staked connections) for tips of at least 0.001 SOL.
  const min = s.sendMode === "protected" ? 0 : SENDER_MIN_TIP_SOL;
  if (emergency) return Math.max(min, s.antiRug.emergencyTipSol);
  if (!s.jitoTipDynamic) return Math.max(min, s.jitoTipSol);
  const floor = await tipFloorSol();
  return Math.max(min, Math.min(s.jitoTipMaxSol, Math.max(s.jitoTipSol, floor ?? 0)));
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
  slot?: number;
}

interface SwapLeg {
  kp: Keypair;
  mint: PublicKey;
  instructions: TransactionInstruction[];
  hotAccounts: PublicKey[];
  emergency: boolean;
  label: string;
}

/**
 * Builds and signs one transaction [CU limit, CU price, swap, (close ATA), tip] and simulates it. Nothing is sent: a
 * failed simulation throws with the program's own reason, the wallet's balance and the logs.
 */
async function buildSwapTx(
  opts: SwapLeg,
  cfg: { cuPrice: number; tip: number; tipTo: "jito" | "sender" | "none"; blockhash: string },
) {
  const s = getSettings();
  const conn = connection();
  const msg = new TransactionMessage({
    payerKey: opts.kp.publicKey,
    recentBlockhash: cfg.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: s.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.cuPrice }),
      ...opts.instructions,
      ...(cfg.tipTo === "jito" ? [tipInstruction(opts.kp.publicKey, lamports(cfg.tip))] : cfg.tipTo === "sender" ? [senderTipInstruction(opts.kp.publicKey, lamports(cfg.tip))] : []),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([opts.kp]);

  const priorityFeeSol = (cfg.cuPrice * s.computeUnitLimit) / 1e6 / LAMPORTS;
  const tipSolPaid = cfg.tipTo === "none" ? 0 : cfg.tip;
  const numbers = {
    sendMode: s.sendMode === "protected" ? "protected" : "fast",
    tipSol: tipSolPaid,
    priorityFeeSol,
    cuPrice: cfg.cuPrice,
    computeUnitLimit: s.computeUnitLimit,
    slippagePct: s.slippagePct,
  };
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
  log.info("trade", `${opts.label}: simulation OK (${sim.value.unitsConsumed ?? "?"} CU)`, { mint: opts.mint.toBase58() });
  return { tx, priorityFeeSol, tip: tipSolPaid, numbers };
}

/**
 * Builds one transaction, simulates it, and lands it (fast: Helius Sender + RPC; protected: single-transaction Jito
 * bundle). Only the chain decides success.
 */
async function landSwap(opts: SwapLeg): Promise<Landed> {
  const s = getSettings();
  const conn = connection();
  const cuPrice = opts.emergency
    ? Math.max(s.priorityFeeMicroLamports, 1_000_000)
    : s.priorityFeeMicroLamports || (await dynamicPriorityFee(opts.hotAccounts));
  const tip = await tipSol(opts.emergency);
  const mode = s.sendMode === "protected" ? "protected" : "fast";
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const built = await buildSwapTx(opts, { cuPrice, tip, tipTo: mode === "protected" ? "jito" : "sender", blockhash });
  log.info("trade", `${opts.label}: sending (${mode === "fast" ? "fast: Helius Sender + RPC" : "protected: Jito bundle"}) with tip ${tip.toFixed(4)} SOL, CU price ${cuPrice}`, {
    mint: opts.mint.toBase58(),
  });

  const res = await landTransaction(built.tx, { label: opts.label, mode, lastValidBlockHeight, mint: opts.mint.toBase58(), numbers: built.numbers });
  log.success("jito", `${opts.label}: landed in slot ${res.slot ?? "?"} after ${((res.steps.at(-1)?.ms ?? 0) / 1000).toFixed(1)} s`, {
    signature: res.signature,
    mint: opts.mint.toBase58(),
  });
  return settleSwap(opts, { signature: res.signature, bundleId: res.bundleId ?? "", slot: res.slot, priorityFeeSol: built.priorityFeeSol, tip: built.tip });
}

/** Reads the confirmed transaction so the ledger holds real amounts, not quotes. */
async function settleSwap(
  opts: Pick<SwapLeg, "kp" | "mint">,
  r: { signature: string; bundleId: string; slot?: number; priorityFeeSol: number; tip: number },
): Promise<Landed> {
  const conn = connection();
  const { signature, bundleId, priorityFeeSol, tip } = r;
  let parsed = null;
  for (let i = 0; i < 10 && !parsed; i++) {
    // An RPC hiccup here must not turn a landed trade into a reported failure: fall back to the quote below.
    parsed = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (!parsed) await new Promise((res) => setTimeout(res, 700));
  }
  if (!parsed?.meta) {
    return { signature, bundleId, slot: r.slot, priorityFeeSol, jitoTipSol: tip, networkFeeSol: 0.000005, solMoved: NaN, tokensMoved: NaN };
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
    slot: parsed.slot ?? r.slot,
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
  const parts = `${sol} buy + ~${venueFee.toFixed(4)} Pump.fun fee + ${tip} landing tip + ~${priority.toFixed(4)} priority fee + up to ${ACCOUNT_RENT_SOL} token account rent`;
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
        slot: landed.slot,
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
      slot: landed.slot,
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

/* ---------------------------------------------------------------- presets: one order across a wallet group */

export interface GroupLegResult {
  walletId: string;
  wallet: string;
  ok: boolean;
  trade?: Trade;
  error?: string;
  details?: Record<string, unknown>;
}

export interface GroupTradeResult {
  side: "buy" | "sell";
  /** "sim": paper trades; "fast": one transaction per wallet through Helius Sender + RPC; "protected": Jito bundles of up to 5. */
  sendMode: "sim" | "fast" | "protected";
  bundles: number;
  ok: number;
  failed: number;
  results: GroupLegResult[];
}

/** Jito bundles hold at most 5 transactions, so a bigger preset goes out as several bundles at once. */
const BUNDLE_MAX = 5;

function legError(walletId: string, wallet: string, e: unknown): GroupLegResult {
  const err = e as Error & { details?: Record<string, unknown> };
  return { walletId, wallet, ok: false, error: err.message, details: err instanceof DetailedError ? err.details : undefined };
}

function summarize(side: "buy" | "sell", sendMode: GroupTradeResult["sendMode"], bundles: number, results: GroupLegResult[], label: string): GroupTradeResult {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  for (const r of results) if (!r.ok) log.error("trade", `${label}: ${r.wallet} failed: ${r.error}`);
  log[failed ? "warn" : "success"]("trade", `${label}: ${ok} of ${results.length} wallet(s) filled${bundles ? ` in ${bundles} Jito bundle(s)` : ""}`);
  return { side, sendMode, bundles, ok, failed, results };
}

/** Active wallets of a preset, in the preset's order. */
function presetWallets(groupId: string) {
  const g = getGroup(groupId);
  const ws = g.walletIds.map((id) => getWallet(id)).filter((w): w is NonNullable<typeof w> => !!w && w.active);
  if (!ws.length) throw new Error(`Preset "${g.name}" has no active wallets`);
  return { group: g, wallets: ws };
}

interface PreparedLeg {
  walletId: string;
  wallet: string;
  leg: SwapLeg;
  record: (landed: Landed) => Trade;
}

/**
 * Protected mode for a preset: every wallet's transaction is built and simulated on its own (a wallet that fails is
 * reported and left out), then they go out as Jito bundles of up to 5, all bundles at once. One Jito tip per bundle,
 * paid by its last transaction. Each bundle lands whole or not at all and is never sent to the public network.
 */
async function landPreparedAsBundles(prepared: PreparedLeg[], label: string, mint: string, results: GroupLegResult[]) {
  if (!prepared.length) return 0;
  const s = getSettings();
  const conn = connection();
  const cuPrice = s.priorityFeeMicroLamports || (await dynamicPriorityFee(prepared[0].leg.hotAccounts));
  const tip = await tipSol(false);
  const chunks: PreparedLeg[][] = [];
  for (let i = 0; i < prepared.length; i += BUNDLE_MAX) chunks.push(prepared.slice(i, i + BUNDLE_MAX));

  await Promise.all(
    chunks.map(async (chunk, ci) => {
      const bundleLabel = `${label} bundle ${ci + 1}/${chunks.length}`;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      // Simulate each wallet's transaction alone first; a failing one is dropped instead of sinking the whole bundle.
      const built = await Promise.all(
        chunk.map((p) =>
          buildSwapTx(p.leg, { cuPrice, tip, tipTo: "none", blockhash }).then(
            (b) => ({ p, b }),
            (e) => (results.push(legError(p.walletId, p.wallet, e)), null),
          ),
        ),
      );
      const ok = built.filter((x): x is NonNullable<typeof x> => !!x);
      if (!ok.length) return;
      // The last transaction carries the bundle's tip; rebuild and re-simulate it with the tip in.
      const last = ok[ok.length - 1];
      try {
        last.b = await buildSwapTx(last.p.leg, { cuPrice, tip, tipTo: "jito", blockhash });
      } catch (e) {
        for (const x of ok) results.push(legError(x.p.walletId, x.p.wallet, e));
        return;
      }
      log.info("trade", `${bundleLabel}: sending ${ok.length} transaction(s) as one Jito bundle, tip ${tip.toFixed(4)} SOL paid by ${last.p.wallet}`, { mint });
      try {
        const res = await landBundle(
          ok.map((x) => x.b.tx),
          { label: bundleLabel, lastValidBlockHeight, mint, numbers: { ...last.b.numbers, wallets: ok.map((x) => x.p.wallet) } },
        );
        log.success("jito", `${bundleLabel}: landed in slot ${res.slot ?? "?"}`, { signature: res.signatures[0], mint });
        await Promise.all(
          ok.map(async (x, i) => {
            try {
              const landed = await settleSwap(x.p.leg, { signature: res.signatures[i], bundleId: res.bundleId ?? "", slot: res.slot, priorityFeeSol: x.b.priorityFeeSol, tip: x.b.tip });
              results.push({ walletId: x.p.walletId, wallet: x.p.wallet, ok: true, trade: x.p.record(landed) });
            } catch (e) {
              results.push(legError(x.p.walletId, x.p.wallet, e));
            }
          }),
        );
      } catch (e) {
        for (const x of ok) results.push(legError(x.p.walletId, x.p.wallet, e));
      }
    }),
  );
  return chunks.length;
}

/**
 * Buys the same SOL amount of one coin from every active wallet of a preset at once. Simulation and Fast mode run
 * the normal single-wallet buy for each wallet in parallel (each with its own checks and transaction); Protected
 * mode sends Jito bundles of up to 5 wallets each. A wallet that is already trading this coin is skipped, so no
 * wallet can submit twice.
 */
export async function groupBuy(req: { mint: string; groupId: string; sol: number; meta?: BuyRequest["meta"] }): Promise<GroupTradeResult> {
  const { group, wallets } = presetWallets(req.groupId);
  if (!(req.sol > 0)) throw new Error("Amount must be positive");
  const s = getSettings();
  const label = `PRESET BUY ${req.sol} SOL x ${wallets.length} (${group.name})`;
  log.info("trade", `${label}: ${wallets.map((w) => w.name).join(", ")}`, { mint: req.mint });

  if (!isLive() || s.sendMode !== "protected") {
    const settled = await Promise.allSettled(wallets.map((w) => executeBuy({ mint: req.mint, walletId: w.id, sol: req.sol, reason: "manual", meta: req.meta })));
    const results = settled.map((r, i) => (r.status === "fulfilled" ? { walletId: wallets[i].id, wallet: wallets[i].name, ok: true, trade: r.value } : legError(wallets[i].id, wallets[i].name, r.reason)));
    return summarize("buy", isLive() ? "fast" : "sim", 0, results, label);
  }

  if (!hasRpc()) throw new Error("Live trading needs SOLANA_RPC_URL");
  const results: GroupLegResult[] = [];
  const locked: string[] = [];
  try {
    const report = await checkMint(req.mint).catch((e) => {
      throw new DetailedError(`Safety check could not run: ${(e as Error).message}`, { stage: "safety", mint: req.mint });
    });
    if (!report.ok) {
      const failed = report.checks.filter((c) => !c.pass);
      throw new DetailedError(`Safety check failed: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}`, { stage: "safety", mint: req.mint, failed, checks: report.checks });
    }
    const mint = new PublicKey(req.mint);
    const v = await venueState(mint).catch(() => null);
    const symbol = req.meta?.symbol ?? req.mint.slice(0, 4);
    const name = req.meta?.name ?? symbol;
    const prepared = (
      await Promise.all(
        wallets.map(async (w): Promise<PreparedLeg | null> => {
          const key = `${w.id}:${req.mint}`;
          if (busy.has(key)) return results.push(legError(w.id, w.name, new Error("A trade for this wallet and token is already in flight"))), null;
          busy.add(key);
          locked.push(key);
          try {
            const kp = keypairOf(w.id);
            await ensureFunds(w.name, kp.publicKey, req.sol, req.mint);
            const built = await buildBuy(mint, kp.publicKey, BigInt(lamports(req.sol)), s.slippagePct);
            return {
              walletId: w.id,
              wallet: w.name,
              leg: { kp, mint, instructions: built.instructions, hotAccounts: built.hotAccounts, emergency: false, label: `BUY ${symbol} (${w.name})` },
              record: (landed) => {
                const tokens = Number.isFinite(landed.tokensMoved) ? landed.tokensMoved : Number(built.expectedOut) / 10 ** built.decimals;
                const spent = Number.isFinite(landed.solMoved) ? landed.solMoved : req.sol;
                return recordBuy(
                  {
                    mode: "live", reason: "manual", walletId: w.id, walletName: w.name, mint: req.mint, symbol, venue: built.venue,
                    solAmount: spent, tokenAmount: tokens, priceSol: spent / tokens,
                    priorityFeeSol: landed.priorityFeeSol, jitoTipSol: landed.jitoTipSol, networkFeeSol: landed.networkFeeSol,
                    signature: landed.signature, bundleId: landed.bundleId, slot: landed.slot,
                  },
                  { name, creator: v?.creator ?? req.meta?.creator ?? "", decimals: built.decimals },
                );
              },
            };
          } catch (e) {
            results.push(legError(w.id, w.name, e));
            return null;
          }
        }),
      )
    ).filter((p): p is PreparedLeg => !!p);
    const bundles = await landPreparedAsBundles(prepared, label, req.mint, results);
    return summarize("buy", "protected", bundles, order(results, wallets), label);
  } finally {
    for (const k of locked) busy.delete(k);
  }
}

/**
 * Sells the same percentage of one coin from every wallet of a preset that holds it. Simulation and Fast mode run the
 * normal sell per wallet in parallel; Protected mode sends Jito bundles of up to 5.
 */
export async function groupSell(req: { mint: string; groupId: string; pct: number }): Promise<GroupTradeResult> {
  const { group, wallets } = presetWallets(req.groupId);
  const ids = new Set(wallets.map((w) => w.id));
  const targets = openPositions().filter((p) => p.mint === req.mint && ids.has(p.walletId));
  if (!targets.length) throw new Error(`No wallet in preset "${group.name}" holds this coin`);
  const pct = Math.min(100, Math.max(0, req.pct));
  if (!(pct > 0)) throw new Error("Sell percentage must be above 0");
  const s = getSettings();
  const reason: TradeReason = pct >= 100 ? "panic" : "manual";
  const label = `PRESET SELL ${+pct.toFixed(2)}% ${targets[0].symbol} x ${targets.length} (${group.name})`;
  // A mix of paper and live positions (switched modes) goes the per-wallet way, which handles each correctly.
  const live = isLive() && targets.every((p) => p.mode === "live");

  if (!live || s.sendMode !== "protected") {
    const settled = await Promise.allSettled(targets.map((p) => executeSell(p.key, pct, reason)));
    const results = settled.map((r, i) =>
      r.status === "fulfilled" && r.value
        ? { walletId: targets[i].walletId, wallet: targets[i].walletName, ok: true, trade: r.value }
        : legError(targets[i].walletId, targets[i].walletName, r.status === "rejected" ? r.reason : new Error("A sell for this position was already in flight")),
    );
    return summarize("sell", live ? "fast" : "sim", 0, results, label);
  }

  const results: GroupLegResult[] = [];
  const locked: string[] = [];
  try {
    const fraction = pct / 100;
    const mint = new PublicKey(req.mint);
    const { program, decimals } = await mintInfo(mint);
    const prepared = (
      await Promise.all(
        targets.map(async (p): Promise<PreparedLeg | null> => {
          if (busy.has(p.key)) return results.push(legError(p.walletId, p.walletName, new Error("A sell for this position was already in flight"))), null;
          busy.add(p.key);
          locked.push(p.key);
          try {
            const kp = keypairOf(p.walletId);
            const ata = getAssociatedTokenAddressSync(mint, kp.publicKey, true, program);
            const onChain = BigInt((await connection().getTokenAccountBalance(ata)).value.amount);
            const raw = fraction >= 1 ? onChain : (onChain * BigInt(Math.round(fraction * 10_000))) / 10_000n;
            if (raw === 0n) throw new Error("Nothing to sell");
            const built = await buildSell(mint, kp.publicKey, raw, s.slippagePct);
            const ixs = [...built.instructions];
            if (raw === onChain) ixs.push(createCloseAccountInstruction(ata, kp.publicKey, kp.publicKey, [], program));
            return {
              walletId: p.walletId,
              wallet: p.walletName,
              leg: { kp, mint, instructions: ixs, hotAccounts: built.hotAccounts, emergency: false, label: `SELL ${Math.round(fraction * 100)}% ${p.symbol} (${p.walletName})` },
              record: (landed) => {
                const tokens = Number.isFinite(landed.tokensMoved) ? -landed.tokensMoved : Number(raw) / 10 ** decimals;
                const received = Number.isFinite(landed.solMoved) ? -landed.solMoved : Number(built.expectedOut) / LAMPORTS;
                return recordSell({
                  mode: "live", reason, walletId: p.walletId, walletName: p.walletName, mint: p.mint, symbol: p.symbol, venue: built.venue,
                  solAmount: received, tokenAmount: tokens, priceSol: received / tokens,
                  priorityFeeSol: landed.priorityFeeSol, jitoTipSol: landed.jitoTipSol, networkFeeSol: landed.networkFeeSol,
                  signature: landed.signature, bundleId: landed.bundleId, slot: landed.slot,
                });
              },
            };
          } catch (e) {
            results.push(legError(p.walletId, p.walletName, e));
            return null;
          }
        }),
      )
    ).filter((p): p is PreparedLeg => !!p);
    const bundles = await landPreparedAsBundles(prepared, label, req.mint, results);
    return summarize("sell", "protected", bundles, order(results, targets.map((p) => ({ id: p.walletId }))), label);
  } finally {
    for (const k of locked) busy.delete(k);
  }
}

/** Results in the preset's wallet order (they arrive in landing order). */
function order(results: GroupLegResult[], wallets: { id: string }[]) {
  const at = new Map(wallets.map((w, i) => [w.id, i]));
  return results.sort((a, b) => (at.get(a.walletId) ?? 0) - (at.get(b.walletId) ?? 0));
}
