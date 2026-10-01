import { hasRpc } from "./config.js";
import { bus, log } from "./bus.js";
import { market, type MarketEvent } from "./events.js";
import { markPrice, markRuleFired, openPositions, positionsForMint, type Position } from "./portfolio.js";
import { venueState } from "./pump.js";
import { getSettings } from "./settings.js";
import { isSimMint } from "./sim.js";
import { PublicKey } from "@solana/web3.js";
import { executeBuy, executeSell, isLive, PAPER_WALLET } from "./trader.js";
import { listWallets } from "./wallets.js";
import { short } from "./solana.js";
import { trackPool, watchSupply } from "./stream.js";
import { addLaunch, applyTrade, getLaunch, hasSocials, loadMeta, markLaunch, markMigrated, onMetaSettled, setRetainer, type Launch } from "./feed.js";
import type { SnipeFilters } from "./settings.js";

const autoSnipeTimes: number[] = [];

function pickAutoWallet(): string {
  if (!isLive()) return PAPER_WALLET.id;
  const ws = listWallets().filter((w) => w.active);
  return (ws.find((w) => !w.isMaster) ?? ws[0])?.id ?? "";
}

export type FilterVerdict = { pass: true } | { pass: false; reason: string; final: boolean };

/**
 * Auto-snipe filters. A "final" failure can never clear (no socials in the metadata, the dev sold, the coin
 * graduated, the watch window ran out), so the launch is dropped. Anything else may still clear on a later trade
 * (market cap rising into range, the curve reaching the trigger), so the launch stays watched.
 */
export function evaluateFilters(l: Launch, f: SnipeFilters, keywords: string[], now = Date.now()): FilterVerdict {
  const fail = (reason: string, final = false): FilterVerdict => ({ pass: false, reason, final });
  const hay = `${l.name} ${l.symbol}`.toLowerCase();
  if (keywords.length && !keywords.some((k) => hay.includes(k.toLowerCase()))) return fail("no keyword match", true);
  if (l.migrated) return fail("already graduated to PumpSwap", true);
  if (f.maxWatchSec > 0 && now - l.ts > f.maxWatchSec * 1000) return fail(`not ready within ${f.maxWatchSec}s`, true);
  if (f.skipIfDevSold && l.devSold) return fail("dev wallet sold", true);
  if ((f.requireSocials || f.requireImage) && l.metaStatus === "pending") return fail("waiting for metadata");
  if (f.requireSocials && !hasSocials(l.meta)) return fail("no Twitter/Telegram/website", true);
  if (f.requireImage && !l.meta?.image) return fail("no image", true);
  if (f.maxDevHoldPct > 0 && l.devHoldPct > f.maxDevHoldPct) return fail(`dev holds ${l.devHoldPct.toFixed(1)}% > ${f.maxDevHoldPct}%`);
  if (f.curveTriggerPct > 0 && l.curvePct < f.curveTriggerPct) return fail(`curve ${l.curvePct.toFixed(0)}% < ${f.curveTriggerPct}%`);
  if (f.minMarketCapSol > 0 && l.marketCapSol < f.minMarketCapSol) return fail(`mc ${l.marketCapSol.toFixed(1)} < ${f.minMarketCapSol} SOL`);
  if (f.maxMarketCapSol > 0 && l.marketCapSol > f.maxMarketCapSol) return fail(`mc ${l.marketCapSol.toFixed(1)} > ${f.maxMarketCapSol} SOL`);
  if (f.minLiquiditySol > 0 && l.liquiditySol < f.minLiquiditySol) return fail(`liquidity ${l.liquiditySol.toFixed(2)} < ${f.minLiquiditySol} SOL`);
  return { pass: true };
}

/** Launches auto-snipe is still deciding on. */
const watching = new Set<string>();

function considerAutoSnipe(mint: string) {
  const s = getSettings();
  const l = getLaunch(mint);
  if (!l) return void watching.delete(mint);
  if (!watching.has(mint)) return;
  if (!s.autoSnipe) return void watching.delete(mint);
  const v = evaluateFilters(l, s.filters, s.autoSnipeKeywords);
  if (!v.pass) {
    if (v.final) {
      watching.delete(mint);
      markLaunch(mint, { skipped: v.reason });
      log.debug("detect", `Auto-snipe passed on ${l.symbol}: ${v.reason}`, { mint });
    }
    return;
  }
  watching.delete(mint);
  const hourAgo = Date.now() - 3_600_000;
  while (autoSnipeTimes.length && autoSnipeTimes[0] < hourAgo) autoSnipeTimes.shift();
  if (autoSnipeTimes.length >= s.autoSnipeMaxPerHour) {
    markLaunch(mint, { skipped: "hourly cap reached" });
    return log.debug("detect", `Auto-snipe skipped ${l.symbol}: hourly cap of ${s.autoSnipeMaxPerHour} reached`);
  }
  const walletId = pickAutoWallet();
  if (!walletId) return log.warn("trade", "Auto-snipe skipped: no active wallet");
  autoSnipeTimes.push(Date.now());
  markLaunch(mint, { sniped: true });
  const why = s.filters.curveTriggerPct > 0 ? ` at ${l.curvePct.toFixed(0)}% curve` : "";
  log.info("detect", `Auto-snipe ${l.symbol}: filters passed${why} (mc ${l.marketCapSol.toFixed(1)} SOL, dev ${l.devHoldPct.toFixed(1)}%)`, { mint });
  executeBuy({ mint, walletId, sol: s.autoSnipeSol, reason: "auto_snipe", meta: l }).catch((e) =>
    log.error("trade", `Auto-snipe ${l.symbol} failed: ${(e as Error).message}`, { mint }),
  );
}

