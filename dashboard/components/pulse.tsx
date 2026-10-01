"use client";

import { Pause, Rocket, ShieldAlert, Users, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngine } from "@/lib/engine";
import { coinPage } from "@/lib/format";
import { prefetchToken } from "@/lib/token-cache";
import { STRETCH_PCT, pulseBucket, type PulseBucket } from "@/lib/pulse";
import type { DevTag, Launch } from "@/lib/types";
import { Age, Avatar, CopyCa, Socials, money, useQuickBuy } from "./token-feed";
import { DevChip, useDevs } from "./devs";
import { cx } from "./ui";

/**
 * Axiom-style Pulse: New pairs | Final stretch | Graduated side by side. Coins move between columns on their own as
 * their bonding curve fills; only the cards whose coin changed re-render (the engine pushes changed coins only and
 * every card is memoised). Hovering a column pauses its order, so the button under the cursor never jumps away.
 */

export const COLUMNS: { id: PulseBucket; label: string; hint: string }[] = [
  { id: "new", label: "New pairs", hint: `Bonding curve under ${STRETCH_PCT}%` },
  { id: "stretch", label: "Final stretch", hint: `Curve ${STRETCH_PCT}% to 99%: about to graduate` },
  { id: "graduated", label: "Graduated", hint: "Curve complete, trading on PumpSwap" },
];

