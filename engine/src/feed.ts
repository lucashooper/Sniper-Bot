import { bus, log } from "./bus.js";

/**
 * Live state of recent Pump.fun launches for the dashboard's token feed and the auto-snipe filters:
 * metadata (image, socials), market cap, bonding-curve progress, liquidity, volume, buy/sell counts and how much of
 * the supply the dev wallet holds. Fed by the same MarketEvents as everything else (live stream or synthetic market).
 */

export interface TokenMeta {
  image?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface Launch {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  uri: string;
  ts: number;
  signature?: string;
  simulated: boolean;
  priceSol: number;
  marketCapSol: number;
  /** Market cap when the coin was created: where its chart starts. */
  launchMarketCapSol: number;
  athMarketCapSol: number;
  /** Bonding-curve completion, 0–100. Pump.fun graduates the coin to PumpSwap at 100. */
  curvePct: number;
  /** SOL actually deposited in the curve (real reserves): what a seller can get out. */
  liquiditySol: number;
  volumeSol: number;
  buys: number;
  sells: number;
  traders: number;
  /** Wallets holding at least one token, from the buys and sells seen since launch (transfers not counted). */
  holders: number;
  /** % of total supply the creator wallet holds, from its own buys and sells since launch. */
  devHoldPct: number;
  devSold: boolean;
  migrated: boolean;
  /** When the engine saw the coin graduate to PumpSwap. */
  migratedAt?: number;
  /** Market cap (SOL) after each of the last trades, oldest first, for the row sparkline. */
  spark: number[];
  meta: TokenMeta | null;
  metaStatus: "pending" | "ok" | "none";
  sniped?: boolean;
  /** Why auto-snipe passed on this coin, when it did. */
  skipped?: string;
}

/** Pump.fun curve constants: 1B supply (6 decimals), 793.1M of it sold on the curve before graduation. */
export const TOTAL_SUPPLY = 1_000_000_000;
export const CURVE_TOKENS = 793_100_000;
/**
 * Pulse columns, shared by the dashboard's three-column view, its list tabs and the feed's memory caps:
 * New pairs under STRETCH_PCT curve, Final stretch from STRETCH_PCT until graduation, Graduated once on PumpSwap.
 */
export const STRETCH_PCT = 40;
export type PulseBucket = "new" | "stretch" | "graduated";
export const pulseBucket = (l: Pick<Launch, "migrated" | "curvePct">): PulseBucket =>
  l.migrated ? "graduated" : l.curvePct >= STRETCH_PCT ? "stretch" : "new";
/**
 * Coins tracked per column. Coins are dropped oldest first within their own column, so a coin climbing the curve is
 * not pushed out by the flood of new launches behind it (Pump.fun sees ~150 launches in a few minutes).
 */
const KEEP: Record<PulseBucket, number> = { new: 150, stretch: 60, graduated: 40 };
/** Coins per column sent to the dashboard (it keeps the same caps when merging pushed updates). */
export const FEED_KEEP: Record<PulseBucket, number> = { new: 50, stretch: 30, graduated: 30 };
const SPARK_POINTS = 40;
/** Trades kept per coin for its chart and trade list. */
const MAX_TAPE = 3_000;
/** A coin opened on its own page stays tracked this long after the page last asked for it, even once it scrolls out of the feed. */
const VIEW_RETAIN_MS = 10 * 60_000;

/** One trade as the coin page shows it: chart candles are built from these. */
export interface TapeTrade {
  /** Increases by one per trade of this coin, so the page can ask for only what it has not seen yet. */
  seq: number;
  ts: number;
  priceSol: number;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  trader: string;
  byCreator: boolean;
  signature?: string;
}

const launches: Launch[] = [];
const byMint = new Map<string, Launch>();
const traders = new Map<string, Set<string>>();
const devTokens = new Map<string, number>();
const curveStart = new Map<string, number>();
const tapes = new Map<string, TapeTrade[]>();
const seqs = new Map<string, number>();
/** Net tokens bought per wallet, from the trades seen since launch. */
const holdings = new Map<string, Map<string, number>>();
const viewedAt = new Map<string, number>();
/** Coins that left the feed list but are still tracked because a page has them open or a position holds them. */
const kept = new Set<string>();
let retainExtra: (mint: string) => boolean = () => false;

/** Lets the engine keep coins it holds positions in tracked after they scroll out of the feed. */
export function setRetainer(fn: (mint: string) => boolean) {
  retainExtra = fn;
}

const retained = (mint: string, now = Date.now()) => now - (viewedAt.get(mint) ?? 0) < VIEW_RETAIN_MS || retainExtra(mint);

function forget(mint: string) {
  byMint.delete(mint);
  traders.delete(mint);
  devTokens.delete(mint);
  curveStart.delete(mint);
  tapes.delete(mint);
  seqs.delete(mint);
  holdings.delete(mint);
  viewedAt.delete(mint);
  kept.delete(mint);
}

export const recentLaunches = () => launches;

/** Newest first within a column; graduated coins by when they graduated. */
const bucketTime = (l: Launch) => (l.migrated ? (l.migratedAt ?? l.ts) : l.ts);

/** The newest `caps[b]` coins of each column, newest first overall. */
export function takePerBucket(list: Launch[], caps: Record<PulseBucket, number>): Launch[] {
  const sorted = [...list].sort((a, b) => bucketTime(b) - bucketTime(a));
  const count: Record<PulseBucket, number> = { new: 0, stretch: 0, graduated: 0 };
  const keep = new Set<Launch>();
  for (const l of sorted) {
    const b = pulseBucket(l);
    if (count[b]++ < caps[b]) keep.add(l);
  }
  return list.filter((l) => keep.has(l));
}

/** What the dashboard's feed shows: the newest coins of each Pulse column. */
export const feedList = () => takePerBucket(launches, FEED_KEEP);
export const getLaunch = (mint: string) => byMint.get(mint);
export const isTrackedLaunch = (mint: string) => byMint.has(mint);

/** Coins that changed since the last push to the dashboard. */
const dirty = new Set<string>();
/** How often changed coins are pushed to open dashboards: fast enough to feel live, slow enough to batch busy coins. */
export const PUSH_MS = 100;
let notifyTimer: NodeJS.Timeout | null = null;
function notify(mint: string) {
  dirty.add(mint);
  notifyTimer ??= setTimeout(() => {
    notifyTimer = null;
    bus.emit("feed");
  }, PUSH_MS);
}

/** The coins that changed since the last call, for the server's live push. */
export function takeDirty(): string[] {
  const out = [...dirty];
  dirty.clear();
  return out;
}

/** Trades of a coin newer than `after`, without touching how long the coin stays tracked. */
export function tapeSince(mint: string, after: number): TapeTrade[] {
  const tape = tapes.get(mint);
  if (!tape?.length || tape[tape.length - 1].seq <= after) return [];
  let i = tape.length;
  while (i > 0 && tape[i - 1].seq > after) i--;
  return tape.slice(i);
}

/** The coin's row and the sequence range of its tape, cheaply, for the live push. */
export function tapeBounds(mint: string) {
  const l = byMint.get(mint);
  if (!l) return null;
  const tape = tapes.get(mint) ?? [];
  return { launch: l, firstSeq: tape[0]?.seq ?? 0, lastSeq: seqs.get(mint) ?? 0 };
}

/** Marks a coin as open on a page, so it stays tracked after it scrolls out of the feed. */
export function touchView(mint: string) {
  if (byMint.has(mint)) viewedAt.set(mint, Date.now());
}

export function addLaunch(e: {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  priceSol: number;
  marketCapSol: number;
  ts: number;
  signature?: string;
  simulated: boolean;
  /** Tokens (UI units) still unsold on the curve at create; 793.1M for a standard coin. */
  curveTokens?: number;
}): Launch {
  const l: Launch = {
    mint: e.mint,
    name: e.name,
    symbol: e.symbol,
    creator: e.creator,
    uri: e.uri,
    ts: e.ts,
    signature: e.signature,
    simulated: e.simulated,
    priceSol: e.priceSol,
    marketCapSol: e.marketCapSol,
    launchMarketCapSol: e.marketCapSol,
    athMarketCapSol: e.marketCapSol,
    curvePct: 0,
    liquiditySol: 0,
    volumeSol: 0,
    buys: 0,
    sells: 0,
    traders: 0,
    holders: 0,
    devHoldPct: 0,
    devSold: false,
    migrated: false,
    spark: [e.marketCapSol],
    meta: null,
    // Synthetic coins get their metadata from the sim right after the launch event.
    metaStatus: e.uri || e.simulated ? "pending" : "none",
  };
  launches.unshift(l);
  byMint.set(l.mint, l);
  traders.set(l.mint, new Set());
  curveStart.set(l.mint, e.curveTokens && e.curveTokens > 0 ? e.curveTokens : CURVE_TOKENS);
  tapes.set(l.mint, []);
  holdings.set(l.mint, new Map());
  trim();
  notify(l.mint);
  return l;
}

/** Drops the oldest coins of any column over its cap; a coin still open on a page or held stays tracked. */
function trim(now = Date.now()) {
  if (launches.length > KEEP.new) {
    const keep = new Set(takePerBucket(launches, KEEP));
    for (let i = launches.length - 1; i >= 0; i--) {
      const old = launches[i];
      if (keep.has(old)) continue;
      launches.splice(i, 1);
      if (retained(old.mint, now)) kept.add(old.mint);
      else forget(old.mint);
    }
  }
  for (const m of kept) if (!retained(m, now)) forget(m);
}

export interface FeedTrade {
  mint: string;
  priceSol: number;
  isBuy: boolean;
  solAmount: number;
  /** UI units; when unknown, derived from solAmount / price. */
  tokenAmount?: number;
  trader: string;
  byCreator: boolean;
  /** Real (deposited) SOL in the curve after the trade, when the event carries it. */
  realSolReserves?: number;
  /** Real tokens left on the curve after the trade, when the event carries it. */
  realTokenReserves?: number;
  signature?: string;
}

export function applyTrade(t: FeedTrade): Launch | null {
  const l = byMint.get(t.mint);
  if (!l) return null;
  l.priceSol = t.priceSol;
  l.marketCapSol = t.priceSol * TOTAL_SUPPLY;
  l.athMarketCapSol = Math.max(l.athMarketCapSol, l.marketCapSol);
  l.volumeSol += t.solAmount;
  if (t.isBuy) l.buys++;
  else l.sells++;
  const set = traders.get(t.mint)!;
  set.add(t.trader);
  l.traders = set.size;
  if (t.realTokenReserves !== undefined) {
    const start = curveStart.get(t.mint) ?? CURVE_TOKENS;
    l.curvePct = clampPct((1 - t.realTokenReserves / start) * 100);
  }
  if (t.realSolReserves !== undefined) l.liquiditySol = t.realSolReserves;
  const tokens = t.tokenAmount ?? (t.priceSol > 0 ? t.solAmount / t.priceSol : 0);
  const seq = (seqs.get(t.mint) ?? 0) + 1;
  seqs.set(t.mint, seq);
  const tape = tapes.get(t.mint)!;
  tape.push({ seq, ts: Date.now(), priceSol: t.priceSol, isBuy: t.isBuy, solAmount: t.solAmount, tokenAmount: tokens, trader: t.trader, byCreator: t.byCreator, signature: t.signature });
  if (tape.length > MAX_TAPE) tape.splice(0, tape.length - MAX_TAPE);
  const hold = holdings.get(t.mint)!;
  const before = hold.get(t.trader) ?? 0;
  const net = Math.max(0, before + (t.isBuy ? tokens : -tokens));
  if (net > 0) hold.set(t.trader, net);
  else hold.delete(t.trader);
  // A holder is a wallet with at least one whole token, the same rule as the coin page's holder list.
  l.holders += (net >= 1 ? 1 : 0) - (before >= 1 ? 1 : 0);
  if (t.byCreator) {
    const held = Math.max(0, (devTokens.get(t.mint) ?? 0) + (t.isBuy ? tokens : -tokens));
    devTokens.set(t.mint, held);
    l.devHoldPct = (held / TOTAL_SUPPLY) * 100;
    if (!t.isBuy) l.devSold = true;
  }
  l.spark.push(l.marketCapSol);
  if (l.spark.length > SPARK_POINTS) l.spark.shift();
  notify(l.mint);
  return l;
}

export interface Holder {
  address: string;
  tokens: number;
  /** % of the 1B supply. */
  pct: number;
  isCreator: boolean;
}

/**
 * Everything the coin page needs. Holders are net buys minus sells per wallet from the trades seen since launch,
 * so wallet-to-wallet transfers are not counted. `after` returns only trades newer than that sequence number.
 */
export function tokenDetail(mint: string, after = 0) {
  const l = byMint.get(mint);
  if (!l) return null;
  viewedAt.set(mint, Date.now());
  const tape = tapes.get(mint) ?? [];
  const all = [...(holdings.get(mint) ?? new Map<string, number>())]
    .filter(([, t]) => t >= 1)
    .sort((a, b) => b[1] - a[1]);
  const holders: Holder[] = all.slice(0, 25).map(([address, tokens]) => ({ address, tokens, pct: (tokens / TOTAL_SUPPLY) * 100, isCreator: address === l.creator }));
  const top10Pct = all.slice(0, 10).reduce((s, [, t]) => s + t, 0) / TOTAL_SUPPLY * 100;
  return {
    launch: l,
    trades: after > 0 ? tape.filter((t) => t.seq > after) : tape,
    /** Lets the page tell a trimmed or restarted tape from a gap and reload in full. */
    firstSeq: tape[0]?.seq ?? 0,
    lastSeq: seqs.get(mint) ?? 0,
    holders,
    holderCount: all.length,
    top10Pct,
  };
}

export function markMigrated(mint: string) {
  const l = byMint.get(mint);
  if (!l) return;
  if (!l.migrated) l.migratedAt = Date.now();
  l.migrated = true;
  l.curvePct = 100;
  notify(mint);
}

export function markLaunch(mint: string, patch: Partial<Pick<Launch, "sniped" | "skipped">>) {
  const l = byMint.get(mint);
  if (!l) return;
  Object.assign(l, patch);
  notify(mint);
}

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/* ---------------------------------------------------------------- metadata */

/** Rewrites ipfs:// links to a public gateway; drops anything that is not plain http(s). */
export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let u = raw.trim();
  if (u.startsWith("ipfs://")) u = `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, "")}`;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Social handles in Pump.fun metadata are sometimes bare ("@coin", "t.me/coin"); normalise them to links. */
function socialUrl(raw: unknown, host: string): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return safeUrl(v);
  if (v.includes(".")) return safeUrl(`https://${v.replace(/^\/+/, "")}`);
  return safeUrl(`https://${host}/${v.replace(/^@/, "")}`);
}

