"use client";

import { ArrowDownToLine, ArrowUpFromLine, Crown, Download, Plus, RefreshCw, Send, Sparkles, Trash2, Wallet as WalletIcon } from "lucide-react";
import { DepositDrawer } from "@/components/deposit";
import { WalletGroups } from "@/components/wallet-groups";
import { useState } from "react";
import { api, useEngine } from "@/lib/engine";
import { short } from "@/lib/format";
import type { Wallet } from "@/lib/types";
import { Badge, Button, Card, CopyButton, Empty, Field, Input, Modal, Td, Th, Toggle, cx, useToast } from "@/components/ui";

export default function WalletsPage() {
  const { state, refresh } = useEngine();
  const toast = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const [fundTarget, setFundTarget] = useState<Wallet | null>(null);
  const [reclaimOpen, setReclaimOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawFrom, setWithdrawFrom] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);

  const wallets = state?.wallets ?? [];
  const balances = state?.balances ?? {};
  const total = wallets.reduce((a, w) => a + (balances[w.id]?.sol ?? 0), 0);
  const locked = state && !state.status.keystoreUnlocked;
  const sim = state?.settings.simulation;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show(ok);
      await refresh();
      return true;
    } catch (e) {
      toast.show((e as Error).message, "err");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {toast.node}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Wallets &amp; Balances</h1>
          <p className="mt-1 text-sm text-neutral-400">Keys are encrypted at rest with AES-256-GCM. The master wallet funds the others and receives reclaimed SOL.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => run(() => api("/api/wallets/refresh", { method: "POST", body: {} }), "Balances refreshed")} disabled={busy || !state?.status.rpcConfigured}>
            <RefreshCw size={15} /> Refresh
          </Button>
          <Button variant="danger" onClick={() => setReclaimOpen(true)} disabled={busy || wallets.length < 2 || !state?.status.rpcConfigured}>
            <ArrowDownToLine size={15} /> Reclaim all
          </Button>
          <Button onClick={() => run(() => api("/api/wallets/generate", { method: "POST", body: { name: "" } }), "Wallet generated")} disabled={busy || !!locked}>
            <Sparkles size={15} /> Generate
          </Button>
          <Button onClick={() => setImportOpen(true)} disabled={!!locked}>
            <Plus size={15} /> Import wallet
          </Button>
          <Button variant="success" onClick={() => setDepositOpen(true)}>
            <Download size={15} /> Deposit
          </Button>
        </div>
      </div>

      {locked && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          The keystore is locked. Add <code className="font-mono">KEYSTORE_PASSPHRASE</code> (12+ characters) to <code className="font-mono">.env</code> and restart the engine to add wallets.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="glass rounded-2xl border border-white/[0.07] p-4">
          <div className="text-xs text-neutral-400">Wallets</div>
          <div className="mt-2 font-mono text-xl font-semibold">{wallets.length}</div>
        </div>
        <div className="glass rounded-2xl border border-white/[0.07] p-4">
          <div className="text-xs text-neutral-400">Total SOL</div>
          <div className="mt-2 font-mono text-xl font-semibold">{state?.status.rpcConfigured ? total.toFixed(4) : "no RPC"}</div>
        </div>
        <div className="glass col-span-2 rounded-2xl border border-white/[0.07] p-4 md:col-span-1">
          <div className="text-xs text-neutral-400">Master</div>
          <div className="mt-2 truncate font-mono text-sm font-semibold">{wallets.find((w) => w.isMaster)?.name ?? "none"}</div>
        </div>
      </div>

      <Card title="Loaded wallets">
        {!wallets.length ? (
          <Empty icon={<WalletIcon size={20} />} title="No wallets yet">Import an existing key or generate a fresh wallet. The first wallet becomes the master.</Empty>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[760px]">
              <thead className="border-b border-white/[0.07]">
                <tr>
                  <Th>Name</Th>
                  <Th>Public key</Th>
                  <Th className="text-right">SOL</Th>
                  <Th className="text-right">Tokens</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {wallets.map((w) => {
                  const b = balances[w.id];
                  const held = b?.tokens.filter((t) => t.amount > 0) ?? [];
                  return (
                    <tr key={w.id} className="hover:bg-neutral-900/60">
                      <Td>
                        <div className="flex items-center gap-2 font-medium">
                          {w.name}
                          {w.isMaster && <Badge tone="amber"><Crown size={11} /> Master</Badge>}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1 font-mono text-xs text-neutral-400">
                          <a href={`https://solscan.io/account/${w.publicKey}`} target="_blank" rel="noreferrer" className="hover:text-violet-300">{short(w.publicKey, 6)}</a>
                          <CopyButton text={w.publicKey} />
                        </div>
                      </Td>
                      <Td className="text-right font-mono tabular-nums">{b ? b.sol.toFixed(4) : "—"}</Td>
                      <Td className="text-right">
                        <span title={held.map((t) => `${short(t.mint)}: ${t.amount}`).join("\n")} className="font-mono text-neutral-400">{held.length}</span>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Toggle checked={w.active} onChange={(v) => run(() => api(`/api/wallets/${w.id}`, { method: "PATCH", body: { active: v } }), v ? "Wallet active" : "Wallet idle")} />
                          <span className={cx("text-xs", w.active ? "text-emerald-300" : "text-neutral-500")}>{w.active ? "Active" : "Idle"}</span>
                        </div>
                      </Td>
                      <Td className="text-right">
                        <div className="inline-flex gap-1">
                          {!w.isMaster && (
                            <>
                              <Button size="sm" variant="ghost" title="Make master" onClick={() => run(() => api(`/api/wallets/${w.id}`, { method: "PATCH", body: { isMaster: true } }), `${w.name} is now master`)}>
                                <Crown size={14} />
                              </Button>
                              <Button size="sm" onClick={() => setFundTarget(w)} disabled={!state?.status.rpcConfigured}>
                                <Send size={13} /> Fund
                              </Button>
                            </>
                          )}
                          <Button size="sm" variant="ghost" title="Withdraw to another address" onClick={() => setWithdrawFrom(w)} disabled={!state?.status.rpcConfigured}>
                            <ArrowUpFromLine size={14} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Remove"
                            onClick={() => confirm(`Remove ${w.name}? Its encrypted key is deleted from the keystore. Make sure you have a backup.`) && run(() => api(`/api/wallets/${w.id}`, { method: "DELETE" }), "Removed")}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <WalletGroups run={run} busy={busy} />

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={(ok) => ok && setImportOpen(false)} run={run} />
      <DepositDrawer open={depositOpen} onClose={() => setDepositOpen(false)} />
      <WithdrawModal wallet={withdrawFrom} sim={!!sim} balance={withdrawFrom ? balances[withdrawFrom.id]?.sol : undefined} onClose={() => setWithdrawFrom(null)} run={run} />
      <FundModal wallet={fundTarget} sim={!!sim} onClose={() => setFundTarget(null)} run={run} />
      <Modal
        open={reclaimOpen}
        onClose={() => setReclaimOpen(false)}
        title="Reclaim all to master"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReclaimOpen(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={async () => (await run(() => api("/api/wallets/reclaim", { method: "POST", body: {} }), sim ? "Dry run complete, see logs" : "Reclaimed")) && setReclaimOpen(false)}>
              {sim ? "Dry run reclaim" : "Reclaim now"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-neutral-300">For every non-master wallet this closes empty token accounts (about 0.002 SOL rent back each) and sends all remaining SOL to the master.</p>
        <p className="text-sm text-neutral-400">Token accounts that still hold tokens are left alone and reported in the log; sell those positions first.</p>
        {sim && <p className="text-sm text-violet-300">Simulation mode is on, so this only simulates the transactions.</p>}
      </Modal>
    </div>
  );
}

function ImportModal({ open, onClose, onDone, run }: { open: boolean; onClose: () => void; onDone: (ok: boolean) => void; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [index, setIndex] = useState(0);
  const isPhrase = secret.trim().split(/\s+/).length >= 12;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import wallet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!secret.trim()}
            onClick={async () => {
              const ok = await run(() => api("/api/wallets/import", { method: "POST", body: { name, secret, accountIndex: index } }), "Wallet imported");
              if (ok) {
                setSecret("");
                setName("");
              }
              onDone(ok);
            }}
          >
            Import
          </Button>
        </>
      }
    >
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sniper 1" /></Field>
      <Field label="Private key or seed phrase" hint="Base58 secret key, solana-keygen JSON array, or a 12/24-word phrase. Sent only to your local engine and encrypted before it touches disk.">
        <textarea
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-xl border border-white/[0.07] bg-ink-950 p-3 font-mono text-xs text-neutral-100 outline-none focus:border-violet-500/60"
        />
      </Field>
      {isPhrase && (
        <Field label="Account index" hint="Derivation path m/44'/501'/index'/0' (Phantom, Solflare, Backpack).">
          <Input type="number" min={0} value={index} onChange={(e) => setIndex(Number(e.target.value))} />
        </Field>
      )}
    </Modal>
  );
}

function FundModal({ wallet, sim, onClose, run }: { wallet: Wallet | null; sim: boolean; onClose: () => void; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const [amount, setAmount] = useState(0.5);
  return (
    <Modal
      open={!!wallet}
      onClose={onClose}
      title={`Fund ${wallet?.name ?? ""}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="success" onClick={async () => (await run(() => api(`/api/wallets/${wallet!.id}/fund`, { method: "POST", body: { sol: amount } }), sim ? "Dry run OK" : "Funded")) && onClose()}>
            {sim ? "Dry run transfer" : `Send ${amount} SOL`}
          </Button>
        </>
      }
    >
      <Field label="Amount from master"><Input type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(Number(e.target.value))} suffix="SOL" /></Field>
      {sim && <p className="text-sm text-violet-300">Simulation mode is on: the transfer is simulated, not sent.</p>}
    </Modal>
  );
}

function WithdrawModal({ wallet, sim, balance, onClose, run }: { wallet: Wallet | null; sim: boolean; balance?: number; onClose: () => void; run: (fn: () => Promise<unknown>, ok: string) => Promise<boolean> }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [typed, setTyped] = useState("");
  const max = amount.trim().toLowerCase() === "max";
  const valid = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to.trim()) && (max || Number(amount) > 0);
  const close = () => (setTo(""), setAmount(""), setTyped(""), onClose());
  return (
    <Modal
      open={!!wallet}
      onClose={close}
      title={`Withdraw from ${wallet?.name ?? ""}`}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button
            variant={sim ? "primary" : "danger"}
            disabled={!valid || (!sim && typed !== "SEND")}
            onClick={async () => (await run(() => api(`/api/wallets/${wallet!.id}/withdraw`, { method: "POST", body: { to: to.trim(), sol: max ? "max" : Number(amount) } }), sim ? "Dry run OK, nothing sent" : "Withdrawal confirmed")) && close()}
          >
            {sim ? "Dry run withdrawal" : `Send ${max ? "everything" : `${amount} SOL`}`}
          </Button>
        </>
      }
    >
      <Field label="To address" hint="Your Phantom, Axiom or exchange deposit address. Double-check it: transfers cannot be reversed.">
        <Input value={to} onChange={(e) => setTo(e.target.value)} className="font-mono text-xs" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="Amount" hint={`Balance ${balance?.toFixed(4) ?? "?"} SOL. Type max to send everything except the network fee.`}>
        <div className="flex gap-2">
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.5" suffix="SOL" wrapperClassName="flex-1" />
          <Button onClick={() => setAmount("max")}>Max</Button>
        </div>
      </Field>
      {sim ? (
        <p className="text-sm text-violet-300">Simulation mode is on: the transfer is simulated against the chain, not sent.</p>
      ) : (
        <label className="block text-xs text-neutral-400">
          Type <span className="font-mono text-rose-300">SEND</span> to confirm a real transfer
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1.5 font-mono" />
        </label>
      )}
    </Modal>
  );
}
