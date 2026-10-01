"use client";

import { Check, Copy, ExternalLink, Globe, Rocket, Send, ShieldAlert, Users, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, useEngine } from "@/lib/engine";
import { coinPage, short, tokenUrl } from "@/lib/format";
import type { Launch } from "@/lib/types";
import { Badge, Empty, cx, useToast } from "./ui";

/* ---------------------------------------------------------------- formatting */

export const money = (n: number, prefix = "$") =>
  `${prefix}${n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(n >= 100 ? 0 : 2)}`;

/** USD when the engine knows the SOL price, otherwise SOL. */
export function useValue() {
  const { state } = useEngine();
  const usd = state?.solUsd ?? null;
  return (sol: number) => (usd ? money(sol * usd) : `${money(sol, "")} SOL`);
}

export function age(ts: number, now: number) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** One shared 1-second clock for every age label on the page, instead of a timer per row. */
const tickers = new Set<() => void>();
let clock: ReturnType<typeof setInterval> | null = null;
function subscribeClock(fn: () => void) {
  tickers.add(fn);
  clock ??= setInterval(() => tickers.forEach((f) => f()), 1000);
  return () => {
    tickers.delete(fn);
    if (!tickers.size && clock) {
      clearInterval(clock);
      clock = null;
    }
  };
}
const nowSec = () => Math.floor(Date.now() / 1000);

/** Re-renders every second so ages stay live. */
export function useNow() {
  return useSyncExternalStore(subscribeClock, nowSec, nowSec) * 1000;
}

/** A live "12s / 3m / 1h" age that re-renders on its own, so the row around it does not have to. */
export function Age({ ts, className }: { ts: number; className?: string }) {
  const now = useNow();
  return <span className={className}>{age(ts, now)}</span>;
}

/* ---------------------------------------------------------------- pieces */

const HUES = [262, 160, 200, 330, 30, 280, 190, 0];
/** Square coin image (Axiom style). Without one, a muted tile with the ticker's first letters. */
export function Avatar({ l, size = 44 }: { l: Launch; size?: number }) {
  const [broken, setBroken] = useState(false);
  const hue = HUES[l.mint.charCodeAt(0) % HUES.length];
  const img = l.meta?.image;
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md bg-ink-800 ring-1 ring-white/[0.06]"
      style={{ width: size, height: size }}
      title={l.migrated ? "Graduated to PumpSwap" : `Bonding curve ${l.curvePct.toFixed(1)}% complete`}
    >
      {img && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt="" width={size} height={size} decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <div
          className="grid h-full w-full place-items-center font-semibold tracking-tight"
          style={{ fontSize: size * 0.3, color: `hsl(${hue} 70% 78%)`, background: `linear-gradient(135deg, hsl(${hue} 35% 20%), hsl(${(hue + 40) % 360} 30% 12%))` }}
        >
          {l.symbol.slice(0, 2).toUpperCase()}
        </div>
      )}
      {l.migrated && <span className="absolute bottom-0 right-0 h-2 w-2 rounded-tl-sm bg-amber-400" />}
    </div>
  );
}

/** Smooth sparkline: a Catmull-Rom curve through the points, with a soft gradient fill under it. */
function Spark({ points, up, id }: { points: number[]; up: boolean; id: string }) {
  const W = 88;
  const H = 30;
  if (points.length < 2) return <div style={{ width: W, height: H }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - 2 - ((p - min) / span) * (H - 4)] as const);
  let d = `M${xy[0][0].toFixed(1)},${xy[0][1].toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const [x0, y0] = xy[Math.max(0, i - 1)];
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[i + 1];
    const [x3, y3] = xy[Math.min(xy.length - 1, i + 2)];
    const c1 = [x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6];
    const c2 = [x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  const color = up ? "#34d399" : "#fb7185";
  const gid = `sg-${id}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** Thin bonding-curve progress strip; full at graduation to PumpSwap. */
export function CurveBar({ pct, migrated, className }: { pct: number; migrated?: boolean; className?: string }) {
  return (
    <div className={cx("h-1 overflow-hidden rounded-full bg-white/[0.06]", className)}>
      <div
        className={cx("h-full rounded-full", migrated ? "bg-amber-400" : pct >= 80 ? "bg-emerald-400" : "bg-emerald-500/70")}
        style={{ width: `${Math.max(2, Math.min(100, migrated ? 100 : pct))}%` }}
      />
    </div>
  );
}

export function CopyCa({ mint }: { mint: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(mint);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 font-mono text-[11px] text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200"
      title="Copy contract address"
    >
      {short(mint, 4)}
      {done ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  );
}

export const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
  </svg>
);

