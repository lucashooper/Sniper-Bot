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

export interface Launch {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  priceSol: number;
  marketCapSol: number;
  ts: number;
  signature?: string;
  simulated: boolean;
  sniped?: boolean;
}

const launches: Launch[] = [];
export const recentLaunches = () => launches;
const autoSnipeTimes: number[] = [];

function pickAutoWallet(): string {
  if (!isLive()) return PAPER_WALLET.id;
  const ws = listWallets().filter((w) => w.active);
  return (ws.find((w) => !w.isMaster) ?? ws[0])?.id ?? "";
}

async function maybeAutoSnipe(l: Launch) {
  const s = getSettings();
  if (!s.autoSnipe) return;
  const hay = `${l.name} ${l.symbol}`.toLowerCase();
  if (s.autoSnipeKeywords.length && !s.autoSnipeKeywords.some((k) => hay.includes(k.toLowerCase()))) return;
  const hourAgo = Date.now() - 3_600_000;
  while (autoSnipeTimes.length && autoSnipeTimes[0] < hourAgo) autoSnipeTimes.shift();
  if (autoSnipeTimes.length >= s.autoSnipeMaxPerHour) {
    log.debug("detect", `Auto-snipe skipped ${l.symbol}: hourly cap of ${s.autoSnipeMaxPerHour} reached`);
    return;
  }
  const walletId = pickAutoWallet();
  if (!walletId) return log.warn("trade", "Auto-snipe skipped: no active wallet");
  autoSnipeTimes.push(Date.now());
  l.sniped = true;
  try {
    await executeBuy({ mint: l.mint, walletId, sol: s.autoSnipeSol, reason: "auto_snipe", meta: l });
  } catch (e) {
    log.error("trade", `Auto-snipe ${l.symbol} failed: ${(e as Error).message}`, { mint: l.mint });
  }
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
      const l: Launch = { ...e };
      launches.unshift(l);
      if (launches.length > 100) launches.pop();
      log.info("detect", `New Pump.fun launch ${e.symbol} (${e.name}) mc ${e.marketCapSol.toFixed(1)} SOL`, { mint: e.mint, signature: e.signature });
      bus.changed("launches");
      void maybeAutoSnipe(l);
      break;
    }
    case "trade": {
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
