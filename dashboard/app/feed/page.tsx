"use client";

import { Columns3, Filter, List, Search, SlidersHorizontal, Star, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useEngine } from "@/lib/engine";
import { Terminal } from "@/components/terminal";
import { FiltersPanel } from "@/components/filters-panel";
import { TokenFeed, defaultWalletId } from "@/components/token-feed";
import { Pulse } from "@/components/pulse";
import { devSearchText, useDevs } from "@/components/devs";
import { pulseBucket, type PulseBucket } from "@/lib/pulse";
import { useSettingsDraft } from "@/components/use-settings";
import { WalletOptions, usePickedWallet } from "@/components/wallet-picker";
import { Badge, Button, Card, Field, Input, Modal, Toggle, cx, useToast } from "@/components/ui";

const LOG_FILTERS: { label: string; sources?: string[] }[] = [
  { label: "All" },
  { label: "Detection", sources: ["stream", "detect"] },
  { label: "Jito bundles", sources: ["jito"] },
  { label: "Trades & exits", sources: ["trade", "exit", "safety"] },
  { label: "Wallets", sources: ["wallet"] },
  { label: "Engine", sources: ["engine", "sim"] },
];

const VIEWS = [
  { id: "new", label: "New pairs" },
  { id: "stretch", label: "Final stretch" },
  { id: "graduated", label: "Graduated" },
] as const;

/** Per-browser feed preferences (layout, dev filter); labels themselves live on the engine. */
interface FeedPrefs {
  layout: "pulse" | "list";
  devs: "all" | "followed";
  showHidden: boolean;
}
const PREFS_KEY = "feed.prefs";
function usePrefs(): [FeedPrefs, (p: Partial<FeedPrefs>) => void] {
  const [prefs, setPrefs] = useState<FeedPrefs>({ layout: "pulse", devs: "all", showHidden: false });
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) setPrefs((p) => ({ ...p, ...(JSON.parse(raw) as Partial<FeedPrefs>) }));
    } catch {
      /* private window or blocked storage: defaults */
    }
  }, []);
  const update = useCallback((patch: Partial<FeedPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* not saved; still applies for this visit */
      }
      return next;
    });
  }, []);
  return [prefs, update];
}

export default function FeedPage() {
  const [tab, setTab] = useState<"tokens" | "logs">("tokens");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">Live Feed</h1>
        <div className="flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5">
          {(["tokens", "logs"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx("rounded-md px-3 py-1 text-xs font-medium capitalize transition", tab === t ? "bg-white/[0.08] text-white" : "text-neutral-500 hover:text-neutral-200")}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === "tokens" ? <Tokens /> : <Logs />}
    </div>
  );
}