function emergency(mint: string, why: string) {
  if (!getSettings().antiRug.enabled) return;
  for (const p of positionsForMint(mint)) {
    log.error("exit", `ANTI-RUG ${p.symbol}: ${why}. Emergency selling 100%`, { mint });
    executeSell(p.key, 100, "anti_rug", true).catch((e) => log.error("exit", `Emergency sell ${p.symbol} failed: ${(e as Error).message}`, { mint }));
  }
}

function checkExits(p: Position) {
  if (p.tokens <= 0 || p.costSol <= 0) return;
  const entry = p.costSol / p.tokens;
  const change = (p.lastPriceSol / entry - 1) * 100;
  const rules = getSettings().exitRules.filter((r) => r.enabled && !p.firedRules.includes(r.id));
  // Stop-losses first: when price gaps down we want out before any take-profit logic.
  for (const r of rules.sort((a, b) => (a.kind === "stop_loss" ? -1 : 1) - (b.kind === "stop_loss" ? -1 : 1) || a.triggerPct - b.triggerPct)) {
    const hit = r.kind === "take_profit" ? change >= r.triggerPct : change <= r.triggerPct;
    if (!hit) continue;
    markRuleFired(p.key, r.id);
    const label = r.kind === "take_profit" ? "Take-profit" : "Stop-loss";
    log.info("exit", `${label} ${r.triggerPct > 0 ? "+" : ""}${r.triggerPct}% hit on ${p.symbol} (now ${change >= 0 ? "+" : ""}${change.toFixed(1)}%), selling ${r.sellPct}%`, { mint: p.mint });
    executeSell(p.key, r.sellPct, r.kind).catch((e) => log.error("exit", `${label} sell ${p.symbol} failed: ${(e as Error).message}`, { mint: p.mint }));
    return; // one rule per tick; the next price update re-evaluates the rest
  }
}

function onEvent(e: MarketEvent) {
  const s = getSettings();
  switch (e.type) {
    case "launch": {
      const l = addLaunch(e);
      log.info("detect", `New Pump.fun launch ${e.symbol} (${e.name}) mc ${e.marketCapSol.toFixed(1)} SOL`, { mint: e.mint, signature: e.signature });
      if (!e.simulated) loadMeta(l);
      if (s.autoSnipe) {
        watching.add(l.mint);
        // The creator's own first buy is logged in the same transaction right after the create; wait for it so the
        // dev-holding filter sees it, and re-check once the metadata (socials, image) has loaded.
        const check = () => setTimeout(() => considerAutoSnipe(l.mint), 0);
        check();
        onMetaSettled(l.mint, check);
      }
      break;
    }
    case "trade": {
      if (applyTrade(e)) considerAutoSnipe(e.mint);
      if (!markPrice(e.mint, e.priceSol, e.venue)) break;
      bus.changed("positions");
      if (e.byCreator && !e.isBuy && s.antiRug.onCreatorSell) {
        emergency(e.mint, `creator ${short(e.trader)} sold ${e.solAmount.toFixed(2)} SOL worth`);
        break;
      }
      if (s.antiRug.crashPct > 0 && e.prevPriceSol && (1 - e.priceSol / e.prevPriceSol) * 100 >= s.antiRug.crashPct) {
        emergency(e.mint, `price fell ${((1 - e.priceSol / e.prevPriceSol) * 100).toFixed(0)}% in one trade`);
        break;
      }
      positionsForMint(e.mint).forEach(checkExits);
      break;
    }
    case "migration":
      markMigrated(e.mint);
      watching.delete(e.mint);
      if (positionsForMint(e.mint).length) {
        log.info("detect", `${short(e.mint)} graduated to PumpSwap; exits now route through the AMM pool`, { mint: e.mint, signature: e.signature });
        if (!isSimMint(e.mint)) trackPool(e.mint);
      }
      break;
    case "liquidity_removed":
      if (s.antiRug.onLiquidityRemoval) emergency(e.mint, `liquidity withdrawn from pool ${short(e.pool)}`);
      break;
    case "supply_increase":
      if (s.antiRug.onSupplyIncrease) emergency(e.mint, `mint supply increased ${e.before} → ${e.after}`);
      break;
  }
}

/** Fallback pricing for live positions in case the log stream misses trades (e.g. a dropped socket). */
async function pollLivePositions() {
  if (!hasRpc()) return;
  for (const p of openPositions()) {
    if (isSimMint(p.mint)) continue;
    try {
      const v = await venueState(new PublicKey(p.mint));
      markPrice(p.mint, v.priceSol, v.venue);
      if (v.venue === "pump_amm") trackPool(p.mint);
      checkExits(p);
    } catch {
      /* transient RPC error */
    }
  }
  bus.changed("positions");
}

export function startEngine() {
  market.subscribe(onEvent);
  // Held coins keep their chart and live stats after they scroll out of the launch feed.
  setRetainer((mint) => positionsForMint(mint).length > 0);
  // Quiet coins get no trades to re-check on; sweep so their watch window still expires.
  setInterval(() => watching.forEach((m) => considerAutoSnipe(m)), 5_000);
  if (hasRpc()) {
    setInterval(() => void pollLivePositions(), 5_000);
    // Keep supply watchers aligned with held live mints.
    const sync = () => {
      const live = new Set(openPositions().filter((p) => !isSimMint(p.mint)).map((p) => p.mint));
      live.forEach((m) => {
        try {
          watchSupply(m);
          trackPool(m);
        } catch {
          /* ignore */
        }
      });
    };
    bus.on("changed", (t) => t === "trades" && sync());
    sync();
  }
}
