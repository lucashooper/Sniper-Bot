"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Crown, ExternalLink, Flame, Search, ShieldAlert, Users, Zap } from "lucide-react";
import { api, useEngine, type ApiError } from "@/lib/engine";
import { takePrefetched } from "@/lib/token-cache";
import { accountUrl, coinPage, compact, pct, short, solscan, time } from "@/lib/format";
import type { GroupTradeResult, Launch, Position, SellAllResult, TapeTrade, TokenDetail, Trade } from "@/lib/types";
import { Avatar, CopyCa, CurveBar, Socials, age, defaultWalletId, money, useNow } from "@/components/token-feed";
import { INTERVALS, TokenChart, type ChartUnit } from "@/components/token-chart";
import { Badge, Button, Card, Empty, cx } from "@/components/ui";
import { buyToast, sellToast, useTradeToasts } from "@/components/trade-toasts";
import { PRESET_PREFIX, WalletOptions } from "@/components/wallet-picker";
import { DevChip } from "@/components/devs";

export default function TokenPage() {
  return (
    <Suspense fallback={null}>
      <TokenRoute />
    </Suspense>
  );
}

function TokenRoute() {
  const mint = useSearchParams().get("mint")?.trim() ?? "";
  return mint ? <TokenView key={mint} mint={mint} /> : <OpenByAddress />;
}

/* ---------------------------------------------------------------- data */

type Tracked = Extract<TokenDetail, { tracked: true }>;

/**
 * The coin's detail from the engine. Newer engines push each new trade over the live connection the moment it
 * happens; the full detail (holders) is re-fetched at most every few seconds. Older engines get a re-fetch per feed
 * tick. After the first load only trades the page has not seen are fetched (by sequence number).
 */
