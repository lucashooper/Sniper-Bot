"use client";

import Link from "next/link";
import { Coins, Crosshair, Percent, TrendingUp, Wallet as WalletIcon } from "lucide-react";
import { useEngine } from "@/lib/engine";
import { signed } from "@/lib/format";
import { PositionsTable } from "@/components/positions";
import { Terminal } from "@/components/terminal";
import { TokenFeed, defaultWalletId } from "@/components/token-feed";
import { Badge, Button, Card, Stat } from "@/components/ui";

export default function Overview() {
  const { state } = useEngine();
  const m = state?.metrics;
  return (
    <div className="space-y-6">
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
        <Card
          title="New launches"
          className="xl:col-span-3"
          action={
            <div className="flex items-center gap-3">
              <Badge tone={state?.status.marketSource === "stream" ? "green" : "violet"}>{state?.status.marketSource === "stream" ? "mainnet" : "synthetic"}</Badge>
              <Link href="/feed" className="text-xs text-violet-300 hover:underline">Full feed</Link>
            </div>
          }
        >
          <div className="max-h-[420px] overflow-y-auto scrollbar-thin">
            <TokenFeed launches={(state?.launches ?? []).slice(0, 25)} presets={(state?.settings.quickBuyPresets ?? [0.1, 0.5, 1]).slice(0, 3)} walletId={defaultWalletId(state)} compactRows />
          </div>
        </Card>
        <Card title="Live log" className="xl:col-span-2" action={<Link href="/feed" className="text-xs text-violet-300 hover:underline">Open terminal</Link>}>
          <Terminal height="h-[420px]" />
        </Card>
      </div>
    </div>
  );
}
