"use client";

import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_URL, normalizeUrl, saveConn, useEngine } from "@/lib/engine";
import { supabaseEnabled } from "@/lib/supabase";
import { useAuth } from "@/components/auth-gate";
import { ModeSwitch } from "@/components/mode-switch";
import { useSettingsDraft } from "@/components/use-settings";
import { Button, Card, Field, Input, Toggle, cx, useToast } from "@/components/ui";

export default function SettingsPage() {
  const { state, reconnect } = useEngine();
  const { draft, set, save, dirty } = useSettingsDraft();
  const { email } = useAuth();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    try {
      setUrl(localStorage.getItem("engine.url") || DEFAULT_URL);
      setToken(localStorage.getItem("engine.token") || "");
    } catch {
      setUrl("http://127.0.0.1:8787");
    }
  }, []);

  const s = state?.status;
  const setupItems = [
    { ok: !!s?.rpcConfigured, label: "Solana RPC", hint: "SOLANA_RPC_URL and SOLANA_WS_URL (Helius recommended)" },
    { ok: !!s?.keystoreUnlocked, label: "Keystore passphrase", hint: "KEYSTORE_PASSPHRASE, 12+ characters, never committed" },
    { ok: (state?.wallets.length ?? 0) > 0, label: "At least one wallet", hint: "Import or generate on the Wallets page" },
    { ok: !!s?.cloud?.enabled, label: "Supabase backup", hint: s?.cloud?.lastError ? `Failing: ${s.cloud.lastError}` : "SUPABASE_URL, SUPABASE_SECRET_KEY and OWNER_EMAIL on the engine host" },
    { ok: !!s?.liveAllowed, label: "Live trading unlocked", hint: "ALLOW_LIVE_TRADING=true, only when you are ready" },
  ];

  return (
    <div className="space-y-6">
      {toast.node}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings &amp; Keys</h1>
          <p className="mt-1 text-sm text-neutral-400">Secrets live in <code className="font-mono">.env</code> on the machine running the engine; the dashboard never sees them.</p>
        </div>
        {dirty && <Button variant="primary" onClick={() => save().then(() => toast.show("Saved"), (e) => toast.show(e.message, "err"))}>Save settings</Button>}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Trading mode">
          <div className="space-y-4 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium">Simulation or live</div>
                <div className="text-xs text-neutral-500">Simulation paper-fills every trade and only dry-runs wallet transfers. Same switch as the header.</div>
              </div>
              <ModeSwitch />
            </div>
            {!s?.liveAllowed && (
              <div className="flex gap-2 rounded-xl border border-white/[0.07] bg-ink-950/60 p-3 text-xs text-neutral-400">
                <AlertTriangle size={15} className="shrink-0 text-amber-300" />
                Live mode is locked by the engine. Set <code className="font-mono">ALLOW_LIVE_TRADING=true</code> on the engine host (<code className="font-mono">.env</code> locally, the hostin <code className="font-mono">.env</code> and restart it to unlock the toggle.apos;s variables in production) and restart it to unlock the switch.
              </div>
            )}
          </div>
        </Card>

        <Card title="Setup checklist">
          <ul className="space-y-3 p-5">
            {setupItems.map((i) => (
              <li key={i.label} className="flex items-start gap-3">
                {i.ok ? <CheckCircle2 size={18} className="mt-px text-emerald-400" /> : <CircleDashed size={18} className="mt-px text-neutral-600" />}
                <div>
                  <div className={cx("text-sm", i.ok ? "text-neutral-200" : "text-neutral-400")}>{i.label}</div>
                  <div className="text-xs text-neutral-500">{i.hint}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Pre-trade safety checks">
          {draft && (
            <div className="space-y-3 p-5">
              {([
                ["requireMintAuthorityRevoked", "Require mint authority revoked"],
                ["requireFreezeAuthorityRevoked", "Require freeze authority revoked"],
                ["rejectDangerousExtensions", "Reject honeypot-capable Token-2022 extensions"],
              ] as const).map(([k, label]) => (
                <label key={k} className="flex items-center justify-between text-sm text-neutral-300">
                  {label}
                  <Toggle checked={draft.safety[k]} onChange={(v) => set({ safety: { ...draft.safety, [k]: v } })} />
                </label>
              ))}
              <Field label="Max top-holder share" hint="Excludes the bonding curve and pool vaults. 0 disables.">
                <Input type="number" min={0} max={100} value={draft.safety.maxTopHolderPct} onChange={(e) => set({ safety: { ...draft.safety, maxTopHolderPct: Number(e.target.value) } })} suffix="%" />
              </Field>
              <Field label="Compute unit limit"><Input type="number" value={draft.computeUnitLimit} onChange={(e) => set({ computeUnitLimit: Number(e.target.value) })} suffix="CU" /></Field>
            </div>
          )}
        </Card>

        <Card title="Engine connection">
          <div className="space-y-4 p-5">
            <Field label="Engine URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-xs" /></Field>
            {supabaseEnabled ? (
              <div className="text-xs text-neutral-400">Signed in as <span className="text-neutral-200">{email}</span>. The engine checks this session on every request.</div>
            ) : (
              <Field label="API token" hint="Only needed if you set ENGINE_API_TOKEN. Stored in this browser only.">
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono text-xs" />
              </Field>
            )}
            <Button onClick={() => (saveConn(normalizeUrl(url), token), reconnect(), toast.show("Reconnecting"))}>Save &amp; reconnect</Button>
            {s?.cloud?.enabled && (
              <div className="text-xs text-neutral-500">Last Supabase backup: <span className="text-neutral-300">{s.cloud.lastBackupAt ? new Date(s.cloud.lastBackupAt).toLocaleString() : "pending"}</span></div>
            )}
            <div className="text-xs text-neutral-500">Jito block engine: <span className="font-mono text-neutral-300">{s?.jitoBlockEngine}</span></div>
          </div>
        </Card>
      </div>
    </div>
  );
}