function useTokenDetail(mint: string) {
  const { feedVersion, connected, push, watchTape, state } = useEngine();
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const [pushedLaunch, setPushedLaunch] = useState<Launch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const inflight = useRef(false);
  const again = useRef(false);

  /** Appends trades the page does not have yet; false when there is a gap (the page must reload the tape). */
  const append = useCallback((incoming: TapeTrade[]) => {
    const fresh = incoming.filter((t) => t.seq > last.current);
    if (!fresh.length) return true;
    if (fresh[0].seq > last.current + 1) return false;
    last.current = fresh[fresh.length - 1].seq;
    setTrades((t) => {
      const next = t.concat(fresh);
      return next.length > 3000 ? next.slice(-3000) : next;
    });
    return true;
  }, []);

  const load = useCallback(async () => {
    if (inflight.current) return void (again.current = true);
    inflight.current = true;
    try {
      const d = await ((!last.current && takePrefetched(mint)) || api<TokenDetail>(`/api/token/${encodeURIComponent(mint)}${last.current ? `?after=${last.current}` : ""}`));
      setError(null);
      if (!d.tracked) {
        last.current = 0;
        setTrades([]);
      } else if (!last.current || d.lastSeq < last.current || d.firstSeq > last.current + 1) {
        // First load, or the engine restarted / trimmed past what we hold: take the full tape.
        if (last.current) {
          last.current = 0;
          again.current = true;
        } else {
          setTrades(d.trades);
          last.current = d.lastSeq;
        }
      } else append(d.trades);
      setDetail(d);
      if (d.tracked) setPushedLaunch(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [mint, append]);

  const tracked = !!detail?.tracked;
  // Live trades over the socket. Holders and counts change with every trade, so re-fetch the detail now and then too.
  const lastFull = useRef(0);
  useEffect(() => {
    if (!push || !connected || !tracked) return;
    return watchTape(
      mint,
      () => last.current,
      (p) => {
        if (p.launch) setPushedLaunch(p.launch);
        if (p.lastSeq < last.current || !append(p.trades)) {
          last.current = 0;
          return void load();
        }
        if (p.trades.length && Date.now() - lastFull.current > 3000) {
          lastFull.current = Date.now();
          void load();
        }
      },
    );
  }, [push, connected, tracked, mint, watchTape, append, load]);

  useEffect(() => {
    if (connected) void load();
    // A pushing engine sends trades itself; only older ones need a re-fetch per feed tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push ? 0 : feedVersion, connected, load]);
  // The engine forgets a coin nobody has open after a while; asking now and then keeps it tracked while the page is up.
  useEffect(() => {
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  // The newest numbers for the header: the feed's copy (pushed ~10x a second) beats the last full fetch.
  const feedLaunch = state?.launches.find((l) => l.mint === mint);
  const merged = useMemo((): TokenDetail | null => {
    // Before the engine answers, show the feed's copy of the coin so the page paints at once.
    if (!detail) return feedLaunch ? { tracked: true, launch: feedLaunch, trades: [], firstSeq: 0, lastSeq: 0, holders: [], holderCount: 0, top10Pct: 0, solUsd: state?.solUsd ?? null } : null;
    if (!detail.tracked) return detail;
    // Trade counts only grow, so the copy with the most trades is the newest.
    const n = (l: Launch) => l.buys + l.sells;
    const fresh = [feedLaunch, pushedLaunch].reduce<Launch>((best, l) => (l && n(l) > n(best) ? l : best), detail.launch);
    return fresh === detail.launch ? detail : { ...detail, launch: fresh };
  }, [detail, feedLaunch, pushedLaunch]);

  return { detail: merged, trades, error };
}

/** Your own fills on this coin, for chart markers and the "Your trades" tab. */
function useFills(mint: string) {
  const { tradesVersion, connected } = useEngine();
  const [fills, setFills] = useState<Trade[]>([]);
  useEffect(() => {
    if (!connected) return;
    api<Trade[]>("/api/trades").then((all) => setFills(all.filter((t) => t.mint === mint)), () => {});
  }, [mint, tradesVersion, connected]);
  return fills;
}

/* ---------------------------------------------------------------- page */

function TokenView({ mint }: { mint: string }) {
  const { state } = useEngine();
  const { detail, trades, error } = useTokenDetail(mint);
  const fills = useFills(mint);
  const now = useNow();
  const positions = useMemo(() => (state?.positions ?? []).filter((p) => p.mint === mint), [state?.positions, mint]);

  const solUsd = detail?.solUsd ?? state?.solUsd ?? null;
  const value = (sol: number) => (solUsd ? money(sol * solUsd) : `${money(sol, "")} SOL`);
  const tracked = detail?.tracked ? (detail as Tracked) : null;
  const l = tracked?.launch;
  const symbol = l?.symbol ?? positions[0]?.symbol ?? short(mint);
  const name = l?.name ?? positions[0]?.name ?? "";
  // The newest price: the last trade pushed for this coin, else the feed's copy, else what the position last saw.
  const lastPrice = trades[trades.length - 1]?.priceSol ?? l?.priceSol ?? positions[0]?.lastPriceSol ?? 0;
  const simulated = l?.simulated ?? positions[0]?.mode === "sim";

  // Change over the last 5 minutes of trades, like Axiom's header.
  const change5m = useMemo(() => {
    if (!trades.length) return null;
    const cutoff = now - 300_000;
    const base = trades.find((t) => t.ts >= cutoff) ?? trades[trades.length - 1];
    const ref = trades.indexOf(base) > 0 ? trades[trades.indexOf(base) - 1].priceSol : base.priceSol;
    return ref ? (trades[trades.length - 1].priceSol / ref - 1) * 100 : null;
  }, [trades, now]);

  if (!state) return null;
  if (!detail && !error) return <div className="py-24 text-center text-sm text-neutral-500">Loading {short(mint)}…</div>;

  return (
    <div className="space-y-3">
      {/* Header: identity and headline numbers */}
      <div className="glass flex flex-wrap items-center gap-x-7 gap-y-3 rounded-xl border border-white/[0.06] bg-ink-900/70 px-3 py-2.5">
        <Link href="/feed" className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition hover:bg-white/[0.06] hover:text-neutral-100" title="Back to the feed">
          <ArrowLeft size={16} />
        </Link>
        <div className="flex min-w-0 items-center gap-3">
          {l ? <Avatar l={l} size={44} /> : <div className="grid h-11 w-11 place-items-center rounded-md bg-ink-800 text-xs font-bold ring-1 ring-white/[0.06]">{symbol.slice(0, 2)}</div>}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold tracking-tight">{symbol}</span>
              <span className="max-w-[180px] truncate text-sm text-neutral-500">{name}</span>
              <CopyCa mint={mint} />
            </div>
            <div className="mt-0.5 flex items-center gap-2.5 text-xs">
              {l && <span className="font-medium text-emerald-400">{age(l.ts, now)}</span>}
              {l && <Socials l={l} />}
              {l && <DevChip address={l.creator} prefix="dev" />}
              {l?.migrated && <Badge tone="amber">PumpSwap</Badge>}
              {simulated && <Badge>sim</Badge>}
              {!tracked && <Badge>not in feed</Badge>}
            </div>
          </div>
        </div>
        {l && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <div className="text-xl font-semibold tracking-tight text-neutral-50">
                <span key={l.marketCapSol} className={change5m !== null && change5m < 0 ? "tick-down" : "tick-up"}>{value(l.marketCapSol)}</span>
              </div>
              {change5m !== null && <div className={cx("text-[11px]", change5m >= 0 ? "text-emerald-400" : "text-rose-400")}>{pct(change5m)} 5m</div>}
            </div>
            <HeadStat label="Price" value={solUsd ? `$${(l.priceSol * solUsd).toPrecision(3)}` : `${l.priceSol.toPrecision(3)} SOL`} />
            <HeadStat label="Liquidity" value={value(l.liquiditySol)} />
            <HeadStat label="Volume" value={value(l.volumeSol)} />
            <HeadStat label="B.Curve" value={`${l.curvePct.toFixed(1)}%`} tone={l.curvePct >= 80 ? "good" : undefined} />
            <HeadStat label="ATH" value={value(l.athMarketCapSol)} />
          </div>
        )}
        {positions.length > 0 && <HeadPosition positions={positions} priceSol={lastPrice} solUsd={solUsd} />}
      </div>

      {/* On phones the trade panel sits right under the chart; on wide screens it is the right-hand column. */}
      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <ChartCard mint={mint} tracked={tracked} trades={trades} fills={fills} solUsd={solUsd} simulated={simulated} />
        </div>
        <div className="space-y-3 xl:row-span-2">
          <TradePanel mint={mint} symbol={symbol} priceSol={lastPrice} positions={positions} migrated={!!l?.migrated} solUsd={solUsd} />
          {tracked && <TokenInfo d={tracked} />}
          {error && <p className="text-xs text-rose-300">{error}</p>}
        </div>
        <div className="min-w-0 xl:col-start-1">
          <BottomTabs tracked={tracked} trades={trades} fills={fills} value={value} />
        </div>
      </div>
    </div>
  );
}

/** Your position in the top bar: what it is worth now and the unrealized PnL, live. */
function HeadPosition({ positions, priceSol, solUsd }: { positions: Position[]; priceSol: number; solUsd: number | null }) {
  const s = positionStats(positions, priceSol);
  const good = s.pnl >= 0;
  return (
    <div className={cx("ml-auto rounded-lg border px-3 py-1.5", good ? "border-emerald-500/20 bg-emerald-500/[0.06]" : "border-rose-500/20 bg-rose-500/[0.06]")}>
      <div className="text-[11px] text-neutral-500">Your position{positions.length > 1 ? ` · ${positions.length} wallets` : ""}</div>
      <div className="flex items-baseline gap-2 tabular-nums">
        <span className="text-[13px] font-semibold text-neutral-100">{solUsd ? money(s.worth * solUsd) : `${s.worth.toFixed(4)} SOL`}</span>
        <span className={cx("text-[12px] font-semibold", good ? "text-emerald-400" : "text-rose-400")}>
          {pct(s.pnlPct, 2)} ({solUsd ? `${good ? "+" : "-"}$${Math.abs(s.pnl * solUsd).toFixed(2)}` : `${good ? "+" : ""}${s.pnl.toFixed(4)} SOL`})
        </span>
      </div>
    </div>
  );
}

function HeadStat({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div>
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className={cx("text-[13px] font-medium", tone === "good" ? "text-emerald-400" : "text-neutral-200")}>{value}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- chart */

function ChartCard({ mint, tracked, trades, fills, solUsd, simulated }: { mint: string; tracked: Tracked | null; trades: TapeTrade[]; fills: Trade[]; solUsd: number | null; simulated: boolean }) {
  const [interval, setIntervalSec] = useState(5);
  const [unit, setUnit] = useState<ChartUnit>("mcap");
  // The engine stops seeing a coin's trades once it graduates (unless you hold it), and has none for coins it never
  // tracked; DexScreener covers those. Simulated coins only exist inside the engine.
  const preferDex = !simulated && (!tracked || (tracked.launch.migrated && trades.length < 2));
  const [source, setSource] = useState<"bot" | "dex" | null>(null);
  const src = source ?? (preferDex ? "dex" : "bot");

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.05] px-2.5 py-1.5 text-xs">
        <div className="flex rounded-md bg-white/[0.03] p-0.5">
          <Seg on={src === "bot"} onClick={() => setSource("bot")} disabled={!tracked}>Live</Seg>
          <Seg on={src === "dex"} onClick={() => setSource("dex")} disabled={simulated}>DexScreener</Seg>
        </div>
        {src === "bot" && (
          <>
            <div className="flex rounded-md bg-white/[0.03] p-0.5">
              {INTERVALS.map((i) => (
                <Seg key={i.sec} on={interval === i.sec} onClick={() => setIntervalSec(i.sec)}>{i.label}</Seg>
              ))}
            </div>
            <div className="flex rounded-md bg-white/[0.03] p-0.5">
              <Seg on={unit === "mcap"} onClick={() => setUnit("mcap")}>MarketCap</Seg>
              <Seg on={unit === "price"} onClick={() => setUnit("price")}>Price</Seg>
            </div>
            <span className="ml-auto flex items-center gap-1.5 text-neutral-500">
              <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              {unit === "mcap" && solUsd ? "USD" : "SOL"} · {trades.length} trades
            </span>
          </>
        )}
      </div>
      <div className="h-[440px]">
        {src === "dex" ? (
          <iframe
            title="DexScreener chart"
            src={`https://dexscreener.com/solana/${mint}?embed=1&theme=dark&trades=0&info=0`}
            className="h-full w-full border-0"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        ) : tracked ? (
          <TokenChart
            trades={trades}
            intervalSec={interval}
            unit={unit}
            solUsd={solUsd}
            creator={tracked.launch.creator}
            startPriceSol={tracked.launch.launchMarketCapSol / 1_000_000_000}
            startTs={tracked.launch.ts}
            fills={fills}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-neutral-500">No live trades for this coin.</div>
        )}
      </div>
    </Card>
  );
}

function Seg({ on, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { on: boolean }) {
  return (
    <button {...p} className={cx("rounded px-2 py-1 font-medium transition disabled:opacity-30", on ? "bg-white/[0.08] text-white" : "text-neutral-500 hover:text-neutral-200")}>
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- trades / holders */

function BottomTabs({ tracked, trades, fills, value }: { tracked: Tracked | null; trades: TapeTrade[]; fills: Trade[]; value: (sol: number) => string }) {
  const [tab, setTab] = useState<"trades" | "holders" | "mine">("trades");
  const recent = useMemo(() => trades.slice(-80).reverse(), [trades]);
  const creator = tracked?.launch.creator;
  const tabs = [
    { id: "trades", label: "Trades" },
    { id: "holders", label: `Holders${tracked ? ` (${tracked.holderCount})` : ""}` },
    { id: "mine", label: `Your trades${fills.length ? ` (${fills.length})` : ""}` },
  ] as const;
  return (
    <Card>
      <div className="flex gap-4 border-b border-white/[0.05] px-4 py-2.5">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx("whitespace-nowrap text-[13px] font-medium transition", tab === t.id ? "text-white" : "text-neutral-500 hover:text-neutral-200")}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="max-h-[360px] overflow-auto scrollbar-thin">
        {tab === "trades" &&
          (recent.length ? (
            <Table head={["Age", "Type", "MC", "SOL", "Tokens", "Trader"]}>
              {recent.map((t) => (
                <tr key={t.seq} className="text-xs">
                  <td className="px-4 py-1.5 text-neutral-500">{time(t.ts)}</td>
                  <td className={cx("px-3 py-1.5 font-semibold", t.isBuy ? "text-emerald-400" : "text-rose-400")}>{t.isBuy ? "Buy" : "Sell"}</td>
                  <td className="px-3 py-1.5 text-neutral-300">{value(t.priceSol * 1_000_000_000)}</td>
                  <td className={cx("px-3 py-1.5", t.isBuy ? "text-emerald-300" : "text-rose-300")}>{t.solAmount.toFixed(3)}</td>
                  <td className="px-3 py-1.5 text-neutral-400">{compact(t.tokenAmount)}</td>
                  <td className="px-3 py-1.5">
                    <Addr a={t.trader} dev={t.trader === creator} sig={t.signature} />
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty icon={<Zap size={18} />} title="No trades yet">Trades on this coin stream in here as they happen.</Empty>
          ))}
        {tab === "holders" &&
          (tracked?.holders.length ? (
            <>
              <Table head={["#", "Wallet", "Tokens", "% supply"]}>
                {tracked.holders.map((h, i) => (
                  <tr key={h.address} className="text-xs">
                    <td className="px-4 py-1.5 text-neutral-600">{i + 1}</td>
                    <td className="px-3 py-1.5"><Addr a={h.address} dev={h.isCreator} /></td>
                    <td className="px-3 py-1.5 text-neutral-300">{compact(h.tokens)}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-white/[0.06]">
                          <div className={cx("h-full", h.isCreator ? "bg-amber-400" : "bg-emerald-400/70")} style={{ width: `${Math.min(100, h.pct * 5)}%` }} />
                        </div>
                        <span className="text-neutral-300">{h.pct.toFixed(2)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
              <p className="border-t border-white/[0.06] px-4 py-2 text-[11px] text-neutral-600">Built from buys and sells the bot saw since launch; tokens moved wallet to wallet are not counted. The bonding curve itself is not listed.</p>
            </>
          ) : (
            <Empty icon={<Users size={18} />} title="No holders seen">{tracked ? "Nobody has bought since the bot started watching this coin." : "The bot has no trade history for this coin."}</Empty>
          ))}
        {tab === "mine" &&
          (fills.length ? (
            <Table head={["Time", "Side", "SOL", "Tokens", "Wallet", "Tx"]}>
              {fills.map((f) => (
                <tr key={f.id} className="text-xs">
                  <td className="px-4 py-1.5 text-neutral-500">{time(f.ts)}</td>
                  <td className={cx("px-3 py-1.5 font-semibold", f.side === "buy" ? "text-emerald-400" : "text-rose-400")}>
                    {f.side} {f.mode === "sim" && <span className="font-normal text-violet-300">sim</span>}
                  </td>
                  <td className="px-3 py-1.5 text-neutral-200">{f.solAmount.toFixed(4)}</td>
                  <td className="px-3 py-1.5 text-neutral-400">{compact(f.tokenAmount)}</td>
                  <td className="px-3 py-1.5 font-sans text-neutral-400">{f.walletName}</td>
                  <td className="px-3 py-1.5">
                    {f.signature ? (
                      <a href={solscan(f.signature)} target="_blank" rel="noopener noreferrer" className="text-violet-300 hover:underline">{short(f.signature)}</a>
                    ) : (
                      <span className="text-neutral-600">paper</span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty icon={<Zap size={18} />} title="No trades on this coin">Your buys and sells here are marked B and S on the chart.</Empty>
          ))}
      </div>
    </Card>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full min-w-[520px]">
      <thead className="frost sticky top-0 bg-ink-900/85">
        <tr className="text-left text-[11px] font-medium text-neutral-500">
          {head.map((h, i) => (
            <th key={h} className={cx("py-2", i === 0 ? "px-4" : "px-3")}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-white/[0.04]">{children}</tbody>
    </table>
  );
}

function Addr({ a, dev, sig }: { a: string; dev?: boolean; sig?: string }) {
  const real = !a.startsWith("sim-");
  return (
    <span className="inline-flex items-center gap-1.5">
      {/* The wallet's label when it has one; click to label it. */}
      <DevChip address={a} className="font-sans" />
      {dev && (
        <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] font-sans font-semibold text-amber-300" title="Coin creator">
          <Crown size={9} /> DEV
        </span>
      )}
      {real && !sig && (
        <a href={accountUrl(a)} target="_blank" rel="noopener noreferrer" className="text-neutral-600 hover:text-neutral-300" title="View wallet on Solscan">
          <ExternalLink size={10} />
        </a>
      )}
      {sig && (
        <a href={solscan(sig)} target="_blank" rel="noopener noreferrer" className="text-neutral-600 hover:text-neutral-300" title="View transaction">
          <ExternalLink size={10} />
        </a>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- trade panel */

/** Totals for your open positions in this coin, valued at the newest trade price (moves on every pushed trade). */
function positionStats(positions: Position[], priceSol: number) {
  const tokens = positions.reduce((s, p) => s + p.tokens, 0);
  const cost = positions.reduce((s, p) => s + p.costSol, 0);
  const worth = positions.reduce((s, p) => s + p.tokens * (priceSol || p.lastPriceSol), 0);
  const realized = positions.reduce((s, p) => s + p.realizedPnlSol, 0);
  const pnl = worth - cost;
  return { tokens, cost, worth, realized, pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0 };
}

type SellUnit = "tokens" | "sol";
type FailedLeg = { wallet: string; error: string; solscan?: string };

function TradePanel({ mint, symbol, priceSol, positions, migrated, solUsd }: { mint: string; symbol: string; priceSol: number; positions: Position[]; migrated: boolean; solUsd: number | null }) {
  const { state } = useEngine();
  const toast = useTradeToasts();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [walletId, setWalletId] = useState("");
  // Sell amount: what is typed (tokens or SOL), or the exact percentage of a pill that filled it.
  const [sellText, setSellText] = useState("");
  const [sellUnit, setSellUnit] = useState<SellUnit>("tokens");
  const [sellPct, setSellPct] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [since, setSince] = useState(0);
  const [lastError, setLastError] = useState<{ message: string; solscan?: string; legs?: FailedLeg[] } | null>(null);
  if (!state) return null;
  const live = state.status.live;
  const presets = state.settings.quickBuyPresets ?? [0.1, 0.5, 1];
  const wallets = state.wallets.filter((w) => w.active);
  const picked = walletId || defaultWalletId(state);
  const preset = picked.startsWith(PRESET_PREFIX) ? (state.groups ?? []).find((g) => g.id === picked.slice(PRESET_PREFIX.length)) : undefined;
  // A preset that was deleted meanwhile falls back to the default wallet.
  const chosen = picked.startsWith(PRESET_PREFIX) && !preset ? defaultWalletId(state) : picked;
  const presetWallets = preset ? wallets.filter((w) => preset.walletIds.includes(w.id)) : [];
  const sol = Number(amount);
  const walletSol = preset ? presetWallets.reduce((s, w) => s + (state.balances[w.id]?.sol ?? 0), 0) : chosen ? state.balances[chosen]?.sol : undefined;
  // What a sell acts on: every holding wallet of the preset, or the chosen wallet's position (or the only one you have).
  const single = preset ? undefined : (positions.find((p) => p.walletId === (chosen || "paper")) ?? (positions.length === 1 ? positions[0] : undefined));
  const sellFrom = preset ? positions.filter((p) => preset.walletIds.includes(p.walletId)) : single ? [single] : [];
  const holdTokens = sellFrom.reduce((s, p) => s + p.tokens, 0);
  const holdSol = holdTokens * priceSol;

  // The sell as a percentage of what is held: exact for a pill, worked out from the typed tokens or SOL otherwise.
  const typed = Number(sellText);
  const rawPct = sellPct ?? (typed > 0 && holdTokens > 0 ? (sellUnit === "tokens" ? typed / holdTokens : priceSol > 0 ? typed / holdSol : 0) * 100 : 0);
  const tooMuch = sellPct === null && rawPct > 100.01;
  // Within a hair of everything means everything, so the token account is closed and its rent comes back.
  const pctToSell = rawPct >= 99.99 ? 100 : Math.round(rawPct * 100) / 100;
  const sellLabel =
    sellPct !== null
      ? `SELL ${sellPct}% OF ${symbol}`
      : typed > 0
        ? sellUnit === "tokens"
          ? `SELL ${compact(typed)} ${symbol}`
          : `SELL ${+typed.toFixed(4)} SOL OF ${symbol}`
        : `SELL ${symbol}`;

  const fillPct = (p: number) => {
    setSellPct(p);
    const tokens = (holdTokens * p) / 100;
    setSellText(sellUnit === "tokens" ? String(+tokens.toPrecision(6)) : String(+(tokens * priceSol).toFixed(6)));
  };
  const switchUnit = (u: SellUnit) => {
    if (u === sellUnit) return;
    // Keep the same amount, shown in the other unit.
    if (typed > 0 && priceSol > 0) setSellText(String(u === "sol" ? +(typed * priceSol).toFixed(6) : +(typed / priceSol).toPrecision(6)));
    setSellUnit(u);
  };

  /** Turns a preset result into per-wallet failures for the box under the button and the console. */
  const failures = (r: GroupTradeResult): FailedLeg[] => {
    const bad = r.results.filter((x) => !x.ok);
    if (bad.length) {
      console.groupCollapsed(`[preset] ${r.side} ${bad.length} of ${r.results.length} wallet(s) failed (${r.sendMode})`);
      console.table(bad.map((b) => ({ wallet: b.wallet, error: b.error, stage: b.details?.stage })));
      for (const b of bad) {
        console.info(b.wallet, b.details ?? {});
        if (Array.isArray(b.details?.steps)) console.table(b.details.steps);
        if (Array.isArray(b.details?.logs)) console.info("program logs\n" + (b.details.logs as string[]).join("\n"));
      }
      console.groupEnd();
    }
    return bad.map((b) => ({ wallet: b.wallet, error: b.error ?? "failed", solscan: typeof b.details?.solscan === "string" ? b.details.solscan : undefined }));
  };
  const showError = (e: unknown) => {
    const err = e as ApiError;
    const link = err.details?.solscan;
    setLastError({ message: err.message, solscan: typeof link === "string" ? link : undefined });
    toast({ tone: "err", title: `${side === "buy" ? "Buy" : "Sell"} of $${symbol} failed`, sub: err.message, links: typeof link === "string" ? [{ href: link, label: "View transaction" }] : undefined });
  };

  const buy = async (n: number) => {
    if (!(n > 0)) return setLastError({ message: "Enter an amount in SOL" });
    setBusy("buy");
    setSince(Date.now());
    setLastError(null);
    try {
      if (preset) {
        const r = await api<GroupTradeResult>(`/api/presets/${encodeURIComponent(preset.id)}/buy`, { method: "POST", body: { mint, sol: n } });
        const trades = r.results.flatMap((x) => (x.trade ? [x.trade] : []));
        const legs = failures(r);
        if (trades.length) toast(presetBuyToast(trades, n, symbol, solUsd, legs.length, r.sendMode, r.bundles));
        if (legs.length) setLastError({ message: `${legs.length} of ${r.results.length} wallets did not buy:`, legs });
      } else {
        const t = await api<Trade>("/api/snipe", { method: "POST", body: { mint, walletId: chosen, sol: n } });
        toast(buyToast(t, solUsd));
      }
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  const sell = async () => {
    if (!sellFrom.length || !(pctToSell > 0) || tooMuch) return;
    setBusy("sell");
    setSince(Date.now());
    setLastError(null);
    const label = `${+pctToSell.toFixed(2)}%`;
    try {
      if (preset) {
        const r = await api<GroupTradeResult>(`/api/presets/${encodeURIComponent(preset.id)}/sell`, { method: "POST", body: { mint, pct: pctToSell } });
        const trades = r.results.flatMap((x) => (x.trade ? [x.trade] : []));
        const legs = failures(r);
        if (trades.length) toast(sellToast(trades, label, symbol, solUsd, legs.length));
        if (legs.length) setLastError({ message: `${legs.length} of ${r.results.length} wallets did not sell:`, legs });
      } else {
        const t = await api<Trade | null>(`/api/positions/${encodeURIComponent(single!.key)}/sell`, { method: "POST", body: { pct: pctToSell } });
        if (!t) throw new Error(`A sell of ${symbol} from ${single!.walletName} is already in flight; wait for it to finish.`);
        toast(sellToast([t], label, symbol, solUsd));
      }
      setSellText("");
      setSellPct(null);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  const sellEverywhere = async () => {
    setBusy("all");
    setLastError(null);
    try {
      const r = await api<SellAllResult>("/api/positions/sell-all", { method: "POST", body: { mint } });
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) {
        console.table(bad);
        setLastError({ message: `${bad.length} of ${r.results.length} wallets did not sell:`, legs: bad.map((b) => ({ wallet: b.wallet, error: b.error ?? "failed" })) });
      }
      if (r.sold) toast({ tone: "sell", title: `🔴 SOLD 100% of $${symbol} from ${r.sold} wallet${r.sold > 1 ? "s" : ""}`, sub: `Received ${r.results.reduce((s, x) => s + (x.solReceived ?? 0), 0).toFixed(4)} SOL. Realized PnL is on the PnL page.` });
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  };

  const holding = positions.length > 0;
  return (
    <Card>
      <div className="p-3">
        <div className="grid grid-cols-2 rounded-lg bg-white/[0.03] p-0.5">
          <button onClick={() => setSide("buy")} className={cx("rounded-md py-1.5 text-[13px] font-semibold transition", side === "buy" ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/25" : "text-neutral-500 hover:text-neutral-200")}>Buy</button>
          <button onClick={() => setSide("sell")} className={cx("rounded-md py-1.5 text-[13px] font-semibold transition", side === "sell" ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/25" : "text-neutral-500 hover:text-neutral-200")}>Sell</button>
        </div>

        {holding && <ActivePosition positions={positions} priceSol={priceSol} solUsd={solUsd} />}

        <label className="mt-3 flex items-center justify-between gap-2 text-xs text-neutral-500">
          Wallet
          <select
            value={chosen}
            onChange={(e) => {
              setWalletId(e.target.value);
              setSellText("");
              setSellPct(null);
            }}
            className="h-8 max-w-[230px] flex-1 rounded-md border border-white/[0.06] bg-ink-900 px-2 text-xs text-neutral-200 outline-none transition focus:border-white/[0.14]"
          >
            {live && !wallets.length && <option value="">No active wallet</option>}
            <WalletOptions paper={!live} presets />
          </select>
        </label>
        {walletSol !== undefined && live && (
          <div className="mt-1 text-right font-mono text-[11px] text-neutral-500">
            {walletSol.toFixed(4)} SOL {preset ? `across ${presetWallets.length} wallets` : "available"}
          </div>
        )}

        {side === "buy" ? (
          <div className="mt-3 space-y-3">
            <div className="flex items-center rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 transition focus-within:border-emerald-400/40">
              <span className="text-xs text-neutral-500">{preset ? "Each wallet" : "Amount"}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && busy === null && void buy(sol)}
                placeholder="0.0"
                className="h-11 min-w-0 flex-1 bg-transparent px-2 text-right text-base font-medium outline-none"
              />
              <span className="text-xs text-neutral-500">SOL</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {presets.slice(0, 8).map((p) => (
                <button
                  key={p}
                  onClick={() => setAmount(String(p))}
                  className={cx("h-8 rounded-md border text-xs font-medium transition", Number(amount) === p ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" : "border-white/[0.06] bg-white/[0.03] text-neutral-300 hover:border-white/[0.12] hover:bg-white/[0.06]")}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="flex justify-between text-[11px] text-neutral-500">
              <span>≈ {priceSol > 0 && sol > 0 ? compact((sol / priceSol) * (preset ? presetWallets.length : 1)) : "0"} {symbol}</span>
              <span>
                slip {state.settings.slippagePct}% · tip {state.settings.jitoTipSol} SOL · {state.settings.sendMode === "protected" ? "protected" : "fast"}
              </span>
            </div>
            <Button variant="success" size="lg" className="w-full font-semibold" disabled={busy !== null || !(sol > 0) || (!!preset && !presetWallets.length)} onClick={() => void buy(sol)}>
              <Zap size={15} />{" "}
              {busy === "buy" ? (
                <>
                  {live ? "Sending" : "Buying"}… <Elapsed since={since} />
                </>
              ) : preset ? (
                `Buy ${symbol} × ${presetWallets.length} wallets`
              ) : (
                `Buy ${symbol}`
              )}
            </Button>
            {preset && sol > 0 && (
              <p className="text-[11px] text-neutral-500">
                {sol} SOL from each of {presetWallets.length} wallets ({+(sol * presetWallets.length).toFixed(4)} SOL in total), each paying its own fees and tip.{" "}
                {live && state.settings.sendMode === "protected"
                  ? `Goes out as ${Math.ceil(presetWallets.length / 5)} Jito bundle${presetWallets.length > 5 ? "s" : ""} (5 wallets max each).`
                  : live
                    ? "Each wallet's buy goes out at once through the fast route."
                    : ""}
              </p>
            )}
            {migrated && <p className="text-[11px] text-neutral-500">Graduated coin: the buy routes through its PumpSwap pool.</p>}
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {sellFrom.length ? (
              <>
                <div className="flex justify-between text-[11px] text-neutral-500">
                  <span>Holding{preset ? ` · ${sellFrom.length} of ${presetWallets.length} wallets` : ` · ${single!.walletName}`}</span>
                  <span className="font-mono text-neutral-300">
                    {compact(holdTokens)} {symbol} · {holdSol.toFixed(4)} SOL
                  </span>
                </div>
                <div className={cx("flex items-center rounded-lg border bg-white/[0.02] px-3 transition", tooMuch ? "border-rose-500/50" : "border-white/[0.06] focus-within:border-rose-400/40")}>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={sellText}
                    onChange={(e) => {
                      setSellText(e.target.value);
                      setSellPct(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && busy === null && void sell()}
                    placeholder="0"
                    className="h-11 min-w-0 flex-1 bg-transparent pr-2 text-base font-medium outline-none"
                  />
                  <div className="flex rounded-md bg-white/[0.04] p-0.5 text-[11px]">
                    {(["tokens", "sol"] as const).map((u) => (
                      <button key={u} onClick={() => switchUnit(u)} className={cx("rounded px-2 py-1 font-medium transition", sellUnit === u ? "bg-white/[0.1] text-white" : "text-neutral-500 hover:text-neutral-200")}>
                        {u === "tokens" ? symbol.slice(0, 8) : "SOL"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      onClick={() => fillPct(p)}
                      className={cx(
                        "h-8 rounded-md border text-xs font-semibold transition",
                        sellPct === p ? "border-rose-400/50 bg-rose-500/15 text-rose-100" : "border-white/[0.06] bg-white/[0.03] text-neutral-300 hover:border-rose-400/25 hover:bg-rose-500/[0.07]",
                      )}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
                <div className="flex justify-between text-[11px] text-neutral-500">
                  <span>{tooMuch ? <span className="text-rose-400">More than you hold</span> : pctToSell > 0 ? `${+pctToSell.toFixed(2)}% of holding` : "Pick a percentage or type an amount"}</span>
                  <span>≈ {((holdSol * Math.min(pctToSell, 100)) / 100).toFixed(4)} SOL</span>
                </div>
                <button
                  disabled={busy !== null || !(pctToSell > 0) || tooMuch}
                  onClick={() => void sell()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-rose-600 py-3 font-semibold text-white shadow-lg shadow-rose-900/20 transition hover:bg-rose-500 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40"
                >
                  {busy === "sell" ? (
                    <>
                      {live ? "Sending" : "Selling"}… <Elapsed since={since} />
                    </>
                  ) : (
                    <>
                      {sellLabel}
                      {preset ? ` × ${sellFrom.length}` : ""}
                    </>
                  )}
                </button>
                <p className="text-[11px] text-neutral-500">
                  {preset ? `Sells the same share from each of the ${sellFrom.length} wallets holding it. ` : ""}Sells go out at market with your slippage, priority fee and tip. Take-profit and stop-loss rules keep running on what is left.
                </p>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-white/[0.07] px-3 py-6 text-center text-xs text-neutral-500">
                {positions.length ? (preset ? `No wallet in ${preset.name} holds ${symbol}.` : "No position from this wallet; pick the wallet or preset that holds it.") : `You hold no ${symbol}.`}
              </div>
            )}
            {positions.length > 1 && (
              <Button variant="danger" size="sm" className="w-full" disabled={busy !== null} onClick={() => void sellEverywhere()}>
                <Flame size={13} /> {busy === "all" ? "Selling…" : `Sell all from ${positions.length} wallets`}
              </Button>
            )}
          </div>
        )}
        {lastError && (
          <div className="mt-3 rounded-md border border-rose-500/20 bg-rose-500/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-rose-300">
            {lastError.message}
            {lastError.solscan && (
              <>
                {" "}
                <a href={lastError.solscan} target="_blank" rel="noreferrer" className="underline">
                  View transaction
                </a>
              </>
            )}
            {lastError.legs?.map((l) => (
              <div key={l.wallet} className="mt-1">
                <span className="font-semibold">{l.wallet}:</span> {l.error}
                {l.solscan && (
                  <>
                    {" "}
                    <a href={l.solscan} target="_blank" rel="noreferrer" className="underline">
                      tx
                    </a>
                  </>
                )}
              </div>
            ))}{" "}
            <span className="text-rose-300/60">Full detail in the browser console.</span>
          </div>
        )}
      </div>
    </Card>
  );
}

/** "BOUGHT 0.02 SOL × 3 wallets of $TICKER": one toast for a whole preset buy. */
function presetBuyToast(trades: Trade[], perWallet: number, symbol: string, solUsd: number | null, failed: number, mode: string, bundles: number) {
  const spent = trades.reduce((s, t) => s + t.solAmount, 0);
  const avgPrice = trades.reduce((s, t) => s + t.solAmount, 0) / Math.max(1e-12, trades.reduce((s, t) => s + t.tokenAmount, 0));
  const t0 = buyToast({ ...trades[0], solAmount: perWallet, priceSol: avgPrice, symbol }, solUsd);
  return {
    ...t0,
    title: `🟢 ${trades.every((t) => t.mode === "sim") ? "PAPER " : ""}BOUGHT ${perWallet} SOL × ${trades.length} wallets of $${symbol}`,
    sub: `${t0.sub!.split(" · ")[0]} · ${spent.toFixed(4)} SOL in total${mode === "protected" ? ` · ${bundles} Jito bundle${bundles > 1 ? "s" : ""}` : ""}${failed ? ` · ${failed} wallet${failed > 1 ? "s" : ""} failed` : ""}`,
    links: trades.filter((t) => t.signature).map((t) => ({ href: solscan(t.signature!), label: `${t.walletName} ${short(t.signature!)}` })),
  };
}

/** Bought value, current value and unrealized PnL of what you hold, re-priced on every trade the engine pushes. */
function ActivePosition({ positions, priceSol, solUsd }: { positions: Position[]; priceSol: number; solUsd: number | null }) {
  const s = positionStats(positions, priceSol);
  const good = s.pnl >= 0;
  const usd = (n: number) => (solUsd ? money(n * solUsd) : "");
  return (
    <div className={cx("mt-3 rounded-lg border px-3 py-2.5", good ? "border-emerald-500/15 bg-emerald-500/[0.04]" : "border-rose-500/15 bg-rose-500/[0.04]")}>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-neutral-400">Active position{positions.length > 1 ? ` · ${positions.length} wallets` : ""}</span>
        <span key={s.pnlPct.toFixed(2)} className={cx("font-semibold tabular-nums", good ? "tick-up text-emerald-400" : "tick-down text-rose-400")}>
          {pct(s.pnlPct, 2)}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 tabular-nums">
        <div>
          <div className="text-[10px] text-neutral-500">Bought</div>
          <div className="text-[13px] font-semibold text-neutral-100">{s.cost.toFixed(4)}</div>
          <div className="text-[10px] text-neutral-500">{usd(s.cost) || "SOL"}</div>
        </div>
        <div>
          <div className="text-[10px] text-neutral-500">Current</div>
          <div className="text-[13px] font-semibold text-neutral-100">{s.worth.toFixed(4)}</div>
          <div className="text-[10px] text-neutral-500">{usd(s.worth) || "SOL"}</div>
        </div>
        <div>
          <div className="text-[10px] text-neutral-500">Unrealized</div>
          <div className={cx("text-[13px] font-semibold", good ? "text-emerald-400" : "text-rose-400")}>{`${good ? "+" : ""}${s.pnl.toFixed(4)}`}</div>
          <div className={cx("text-[10px]", good ? "text-emerald-400/70" : "text-rose-400/70")}>{solUsd ? `${good ? "+" : "-"}$${Math.abs(s.pnl * solUsd).toFixed(2)}` : "SOL"}</div>
        </div>
      </div>
      {Math.abs(s.realized) > 1e-9 && (
        <div className="mt-1.5 text-[10px] text-neutral-500">
          Realized so far <span className={s.realized >= 0 ? "text-emerald-400" : "text-rose-400"}>{`${s.realized >= 0 ? "+" : ""}${s.realized.toFixed(4)} SOL`}</span>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- token info */

function TokenInfo({ d }: { d: Tracked }) {
  const l = d.launch;
  const tiles: { label: string; value: string; tone?: "good" | "warn" | "bad" }[] = [
    { label: "Dev holds", value: `${l.devHoldPct.toFixed(1)}%`, tone: l.devHoldPct > 10 ? "bad" : l.devHoldPct > 5 ? "warn" : "good" },
    { label: "Top 10", value: `${d.top10Pct.toFixed(1)}%`, tone: d.top10Pct > 30 ? "warn" : undefined },
    { label: "Holders", value: String(d.holderCount) },
    { label: "Traders", value: String(l.traders) },
    { label: "Buys", value: String(l.buys), tone: "good" },
    { label: "Sells", value: String(l.sells), tone: "bad" },
  ];
  return (
    <Card title="Token info">
      <div className="space-y-4 p-4">
        <div>
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="text-neutral-400">{l.migrated ? "Graduated to PumpSwap" : "Bonding curve"}</span>
            <span className="text-neutral-200">{l.curvePct.toFixed(1)}%</span>
          </div>
          <CurveBar pct={l.curvePct} migrated={l.migrated} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2 py-2 text-center">
              <div
                className={cx(
                  "text-sm font-semibold",
                  t.tone === "good" && "text-emerald-400",
                  t.tone === "warn" && "text-amber-300",
                  t.tone === "bad" && "text-rose-400",
                  !t.tone && "text-neutral-100",
                )}
              >
                {t.value}
              </div>
              <div className="mt-0.5 text-[10px] text-neutral-500">{t.label}</div>
            </div>
          ))}
        </div>
        {l.devSold && (
          <div className="flex items-center gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <ShieldAlert size={14} /> The dev wallet has sold.
          </div>
        )}
        {l.meta?.description && <p className="text-xs leading-relaxed text-neutral-400">{l.meta.description}</p>}
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>
            Dev <Addr a={l.creator} />
          </span>
          {!l.simulated && (
            <a href={`https://pump.fun/coin/${l.mint}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-neutral-200">
              pump.fun <ExternalLink size={11} />
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- no mint */

function OpenByAddress() {
  const router = useRouter();
  const [ca, setCa] = useState("");
  return (
    <div className="mx-auto max-w-lg py-16">
      <Empty icon={<Flame size={20} />} title="Open a coin">
        Click any coin in the Live Feed, or paste a contract address.
      </Empty>
      <form
        className="relative mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ca.trim()) router.push(coinPage(ca.trim()));
        }}
      >
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-600" />
        <input value={ca} onChange={(e) => setCa(e.target.value)} placeholder="Contract address" className="h-11 w-full rounded-xl border border-white/[0.07] bg-ink-950 pl-8 pr-3 font-mono text-sm outline-none focus:border-white/20" />
      </form>
    </div>
  );
}

/** Seconds since a live order went out: a live buy can take up to a minute to land or be proven expired. */
function Elapsed({ since }: { since: number }) {
  const now = useNow();
  return <span className="tabular-nums opacity-70">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}
