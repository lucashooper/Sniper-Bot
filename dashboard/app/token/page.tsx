"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Crown, ExternalLink, Flame, Search, ShieldAlert, Users, Zap } from "lucide-react";
import { api, useEngine } from "@/lib/engine";
import { accountUrl, coinPage, compact, pct, short, solscan, time } from "@/lib/format";
import type { Position, SellAllResult, TapeTrade, TokenDetail, Trade } from "@/lib/types";
import { Avatar, CopyCa, Socials, age, defaultWalletId, money, useNow } from "@/components/token-feed";
import { INTERVALS, TokenChart, type ChartUnit } from "@/components/token-chart";
import { Badge, Button, Card, Empty, cx, useToast } from "@/components/ui";

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
 * The coin's detail from the engine, re-fetched each time the feed ticks. After the first load only trades the page
 * has not seen are sent (by sequence number), so a busy coin's chart stays cheap to keep live.
 */
function useTokenDetail(mint: string) {
  const { feedVersion, connected } = useEngine();
  const [detail, setDetail] = useState<TokenDetail | null>(null);
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const inflight = useRef(false);
  const again = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return void (again.current = true);
    inflight.current = true;
    try {
      const d = await api<TokenDetail>(`/api/token/${encodeURIComponent(mint)}${last.current ? `?after=${last.current}` : ""}`);
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
      } else if (d.trades.length) {
        setTrades((t) => {
          const next = t.concat(d.trades);
          return next.length > 3000 ? next.slice(-3000) : next;
        });
        last.current = d.lastSeq;
      }
      setDetail(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        void load();
      }
    }
  }, [mint]);

  useEffect(() => {
    if (connected) void load();
  }, [feedVersion, connected, load]);
  // The engine forgets a coin nobody has open after a while; asking now and then keeps it tracked while the page is up.
  useEffect(() => {
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  return { detail, trades, error };
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
  const lastPrice = l?.priceSol ?? positions[0]?.lastPriceSol ?? 0;
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
    <div className="space-y-4">
      {/* Header: identity and headline numbers */}
      <div className="glass flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-neutral-800 bg-ink-900/80 px-4 py-3">
        <Link href="/feed" className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100" title="Back to the feed">
          <ArrowLeft size={16} />
        </Link>
        <div className="flex min-w-0 items-center gap-3">
          {l ? <Avatar l={l} size={44} /> : <div className="grid h-11 w-11 place-items-center rounded-xl bg-ink-800 text-xs font-bold">{symbol.slice(0, 2)}</div>}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">{symbol}</span>
              <span className="max-w-[180px] truncate text-sm text-neutral-500">{name}</span>
              <CopyCa mint={mint} />
            </div>
            <div className="mt-0.5 flex items-center gap-2.5 text-xs">
              {l && <span className="font-mono text-emerald-400">{age(l.ts, now)}</span>}
              {l && <Socials l={l} />}
              {l?.migrated && <Badge tone="amber">PumpSwap</Badge>}
              {simulated && <Badge tone="violet">sim</Badge>}
              {!tracked && <Badge>not in feed</Badge>}
            </div>
          </div>
        </div>
        {l && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <div className="font-mono text-2xl font-semibold tabular-nums text-neutral-50">{value(l.marketCapSol)}</div>
              {change5m !== null && <div className={cx("font-mono text-[11px]", change5m >= 0 ? "text-emerald-400" : "text-rose-400")}>{pct(change5m)} 5m</div>}
            </div>
            <HeadStat label="Price" value={solUsd ? `$${(l.priceSol * solUsd).toPrecision(3)}` : `${l.priceSol.toPrecision(3)} SOL`} />
            <HeadStat label="Liquidity" value={value(l.liquiditySol)} />
            <HeadStat label="Volume" value={value(l.volumeSol)} />
            <HeadStat label="B.Curve" value={`${l.curvePct.toFixed(1)}%`} tone={l.curvePct >= 80 ? "good" : undefined} />
            <HeadStat label="ATH" value={value(l.athMarketCapSol)} />
          </div>
        )}
      </div>

      {/* On phones the trade panel sits right under the chart; on wide screens it is the right-hand column. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <ChartCard mint={mint} tracked={tracked} trades={trades} fills={fills} solUsd={solUsd} simulated={simulated} />
        </div>
        <div className="space-y-4 xl:row-span-2">
          <TradePanel mint={mint} symbol={symbol} priceSol={lastPrice} positions={positions} migrated={!!l?.migrated} />
          {positions.length > 0 && <PositionCard positions={positions} value={value} />}
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

function HeadStat({ label, value, tone }: { label: string; value: string; tone?: "good" }) {
  return (
    <div>
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className={cx("font-mono text-sm tabular-nums", tone === "good" ? "text-emerald-400" : "text-neutral-200")}>{value}</div>
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
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800/80 px-3 py-2 text-xs">
        <div className="flex rounded-lg bg-ink-950 p-0.5">
          <Seg on={src === "bot"} onClick={() => setSource("bot")} disabled={!tracked}>Live</Seg>
          <Seg on={src === "dex"} onClick={() => setSource("dex")} disabled={simulated}>DexScreener</Seg>
        </div>
        {src === "bot" && (
          <>
            <div className="flex rounded-lg bg-ink-950 p-0.5">
              {INTERVALS.map((i) => (
                <Seg key={i.sec} on={interval === i.sec} onClick={() => setIntervalSec(i.sec)}>{i.label}</Seg>
              ))}
            </div>
            <div className="flex rounded-lg bg-ink-950 p-0.5">
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
    <button {...p} className={cx("rounded-md px-2.5 py-1 font-medium transition disabled:opacity-30", on ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-200")}>
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
      <div className="flex gap-1 border-b border-neutral-800/80 px-3 py-2">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx("whitespace-nowrap rounded-lg px-3 py-1.5 text-sm", tab === t.id ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-200")}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="max-h-[360px] overflow-auto scrollbar-thin">
        {tab === "trades" &&
          (recent.length ? (
            <Table head={["Age", "Type", "MC", "SOL", "Tokens", "Trader"]}>
              {recent.map((t) => (
                <tr key={t.seq} className="font-mono text-xs">
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
                  <tr key={h.address} className="font-mono text-xs">
                    <td className="px-4 py-1.5 text-neutral-600">{i + 1}</td>
                    <td className="px-3 py-1.5"><Addr a={h.address} dev={h.isCreator} /></td>
                    <td className="px-3 py-1.5 text-neutral-300">{compact(h.tokens)}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-16 overflow-hidden rounded-full bg-neutral-800">
                          <div className={cx("h-full", h.isCreator ? "bg-amber-400" : "bg-violet-400")} style={{ width: `${Math.min(100, h.pct * 5)}%` }} />
                        </div>
                        <span className="text-neutral-300">{h.pct.toFixed(2)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
              <p className="border-t border-neutral-800/80 px-4 py-2 text-[11px] text-neutral-600">Built from buys and sells the bot saw since launch; tokens moved wallet to wallet are not counted. The bonding curve itself is not listed.</p>
            </>
          ) : (
            <Empty icon={<Users size={18} />} title="No holders seen">{tracked ? "Nobody has bought since the bot started watching this coin." : "The bot has no trade history for this coin."}</Empty>
          ))}
        {tab === "mine" &&
          (fills.length ? (
            <Table head={["Time", "Side", "SOL", "Tokens", "Wallet", "Tx"]}>
              {fills.map((f) => (
                <tr key={f.id} className="font-mono text-xs">
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
      <thead className="sticky top-0 bg-ink-900/95 backdrop-blur">
        <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          {head.map((h, i) => (
            <th key={h} className={cx("py-2", i === 0 ? "px-4" : "px-3")}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-neutral-800/60">{children}</tbody>
    </table>
  );
}

function Addr({ a, dev, sig }: { a: string; dev?: boolean; sig?: string }) {
  const real = !a.startsWith("sim-");
  return (
    <span className="inline-flex items-center gap-1.5">
      {real ? (
        <a href={accountUrl(a)} target="_blank" rel="noopener noreferrer" className="text-neutral-300 hover:text-violet-300">{short(a)}</a>
      ) : (
        <span className="text-neutral-400">{a.replace("sim-trader-", "trader ")}</span>
      )}
      {dev && (
        <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] font-sans font-semibold text-amber-300" title="Coin creator">
          <Crown size={9} /> DEV
        </span>
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

function TradePanel({ mint, symbol, priceSol, positions, migrated }: { mint: string; symbol: string; priceSol: number; positions: Position[]; migrated: boolean }) {
  const { state } = useEngine();
  const toast = useToast();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [walletId, setWalletId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!state) return null;
  const live = state.status.live;
  const presets = state.settings.quickBuyPresets ?? [0.1, 0.5, 1];
  const wallets = state.wallets.filter((w) => w.active);
  const chosen = walletId || defaultWalletId(state);
  const sol = Number(amount);
  const walletSol = chosen ? state.balances[chosen]?.sol : undefined;
  // Sells act on your position in this coin from the chosen wallet (or the only one you have).
  const pos = positions.find((p) => p.walletId === (chosen || "paper")) ?? (positions.length === 1 ? positions[0] : undefined);

  const buy = async (n: number) => {
    if (!(n > 0)) return toast.show("Enter an amount in SOL", "err");
    setBusy("buy");
    try {
      await api("/api/snipe", { method: "POST", body: { mint, walletId: chosen, sol: n } });
      toast.show(`${live ? "Bought" : "Paper bought"} ${n} SOL of ${symbol}`);
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  const sell = async (p: number) => {
    if (!pos) return;
    setBusy(`sell${p}`);
    try {
      await api(`/api/positions/${encodeURIComponent(pos.key)}/sell`, { method: "POST", body: { pct: p } });
      toast.show(p >= 100 ? `Sold all ${symbol}` : `Sold ${p}% of ${symbol}`);
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  const sellEverywhere = async () => {
    setBusy("all");
    try {
      const r = await api<SellAllResult>("/api/positions/sell-all", { method: "POST", body: { mint } });
      if (r.failed) toast.show(`Sold ${r.sold}, ${r.failed} failed: ${r.results.find((x) => !x.ok)?.error ?? "see the log"}`, "err");
      else toast.show(`Sold ${symbol} from ${r.sold} wallets`);
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      {toast.node}
      <div className="p-3">
        <div className="grid grid-cols-2 rounded-xl bg-ink-950 p-1">
          <button onClick={() => setSide("buy")} className={cx("rounded-lg py-2 text-sm font-semibold transition", side === "buy" ? "bg-emerald-500 text-emerald-950" : "text-neutral-500 hover:text-neutral-200")}>Buy</button>
          <button onClick={() => setSide("sell")} className={cx("rounded-lg py-2 text-sm font-semibold transition", side === "sell" ? "bg-rose-500 text-white" : "text-neutral-500 hover:text-neutral-200")}>Sell</button>
        </div>

        <label className="mt-3 flex items-center justify-between gap-2 text-xs text-neutral-500">
          Wallet
          <select value={chosen} onChange={(e) => setWalletId(e.target.value)} className="h-8 max-w-[210px] flex-1 rounded-lg border border-neutral-800 bg-ink-950 px-2 text-xs text-neutral-200 outline-none focus:border-violet-500/60">
            {!live && <option value="">Paper wallet</option>}
            {live && !wallets.length && <option value="">No active wallet</option>}
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>{w.name} · {short(w.publicKey)}</option>
            ))}
          </select>
        </label>
        {live && walletSol !== undefined && <div className="mt-1 text-right font-mono text-[11px] text-neutral-500">{walletSol.toFixed(4)} SOL available</div>}

        {side === "buy" ? (
          <div className="mt-3 space-y-3">
            <div className="flex items-center rounded-xl border border-neutral-800 bg-ink-950 px-3 focus-within:border-emerald-500/50">
              <span className="text-xs text-neutral-500">Amount</span>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void buy(sol)}
                placeholder="0.0"
                className="h-11 min-w-0 flex-1 bg-transparent px-2 text-right font-mono text-base outline-none"
              />
              <span className="font-mono text-xs text-neutral-400">SOL</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {presets.slice(0, 8).map((p) => (
                <button
                  key={p}
                  onClick={() => setAmount(String(p))}
                  className={cx("h-8 rounded-lg border font-mono text-xs transition", Number(amount) === p ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200" : "border-neutral-800 bg-ink-800 text-neutral-300 hover:bg-neutral-800")}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="flex justify-between text-[11px] text-neutral-500">
              <span>≈ {priceSol > 0 && sol > 0 ? compact(sol / priceSol) : "0"} {symbol}</span>
              <span>
                slip {state.settings.slippagePct}% · tip {state.settings.jitoTipSol} SOL
              </span>
            </div>
            <Button variant="success" size="lg" className="w-full" disabled={busy !== null || !(sol > 0)} onClick={() => void buy(sol)}>
              <Zap size={16} /> {busy === "buy" ? "Buying…" : `Buy ${symbol}`}
            </Button>
            {migrated && <p className="text-[11px] text-neutral-500">Graduated coin: the buy routes through its PumpSwap pool.</p>}
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {pos ? (
              <>
                <div className="flex justify-between rounded-xl border border-neutral-800 bg-ink-950 px-3 py-2.5 text-xs">
                  <span className="text-neutral-500">Holding · {pos.walletName}</span>
                  <span className="font-mono text-neutral-200">
                    {compact(pos.tokens)} {symbol} · {(pos.tokens * pos.lastPriceSol).toFixed(4)} SOL
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      disabled={busy !== null}
                      onClick={() => void sell(p)}
                      className={cx(
                        "h-10 rounded-lg font-mono text-xs font-semibold transition active:scale-95 disabled:opacity-40",
                        p === 100 ? "bg-rose-500 text-white hover:bg-rose-400" : "border border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20",
                      )}
                    >
                      {busy === `sell${p}` ? "…" : `${p}%`}
                    </button>
                  ))}
                </div>
                {positions.length > 1 && (
                  <Button variant="danger" size="sm" className="w-full" disabled={busy !== null} onClick={() => void sellEverywhere()}>
                    <Flame size={13} /> {busy === "all" ? "Selling…" : `Sell all from ${positions.length} wallets`}
                  </Button>
                )}
                <p className="text-[11px] text-neutral-500">Sells go out at market with your slippage, priority fee and Jito tip. Take-profit and stop-loss rules keep running on what is left.</p>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-neutral-800 px-3 py-6 text-center text-xs text-neutral-500">
                {positions.length ? "No position from this wallet; pick the wallet that holds it." : `You hold no ${symbol}.`}
              </div>
            )}
            {!pos && positions.length > 1 && (
              <Button variant="danger" size="sm" className="w-full" disabled={busy !== null} onClick={() => void sellEverywhere()}>
                <Flame size={13} /> {busy === "all" ? "Selling…" : `Sell all from ${positions.length} wallets`}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function PositionCard({ positions, value }: { positions: Position[]; value: (sol: number) => string }) {
  const cost = positions.reduce((s, p) => s + p.costSol, 0);
  const worth = positions.reduce((s, p) => s + p.tokens * p.lastPriceSol, 0);
  const realized = positions.reduce((s, p) => s + p.realizedPnlSol, 0);
  const pnl = worth - cost + realized;
  return (
    <Card>
      <div className="grid grid-cols-3 divide-x divide-neutral-800/80 text-center">
        <Cell label="Invested" value={`${cost.toFixed(3)}`} sub="SOL" />
        <Cell label="Holding" value={`${worth.toFixed(3)}`} sub={value(worth)} />
        <Cell label="PnL" value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}`} sub={cost ? pct((pnl / cost) * 100) : ""} tone={pnl >= 0 ? "good" : "bad"} />
      </div>
    </Card>
  );
}

function Cell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="px-2 py-3">
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className={cx("mt-0.5 font-mono text-sm font-semibold tabular-nums", tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-rose-400" : "text-neutral-100")}>{value}</div>
      {sub && <div className="font-mono text-[10px] text-neutral-500">{sub}</div>}
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
            <span className="font-mono text-neutral-200">{l.curvePct.toFixed(1)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
            <div className={cx("h-full rounded-full transition-all", l.migrated ? "bg-amber-400" : "bg-gradient-to-r from-violet-500 to-emerald-400")} style={{ width: `${Math.max(1, l.curvePct)}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl border border-neutral-800 bg-ink-950 px-2 py-2 text-center">
              <div
                className={cx(
                  "font-mono text-sm font-semibold",
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
          <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
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
        <input value={ca} onChange={(e) => setCa(e.target.value)} placeholder="Contract address" className="h-11 w-full rounded-xl border border-neutral-800 bg-ink-950 pl-8 pr-3 font-mono text-sm outline-none focus:border-violet-500/60" />
      </form>
    </div>
  );
}
