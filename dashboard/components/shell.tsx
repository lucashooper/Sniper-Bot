"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useState } from "react";
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
  { href: "/feed", label: "Live Feed & Logs", icon: Radio },
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
        {state?.status.live && connected && (
          <div className="sticky top-0 z-20 flex items-center justify-center gap-2 bg-rose-600 px-4 py-1 text-center text-xs font-semibold tracking-wide text-white">
            LIVE EXECUTION: trades spend real SOL
          </div>
        )}
        <header className={cx("sticky z-10 flex h-16 items-center justify-between gap-3 border-b bg-ink-950/80 px-4 backdrop-blur md:px-8", state?.status.live && connected ? "top-6 border-rose-500/40" : "top-0 border-neutral-800/80")}>
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

/** Explains why the engine is unreachable in terms of what to change, not just that it failed. */
function OfflineNotice({ error }: { error: string | null }) {
  const url = readConn().url;
  const local = /\/\/(127\.0\.0\.1|localhost)/.test(url);
  const onHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  let msg: React.ReactNode;
  if (error === "unauthorized") {
    msg = <>The engine rejected this sign-in. Check that <code className="font-mono">OWNER_EMAIL</code> on the engine host matches the account you signed in with.</>;
  } else if (local && onHttps) {
    msg = (
      <>
        This site is pointed at <code className="font-mono">{url}</code>, which is your own computer, not the server. Set{" "}
        <code className="font-mono">NEXT_PUBLIC_ENGINE_URL</code> on Netlify to your engine&apos;s https address and redeploy
        {url !== DEFAULT_URL && <>, or fix the address saved under Settings</>}.
      </>
    );
  } else if (onHttps && url.startsWith("http://")) {
    msg = <>An https site cannot call an http engine. Use the engine&apos;s https address (Railway gives you one).</>;
  } else if (error === "unreachable" || error === "bad-url") {
    msg = local ? (
      <>Start the engine with <code className="font-mono">npm run dev:engine</code>, or set its address under Settings.</>
    ) : (
      <>Cannot reach <code className="font-mono">{url}</code>. Check the engine is running on its host and that this site&apos;s address is in its <code className="font-mono">DASHBOARD_ORIGINS</code>.</>
    );
  } else {
    msg = <>Connecting to <code className="font-mono">{url}</code>…</>;
  }
  return (
    <div className="mx-4 mt-4 flex gap-3 rounded-xl border border-neutral-800 bg-ink-900 px-4 py-3 text-sm text-neutral-300 md:mx-8">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-neutral-500" />
      <div>
        <span className="font-medium text-neutral-100">Engine offline. Nothing is trading.</span> {msg}
      </div>
    </div>
  );
}
