"use client";

import { Check, Copy, ExternalLink, Globe, Rocket, Send, ShieldAlert, Users, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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

/** Re-renders every second so ages stay live. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ---------------------------------------------------------------- pieces */

const HUES = [262, 160, 200, 330, 30, 280, 190, 0];
export function Avatar({ l, size = 52 }: { l: Launch; size?: number }) {
  const [broken, setBroken] = useState(false);
  const hue = HUES[l.mint.charCodeAt(0) % HUES.length];
  const pct = Math.max(2, l.curvePct);
  const ring = l.migrated ? "#facc15" : pct >= 80 ? "#34d399" : pct >= 40 ? "#a78bfa" : "#525252";
  const img = l.meta?.image;
  return (
    <div
      className="relative shrink-0 rounded-xl p-[2px]"
      style={{ width: size, height: size, background: `conic-gradient(${ring} ${pct}%, #26272b 0)` }}
      title={l.migrated ? "Graduated to PumpSwap" : `Bonding curve ${l.curvePct.toFixed(1)}% complete`}
    >
      <div className="h-full w-full overflow-hidden rounded-[10px] bg-ink-950">
        {img && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-full w-full object-cover" />
        ) : (
          <div
            className="grid h-full w-full place-items-center text-sm font-bold text-white/90"
            style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 60) % 360} 70% 30%))` }}
          >
            {l.symbol.slice(0, 2).toUpperCase()}
          </div>
        )}
      </div>
    </div>
  );
}

function Spark({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 2) return <div className="h-8 w-24" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => `${((i / (points.length - 1)) * 96).toFixed(1)},${(30 - ((p - min) / span) * 28).toFixed(1)}`).join(" ");
  const color = up ? "#34d399" : "#fb7185";
  return (
    <svg width="96" height="32" viewBox="0 0 96 32" className="shrink-0">
      <polyline points={`0,32 ${d} 96,32`} fill={color} fillOpacity="0.08" stroke="none" />
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
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
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 font-mono text-[11px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
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
    <span className="flex items-center gap-1 whitespace-nowrap font-mono text-[11px]">
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
  const buy = async (l: Launch, sol: number) => {
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
  };
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
  const now = useNow();
  const value = useValue();
  const { buy, busy, toastNode } = useQuickBuy(walletId);
  const router = useRouter();
  const amounts = useMemo(() => {
    const a = [...presets];
    if (custom && custom > 0 && !a.includes(custom)) a.push(custom);
    return a;
  }, [presets, custom]);

  if (!launches.length) return <Empty icon={<Rocket size={20} />} title="Listening for launches">New Pump.fun coins appear here the moment they are created.</Empty>;

  return (
    <div className="overflow-x-auto scrollbar-thin">
      {toastNode}
      <table className={cx("w-full", compactRows ? "min-w-[640px]" : "min-w-[1120px]")}>
        <thead className="sticky top-0 z-10 border-b border-neutral-800 bg-ink-900/95 backdrop-blur">
          <tr className="text-left text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            <th className="px-4 py-2.5">Pair info</th>
            {!compactRows && <th className="px-2 py-2.5" />}
            <th className="px-3 py-2.5">Market cap</th>
            {!compactRows && <th className="px-3 py-2.5">Liq / Vol</th>}
            {!compactRows && <th className="px-3 py-2.5">Txns</th>}
            {!compactRows && <th className="px-3 py-2.5">Token info</th>}
            <th className="px-4 py-2.5 text-right">Quick buy</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800/70 [&_td]:whitespace-nowrap">
          {launches.map((l) => {
            const start = l.spark[0] || l.marketCapSol;
            const change = start ? (l.marketCapSol / start - 1) * 100 : 0;
            return (
              <tr
                key={l.mint}
                onClick={(e) => {
                  // Copy, socials and quick-buy handle their own clicks; anywhere else on the row opens the coin page.
                  if ((e.target as HTMLElement).closest("button, a")) return;
                  router.push(coinPage(l.mint));
                }}
                className="group cursor-pointer transition hover:bg-white/[0.03]"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar l={l} size={compactRows ? 40 : 52} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-neutral-100 group-hover:text-violet-200">{l.symbol}</span>
                        <span className="max-w-[120px] truncate text-sm text-neutral-500">{l.name}</span>
                        <CopyCa mint={l.mint} />
                      </div>
                      <div className="mt-1 flex items-center gap-2.5 text-xs">
                        <span className="font-mono text-emerald-400">{age(l.ts, now)}</span>
                        <Socials l={l} />
                        {l.sniped && <Badge tone="green">sniped</Badge>}
                        {l.migrated && <Badge tone="amber">PumpSwap</Badge>}
                        {l.simulated && <Badge tone="violet">sim</Badge>}
                        {l.skipped && !compactRows && <span className="truncate text-[11px] text-neutral-600" title={`Auto-snipe passed: ${l.skipped}`}>skip: {l.skipped}</span>}
                      </div>
                    </div>
                  </div>
                </td>
                {!compactRows && (
                  <td className="px-2 py-3">
                    <Spark points={l.spark} up={change >= 0} />
                  </td>
                )}
                <td className="px-3 py-3">
                  <div className="font-mono text-sm text-neutral-100">{value(l.marketCapSol)}</div>
                  <div className={cx("font-mono text-[11px]", change >= 0 ? "text-emerald-400" : "text-rose-400")}>
                    {change >= 0 ? "+" : ""}
                    {change.toFixed(1)}%
                  </div>
                </td>
                {!compactRows && (
                  <td className="px-3 py-3 font-mono text-sm">
                    <div className="text-neutral-300" title="SOL in the bonding curve">{value(l.liquiditySol)}</div>
                    <div className="text-[11px] text-neutral-500" title="Volume since launch">{value(l.volumeSol)}</div>
                  </td>
                )}
                {!compactRows && (
                  <td className="px-3 py-3 font-mono text-sm">
                    <div className="text-neutral-200">{l.buys + l.sells}</div>
                    <div className="text-[11px]">
                      <span className="text-emerald-400">{l.buys}</span>
                      <span className="text-neutral-600"> / </span>
                      <span className="text-rose-400">{l.sells}</span>
                    </div>
                  </td>
                )}
                {!compactRows && (
                  <td className="px-3 py-3">
                    <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1">
                      <Stat2 label="Curve" value={`${l.curvePct.toFixed(1)}%`} tone={l.curvePct >= 80 ? "good" : undefined} />
                      <Stat2 label="Dev" value={`${l.devHoldPct.toFixed(1)}%`} tone={l.devHoldPct > 10 ? "bad" : l.devHoldPct > 5 ? "warn" : "good"} />
                      <span className="flex items-center gap-1 font-mono text-[11px] text-neutral-400">
                        <Users size={11} className="text-neutral-600" /> {l.traders}
                      </span>
                      {l.devSold ? (
                        <span className="flex items-center gap-1 font-mono text-[11px] text-rose-400">
                          <ShieldAlert size={11} /> dev sold
                        </span>
                      ) : (
                        <Stat2 label="ATH" value={value(l.athMarketCapSol)} />
                      )}
                    </div>
                  </td>
                )}
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1.5">
                    {amounts.map((a) => (
                      <button
                        key={a}
                        disabled={busy !== null}
                        onClick={() => buy(l, a)}
                        title={`Buy ${a} SOL${l.migrated ? " (routes through PumpSwap)" : ""}`}
                        className={cx(
                          "inline-flex h-7 items-center gap-1 rounded-full px-2.5 font-mono text-xs font-semibold transition active:scale-95 disabled:opacity-40",
                          busy === `${l.mint}:${a}` ? "bg-violet-400 text-ink-950" : "bg-violet-600/90 text-white hover:bg-violet-500",
                        )}
                      >
                        <Zap size={11} /> {a}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