export function Pulse({ launches, amounts, walletId, column, onColumn }: { launches: Launch[]; amounts: number[]; walletId: string; column: PulseBucket; onColumn: (c: PulseBucket) => void }) {
  const { state } = useEngine();
  const solUsd = state?.solUsd ?? null;
  const { buy, busy, toastNode } = useQuickBuy(walletId);
  const router = useRouter();
  const open = useCallback((mint: string) => router.push(coinPage(mint)), [router]);
  // Load the coin page's code (and its chart library) ahead of the first click.
  useEffect(() => router.prefetch("/token/"), [router]);
  const split = useMemo(() => {
    const out: Record<PulseBucket, Launch[]> = { new: [], stretch: [], graduated: [] };
    for (const l of launches) out[pulseBucket(l)].push(l);
    return out;
  }, [launches]);

  return (
    <>
      {toastNode}
      {/* Below the large breakpoint the columns stack into tabs: one column at a time. */}
      <div className="mb-2 flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5 lg:hidden">
        {COLUMNS.map((c) => (
          <button key={c.id} onClick={() => onColumn(c.id)} className={cx("flex-1 rounded-md py-1.5 text-xs font-medium transition", column === c.id ? "bg-white/[0.08] text-white" : "text-neutral-500")}>
            {c.label} <span className="text-neutral-600">{split[c.id].length}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {COLUMNS.map((c) => (
          <Column key={c.id} col={c} coins={split[c.id]} hidden={column !== c.id} solUsd={solUsd} amounts={amounts} busy={busy} onBuy={buy} onOpen={open} />
        ))}
      </div>
    </>
  );
}

function Column({
  col,
  coins,
  hidden,
  solUsd,
  amounts,
  busy,
  onBuy,
  onOpen,
}: {
  col: (typeof COLUMNS)[number];
  coins: Launch[];
  hidden: boolean;
  solUsd: number | null;
  amounts: number[];
  busy: string | null;
  onBuy: (l: Launch, sol: number) => void;
  onOpen: (mint: string) => void;
}) {
  const { devs } = useDevs();
  // When each coin landed in this column, so the newest arrival is on top (a launch, or a coin that just crossed into
  // the final stretch or graduated). Coins present on first render keep the engine's order.
  const arrived = useRef(new Map<string, number>());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // After the first paint, every coin that shows up is an arrival and animates in.
    const t = setTimeout(() => setReady(true), 0);
    return () => clearTimeout(t);
  }, []);
  const [frozen, setFrozen] = useState<string[] | null>(null);

  const ordered = useMemo(() => {
    const seen = arrived.current;
    const now = Date.now();
    const here = new Set<string>();
    coins.forEach((l, i) => {
      here.add(l.mint);
      if (!seen.has(l.mint)) seen.set(l.mint, ready ? now : -i);
    });
    for (const m of seen.keys()) if (!here.has(m)) seen.delete(m);
    const key = (l: Launch) => (col.id === "graduated" ? (l.migratedAt ?? l.ts) : col.id === "new" ? l.ts : seen.get(l.mint)!);
    return [...coins].sort((a, b) => key(b) - key(a) || b.curvePct - a.curvePct);
  }, [coins, col.id, ready]);

  // Paused: keep the order from when the pointer came in; coins that left the column drop out, new ones wait.
  const shown = useMemo(() => {
    if (!frozen) return ordered;
    const by = new Map(ordered.map((l) => [l.mint, l]));
    return frozen.map((m) => by.get(m)).filter((l): l is Launch => !!l);
  }, [frozen, ordered]);
  const waiting = frozen ? ordered.length - shown.length : 0;

  return (
    <section className={cx("glass flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-ink-900/70", hidden ? "hidden lg:flex" : "flex")}>
      <header className="flex items-center gap-2 border-b border-white/[0.05] px-3 py-2">
        <h2 className="text-[13px] font-medium text-neutral-100" title={col.hint}>{col.label}</h2>
        <span className="text-[11px] text-neutral-600">{coins.length}</span>
        {frozen && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-amber-300/80">
            <Pause size={10} /> Paused{waiting > 0 ? ` · ${waiting} new` : ""}
          </span>
        )}
      </header>
      <div
        className="max-h-[calc(100vh-232px)] min-h-[420px] space-y-1.5 overflow-y-auto p-1.5 scrollbar-thin"
        onMouseEnter={() => setFrozen(ordered.map((l) => l.mint))}
        onMouseLeave={() => setFrozen(null)}
      >
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-xs text-neutral-500">
            <Rocket size={16} className="text-neutral-600" />
            {col.id === "new" ? "Listening for launches" : col.id === "stretch" ? `Coins appear here once their curve passes ${STRETCH_PCT}%` : "Coins appear here when they graduate to PumpSwap"}
          </div>
        ) : (
          shown.map((l) => (
            <PulseCard
              key={l.mint}
              l={l}
              tag={devs[l.creator]}
              solUsd={solUsd}
              amounts={amounts}
              busyAmt={busy?.startsWith(`${l.mint}:`) ? Number(busy.slice(l.mint.length + 1)) : null}
              locked={busy !== null}
              onBuy={onBuy}
              onOpen={onOpen}
              animate={ready}
            />
          ))
        )}
      </div>
    </section>
  );
}

const fmtValue = (sol: number, usd: number | null) => (usd ? money(sol * usd) : `${money(sol, "")} SOL`);

