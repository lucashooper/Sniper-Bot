"use client";

import { AlertTriangle, CheckCircle2, Crosshair, Plus, ShieldAlert, ShieldCheck, Trash2, XCircle, Zap } from "lucide-react";
import { useState } from "react";
import { api, useEngine } from "@/lib/engine";
import { short } from "@/lib/format";
import type { ExitRule } from "@/lib/types";
import { useSettingsDraft } from "@/components/use-settings";
import { Badge, Button, Card, Field, Input, Modal, Toggle, cx, useToast } from "@/components/ui";

interface SafetyReport {
  ok: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
}

export default function SnipePage() {
  const { state } = useEngine();
  const { draft, set, save, dirty } = useSettingsDraft();
  const toast = useToast();
  const [mint, setMint] = useState("");
  const [amount, setAmount] = useState(0.25);
  const [walletId, setWalletId] = useState("");
  const [report, setReport] = useState<SafetyReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [firing, setFiring] = useState(false);

  const live = !!state?.status.live;
  const wallets = (state?.wallets ?? []).filter((w) => w.active);
  const chosen = walletId || wallets.find((w) => !w.isMaster)?.id || wallets[0]?.id || "";
  const validMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint.trim());

  const check = async () => {
    setChecking(true);
    setReport(null);
    try {
      setReport(await api<SafetyReport>("/api/safety", { method: "POST", body: { mint: mint.trim() } }));
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setChecking(false);
    }
  };

  const fire = async () => {
    setFiring(true);
    try {
      if (dirty) await save();
      await api("/api/snipe", { method: "POST", body: { mint: mint.trim(), walletId: chosen, sol: amount } });
      toast.show(live ? "Snipe landed" : "Paper snipe filled");
      setConfirmOpen(false);
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setFiring(false);
    }
  };

  if (!draft) return null;
  const tipLabel = draft.jitoTipDynamic ? `${draft.jitoTipSol}–${draft.jitoTipMaxSol} SOL (tracks tip floor)` : `${draft.jitoTipSol} SOL`;

  return (
    <div className="space-y-6">
      {toast.node}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Snipe Configuration</h1>
          <p className="mt-1 text-sm text-neutral-400">Buys go out as a Jito bundle: all-or-nothing, never in the public mempool, so a failed or front-run buy costs nothing.</p>
        </div>
        {dirty && <Button variant="primary" onClick={() => save().then(() => toast.show("Settings saved"), (e) => toast.show(e.message, "err"))}>Save settings</Button>}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Target" className="xl:col-span-2">
          <div className="space-y-5 p-5">
            <Field label="Token mint" hint="A Pump.fun coin on its bonding curve, or one that has graduated to PumpSwap. The engine picks the venue.">
              <div className="flex gap-2">
                <Input value={mint} onChange={(e) => (setMint(e.target.value), setReport(null))} placeholder="Paste a token mint address" className="font-mono text-xs" wrapperClassName="min-w-0 flex-1" />
                <Button onClick={check} disabled={!validMint || checking}>
                  <ShieldCheck size={15} /> {checking ? "Checking" : "Check"}
                </Button>
              </div>
            </Field>

            {report && (
              <div className={cx("rounded-xl border p-3", report.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-rose-500/30 bg-rose-500/5")}>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  {report.ok ? <ShieldCheck size={16} className="text-emerald-400" /> : <ShieldAlert size={16} className="text-rose-400" />}
                  {report.ok ? "Safety checks passed" : "Blocked by safety checks"}
                </div>
                <ul className="space-y-1">
                  {report.checks.map((c) => (
                    <li key={c.name} className="flex items-start gap-2 text-xs">
                      {c.pass ? <CheckCircle2 size={14} className="mt-px shrink-0 text-emerald-400" /> : <XCircle size={14} className="mt-px shrink-0 text-rose-400" />}
                      <span className="text-neutral-300">{c.name}:</span>
                      <span className="break-all text-neutral-500">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Buy amount"><Input type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} suffix="SOL" /></Field>
              <Field label="Wallet" hint={live ? undefined : wallets.length ? "Simulation fills on paper; a real wallet also dry-runs the real transaction." : "Simulation uses the paper wallet."}>
                <select
                  value={chosen}
                  onChange={(e) => setWalletId(e.target.value)}
                  className="h-10 w-full rounded-xl border border-neutral-800 bg-ink-950 px-3 text-sm outline-none focus:border-violet-500/60"
                >
                  {!live && <option value="">Paper wallet</option>}
                  {wallets.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} · {short(w.publicKey)}{w.isMaster ? " (master)" : ""}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Slippage"><Input type="number" min={0.5} max={99} value={draft.slippagePct} onChange={(e) => set({ slippagePct: Number(e.target.value) })} suffix="%" /></Field>
              <Field label="Priority fee" hint="0 = fetch live each trade"><Input type="number" min={0} value={draft.priorityFeeMicroLamports} onChange={(e) => set({ priorityFeeMicroLamports: Number(e.target.value) })} suffix="µL/CU" /></Field>
              <Field label="Jito tip"><Input type="number" step="0.001" min={0.000001} value={draft.jitoTipSol} onChange={(e) => set({ jitoTipSol: Number(e.target.value) })} suffix="SOL" /></Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-ink-950/60 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Dynamic tip</div>
                <div className="text-xs text-neutral-500">Use the 75th-percentile landed tip when it is higher, capped at the max.</div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-32"><Input type="number" step="0.001" value={draft.jitoTipMaxSol} onChange={(e) => set({ jitoTipMaxSol: Number(e.target.value) })} suffix="max" /></div>
                <Toggle checked={draft.jitoTipDynamic} onChange={(v) => set({ jitoTipDynamic: v })} />
              </div>
            </div>

            <Button
              size="lg"
              variant={live ? "danger" : "success"}
              className="w-full"
              disabled={!validMint || !(amount > 0) || (live && !chosen) || report?.ok === false}
              onClick={() => setConfirmOpen(true)}
            >
              <Zap size={18} /> Launch {live ? "LIVE" : "paper"} snipe
            </Button>
          </div>
        </Card>

        <div className="space-y-6">
          <Card title="Auto-snipe new launches" action={<Toggle checked={draft.autoSnipe} onChange={(v) => save({ autoSnipe: v }).catch((e) => toast.show(e.message, "err"))} />}>
            <div className="space-y-4 p-5">
              <p className="text-xs text-neutral-500">Buys each new Pump.fun launch that matches your keywords and passes safety checks, up to the hourly cap.</p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Per snipe"><Input type="number" step="0.01" value={draft.autoSnipeSol} onChange={(e) => set({ autoSnipeSol: Number(e.target.value) })} suffix="SOL" /></Field>
                <Field label="Max per hour"><Input type="number" min={1} value={draft.autoSnipeMaxPerHour} onChange={(e) => set({ autoSnipeMaxPerHour: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Keywords" hint="Comma separated. Empty = every launch.">
                <Input value={draft.autoSnipeKeywords.join(", ")} onChange={(e) => set({ autoSnipeKeywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder="cat, ai" />
              </Field>
            </div>
          </Card>
          <ExitRules />
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={live ? "Confirm live snipe" : "Confirm paper snipe"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant={live ? "danger" : "success"} disabled={firing} onClick={fire}>
              <Crosshair size={15} /> {firing ? "Sending…" : live ? "Spend real SOL" : "Fill on paper"}
            </Button>
          </>
        }
      >
        {live && (
          <div className="flex gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            <AlertTriangle size={18} className="shrink-0" /> This sends a real transaction. Memecoins can go to zero in seconds.
          </div>
        )}
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-neutral-500">Token</dt><dd className="font-mono text-xs">{short(mint.trim(), 6)}</dd>
          <dt className="text-neutral-500">Amount</dt><dd>{amount} SOL</dd>
          <dt className="text-neutral-500">Wallet</dt><dd>{wallets.find((w) => w.id === chosen)?.name ?? "Paper wallet"}</dd>
          <dt className="text-neutral-500">Slippage</dt><dd>{draft.slippagePct}%</dd>
          <dt className="text-neutral-500">Jito tip</dt><dd>{tipLabel}</dd>
        </dl>
      </Modal>
    </div>
  );
}

function ExitRules() {
  const { draft, set, save, dirty } = useSettingsDraft();
  const toast = useToast();
  if (!draft) return null;
  const rules = draft.exitRules;
  const update = (id: string, patch: Partial<ExitRule>) => set({ exitRules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const a = draft.antiRug;

  return (
    <Card title="Exit strategy" action={dirty && <Button size="sm" variant="primary" onClick={() => save().then(() => toast.show("Exit rules saved"))}>Save</Button>}>
      {toast.node}
      <div className="space-y-3 p-5">
        {rules.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            <Toggle checked={r.enabled} onChange={(v) => update(r.id, { enabled: v })} />
            <Badge tone={r.kind === "take_profit" ? "green" : "red"}>{r.kind === "take_profit" ? "TP" : "SL"}</Badge>
            <span className="text-xs text-neutral-500">at</span>
            <div className="w-20"><Input type="number" value={r.triggerPct} onChange={(e) => update(r.id, { triggerPct: Number(e.target.value) })} suffix="%" /></div>
            <span className="text-xs text-neutral-500">sell</span>
            <div className="w-20"><Input type="number" min={1} max={100} value={r.sellPct} onChange={(e) => update(r.id, { sellPct: Number(e.target.value) })} suffix="%" /></div>
            <button className="ml-auto rounded-md p-1 text-neutral-600 hover:text-rose-300" onClick={() => set({ exitRules: rules.filter((x) => x.id !== r.id) })} aria-label="Remove rule">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => set({ exitRules: [...rules, { id: `tp${Date.now()}`, kind: "take_profit", triggerPct: 300, sellPct: 100, enabled: true }] })}><Plus size={13} /> Take-profit</Button>
          <Button size="sm" onClick={() => set({ exitRules: [...rules, { id: `sl${Date.now()}`, kind: "stop_loss", triggerPct: -40, sellPct: 100, enabled: true }] })}><Plus size={13} /> Stop-loss</Button>
        </div>

        <div className="mt-4 space-y-3 border-t border-neutral-800 pt-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium">Anti-rug emergency sell</div>
            <Toggle checked={a.enabled} onChange={(v) => set({ antiRug: { ...a, enabled: v } })} />
          </div>
          {([
            ["onCreatorSell", "Creator (dev wallet) sells"],
            ["onLiquidityRemoval", "Liquidity withdrawn from the PumpSwap pool"],
            ["onSupplyIncrease", "New tokens minted"],
          ] as const).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between text-xs text-neutral-400">
              {label}
              <Toggle checked={a[k]} disabled={!a.enabled} onChange={(v) => set({ antiRug: { ...a, [k]: v } })} />
            </label>
          ))}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Single-trade crash"><Input type="number" value={a.crashPct} onChange={(e) => set({ antiRug: { ...a, crashPct: Number(e.target.value) } })} suffix="%" /></Field>
            <Field label="Emergency tip"><Input type="number" step="0.001" value={a.emergencyTipSol} onChange={(e) => set({ antiRug: { ...a, emergencyTipSol: Number(e.target.value) } })} suffix="SOL" /></Field>
          </div>
        </div>
      </div>
    </Card>
  );
}
