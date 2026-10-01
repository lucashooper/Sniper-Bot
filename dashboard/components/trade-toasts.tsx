"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ExternalLink, X } from "lucide-react";
import { api, useEngine } from "@/lib/engine";
import { compact, short, solscan } from "@/lib/format";
import type { Trade } from "@/lib/types";
import { money } from "@/components/token-feed";
import { cx } from "@/components/ui";

const SUPPLY = 1_000_000_000;
/** Orders placed from the dashboard toast from the click itself; everything else (auto-snipe, exit rules) from here. */
const CLICKED = new Set(["manual", "panic"]);

export interface TradeToast {
  id: number;
  tone: "buy" | "sell" | "err";
  title: string;
  /** Second line; `pnl` is drawn bright green or red. */
  sub?: string;
  pnl?: { text: string; good: boolean };
  links?: { href: string; label: string }[];
}

type Push = (t: Omit<TradeToast, "id">) => void;

const Ctx = createContext<Push | null>(null);

/** Toasts for a toast-less tree (should not happen) go to the console instead of crashing a trade handler. */
export function useTradeToasts(): Push {
  return useContext(Ctx) ?? ((t) => console.info("[toast]", t.title, t.sub ?? ""));
}

const usd = (sol: number, solUsd: number | null) => (solUsd ? money(sol * solUsd) : `${money(sol, "")} SOL`);
const signedValue = (sol: number, solUsd: number | null) => {
  const sign = sol >= 0 ? "+" : "-";
  return solUsd ? `${sign}$${Math.abs(sol * solUsd).toFixed(2)}` : `${sign}${Math.abs(sol).toFixed(4)} SOL`;
};
const txLinks = (trades: Trade[]) =>
  trades.filter((t) => t.signature).map((t) => ({ href: solscan(t.signature!), label: trades.length > 1 ? `${t.walletName} ${short(t.signature!)}` : short(t.signature!, 6) }));

/** "BOUGHT 0.02 SOL of $TICKER" with the market cap the fill happened at and its transaction. */
export function buyToast(t: Trade, solUsd: number | null, auto = false): Omit<TradeToast, "id"> {
  return {
    tone: "buy",
    title: `🟢 ${auto ? `${reasonLabel(t.reason)}: ` : ""}${t.mode === "sim" ? "PAPER " : ""}BOUGHT ${+t.solAmount.toFixed(4)} SOL of $${t.symbol}`,
    sub: `MC at fill ${usd(t.priceSol * SUPPLY, solUsd)} · ${t.walletName}`,
    links: txLinks([t]),
  };
}

/**
 * "SOLD 50% of $TICKER" with the realized PnL of what was sold. Several trades (a preset sell) add up into one toast.
 * The PnL percentage is against the cost of the part that was sold, fees included (what the engine books).
 */
export function sellToast(trades: Trade[], pctLabel: string, symbol: string, solUsd: number | null, failed = 0, auto?: string): Omit<TradeToast, "id"> {
  const realized = trades.reduce((s, t) => s + t.realizedPnlSol, 0);
  const cost = trades.reduce((s, t) => s + t.solAmount - t.realizedPnlSol, 0);
  const received = trades.reduce((s, t) => s + t.solAmount, 0);
  const ret = cost > 0 ? (realized / cost) * 100 : 0;
  const sim = trades.length > 0 && trades.every((t) => t.mode === "sim");
  return {
    tone: failed && !trades.length ? "err" : "sell",
    title: `🔴 ${auto ? `${auto}: ` : ""}${sim ? "PAPER " : ""}SOLD ${pctLabel} of $${symbol}${trades.length > 1 ? ` from ${trades.length} wallets` : ""}`,
    pnl: { text: `Realized PnL: ${signedValue(realized, solUsd)} (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%)`, good: realized >= 0 },
    sub: `Received ${received.toFixed(4)} SOL${failed ? ` · ${failed} wallet${failed > 1 ? "s" : ""} failed, see the Live log` : ""}`,
    links: txLinks(trades),
  };
}