/** One coin, compact. Memoised: only re-renders when the engine sends a new object for this coin (or its dev label changes). */
const PulseCard = memo(function PulseCard({
  l,
  tag,
  solUsd,
  amounts,
  busyAmt,
  locked,
  onBuy,
  onOpen,
  animate,
}: {
  l: Launch;
  tag: DevTag | undefined;
  solUsd: number | null;
  amounts: number[];
  busyAmt: number | null;
  locked: boolean;
  onBuy: (l: Launch, sol: number) => void;
  onOpen: (mint: string) => void;
  animate: boolean;
}) {
  // Decided once at mount: cards present when the page opened do not all flash in.
  const [enter] = useState(animate);
  const value = (sol: number) => fmtValue(sol, solUsd);
  const prev = l.spark.length > 1 ? l.spark[l.spark.length - 2] : l.marketCapSol;
  const tick = l.marketCapSol > prev ? "tick-up" : l.marketCapSol < prev ? "tick-down" : "";
  const followed = tag?.mode === "follow";
  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return;
        onOpen(l.mint);
      }}
      onPointerDown={(e) => !(e.target as HTMLElement).closest("button, a") && prefetchToken(l.mint)}
      className={cx(
        "relative cursor-pointer overflow-hidden rounded-lg border bg-ink-900/60 p-2.5 transition-colors hover:border-white/[0.12] hover:bg-white/[0.02]",
        followed ? "border-amber-300/25" : "border-white/[0.06]",
        enter && "pulse-enter",
      )}
    >
      <div className="flex gap-2.5">
        <Avatar l={l} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-[13px] font-semibold text-neutral-50">{l.symbol}</span>
                <span className="min-w-0 truncate text-[12px] text-neutral-500">{l.name}</span>
                <CopyCa mint={l.mint} />
              </div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px]">
                <Age ts={l.ts} className="shrink-0 font-medium text-emerald-400" />
                <Socials l={l} />
                <DevChip address={l.creator} prefix="dev" />
              </div>
            </div>
            <div className="shrink-0 whitespace-nowrap text-right leading-tight">
              <div className="text-[13px] font-medium text-neutral-100">
                <span className="mr-1 text-[10px] font-normal text-neutral-600">MC</span>
                <span key={l.marketCapSol} className={tick}>{value(l.marketCapSol)}</span>
              </div>
              <div className="text-[11px] text-neutral-400">
                <span className="mr-1 text-[10px] text-neutral-600">V</span>
                {value(l.volumeSol)}
              </div>
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap text-[11px] text-neutral-400">
              <span className="flex items-center gap-1" title="Holders (wallets holding at least one token, from trades seen since launch)">
                <Users size={11} className="text-neutral-600" /> {l.holders ?? l.traders}
              </span>
              <span title={`${l.buys} buys / ${l.sells} sells`}>
                <span className="text-neutral-600">TX </span>
                {l.buys + l.sells}
              </span>
              {!l.migrated && (
                <span title="Bonding curve progress toward PumpSwap" className={cx(l.curvePct >= 80 && "text-emerald-400")}>
                  <span className="text-neutral-600">BC </span>
                  {l.curvePct.toFixed(0)}%
                </span>
              )}
              <span title="Dev wallet's share of the supply" className={cx(l.devHoldPct > 10 ? "text-rose-400" : l.devHoldPct > 5 ? "text-amber-300" : undefined)}>
                <span className="text-neutral-600">DH </span>
                {l.devHoldPct.toFixed(1)}%
              </span>
              {l.devSold && (
                <span className="flex items-center gap-0.5 text-rose-400" title="The dev wallet has sold">
                  <ShieldAlert size={11} /> dev sold
                </span>
              )}
              {l.sniped && <span className="text-emerald-300">sniped</span>}
            </div>
            <div className="flex shrink-0 gap-1">
              {amounts.slice(0, 4).map((a) => (
                <button
                  key={a}
                  disabled={locked}
                  onClick={() => onBuy(l, a)}
                  title={`Buy ${a} SOL${l.migrated ? " (routes through PumpSwap)" : ""}`}
                  className={cx(
                    "inline-flex h-6 items-center gap-0.5 rounded-md border px-1.5 text-[11px] font-medium transition active:scale-95 disabled:opacity-40",
                    busyAmt === a
                      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-200"
                      : "border-white/[0.06] bg-white/[0.02] text-neutral-300 hover:border-emerald-400/30 hover:bg-emerald-400/10 hover:text-emerald-200",
                  )}
                >
                  <Zap size={10} className="text-emerald-400" />
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* 2px bonding-curve strip along the bottom edge; amber once graduated. */}
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/[0.04]" title={l.migrated ? "Graduated to PumpSwap" : `Bonding curve ${l.curvePct.toFixed(1)}%`}>
        <div className={cx("h-full", l.migrated ? "bg-amber-400/80" : "bg-emerald-400/70")} style={{ width: `${Math.max(1, Math.min(100, l.migrated ? 100 : l.curvePct))}%` }} />
      </div>
    </div>
  );
});
