"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { ArrowDownToLine, BarChart3, ChevronsLeft, ChevronsRight, Crosshair, KeyRound, LayoutDashboard, LogOut, Radio, Search, Wallet } from "lucide-react";
import { DEFAULT_URL, readConn, useEngine } from "@/lib/engine";
import { coinPage, short } from "@/lib/format";
import { useAuth } from "./auth-gate";
import { DepositDrawer } from "./deposit";
import { ModeSwitch } from "./mode-switch";
import { cx } from "./ui";

export const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/feed", label: "Live Feed", icon: Radio },
  { href: "/wallets", label: "Wallets", icon: Wallet },
  { href: "/snipe", label: "Snipe Config", icon: Crosshair },
  { href: "/pnl", label: "PnL", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: KeyRound },
];

function useCollapsed() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("ui.sidebar") === "collapsed");
    } catch {
      /* storage blocked */
    }
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("ui.sidebar", c ? "open" : "collapsed");
      } catch {
        /* storage blocked */
      }
      return !c;
    });
  return [collapsed, toggle] as const;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { state, connected, error } = useEngine();
  const { email, signOut } = useAuth();
  const [depositOpen, setDepositOpen] = useState(false);
  const [collapsed, toggle] = useCollapsed();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  // Trading pages use the full width; forms and settings read better in a column.
  const wide = path.startsWith("/feed") || path.startsWith("/token") || path === "/";

  return (
    <div className="flex min-h-screen">
      {/* Floating sidebar (Whop-style), collapsible to an icon rail. Always a rail on small screens. */}
      <aside
        className={cx(
          "fixed inset-y-2 left-2 z-30 flex w-14 flex-col rounded-xl border border-white/[0.06] bg-ink-900/90 py-2.5 transition-[width] duration-200",
          !collapsed && "lg:w-52",
        )}
      >
        <div className={cx("mb-3 flex items-center gap-2.5 px-2.5", collapsed && "lg:justify-center")}>
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-emerald-400 text-ink-950">
            <Crosshair size={18} strokeWidth={2.5} />
          </div>
          {!collapsed && <span className="hidden truncate text-sm font-semibold tracking-tight lg:block">Sniper Bot</span>}
        </div>
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              title={label}
              className={cx(
                "relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition",
                active(href) ? "bg-white/[0.07] text-white" : "text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-200",
              )}
            >
              {active(href) && <span className="absolute -left-2 h-4 w-0.5 rounded-r-full bg-emerald-400" />}
              <Icon size={16} className="shrink-0" />
              {!collapsed && <span className="hidden truncate lg:block">{label}</span>}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-3 px-2">
          {!collapsed && (
            <div className="hidden space-y-1.5 rounded-lg bg-white/[0.02] px-2.5 py-2 text-[11px] text-neutral-500 lg:block">
              <Row label="Market feed" value={state?.status.marketSource === "stream" ? "Mainnet" : "Synthetic"} tone={state?.status.marketSource === "stream" ? "good" : undefined} />
              <Row label="Keystore" value={state?.status.keystoreUnlocked ? "Unlocked" : "Locked"} tone={state?.status.keystoreUnlocked ? "good" : "warn"} />
              <Row label="Open positions" value={String(state?.metrics.openCount ?? 0)} />
            </div>
          )}
          <button
            onClick={toggle}
            className="hidden h-8 w-full items-center justify-center rounded-lg text-neutral-600 transition hover:bg-white/[0.04] hover:text-neutral-300 lg:flex"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
          </button>
        </div>
      </aside>

      <div className={cx("flex min-w-0 flex-1 flex-col pl-16 transition-[padding] duration-200", !collapsed && "lg:pl-56")}>
        <header className="frost sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-white/[0.05] bg-ink-950/75 px-3 md:px-5">
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <EngineDot connected={connected} />
            <ModeSwitch />
            <WalletChip />
            <button
              onClick={() => setDepositOpen(true)}
              disabled={!connected}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              <ArrowDownToLine size={13} /> Deposit
            </button>
            {email && (
              <button onClick={signOut} title={`Sign out ${email}`} aria-label="Sign out" className="grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition hover:bg-white/[0.05] hover:text-neutral-100">
                <LogOut size={15} />
              </button>
            )}
          </div>
        </header>
        {!connected && <OfflineNotice error={error} />}
        <DepositDrawer open={depositOpen} onClose={() => setDepositOpen(false)} />
        <main className={cx("mx-auto w-full flex-1 px-3 py-5 md:px-5", wide ? "max-w-[1680px]" : "max-w-6xl")}>{children}</main>
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{label}</span>
      <span className={cx(tone === "good" ? "text-emerald-400" : tone === "warn" ? "text-amber-300" : "text-neutral-300")}>{value}</span>
    </div>
  );
}