export function parseMeta(json: unknown): TokenMeta {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const ext = (j.extensions && typeof j.extensions === "object" ? j.extensions : {}) as Record<string, unknown>;
  const meta: TokenMeta = {
    image: safeUrl(j.image),
    description: typeof j.description === "string" ? j.description.slice(0, 280) : undefined,
    twitter: socialUrl(j.twitter ?? ext.twitter, "x.com"),
    telegram: socialUrl(j.telegram ?? ext.telegram, "t.me"),
    website: safeUrl(j.website ?? ext.website),
  };
  return meta;
}

export const hasSocials = (m: TokenMeta | null) => !!(m && (m.twitter || m.telegram || m.website));

const metaWaiters = new Map<string, Array<() => void>>();
let inflight = 0;
const queue: Launch[] = [];
const MAX_INFLIGHT = 6;
const MAX_QUEUE = 50;

/** Fetches the coin's metadata JSON (IPFS) in the background; resolves the launch's metaStatus either way. */
export function loadMeta(l: Launch, fetcher: (url: string) => Promise<unknown> = fetchJson) {
  if (l.metaStatus !== "pending") return;
  if (inflight >= MAX_INFLIGHT) {
    queue.push(l);
    // Launch bursts: keep the newest coins, give up on the oldest queued ones.
    while (queue.length > MAX_QUEUE) settleMeta(queue.shift()!, null);
    return;
  }
  inflight++;
  const url = safeUrl(l.uri);
  (url ? fetcher(url) : Promise.reject(new Error("no uri")))
    .then((json) => settleMeta(l, parseMeta(json)))
    .catch((e) => {
      log.debug("detect", `Metadata for ${l.symbol} unavailable: ${(e as Error).message}`, { mint: l.mint });
      settleMeta(l, null);
    })
    .finally(() => {
      inflight--;
      const next = queue.pop();
      if (next) loadMeta(next, fetcher);
    });
}

