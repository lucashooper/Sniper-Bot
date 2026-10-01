"use client";

import { ArrowDownToLine, Flame, Layers, Pencil, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useEngine } from "@/lib/engine";
import type { SellAllResult, WalletGroup } from "@/lib/types";
import { Badge, Button, Card, Empty, Field, Input, Modal, cx } from "./ui";

type Run = (fn: () => Promise<unknown>, ok: string) => Promise<boolean>;

/** Wallet groups ("presets"): fund, sweep and sell across several wallets at once. Buys still use one wallet. */
export function WalletGroups({ run, busy }: { run: Run; busy: boolean }) {
  const { state } = useEngine();
  const [editing, setEditing] = useState<WalletGroup | "new" | null>(null);
  const [funding, setFunding] = useState<WalletGroup | null>(null);
  const [sweeping, setSweeping] = useState<WalletGroup | null>(null);
  const [generating, setGenerating] = useState<WalletGroup | null>(null);

  if (!state) return null;
  const groups = state.groups ?? [];
  const wallets = state.wallets;
  const balances = state.balances;
  const rpc = state.status.rpcConfigured;
  const sim = state.settings.simulation;
  const locked = !state.status.keystoreUnlocked;

  const sellAll = (g: WalletGroup) => {
    const held = state.positions.filter((p) => g.walletIds.includes(p.walletId));
    if (!held.length) return;
    void run(async () => {
      const r = await api<SellAllResult>("/api/positions/sell-all", { method: "POST", body: { groupId: g.id } });
      if (r.failed) throw new Error(`Sold ${r.sold}, ${r.failed} failed: ${r.results.find((x) => !x.ok)?.error ?? "see the log"}`);
    }, `Sold everything in ${g.name}`);
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Layers size={15} className="text-violet-300" /> Wallet groups
        </span>
      }
      action={
        <Button size="sm" onClick={() => setEditing("new")} disabled={!wallets.length && locked}>
          <Plus size={13} /> New group
        </Button>
      }
    >
      {!groups.length ? (
        <Empty icon={<Layers size={20} />} title="No groups yet">
          Group wallets into presets to fund them, sweep them back to the master, or sell a coin from all of them in one click.
        </Empty>
      ) : (
        <div className="grid gap-3 p-4 md:grid-cols-2">
          {groups.map((g) => {
            const members = wallets.filter((w) => g.walletIds.includes(w.id));
            const sol = members.reduce((a, w) => a + (balances[w.id]?.sol ?? 0), 0);
            const positions = state.positions.filter((p) => g.walletIds.includes(p.walletId));
            const fundable = members.filter((w) => !w.isMaster).length;
            return (
              <div key={g.id} className="rounded-xl border border-neutral-800 bg-ink-950/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{g.name}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-neutral-400">
                      <span>{members.length} wallet{members.length === 1 ? "" : "s"}</span>
                      <span>{rpc ? `${sol.toFixed(4)} SOL` : "no RPC"}</span>
                      <span className={cx(positions.length > 0 && "text-emerald-300")}>{positions.length} open position{positions.length === 1 ? "" : "s"}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" title="Edit group" onClick={() => setEditing(g)}>
                      <Pencil size={13} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Delete group (wallets are kept)"
                      onClick={() => confirm(`Delete the group ${g.name}? Its wallets are kept.`) && run(() => api(`/api/groups/${g.id}`, { method: "DELETE" }), "Group deleted")}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {members.length ? (
                    members.map((w) => (
                      <Badge key={w.id} tone={w.active ? "neutral" : "amber"}>
                        {w.name}
                        {rpc && balances[w.id] && <span className="font-mono text-neutral-500">{balances[w.id].sol.toFixed(3)}</span>}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-neutral-500">Empty. Add wallets or generate new ones.</span>
                  )}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setGenerating(g)} disabled={busy || locked}>
                    <Sparkles size={13} /> Generate
                  </Button>
                  <Button size="sm" onClick={() => setFunding(g)} disabled={busy || !rpc || !fundable}>
                    <Send size={13} /> Fund each
                  </Button>
                  <Button size="sm" onClick={() => setSweeping(g)} disabled={busy || !rpc || !fundable}>
                    <ArrowDownToLine size={13} /> Sweep to master
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => sellAll(g)} disabled={busy || !positions.length}>
                    <Flame size={13} /> Sell all
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <EditGroupModal group={editing} onClose={() => setEditing(null)} run={run} />
      <GenerateModal group={generating} onClose={() => setGenerating(null)} run={run} />
      <FundGroupModal group={funding} sim={sim} onClose={() => setFunding(null)} run={run} />
      <Modal
        open={!!sweeping}
        onClose={() => setSweeping(null)}
        title={`Sweep ${sweeping?.name ?? ""} to master`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSweeping(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () =>
                (await run(() => api("/api/wallets/reclaim", { method: "POST", body: { groupId: sweeping!.id } }), sim ? "Dry run complete, see logs" : "Swept to master")) && setSweeping(null)
              }
            >
              {sim ? "Dry run sweep" : "Sweep now"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-300">Every wallet in this group closes its empty token accounts (about 0.002 SOL rent back each) and sends all its SOL to the master.</p>
        <p className="text-sm text-neutral-400">Wallets still holding tokens keep those accounts; sell first to recover that rent.</p>
        {sim && <p className="text-sm text-violet-300">Simulation mode is on, so this only simulates the transactions.</p>}
      </Modal>
    </Card>
  );
}

function EditGroupModal({ group, onClose, run }: { group: WalletGroup | "new" | null; onClose: () => void; run: Run }) {
  const { state } = useEngine();
  const isNew = group === "new";
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [seen, setSeen] = useState<WalletGroup | "new" | null>(null);
  // Reset the form whenever a different group (or "new") is opened.
  if (group !== seen) {
    setSeen(group);
    setName(group && group !== "new" ? group.name : "");
    setPicked(group && group !== "new" ? group.walletIds : []);
  }
  const wallets = state?.wallets ?? [];
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const save = async () => {
    const body = { name, walletIds: picked };
    const ok = isNew
      ? await run(() => api("/api/groups", { method: "POST", body }), `Group ${name.trim()} created`)
      : await run(() => api(`/api/groups/${(group as WalletGroup).id}`, { method: "PATCH", body }), "Group saved");
    if (ok) onClose();
  };
  return (
    <Modal
      open={!!group}
      onClose={onClose}
      title={isNew ? "New wallet group" : `Edit ${(group as WalletGroup | null)?.name ?? ""}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={save}>{isNew ? "Create group" : "Save"}</Button>
        </>
      }
    >
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Snipers A" maxLength={40} /></Field>
      <Field label="Wallets" hint="A wallet can be in more than one group. Leave it empty and use Generate to fill it with fresh wallets.">
        {wallets.length ? (
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-neutral-800 p-1.5 scrollbar-thin">
            {wallets.map((w) => (
              <label key={w.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm hover:bg-neutral-800/60">
                <input type="checkbox" checked={picked.includes(w.id)} onChange={() => toggle(w.id)} className="accent-violet-500" />
                <span className="flex-1">{w.name}</span>
                {w.isMaster && <Badge tone="amber">Master</Badge>}
                <span className="font-mono text-xs text-neutral-500">{w.publicKey.slice(0, 4)}…{w.publicKey.slice(-4)}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">No wallets yet.</p>
        )}
      </Field>
    </Modal>
  );
}

function GenerateModal({ group, onClose, run }: { group: WalletGroup | null; onClose: () => void; run: Run }) {
  const [count, setCount] = useState(3);
  return (
    <Modal
      open={!!group}
      onClose={onClose}
      title={`Generate wallets into ${group?.name ?? ""}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!(count >= 1 && count <= 20)}
            onClick={async () => (await run(() => api(`/api/groups/${group!.id}/generate`, { method: "POST", body: { count } }), `${count} wallet(s) added to ${group!.name}`)) && onClose()}
          >
            Generate {count}
          </Button>
        </>
      }
    >
      <Field label="How many" hint="Fresh keypairs, encrypted in the engine's keystore like any other wallet. Up to 20 at a time.">
        <Input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} />
      </Field>
    </Modal>
  );
}

function FundGroupModal({ group, sim, onClose, run }: { group: WalletGroup | null; sim: boolean; onClose: () => void; run: Run }) {
  const { state } = useEngine();
  const [amount, setAmount] = useState(0.2);
  const targets = (state?.wallets ?? []).filter((w) => group?.walletIds.includes(w.id) && !w.isMaster);
  const master = state?.wallets.find((w) => w.isMaster);
  const masterSol = master ? state?.balances[master.id]?.sol : undefined;
  const total = amount * targets.length;
  const short = masterSol !== undefined && total > masterSol;
  return (
    <Modal
      open={!!group}
      onClose={onClose}
      title={`Fund ${group?.name ?? ""}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="success"
            disabled={!(amount > 0) || !targets.length || (!sim && short)}
            onClick={async () => (await run(() => api(`/api/groups/${group!.id}/fund`, { method: "POST", body: { sol: amount } }), sim ? "Dry run OK" : `Funded ${targets.length} wallets`)) && onClose()}
          >
            {sim ? "Dry run transfers" : `Send ${total.toFixed(3)} SOL`}
          </Button>
        </>
      }
    >
      <Field label="SOL for each wallet" hint={`${targets.length} wallet(s) receive this from ${master?.name ?? "the master"}. Total ${total.toFixed(3)} SOL plus network fees.`}>
        <Input type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} suffix="SOL" />
      </Field>
      {short && <p className="text-sm text-rose-300">The master holds {masterSol!.toFixed(4)} SOL, less than the {total.toFixed(3)} SOL this needs.</p>}
      {sim && <p className="text-sm text-violet-300">Simulation mode is on: the transfers are simulated, not sent.</p>}
    </Modal>
  );
}