/** Engine connectivity at a glance: a soft pulsing green dot while the live connection is up. */
function EngineDot({ connected }: { connected: boolean }) {
  return (
    <span className="hidden items-center gap-1.5 px-1.5 text-[11px] text-neutral-500 sm:flex" title={connected ? "Engine connected: live updates on" : "Engine offline"}>
      <span className="relative flex h-1.5 w-1.5">
        {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />}
        <span className={cx("relative inline-flex h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-neutral-600")} />
      </span>
      {connected ? "Engine" : "Offline"}
    </span>
  );
}

/** The master wallet and its SOL balance, e.g. "HLxu…HomQ | 1.420 SOL". */
function WalletChip() {
  const { state } = useEngine();
  const master = state?.wallets.find((w) => w.isMaster);
  if (!state || !master) return null;
  const bal = state.balances[master.id]?.sol;
  const noRpc = !state.status.rpcConfigured;
  return (
    <Link
      href="/wallets"
      title={noRpc ? "Balances need SOLANA_RPC_URL on the engine" : `${master.name}: ${master.publicKey}`}
      className="hidden h-8 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 text-xs transition hover:border-white/[0.12] md:inline-flex"
    >
      <Wallet size={13} className="text-neutral-500" />
      <span className="font-mono text-neutral-400">{short(master.publicKey, 4)}</span>
      <span className="h-3 w-px bg-white/10" />
      <span className="font-medium text-neutral-100">{bal === undefined || noRpc ? "–" : bal.toFixed(bal < 1 ? 4 : 3)} SOL</span>
    </Link>
  );
}

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** One search for everything: coins in the feed by name or ticker, or paste any contract address to open its page. */
function GlobalSearch() {
  const { state } = useEngine();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needle = q.trim();
  const results = useMemo(() => {
    if (!needle) return [];
    const n = needle.toLowerCase();
    return (state?.launches ?? []).filter((l) => l.symbol.toLowerCase().includes(n) || l.name.toLowerCase().includes(n) || l.mint === needle).slice(0, 6);
  }, [needle, state?.launches]);
  const isMint = MINT_RE.test(needle);

  const go = (mint: string) => {
    setQ("");
    setOpen(false);
    input.current?.blur();
    router.push(coinPage(mint));
  };

  return (
    <div className="relative w-full max-w-md">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-600" />
      <input
        ref={input}
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0), setOpen(true))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, Math.max(0, results.length - 1))));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
          else if (e.key === "Escape") input.current?.blur();
          else if (e.key === "Enter") {
            if (results[sel]) go(results[sel].mint);
            else if (isMint) go(needle);
          }
        }}
        placeholder="Search by name, ticker or paste a CA"
        className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] pl-8 pr-8 text-[13px] text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-white/[0.14] focus:bg-white/[0.05]"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-white/10 px-1 text-[10px] text-neutral-600 sm:block">/</kbd>
      {open && needle && (
        <div className="absolute inset-x-0 top-10 z-40 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-900 shadow-2xl shadow-black/60">
          {results.map((l, i) => (
            <button
              key={l.mint}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(l.mint)}
              onMouseEnter={() => setSel(i)}
              className={cx("flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px]", i === sel ? "bg-white/[0.06]" : "")}
            >
              <span className="font-medium text-neutral-100">{l.symbol}</span>
              <span className="truncate text-neutral-500">{l.name}</span>
              <span className="ml-auto font-mono text-[11px] text-neutral-600">{short(l.mint, 4)}</span>
            </button>
          ))}
          {!results.length && (
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => isMint && go(needle)} disabled={!isMint} className="w-full px-3 py-2.5 text-left text-[13px] text-neutral-500">
              {isMint ? <>Open <span className="font-mono text-neutral-200">{short(needle, 6)}</span></> : "No coin in the feed matches. Paste a contract address to open any coin."}
            </button>
          )}
        </div>
      )}
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
    <div className="mx-3 mt-3 rounded-xl border border-white/[0.07] bg-ink-900 px-4 py-3 text-sm text-neutral-300 md:mx-5">
      <div className="flex gap-3">
        <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", failed ? "bg-rose-400" : "bg-neutral-500")} />
        <div className="min-w-0 flex-1">
          <span className="font-medium text-neutral-100">Engine offline. Nothing is trading.</span> {msg}
          {url === DEFAULT_URL ? null : <span className="text-neutral-500"> (address saved under Settings: {url})</span>}
        </div>
        <button
          onClick={async () => (setBusy(true), await runDiagnosis().finally(() => setBusy(false)))}
          disabled={busy}
          className="h-7 shrink-0 rounded-lg border border-white/[0.07] bg-ink-800 px-2.5 text-xs text-neutral-300 hover:bg-white/[0.06] disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {diagnosis && (
        <ol className="mt-3 space-y-1.5 border-t border-white/[0.07] pt-3 text-xs">
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
