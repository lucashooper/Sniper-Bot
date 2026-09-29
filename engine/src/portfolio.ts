import crypto from "node:crypto";
import { bus } from "./bus.js";
import type { Venue } from "./events.js";
import { loadJson, saveJson } from "./store.js";

export type TradeReason = "manual" | "auto_snipe" | "take_profit" | "stop_loss" | "anti_rug" | "panic";

export interface Trade {
  id: string;
  ts: number;
  mode: "sim" | "live";
  side: "buy" | "sell";
  reason: TradeReason;
  walletId: string;
  walletName: string;
  mint: string;
  symbol: string;
  venue: Venue;
  /** SOL spent (buy) or received (sell), excluding fees and tips. */
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  networkFeeSol: number;
  /** Sells only: proceeds - cost basis of the sold portion - this sell's fees. */
  realizedPnlSol: number;
  signature?: string;
  bundleId?: string;
}

export interface Position {
  key: string;
  walletId: string;
  walletName: string;
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  venue: Venue;
  mode: "sim" | "live";
  tokens: number;
  decimals: number;
  /** Remaining cost basis in SOL (includes buy fees and tips). */
  costSol: number;
  entryPriceSol: number;
  lastPriceSol: number;
  peakPriceSol: number;
  realizedPnlSol: number;
  firedRules: string[];
  openedAt: number;
  closedAt?: number;
}

interface State {
  trades: Trade[];
  open: Position[];
  closed: Position[];
}

const state: State = loadJson<State>("portfolio.json", { trades: [], open: [], closed: [] });
let saveTimer: NodeJS.Timeout | null = null;
const persistSoon = () => {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    saveJson("portfolio.json", state);
  }, 500);
};

export const posKey = (walletId: string, mint: string) => `${walletId}:${mint}`;
export const openPositions = () => state.open;
export const closedPositions = () => state.closed;
export const trades = () => state.trades;
export const findPosition = (key: string) => state.open.find((p) => p.key === key);
export const positionsForMint = (mint: string) => state.open.filter((p) => p.mint === mint);
export const heldMints = () => [...new Set(state.open.map((p) => p.mint))];

export function recordBuy(
  t: Omit<Trade, "id" | "ts" | "side" | "realizedPnlSol">,
  meta: { name: string; creator: string; decimals: number },
) {
  const trade: Trade = { ...t, id: crypto.randomUUID(), ts: Date.now(), side: "buy", realizedPnlSol: 0 };
  state.trades.push(trade);
  const cost = t.solAmount + t.priorityFeeSol + t.jitoTipSol + t.networkFeeSol;
  const key = posKey(t.walletId, t.mint);
  const p = findPosition(key);
  if (p) {
    p.tokens += t.tokenAmount;
    p.costSol += cost;
    p.entryPriceSol = p.costSol / p.tokens;
  } else {
    state.open.push({
      key,
      walletId: t.walletId,
      walletName: t.walletName,
      mint: t.mint,
      symbol: t.symbol,
      name: meta.name,
      creator: meta.creator,
      venue: t.venue,
      mode: t.mode,
      tokens: t.tokenAmount,
      decimals: meta.decimals,
      costSol: cost,
      entryPriceSol: cost / t.tokenAmount,
      lastPriceSol: t.priceSol,
      peakPriceSol: t.priceSol,
      realizedPnlSol: 0,
      firedRules: [],
      openedAt: Date.now(),
    });
  }
  persistSoon();
  bus.changed("trades");
  bus.changed("positions");
  return trade;
}