export function Socials({ l }: { l: Launch }) {
  const m = l.meta;
  const link = (href: string | undefined, icon: React.ReactNode, title: string) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title} className="text-neutral-500 hover:text-neutral-200" onClick={(e) => e.stopPropagation()}>
        {icon}
      </a>
    ) : null;
  return (
    <span className="flex items-center gap-2">
      {link(m?.twitter, <XIcon />, "X / Twitter")}
      {link(m?.telegram, <Send size={12} />, "Telegram")}
      {link(m?.website, <Globe size={12} />, "Website")}
      {!l.simulated && link(tokenUrl(l.mint), <ExternalLink size={12} />, "Open on pump.fun")}
    </span>
  );
}

function Stat2({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap text-[11px]">
      <span className="text-neutral-600">{label}</span>
      <span className={cx(tone === "good" && "text-emerald-400", tone === "bad" && "text-rose-400", tone === "warn" && "text-amber-300", !tone && "text-neutral-300")}>{value}</span>
    </span>
  );
}

/* ---------------------------------------------------------------- quick buy */

export function useQuickBuy(walletId: string) {
  const { state } = useEngine();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // The callback stays the same object across renders so memoised feed rows do not re-render for it.
  const ctx = useRef({ state, walletId, toast });
  ctx.current = { state, walletId, toast };
  const buy = useCallback(async (l: Launch, sol: number) => {
    const { state, walletId, toast } = ctx.current;
    if (!state || !(sol > 0)) return;
    setBusy(`${l.mint}:${sol}`);
    try {
      await api("/api/snipe", { method: "POST", body: { mint: l.mint, walletId, sol } });
      toast.show(`${state.status.live ? "Bought" : "Paper bought"} ${sol} SOL of ${l.symbol}`);
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  }, []);
  return { buy, busy, toastNode: toast.node };
}

/** Wallet quick-buys use: the chosen one, else the first active non-master wallet (paper wallet in simulation). */
export function defaultWalletId(state: ReturnType<typeof useEngine>["state"]) {
  const ws = (state?.wallets ?? []).filter((w) => w.active);
  if (!state?.status.live) return "";
  return ws.find((w) => !w.isMaster)?.id ?? ws[0]?.id ?? "";
}

/* ---------------------------------------------------------------- table */

export function TokenFeed({
  launches,
  presets,
  custom,
  walletId,
  compactRows = false,
}: {
  launches: Launch[];
  presets: number[];
  custom?: number;
  walletId: string;
  compactRows?: boolean;
}) {
  const { state } = useEngine();
  const solUsd = state?.solUsd ?? null;
  const { buy, busy, toastNode } = useQuickBuy(walletId);
  const router = useRouter();
  const open = useCallback((mint: string) => router.push(coinPage(mint)), [router]);
  const presetKey = presets.join(",");
  const amounts = useMemo(() => {
    const a = presetKey ? presetKey.split(",").map(Number) : [];
    if (custom && custom > 0 && !a.includes(custom)) a.push(custom);
    return a;
  }, [presetKey, custom]);

  if (!launches.length) return <Empty icon={<Rocket size={20} />} title="Listening for launches">New Pump.fun coins appear here the moment they are created.</Empty>;

  return (
    <div className="overflow-x-auto scrollbar-thin">
      {toastNode}
      <table className={cx("w-full", compactRows ? "min-w-[560px]" : "min-w-[1080px]")}>
        <thead className="frost sticky top-0 z-10 border-b border-white/[0.05] bg-ink-900/80">
          <tr className="text-left text-[11px] font-medium text-neutral-500">
            <th className="px-4 py-2 font-medium">Pair info</th>
            {!compactRows && <th className="px-2 py-2" />}
            <th className="px-3 py-2 font-medium">Market cap</th>
            {!compactRows && <th className="px-3 py-2 font-medium">Liquidity</th>}
            {!compactRows && <th className="px-3 py-2 font-medium">Volume</th>}
            {!compactRows && <th className="px-3 py-2 font-medium">TXNs</th>}
            {!compactRows && <th className="px-3 py-2 font-medium">Token info</th>}
            <th className="px-4 py-2 text-right font-medium">Quick buy</th>
          </tr>
        </thead>
        <tbody className="[&_td]:whitespace-nowrap">
          {launches.map((l) => (
            <Row
              key={l.mint}
              l={l}
              solUsd={solUsd}
              amounts={amounts}
              busyAmt={busy?.startsWith(`${l.mint}:`) ? Number(busy.slice(l.mint.length + 1)) : null}
              locked={busy !== null}
              onBuy={buy}
              onOpen={open}
              compact={compactRows}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

const fmtValue = (sol: number, usd: number | null) => (usd ? money(sol * usd) : `${money(sol, "")} SOL`);

/** One coin. Memoised: the engine sends a new object only for coins that changed, so quiet rows skip re-rendering. */
const Row = memo(function Row({
  l,
  solUsd,
  amounts,
  busyAmt,
  locked,
  onBuy,
  onOpen,
  compact,
}: {
  l: Launch;
  solUsd: number | null;
  amounts: number[];
  busyAmt: number | null;
  locked: boolean;
  onBuy: (l: Launch, sol: number) => void;
  onOpen: (mint: string) => void;
  compact: boolean;
}) {
  const value = (sol: number) => fmtValue(sol, solUsd);
  const start = l.spark[0] || l.marketCapSol;
  const change = start ? (l.marketCapSol / start - 1) * 100 : 0;
  const prev = l.spark.length > 1 ? l.spark[l.spark.length - 2] : l.marketCapSol;
  const tick = l.marketCapSol > prev ? "tick-up" : l.marketCapSol < prev ? "tick-down" : "";
  return (
    <tr
      onClick={(e) => {
        // Copy, socials and quick-buy handle their own clicks; anywhere else on the row opens the coin page.
        if ((e.target as HTMLElement).closest("button, a")) return;
        onOpen(l.mint);
      }}
      className="group cursor-pointer border-b border-white/[0.04] transition-colors hover:bg-white/[0.025]"
    >
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Avatar l={l} size={compact ? 36 : 44} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-semibold text-neutral-50">{l.symbol}</span>
              <span className="max-w-[130px] truncate text-[12px] text-neutral-500">{l.name}</span>
              <CopyCa mint={l.mint} />
            </div>
            <div className="mt-1 flex items-center gap-2.5 text-[11px]">
              <Age ts={l.ts} className="font-medium text-emerald-400" />
              <Socials l={l} />
              {l.sniped && <Badge tone="green">sniped</Badge>}
              {l.migrated && <Badge tone="amber">PumpSwap</Badge>}
              {l.simulated && <Badge>sim</Badge>}
              {l.skipped && !compact && <span className="max-w-[160px] truncate text-neutral-600" title={`Auto-snipe passed: ${l.skipped}`}>skip: {l.skipped}</span>}
            </div>
          </div>
        </div>
      </td>
      {!compact && (
        <td className="px-2 py-2.5">
          <Spark points={l.spark} up={change >= 0} id={l.mint} />
        </td>
      )}
      <td className="px-3 py-2.5">
        <div className="text-[13px] font-medium text-neutral-100">
          <span key={l.marketCapSol} className={tick}>{value(l.marketCapSol)}</span>
        </div>
        <div className={cx("text-[11px]", change >= 0 ? "text-emerald-400" : "text-rose-400")}>
          {change >= 0 ? "+" : ""}
          {change.toFixed(1)}%
        </div>
      </td>
      {!compact && (
        <td className="px-3 py-2.5 text-[13px] text-neutral-300" title="SOL in the bonding curve">{value(l.liquiditySol)}</td>
      )}
      {!compact && (
        <td className="px-3 py-2.5 text-[13px] text-neutral-300" title="Volume since launch">{value(l.volumeSol)}</td>
      )}
      {!compact && (
        <td className="px-3 py-2.5">
          <div className="text-[13px] text-neutral-200">{l.buys + l.sells}</div>
          <div className="text-[11px]">
            <span className="text-emerald-400">{l.buys}</span>
            <span className="text-neutral-700"> / </span>
            <span className="text-rose-400">{l.sells}</span>
          </div>
        </td>
      )}
      {!compact && (
        <td className="px-3 py-2.5">
          <div className="w-[168px] space-y-1.5">
            <div className="flex items-center gap-2" title={l.migrated ? "Graduated to PumpSwap" : "Bonding curve progress toward PumpSwap"}>
              <CurveBar pct={l.curvePct} migrated={l.migrated} className="flex-1" />
              <span className={cx("w-10 text-right text-[11px]", l.curvePct >= 80 ? "text-emerald-400" : "text-neutral-400")}>{l.migrated ? "PS" : `${l.curvePct.toFixed(0)}%`}</span>
            </div>
            <div className="flex items-center gap-3">
              <Stat2 label="Dev" value={`${l.devHoldPct.toFixed(1)}%`} tone={l.devHoldPct > 10 ? "bad" : l.devHoldPct > 5 ? "warn" : undefined} />
              <span className="flex items-center gap-1 text-[11px] text-neutral-400" title="Traders">
                <Users size={11} className="text-neutral-600" /> {l.traders}
              </span>
              {l.devSold ? (
                <span className="flex items-center gap-1 text-[11px] text-rose-400">
                  <ShieldAlert size={11} /> dev sold
                </span>
              ) : (
                <Stat2 label="ATH" value={value(l.athMarketCapSol)} />
              )}
            </div>
          </div>
        </td>
      )}
      <td className="px-4 py-2.5">
        <div className="flex justify-end gap-1">
          {amounts.map((a) => (
            <button
              key={a}
              disabled={locked}
              onClick={() => onBuy(l, a)}
              title={`Buy ${a} SOL${l.migrated ? " (routes through PumpSwap)" : ""}`}
              className={cx(
                "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] font-medium transition active:scale-95 disabled:opacity-40",
                busyAmt === a
                  ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-200"
                  : "border-white/[0.06] bg-white/[0.03] text-neutral-200 hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-emerald-200 hover:shadow-sm hover:shadow-emerald-500/10",
              )}
            >
              <Zap size={11} className="text-emerald-400" /> {a}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
});