function settleMeta(l: Launch, meta: TokenMeta | null) {
  l.meta = meta;
  l.metaStatus = meta ? "ok" : "none";
  notify(l.mint);
  metaWaiters.get(l.mint)?.forEach((fn) => fn());
  metaWaiters.delete(l.mint);
}

export function onMetaSettled(mint: string, fn: () => void) {
  const l = byMint.get(mint);
  if (!l || l.metaStatus !== "pending") return fn();
  metaWaiters.set(mint, [...(metaWaiters.get(mint) ?? []), fn]);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 64_000) throw new Error("metadata too large");
  return JSON.parse(text);
}

/** Simulation: give synthetic coins metadata without a network call. */
export function setMeta(mint: string, meta: TokenMeta | null) {
  const l = byMint.get(mint);
  if (l) settleMeta(l, meta);
}

/** Test hook. */
export function _resetFeed() {
  launches.length = 0;
  byMint.clear();
  traders.clear();
  devTokens.clear();
  curveStart.clear();
  tapes.clear();
  seqs.clear();
  holdings.clear();
  viewedAt.clear();
  kept.clear();
  dirty.clear();
  queue.length = 0;
}

/* ---------------------------------------------------------------- SOL price */

let solUsdCache: { v: number | null; at: number } = { v: null, at: 0 };
/** SOL/USD spot for showing market caps in dollars like Pump.fun and Axiom do. Cached for a minute; null if unreachable. */
export function solUsd(): number | null {
  if (Date.now() - solUsdCache.at > 60_000) {
    solUsdCache.at = Date.now();
    fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(4_000) })
      .then((r) => r.json() as Promise<{ data?: { amount?: string } }>)
      .then((j) => {
        const n = Number(j.data?.amount);
        if (Number.isFinite(n) && n > 0) solUsdCache = { v: n, at: Date.now() };
      })
      .catch(() => {});
  }
  return solUsdCache.v;
}
