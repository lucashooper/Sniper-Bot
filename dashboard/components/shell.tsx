"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useState } from "react";
import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { ArrowDownToLine, BarChart3, Crosshair, KeyRound, LayoutDashboard, LogOut, Radio, Wallet } from "lucide-react";
import { DEFAULT_URL, readConn, useEngine } from "@/lib/engine";
import { useAuth } from "./auth-gate";
import { DepositDrawer } from "./deposit";
import { ModeSwitch } from "./mode-switch";
import { cx } from "./ui";

export const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/wallets", label: "Wallets & Balances", icon: Wallet },
  { href: "/snipe", label: "Snipe Configuration", icon: Crosshair },
  { href: "/feed", label: "Live Feed", icon: Radio },
  { href: "/pnl", label: "PnL Analytics", icon: BarChart3 },
  { href: "/settings", label: "Settings & Keys", icon: KeyRound },
];

function ModeDot() {
  const { state, connected } = useEngine();
  if (!connected) return <span className="flex items-center gap-1.5 text-[11px] text-neutral-500"><i className="h-1.5 w-1.5 rounded-full bg-neutral-600" />offline</span>;
  const live = state?.status.live;
  return (
    <span className={cx("flex items-center gap-1.5 text-[11px] font-medium", live ? "text-rose-300" : "text-emerald-300")}>
      <i className={cx("h-1.5 w-1.5 rounded-full", live ? "animate-pulse bg-rose-400" : "bg-emerald-400")} />
      {live ? "LIVE trading" : "Simulation"}
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { state, connected, error } = useEngine();
  const { email, signOut } = useAuth();
  const [depositOpen, setDepositOpen] = useState(false);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const value = state ? state.metrics.portfolioValueSol : 0;

  return (
    <div className="flex min-h-screen">
      {/* Floating icon rail */}
      <aside className="fixed inset-y-3 left-3 z-30 flex w-14 flex-col items-center gap-2 rounded-2xl border border-neutral-800 bg-ink-900/90 py-3 backdrop-blur">
        <div className="mb-2 grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-emerald-400 text-ink-950 shadow-[0_0_24px_-4px_rgba(139,92,246,0.6)]">
          <Crosshair size={20} strokeWidth={2.5} />
        </div>
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            title={label}
            className={cx(
              "relative grid h-10 w-10 place-items-center rounded-xl transition",
              active(href) ? "bg-neutral-800 text-white" : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-200",
            )}
          >
            {active(href) && <motion.span layoutId="rail" className="absolute -left-3 h-5 w-1 rounded-r-full bg-violet-400" />}
            <Icon size={18} />
          </Link>
        ))}
      </aside>

      {/* Workspace panel, like Whop's community sidebar */}
      <aside className="fixed inset-y-0 left-20 z-20 hidden w-60 flex-col border-r border-neutral-800/80 bg-ink-950 lg:flex">
        <div className="flex items-center gap-3 border-b border-neutral-800/80 px-4 py-4">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-neutral-800 bg-ink-800 font-mono text-xs font-bold text-emerald-300">SB</div>
          <div className="min-w-0">
            <div className="truncate font-semibold">Sniper Bot</div>
            <ModeDot />
          </div>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cx(
                "flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition",
                active(href) ? "bg-neutral-800 font-medium text-white" : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200",
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-2 border-t border-neutral-800/80 p-4 text-[11px] text-neutral-500">
          <div className="flex justify-between"><span>Market feed</span><span className="text-neutral-300">{state?.status.marketSource === "stream" ? "Solana WebSocket" : "Synthetic"}</span></div>
          <div className="flex justify-between"><span>Keystore</span><span className={state?.status.keystoreUnlocked ? "text-emerald-300" : "text-amber-300"}>{state?.status.keystoreUnlocked ? "Unlocked" : "Locked"}</span></div>
          <div className="flex justify-between"><span>Open positions</span><span className="text-neutral-300">{state?.metrics.openCount ?? 0}</span></div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col pl-20 lg:pl-80">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-3 border-b border-neutral-800/80 bg-ink-950/80 px-4 backdrop-blur md:px-8">
          <div className="hidden text-sm text-neutral-400 sm:block">{NAV.find((n) => active(n.href))?.label}</div>
          <div className="ml-auto flex items-center gap-2">
            <ModeSwitch />
            <button
              onClick={() => setDepositOpen(true)}
              disabled={!connected}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-emerald-500 px-3.5 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              <ArrowDownToLine size={14} /> Deposit
            </button>
            <span className="hidden rounded-full border border-neutral-800 bg-ink-800 px-3.5 py-1.5 font-mono text-sm font-semibold tabular-nums md:inline">
              {value.toFixed(3)} SOL
            </span>
            {email && (
              <button onClick={signOut} title={`Sign out ${email}`} aria-label="Sign out" className="grid h-9 w-9 place-items-center rounded-full border border-neutral-800 bg-ink-800 text-neutral-400 hover:text-neutral-100">
                <LogOut size={15} />
              </button>
            )}
          </div>
        </header>
        {!connected && <OfflineNotice error={error} />}
        <DepositDrawer open={depositOpen} onClose={() => setDepositOpen(false)} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}

