"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Coins, Crosshair, Percent, Rocket, TrendingUp, Wallet as WalletIcon } from "lucide-react";
import { useState } from "react";
import { api, useEngine } from "@/lib/engine";
import { ago, compact, short, signed } from "@/lib/format";
import { PositionsTable } from "@/components/positions";
import { Terminal } from "@/components/terminal";
import { Badge, Button, Card, Empty, Stat, useToast } from "@/components/ui";

export default function Overview() {
  const { state } = useEngine();
  const m = state?.metrics;
  const toast = useToast();
  const [sniping, setSniping] = useState<string | null>(null);

  const quickSnipe = async (mint: string) => {
    if (!state) return;
    if (state.status.live && !confirm(`LIVE: buy ${state.settings.autoSnipeSol} SOL of this token with real funds?`)) return;
    setSniping(mint);
    try {
      const walletId = state.wallets.find((w) => w.active && !w.isMaster)?.id ?? state.wallets.find((w) => w.active)?.id ?? "";
      await api("/api/snipe", { method: "POST", body: { mint, walletId, sol: state.settings.autoSnipeSol } });
      toast.show("Bought");
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setSniping(null);
    }
  };

  return (
    <div className="space-y-6">
      {toast.node}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-neutral-400">
            {state?.status.live ? "Live mode: trades spend real SOL." : "Simulation mode: every trade is paper, nothing is sent on chain."}
          </p>
        </div>
        <Link href="/snipe"><Button variant="primary"><Crosshair size={16} /> New snipe</Button></Link>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat icon={<Coins size={14} />} label="Total SOL invested" value={(m?.totalInvestedSol ?? 0).toFixed(3)} sub={`${m?.tradeCount ?? 0} trades`} />
        <Stat icon={<WalletIcon size={14} />} label="Portfolio value" value={(m?.portfolioValueSol ?? 0).toFixed(3)} sub={`${m?.openCount ?? 0} open`} />
        <Stat icon={<TrendingUp size={14} />} label="Realized PnL" value={signed(m?.realizedPnlSol ?? 0, 3)} tone={(m?.realizedPnlSol ?? 0) >= 0 ? "up" : "down"} />
        <Stat icon={<TrendingUp size={14} />} label="Unrealized PnL" value={signed(m?.unrealizedPnlSol ?? 0, 3)} tone={(m?.unrealizedPnlSol ?? 0) >= 0 ? "up" : "down"} />
        <Stat icon={<Percent size={14} />} label="Win rate" value={`${(m?.winRatePct ?? 0).toFixed(0)}%`} sub={`${m?.closedCount ?? 0} closed`} />
      </div>

      <Card title="Open positions">
        <PositionsTable />
      </Card>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="New launches" className="xl:col-span-2" action={<Badge tone={state?.status.marketSource === "stream" ? "green" : "violet"}>{state?.status.marketSource === "stream" ? "mainnet" : "synthetic"}</Badge>}>
          {!state?.launches.length ? (
            <Empty icon={<Rocket size={20} />} title="Listening for launches" />
          ) : (
            <ul className="max-h-[360px] divide-y divide-neutral-800/70 overflow-y-auto scrollbar-thin">
              {state.launches.slice(0, 25).map((l) => (
                <motion.li key={l.mint} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {l.symbol}
                      {l.sniped && <Badge tone="green">sniped</Badge>}
                    </div>
                    <div className="truncate text-xs text-neutral-500">{l.name} · {short(l.mint)} · {ago(l.ts)}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-neutral-400">{compact(l.marketCapSol)} SOL mc</span>
                    <Button size="sm" disabled={sniping === l.mint} onClick={() => quickSnipe(l.mint)}>Buy</Button>
                  </div>
                </motion.li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Live log" className="xl:col-span-3" action={<Link href="/feed" className="text-xs text-violet-300 hover:underline">Open terminal</Link>}>
          <Terminal height="h-[360px]" />
        </Card>
      </div>
    </div>
  );
}