export function recordSell(t: Omit<Trade, "id" | "ts" | "side" | "realizedPnlSol">) {
  const p = findPosition(posKey(t.walletId, t.mint));
  const fraction = p && p.tokens > 0 ? Math.min(1, t.tokenAmount / p.tokens) : 1;
  const basis = p ? p.costSol * fraction : 0;
  const fees = t.priorityFeeSol + t.jitoTipSol + t.networkFeeSol;
  const realized = t.solAmount - basis - fees;
  const trade: Trade = { ...t, id: crypto.randomUUID(), ts: Date.now(), side: "sell", realizedPnlSol: realized };
  state.trades.push(trade);
  if (p) {
    p.tokens -= t.tokenAmount;
    p.costSol -= basis;
    p.realizedPnlSol += realized;
    // Dust left after rounding counts as closed.
    if (p.tokens <= 1e-6 || fraction >= 0.9999) {
      p.tokens = 0;
      p.closedAt = Date.now();
      state.open = state.open.filter((x) => x !== p);
      state.closed.push(p);
    }
  }
  persistSoon();
  bus.changed("trades");
  bus.changed("positions");
  return trade;
}

export function markPrice(mint: string, priceSol: number, venue?: Venue) {
  let touched = false;
  for (const p of state.open) {
    if (p.mint !== mint) continue;
    p.lastPriceSol = priceSol;
    p.peakPriceSol = Math.max(p.peakPriceSol, priceSol);
    if (venue) p.venue = venue;
    touched = true;
  }
  if (touched) persistSoon();
  return touched;
}

export function markRuleFired(key: string, ruleId: string) {
  const p = findPosition(key);
  if (p && !p.firedRules.includes(ruleId)) p.firedRules.push(ruleId);
  persistSoon();
}

export function metrics(mode?: "sim" | "live") {
  const ts = state.trades.filter((t) => !mode || t.mode === mode);
  const open = state.open.filter((p) => !mode || p.mode === mode);
  const closed = state.closed.filter((p) => !mode || p.mode === mode);
  const invested = ts.filter((t) => t.side === "buy").reduce((a, t) => a + t.solAmount + t.priorityFeeSol + t.jitoTipSol + t.networkFeeSol, 0);
  const value = open.reduce((a, p) => a + p.tokens * p.lastPriceSol, 0);
  const realized = ts.reduce((a, t) => a + t.realizedPnlSol, 0);
  const unrealized = open.reduce((a, p) => a + p.tokens * p.lastPriceSol - p.costSol, 0);
  const wins = closed.filter((p) => p.realizedPnlSol > 0).length;
  const tips = ts.reduce((a, t) => a + t.jitoTipSol, 0);
  const fees = ts.reduce((a, t) => a + t.priorityFeeSol + t.networkFeeSol, 0);
  return {
    totalInvestedSol: invested,
    portfolioValueSol: value,
    realizedPnlSol: realized,
    unrealizedPnlSol: unrealized,
    winRatePct: closed.length ? (wins / closed.length) * 100 : 0,
    closedCount: closed.length,
    openCount: open.length,
    tradeCount: ts.length,
    jitoTipsSol: tips,
    feesSol: fees,
  };
}

/** PnL series for charting: cumulative realized PnL after each sell. */
export function pnlSeries(mode?: "sim" | "live") {
  let acc = 0;
  return state.trades
    .filter((t) => (!mode || t.mode === mode) && t.side === "sell")
    .map((t) => ({ ts: t.ts, pnl: (acc += t.realizedPnlSol) }));
}

export function tradesCsv(): string {
  const cols: (keyof Trade)[] = [
    "ts", "mode", "side", "reason", "walletName", "mint", "symbol", "venue", "solAmount", "tokenAmount",
    "priceSol", "priorityFeeSol", "jitoTipSol", "networkFeeSol", "realizedPnlSol", "signature", "bundleId",
  ];
  const esc = (v: unknown) => {
    const s = v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = state.trades.map((t) =>
    cols.map((c) => (c === "ts" ? new Date(t.ts).toISOString() : esc(t[c]))).join(","),
  );
  return [cols.map((c) => (c === "ts" ? "time" : c)).join(","), ...rows].join("\n");
}

export function resetSimulation() {
  state.trades = state.trades.filter((t) => t.mode !== "sim");
  state.open = state.open.filter((p) => p.mode !== "sim");
  state.closed = state.closed.filter((p) => p.mode !== "sim");
  persistSoon();
  bus.changed("positions");
  bus.changed("trades");
}
