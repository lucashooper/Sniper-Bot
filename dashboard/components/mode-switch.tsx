"use client";

import { AlertTriangle, FlaskConical, Zap } from "lucide-react";
import { useState } from "react";
import { api, useEngine } from "@/lib/engine";
import { Button, Input, Modal, cx } from "./ui";

/**
 * Global Simulation / Live switch. Going live needs ALLOW_LIVE_TRADING=true on the engine host AND typing LIVE here;
 * going back to simulation is one click.
 */
export function ModeSwitch() {
  const { state, connected, refresh } = useEngine();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!connected || !state) {
    return (
      <span className="inline-flex h-8 items-center gap-2 rounded-lg border border-white/[0.06] px-2.5 text-xs font-medium text-neutral-500">Offline</span>
    );
  }

  const live = state.status.live;
  const set = async (simulation: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/settings", { method: "PUT", body: { simulation } });
      await refresh();
      setOpen(false);
      setTyped("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const master = state.wallets.find((w) => w.isMaster);
  const masterSol = master ? state.balances[master.id]?.sol : undefined;

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={live}
        aria-label="Trading mode"
        onClick={() => (live ? void set(true) : setOpen(true))}
        className={cx(
          "inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition",
          live ? "border-rose-500/30 bg-rose-500/[0.08] text-rose-200 hover:bg-rose-500/15" : "border-white/[0.06] bg-white/[0.02] text-neutral-400 hover:border-white/[0.12] hover:text-neutral-100",
        )}
        title={live ? "Live: trades spend real SOL. Click to return to simulation" : "Simulation: paper trades only. Click to go live"}
      >
        {live ? (
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
          </span>
        ) : (
          <FlaskConical size={13} className="text-neutral-500" />
        )}
        {live ? "Live" : "Simulation"}
      </button>

      <Modal
        open={open}
        onClose={() => (setOpen(false), setTyped(""), setErr(null))}
        title="Switch to live execution"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Stay in simulation</Button>
            <Button variant="danger" disabled={!state.status.liveAllowed || typed !== "LIVE" || busy} onClick={() => void set(false)}>
              <Zap size={15} /> Go live
            </Button>
          </>
        }
      >
        {!state.status.liveAllowed ? (
          <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div>Live trading is locked on the engine. Set <code className="font-mono">ALLOW_LIVE_TRADING=true</code> in the engine host's variables and restart it, then come back here.</div>
          </div>
        ) : (
          <>
            <p className="text-sm text-neutral-300">Snipes, auto-snipes, exits, funding and withdrawals will send real transactions and spend real SOL.</p>
            <ul className="space-y-1 text-sm text-neutral-400">
              <li>Master wallet: <span className="text-neutral-200">{master ? `${master.name}, ${masterSol?.toFixed(4) ?? "?"} SOL` : "none"}</span></li>
              <li>Auto-snipe: <span className={state.settings.autoSnipe ? "text-rose-300" : "text-neutral-200"}>{state.settings.autoSnipe ? `ON, ${state.settings.autoSnipeSol} SOL each, up to ${state.settings.autoSnipeMaxPerHour}/hour` : "off (manual snipes only)"}</span></li>
              <li>RPC: <span className="text-neutral-200">{state.status.rpcConfigured ? "configured" : "missing, live trades will fail"}</span></li>
            </ul>
            <label className="block text-xs text-neutral-400">
              Type <span className="font-mono text-rose-300">LIVE</span> to confirm
              <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1.5 font-mono" />
            </label>
          </>
        )}
        {err && <p className="text-sm text-rose-300">{err}</p>}
      </Modal>
    </>
  );
}
