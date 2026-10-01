"use client";

import { AnimatePresence, m } from "framer-motion";
import { ExternalLink, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useEngine } from "@/lib/engine";
import { Button, CopyButton } from "./ui";

/** Axiom-style deposit panel for the master wallet: address, QR and one-click copy. */
export function DepositDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, refresh } = useEngine();
  const master = state?.wallets.find((w) => w.isMaster);
  const bal = master ? state?.balances[master.id] : undefined;
  const [svg, setSvg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!master || !open) return;
    // Loaded on first open: the QR encoder is not needed for anything else.
    void import("qrcode").then(({ default: QRCode }) => QRCode.toString(master.publicKey, { type: "svg", margin: 1, width: 220, color: { dark: "#0b0b10", light: "#ffffff" } })).then(setSvg);
  }, [master?.publicKey, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/wallets/generate", { method: "POST", body: { name: "Main" } });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <m.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <m.aside
            role="dialog"
            aria-modal="true"
            aria-label="Deposit"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-white/[0.07] bg-ink-900 shadow-2xl"
          >
            <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
              <h3 className="font-semibold">Deposit SOL</h3>
              <button onClick={onClose} className="rounded-lg p-1 text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200" aria-label="Close">
                <X size={18} />
              </button>
            </header>
            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              {!master ? (
                <div className="space-y-3 text-sm text-neutral-300">
                  <p>You have no wallet yet. Create one and it becomes your main (master) wallet; deposit into it, then fund sniper wallets from it.</p>
                  {state && !state.status.keystoreUnlocked ? (
                    <p className="text-amber-300">The engine's keystore is locked: set KEYSTORE_PASSPHRASE on the engine host first.</p>
                  ) : (
                    <Button variant="primary" onClick={create} disabled={busy || !state}>
                      <Sparkles size={15} /> Create main wallet
                    </Button>
                  )}
                  {err && <p className="text-rose-300">{err}</p>}
                </div>
              ) : (
                <>
                  <div>
                    <div className="text-xs text-neutral-400">Main wallet</div>
                    <div className="mt-1 font-medium">{master.name}</div>
                    <div className="mt-1 font-mono text-sm text-neutral-300">{bal ? `${bal.sol.toFixed(4)} SOL` : state?.status.rpcConfigured ? "…" : "balance needs an RPC"}</div>
                  </div>
                  <div className="mx-auto w-fit rounded-2xl bg-white p-3" dangerouslySetInnerHTML={{ __html: svg }} />
                  <div className="rounded-xl border border-white/[0.07] bg-ink-950 p-3">
                    <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-500">Address (Solana)</div>
                    <div className="flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all font-mono text-xs text-neutral-100">{master.publicKey}</code>
                      <CopyButton text={master.publicKey} />
                    </div>
                  </div>
                  <ul className="space-y-1.5 text-xs text-neutral-400">
                    <li>Send SOL on the Solana network only, from Phantom, Axiom or an exchange.</li>
                    <li>The balance updates within about 20 seconds of the transfer confirming.</li>
                    <li>Deposits are real even in Simulation mode; simulation only affects trades.</li>
                  </ul>
                  <a href={`https://solscan.io/account/${master.publicKey}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200">
                    View on Solscan <ExternalLink size={12} />
                  </a>
                </>
              )}
            </div>
          </m.aside>
        </m.div>
      )}
    </AnimatePresence>
  );
}