function Tokens() {
  const { state } = useEngine();
  const { devs, manage, supported: devsSupported } = useDevs();
  const { draft, set, save, dirty, reset } = useSettingsDraft();
  const toast = useToast();
  const [prefs, setPrefs] = usePrefs();
  const [view, setView] = useState<PulseBucket>("new");
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState<number>(0.25);
  const [walletId, setWalletId] = usePickedWallet();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [presetText, setPresetText] = useState<string | null>(null);

  const followedCount = useMemo(() => Object.values(devs).filter((d) => d.mode === "follow").length, [devs]);
  const labelledCount = Object.keys(devs).length;

  // Search (ticker, name, CA, dev address or dev label) and the dev filter, shared by both layouts.
  const { filtered, hiddenCount } = useMemo(() => {
    const all = state?.launches ?? [];
    const needle = q.trim().toLowerCase();
    let hidden = 0;
    const out = all.filter((l) => {
      const tag = devs[l.creator];
      if (tag?.mode === "hide" && !prefs.showHidden) return (hidden++, false);
      if (prefs.devs === "followed" && tag?.mode !== "follow") return false;
      return !needle || `${l.symbol} ${l.name} ${l.mint} ${devSearchText(l.creator, tag)}`.toLowerCase().includes(needle);
    });
    return { filtered: out, hiddenCount: hidden };
  }, [state?.launches, q, devs, prefs.devs, prefs.showHidden]);

  const listed = useMemo(() => {
    const inView = filtered.filter((l) => pulseBucket(l) === view);
    return view === "stretch" ? inView.sort((a, b) => b.curvePct - a.curvePct) : inView;
  }, [filtered, view]);

  const presets = state?.settings.quickBuyPresets ?? [0.1, 0.5, 1];
  const presetKey = presets.join(",");
  const amounts = useMemo(() => {
    const a = presetKey ? presetKey.split(",").map(Number) : [];
    if (custom > 0 && !a.includes(custom)) a.push(custom);
    return a;
  }, [presetKey, custom]);

  if (!state || !draft) return null;
  const live = state.status.live;
  const chosen = walletId || defaultWalletId(state);

  const savePresets = () => {
    if (presetText === null) return;
    const list = presetText.split(/[\s,]+/).map(Number).filter((n) => n > 0);
    setPresetText(null);
    if (list.length) save({ quickBuyPresets: list }).catch((e) => toast.show(e.message, "err"));
  };
  const seg = (on: boolean) => cx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition", on ? "bg-white/[0.08] text-white" : "text-neutral-500 hover:text-neutral-200");

  const toolbar = (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.05] px-3 py-2">
        <div className="flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5" role="tablist" aria-label="Layout">
          <button onClick={() => setPrefs({ layout: "pulse" })} className={seg(prefs.layout === "pulse")} title="Three columns: New pairs, Final stretch, Graduated">
            <Columns3 size={13} /> Columns
          </button>
          <button onClick={() => setPrefs({ layout: "list" })} className={seg(prefs.layout === "list")} title="One table, one column at a time">
            <List size={13} /> List
          </button>
        </div>
        {prefs.layout === "list" && (
          <div className="flex items-center gap-4 pl-1">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)} className={cx("text-[14px] font-medium transition", view === v.id ? "text-white" : "text-neutral-500 hover:text-neutral-300")}>
                {v.label}
              </button>
            ))}
          </div>
        )}
        <Badge tone={state.status.marketSource === "stream" ? "green" : "neutral"}>{state.status.marketSource === "stream" ? "mainnet" : "synthetic"}</Badge>
          <div className="relative w-full max-w-[240px] flex-1 sm:w-60 sm:flex-none">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticker, CA, dev wallet or label" className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.02] pl-7 pr-3 text-[13px] outline-none transition placeholder:text-neutral-600 focus:border-white/[0.14]" />
          </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5" aria-label="Dev filter">
            <button onClick={() => setPrefs({ devs: "all" })} className={seg(prefs.devs === "all")}>All devs</button>
            <button
              onClick={() => setPrefs({ devs: "followed" })}
              className={seg(prefs.devs === "followed")}
              title={followedCount ? `Only coins from your ${followedCount} followed dev${followedCount === 1 ? "" : "s"}` : "Follow a dev first: click a dev address on any coin"}
            >
              <Star size={12} className={prefs.devs === "followed" ? "fill-amber-300 text-amber-300" : undefined} /> Followed{followedCount ? ` ${followedCount}` : ""}
            </button>
          </div>
          <Button size="sm" variant="ghost" onClick={manage} disabled={!devsSupported} title={devsSupported ? "Labelled, followed and hidden dev wallets" : "Your engine is older than dev labels; it picks them up after it redeploys"}>
            <UserRound size={13} /> Dev list{labelledCount ? ` ${labelledCount}` : ""}
          </Button>
          {hiddenCount > 0 && (
            <button onClick={() => setPrefs({ showHidden: true })} className="text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-200 hover:underline" title="Coins from devs you hid">
              {hiddenCount} hidden
            </button>
          )}
          {prefs.showHidden && (
            <button onClick={() => setPrefs({ showHidden: false })} className="text-[11px] text-amber-300/80 hover:text-amber-200">Showing hidden devs</button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 text-[13px]">
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Presets</span>
          <input
            value={presetText ?? presets.join(", ")}
            onChange={(e) => setPresetText(e.target.value)}
            onBlur={savePresets}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            className="h-7 w-28 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 text-xs outline-none transition focus:border-white/[0.14]"
            title="Comma-separated SOL amounts for the buy buttons"
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Custom</span>
          <input type="number" min={0} step="0.01" value={custom} onChange={(e) => setCustom(Number(e.target.value))} className="h-7 w-20 rounded-md border border-white/[0.06] bg-white/[0.02] px-2 text-xs outline-none transition focus:border-white/[0.14]" />
          <span className="text-xs text-neutral-500">SOL</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Wallet</span>
          <select value={chosen} onChange={(e) => setWalletId(e.target.value)} className="h-7 rounded-md border border-white/[0.06] bg-ink-900 px-2 text-xs outline-none transition focus:border-white/[0.14]">
            <WalletOptions paper={!live} />
          </select>
        </label>
        <div className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-2">
            <span className="text-neutral-500">Auto-snipe</span>
            <Toggle checked={state.settings.autoSnipe} onChange={(v) => save({ autoSnipe: v }).then(() => toast.show(v ? `Auto-snipe on: ${state.settings.autoSnipeSol} SOL per coin that passes your filters` : "Auto-snipe off"), (e) => toast.show(e.message, "err"))} />
          </span>
          <Button size="sm" onClick={() => setFiltersOpen(true)}>
            <SlidersHorizontal size={13} /> Filters
          </Button>
        </div>
      </div>
    </Card>
  );

  return (
    <>
      {toast.node}
      {toolbar}
      {prefs.devs === "followed" && filtered.length === 0 && (
        <p className="px-1 text-xs text-neutral-500">
          {followedCount ? "None of your followed devs has a coin in the feed right now." : "You do not follow any dev yet. Click a dev address on any coin and choose Follow."}
        </p>
      )}
      {prefs.layout === "pulse" ? (
        <Pulse launches={filtered} amounts={amounts} walletId={chosen} column={view} onColumn={setView} />
      ) : (
        <Card>
          <div className="max-h-[calc(100vh-232px)] min-h-[420px] overflow-y-auto scrollbar-thin">
            <TokenFeed launches={listed} presets={presets} custom={custom} walletId={chosen} />
          </div>
        </Card>
      )}

      <Modal
        open={filtersOpen}
        onClose={() => (reset(), setFiltersOpen(false))}
        title="Auto-snipe filters"
        footer={
          <>
            <Button variant="ghost" onClick={() => (reset(), setFiltersOpen(false))}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!dirty}
              onClick={() => save().then(() => (setFiltersOpen(false), toast.show("Filters saved")), (e) => toast.show(e.message, "err"))}
            >
              <Filter size={14} /> Save filters
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Buy per coin"><Input type="number" step="0.01" min={0} value={draft.autoSnipeSol} onChange={(e) => set({ autoSnipeSol: Number(e.target.value) })} suffix="SOL" /></Field>
          <Field label="Max buys per hour"><Input type="number" min={1} value={draft.autoSnipeMaxPerHour} onChange={(e) => set({ autoSnipeMaxPerHour: Number(e.target.value) })} /></Field>
        </div>
        <FiltersPanel draft={draft} set={set} />
        <p className="text-xs text-neutral-500">Every buy still runs the safety checks (mint and freeze authority, dangerous Token-2022 extensions, top holder) and your take-profit and stop-loss rules.</p>
      </Modal>
    </>
  );
}

function Logs() {
  const { connected, logs } = useEngine();
  const [f, setF] = useState(0);
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <i className={cx("h-2 w-2 rounded-full", connected ? "animate-pulse bg-emerald-400" : "bg-neutral-600")} />
          terminal
          <span className="font-normal text-neutral-500">{logs.length} lines</span>
        </span>
      }
      action={
        <div className="flex flex-wrap gap-1">
          {LOG_FILTERS.map((x, i) => (
            <button key={x.label} onClick={() => setF(i)} className={cx("rounded-lg px-2.5 py-1 text-xs", f === i ? "bg-white/[0.08] text-white" : "text-neutral-500 hover:text-neutral-200")}>
              {x.label}
            </button>
          ))}
        </div>
      }
    >
      <Terminal height="h-[calc(100vh-260px)] min-h-[420px]" sources={LOG_FILTERS[f].sources} />
    </Card>
  );
}