function reasonLabel(r: string) {
  return r === "auto_snipe" ? "Auto-snipe" : r === "take_profit" ? "Take profit" : r === "stop_loss" ? "Stop loss" : r === "anti_rug" ? "Anti-rug" : r;
}

/**
 * Floating trade confirmations in the top-right corner. Orders clicked in the dashboard push their own toast when the
 * engine answers; trades the engine makes by itself (auto-snipe, take profit, stop loss, anti-rug) are picked up here
 * from the trade list so they toast too.
 */
export function TradeToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<TradeToast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const close = useCallback((id: number) => {
    setList((l) => l.filter((t) => t.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);
  const arm = useCallback((id: number, ms: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => close(id), ms));
  }, [close]);
  const push = useCallback<Push>(
    (t) => {
      const id = next.current++;
      // Newest on top; at most five on screen.
      setList((l) => [{ ...t, id }, ...l].slice(0, 5));
      arm(id, t.tone === "err" ? 15_000 : 8_000);
    },
    [arm],
  );

  useAutoTradeToasts(push);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 top-16 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        <AnimatePresence initial={false}>
          {list.map((t) => (
            <m.div
              key={t.id}
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              // Hovering keeps a toast up so its link can be clicked; leaving restarts a short timer.
              onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
              onMouseLeave={() => arm(t.id, 3000)}
              className={cx(
                "frost pointer-events-auto relative overflow-hidden rounded-xl border bg-ink-900/95 py-2.5 pl-4 pr-8 shadow-2xl shadow-black/40",
                t.tone === "buy" && "border-emerald-500/25",
                t.tone === "sell" && "border-rose-500/25",
                t.tone === "err" && "border-rose-500/40",
              )}
            >
              <i className={cx("absolute inset-y-0 left-0 w-[3px]", t.tone === "buy" ? "bg-emerald-400" : "bg-rose-500")} />
              <div className={cx("text-[13px] font-semibold tracking-tight", t.tone === "err" ? "text-rose-200" : "text-neutral-50")}>{t.title}</div>
              {t.pnl && <div className={cx("mt-0.5 text-[13px] font-semibold tabular-nums", t.pnl.good ? "text-emerald-400" : "text-rose-400")}>{t.pnl.text}</div>}
              {t.sub && <div className={cx("mt-0.5 text-[11.5px] leading-snug", t.tone === "err" ? "text-rose-300/80" : "text-neutral-400")}>{t.sub}</div>}
              {!!t.links?.length && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {t.links.map((l) => (
                    <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-[11px] text-violet-300 hover:underline">
                      {l.label} <ExternalLink size={10} />
                    </a>
                  ))}
                </div>
              )}
              <button onClick={() => close(t.id)} className="absolute right-2 top-2 rounded p-0.5 text-neutral-600 hover:bg-white/[0.06] hover:text-neutral-200" aria-label="Dismiss">
                <X size={13} />
              </button>
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

/** Toasts trades the engine made on its own, as they appear in the trade list. */
function useAutoTradeToasts(push: Push) {
  const { tradesVersion, connected, state } = useEngine();
  const seen = useRef<Set<string> | null>(null);
  const solUsd = useRef<number | null>(null);
  solUsd.current = state?.solUsd ?? null;
  useEffect(() => {
    if (!connected) return;
    let stale = false;
    api<Trade[]>("/api/trades").then(
      (all) => {
        if (stale) return;
        // The first list is history: remember it without toasting.
        if (!seen.current) return void (seen.current = new Set(all.map((t) => t.id)));
        const fresh = all.filter((t) => !seen.current!.has(t.id));
        for (const t of fresh) seen.current.add(t.id);
        for (const t of fresh.reverse()) {
          if (CLICKED.has(t.reason)) continue;
          push(t.side === "buy" ? buyToast(t, solUsd.current, true) : sellToast([t], compact(t.tokenAmount), t.symbol, solUsd.current, 0, reasonLabel(t.reason)));
        }
      },
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [tradesVersion, connected, push]);
}
