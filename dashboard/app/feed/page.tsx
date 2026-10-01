"use client";

import { Filter, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { useEngine } from "@/lib/engine";
import { Terminal } from "@/components/terminal";
import { FiltersPanel } from "@/components/filters-panel";
import { TokenFeed, defaultWalletId } from "@/components/token-feed";
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
  { id: "graduating", label: "Final stretch" },
  { id: "graduated", label: "Graduated" },
] as const;

export default function FeedPage() {
  const [tab, setTab] = useState<"tokens" | "logs">("tokens");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Feed</h1>
          <p className="mt-1 text-sm text-neutral-400">New Pump.fun launches as they are created, with one-click buys, and the engine&apos;s live log.</p>
        </div>
        <div className="flex rounded-xl border border-neutral-800 bg-ink-900 p-1">
          {(["tokens", "logs"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx("rounded-lg px-4 py-1.5 text-sm capitalize", tab === t ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-200")}>
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
  const { draft, set, save, dirty, reset } = useSettingsDraft();
  const toast = useToast();
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("new");
  const [q, setQ] = useState("");
  const [custom, setCustom] = useState<number>(0.25);
  const [walletId, setWalletId] = usePickedWallet();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [presetText, setPresetText] = useState<string | null>(null);

  const launches = useMemo(() => {
    const all = state?.launches ?? [];
    const needle = q.trim().toLowerCase();
    const matched = needle ? all.filter((l) => `${l.symbol} ${l.name} ${l.mint}`.toLowerCase().includes(needle)) : all;
    if (view === "graduated") return matched.filter((l) => l.migrated);
    if (view === "graduating") return matched.filter((l) => !l.migrated && l.curvePct >= 30).sort((a, b) => b.curvePct - a.curvePct);
    return matched;
  }, [state?.launches, q, view]);

  if (!state || !draft) return null;
  const live = state.status.live;
  const chosen = walletId || defaultWalletId(state);
  const presets = state.settings.quickBuyPresets ?? [0.1, 0.5, 1];

  const savePresets = () => {
    if (presetText === null) return;
    const list = presetText.split(/[\s,]+/).map(Number).filter((n) => n > 0);
    setPresetText(null);
    if (list.length) save({ quickBuyPresets: list }).catch((e) => toast.show(e.message, "err"));
  };

  return (
    <>
      {toast.node}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800/80 px-4 py-3">
          <div className="flex gap-1">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => setView(v.id)} className={cx("rounded-lg px-3 py-1.5 text-sm font-medium", view === v.id ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-200")}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="relative min-w-[180px] flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-600" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, ticker or CA" className="h-9 w-full rounded-xl border border-neutral-800 bg-ink-950 pl-8 pr-3 text-sm outline-none focus:border-violet-500/60" />
          </div>
          <Badge tone={state.status.marketSource === "stream" ? "green" : "violet"}>{state.status.marketSource === "stream" ? "mainnet" : "synthetic"}</Badge>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-neutral-800/80 px-4 py-3 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-neutral-400">Presets</span>
            <input
              value={presetText ?? presets.join(", ")}
              onChange={(e) => setPresetText(e.target.value)}
              onBlur={savePresets}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              className="h-8 w-28 rounded-lg border border-neutral-800 bg-ink-950 px-2 font-mono text-xs outline-none focus:border-violet-500/60"
              title="Comma-separated SOL amounts for the buy buttons"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-neutral-400">Custom</span>
            <input type="number" min={0} step="0.01" value={custom} onChange={(e) => setCustom(Number(e.target.value))} className="h-8 w-20 rounded-lg border border-neutral-800 bg-ink-950 px-2 font-mono text-xs outline-none focus:border-violet-500/60" />
            <span className="text-xs text-neutral-500">SOL</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-neutral-400">Wallet</span>
            <select value={chosen} onChange={(e) => setWalletId(e.target.value)} className="h-8 rounded-lg border border-neutral-800 bg-ink-950 px-2 text-xs outline-none focus:border-violet-500/60">
              <WalletOptions paper={!live} />
            </select>
          </label>
          <div className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-2">
              <span className="text-neutral-400">Auto-snipe</span>
              <Toggle checked={state.settings.autoSnipe} onChange={(v) => save({ autoSnipe: v }).then(() => toast.show(v ? `Auto-snipe on: ${state.settings.autoSnipeSol} SOL per coin that passes your filters` : "Auto-snipe off"), (e) => toast.show(e.message, "err"))} />
            </span>
            <Button size="sm" onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal size={13} /> Filters
            </Button>
          </div>
        </div>

        <div className="max-h-[calc(100vh-300px)] min-h-[420px] overflow-y-auto scrollbar-thin">
          <TokenFeed launches={launches} presets={presets} custom={custom} walletId={chosen} />
        </div>
      </Card>

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
            <button key={x.label} onClick={() => setF(i)} className={cx("rounded-lg px-2.5 py-1 text-xs", f === i ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-200")}>
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
