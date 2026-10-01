"use client";

import { Download, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, downloadTradesCsv, useEngine } from "@/lib/engine";
import { price, short, signed, solscan, time } from "@/lib/format";
import type { Metrics, Trade } from "@/lib/types";
import { PnlChart } from "@/components/pnl-chart";
import { PositionsTable } from "@/components/positions";
import { Badge, Button, Card, Stat, Td, Th, cx } from "@/components/ui";

type Mode = "all" | "sim" | "live";

export default function PnlPage() {
  const { tradesVersion, state } = useEngine();
  const [mode, setMode] = useState<Mode>("all");
  const [data, setData] = useState<{ metrics: Metrics; series: { ts: number; pnl: number }[] } | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    const q = mode === "all" ? "" : `?mode=${mode}`;
    void api<typeof data>(`/api/pnl${q}`).then(setData).catch(() => undefined);
    void api<Trade[]>("/api/trades").then(setTrades).catch(() => undefined);
  }, [mode, tradesVersion]);

  // Unrealized moves with every price tick, so take it from live state rather than the last trade fetch.
  const m = data?.metrics;
  const shown = trades.filter((t) => mode === "all" || t.mode === mode);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">PnL Analytics</h1>
          <p className="mt-1 text-sm text-neutral-400">Every fill, Jito tip and fee is on the ledger. Costs include tips and fees, so PnL is what actually hit your wallet.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-xl border border-neutral-800 bg-ink-900 p-1">
            {(["all", "sim", "live"] as Mode[]).map((x) => (
              <button key={x} onClick={() => setMode(x)} className={cx("rounded-lg px-3 py-1.5 text-xs font-medium capitalize", mode === x ? "bg-neutral-800 text-white" : "text-neutral-500")}>
                {x}
              </button>
            ))}
          </div>
          <Button onClick={() => downloadTradesCsv().catch((e) => alert(e.message))}><Download size={15} /> Download PnL CSV</Button>
          <Button variant="ghost" onClick={() => confirm("Delete all simulated trades and positions?") && api("/api/sim/reset", { method: "POST", body: {} })}>
            <RotateCcw size={15} /> Reset sim
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Invested" value={(m?.totalInvestedSol ?? 0).toFixed(3)} />
        <Stat label="Portfolio value" value={(mode === "all" ? state?.metrics.portfolioValueSol ?? 0 : m?.portfolioValueSol ?? 0).toFixed(3)} />
        <Stat label="Realized" value={signed(m?.realizedPnlSol ?? 0, 3)} tone={(m?.realizedPnlSol ?? 0) >= 0 ? "up" : "down"} />
        <Stat
          label="Unrealized"
          value={signed((mode === "all" ? state?.metrics.unrealizedPnlSol : m?.unrealizedPnlSol) ?? 0, 3)}
          tone={((mode === "all" ? state?.metrics.unrealizedPnlSol : m?.unrealizedPnlSol) ?? 0) >= 0 ? "up" : "down"}
        />
        <Stat label="Win rate" value={`${(m?.winRatePct ?? 0).toFixed(0)}%`} sub={`${m?.closedCount ?? 0} closed`} />
        <Stat label="Tips + fees" value={((m?.jitoTipsSol ?? 0) + (m?.feesSol ?? 0)).toFixed(4)} sub={`${(m?.jitoTipsSol ?? 0).toFixed(4)} in Jito tips`} />
      </div>

      <Card title="Cumulative realized PnL (SOL)">
        <div className="p-4"><PnlChart series={data?.series ?? []} /></div>
      </Card>

      <Card title="Open positions"><PositionsTable /></Card>

      <Card title="Trade history">
        <div className="max-h-[480px] overflow-auto scrollbar-thin">
          <table className="w-full min-w-[900px]">
            <thead className="sticky top-0 border-b border-neutral-800 bg-ink-900">
              <tr>
                <Th>Time</Th><Th>Side</Th><Th>Token</Th><Th>Reason</Th>
                <Th className="text-right">SOL</Th><Th className="text-right">Price</Th><Th className="text-right">Tip + fees</Th><Th className="text-right">PnL</Th><Th>Tx</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/70">
              {shown.map((t) => (
                <tr key={t.id} className="hover:bg-neutral-900/60">
                  <Td className="font-mono text-xs text-neutral-400">{time(t.ts)}</Td>
                  <Td>
                    <Badge tone={t.side === "buy" ? "green" : "red"}>{t.side}</Badge> {t.mode === "sim" && <Badge tone="violet">SIM</Badge>}
                  </Td>
                  <Td className="font-medium">{t.symbol}</Td>
                  <Td className="text-xs text-neutral-400">{t.reason.replace("_", " ")}</Td>
                  <Td className="text-right font-mono tabular-nums">{t.solAmount.toFixed(4)}</Td>
                  <Td className="text-right font-mono text-xs tabular-nums text-neutral-400">{price(t.priceSol)}</Td>
                  <Td className="text-right font-mono text-xs tabular-nums text-neutral-400">{(t.jitoTipSol + t.priorityFeeSol + t.networkFeeSol).toFixed(4)}</Td>
                  <Td className={cx("text-right font-mono tabular-nums", t.side === "sell" && (t.realizedPnlSol >= 0 ? "text-emerald-400" : "text-rose-400"))}>
                    {t.side === "sell" ? signed(t.realizedPnlSol) : ""}
                  </Td>
                  <Td>{t.signature ? <a className="font-mono text-xs text-violet-400 hover:underline" href={solscan(t.signature)} target="_blank" rel="noreferrer">{short(t.signature)}</a> : <span className="text-xs text-neutral-600">paper</span>}</Td>
                </tr>
              ))}
              {!shown.length && (
                <tr><Td className="py-10 text-center text-neutral-500" >No trades yet.</Td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