/** Explains why the engine is unreachable, using the hop-by-hop check when it has run. */
function OfflineNotice({ error }: { error: string | null }) {
  const { diagnosis, runDiagnosis } = useEngine();
  const [busy, setBusy] = useState(false);
  const url = readConn().url;
  const failed = diagnosis?.find((c) => !c.ok);
  let msg: React.ReactNode;
  if (failed) msg = <><span className="text-neutral-100">{failed.label}:</span> {failed.detail}</>;
  else if (error === "unauthorized") msg = <>The engine rejected this sign-in. Running a check for the exact reason…</>;
  else if (!diagnosis) msg = <>Connecting to <code className="font-mono">{url}</code>…</>;
  else msg = <>Every check passed just now; reconnecting.</>;
  return (
    <div className="mx-4 mt-4 rounded-xl border border-neutral-800 bg-ink-900 px-4 py-3 text-sm text-neutral-300 md:mx-8">
      <div className="flex gap-3">
        <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", failed ? "bg-rose-400" : "bg-neutral-500")} />
        <div className="min-w-0 flex-1">
          <span className="font-medium text-neutral-100">Engine offline. Nothing is trading.</span> {msg}
          {url === DEFAULT_URL ? null : <span className="text-neutral-500"> (address saved under Settings: {url})</span>}
        </div>
        <button
          onClick={async () => (setBusy(true), await runDiagnosis().finally(() => setBusy(false)))}
          disabled={busy}
          className="h-7 shrink-0 rounded-lg border border-neutral-800 bg-ink-800 px-2.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {diagnosis && (
        <ol className="mt-3 space-y-1.5 border-t border-neutral-800 pt-3 text-xs">
          {diagnosis.map((c) => (
            <li key={c.label} className="flex gap-2">
              {c.ok ? <CheckCircle2 size={14} className="mt-px shrink-0 text-emerald-400" /> : <XCircle size={14} className="mt-px shrink-0 text-rose-400" />}
              <span className={c.ok ? "text-neutral-400" : "text-neutral-200"}>
                <span className="font-medium">{c.label}</span>{c.ok ? `: ${c.detail}` : ""}
              </span>
            </li>
          ))}
          {["Engine address", "Engine responds", "Engine accepts this site", "Sign-in accepted", "Live connection"]
            .slice(diagnosis.length)
            .map((l) => (
              <li key={l} className="flex gap-2 text-neutral-600">
                <CircleDashed size={14} className="mt-px shrink-0" /> {l}
              </li>
            ))}
        </ol>
      )}
    </div>
  );
}
