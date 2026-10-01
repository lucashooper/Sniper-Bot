"use client";

import { Flame, Layers, PackageOpen } from "lucide-react";
import { useState } from "react";
import { api, useEngine } from "@/lib/engine";
import Link from "next/link";
import { coinPage, compact, pct, price, signed } from "@/lib/format";
import type { SellAllResult } from "@/lib/types";
import { Badge, Button, Empty, Td, Th, cx, useToast } from "./ui";

export function PositionsTable() {
  const { state } = useEngine();
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const positions = state?.positions ?? [];

  const sell = async (key: string, p: number) => {
    setBusy(key + p);
    try {
      await api(`/api/positions/${encodeURIComponent(key)}/sell`, { method: "POST", body: { pct: p } });
      toast.show(p >= 100 ? "Position closed" : `Sold ${p}%`);
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };

  /** Sells 100% from every wallet holding `mint` (or every open position when no mint), each wallet at once. */
  const sellAll = async (mint?: string) => {
    const hit = positions.filter((p) => !mint || p.mint === mint);
    const what = mint ? `${hit[0]?.symbol} from all ${hit.length} wallets` : `all ${hit.length} open positions`;
    setBusy(`all:${mint ?? ""}`);
    try {
      const r = await api<SellAllResult>("/api/positions/sell-all", { method: "POST", body: mint ? { mint } : {} });
      if (r.failed) toast.show(`Sold ${r.sold}, ${r.failed} failed: ${r.results.find((x) => !x.ok)?.error ?? "see the log"}`, "err");
      else toast.show(`Sold ${what}`);
    } catch (e) {
      toast.show((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  };
  const holders = new Map<string, number>();
  positions.forEach((p) => holders.set(p.mint, (holders.get(p.mint) ?? 0) + 1));

  if (!positions.length) {
    return <Empty icon={<PackageOpen size={20} />} title="No open positions">Snipe a token or enable auto-snipe and positions will stream in here with live prices.</Empty>;
  }
  return (
    <div className="overflow-x-auto scrollbar-thin">
      {toast.node}
      {positions.length > 1 && (
        <div className="flex justify-end px-4 pt-3">
          <Button size="sm" variant="danger" disabled={!!busy} onClick={() => sellAll()}>
            <Flame size={13} /> Sell everything ({positions.length})
          </Button>
        </div>
      )}
      <table className="w-full min-w-[820px]">
        <thead className="border-b border-neutral-800">
          <tr>
            <Th>Token</Th>
            <Th>Wallet</Th>
            <Th className="text-right">Holding</Th>
            <Th className="text-right">Entry / Now</Th>
            <Th className="text-right">Value</Th>
            <Th className="text-right">PnL</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800/70">
          {positions.map((p) => {
            const entry = p.costSol / p.tokens;
            const value = p.tokens * p.lastPriceSol;
            const change = (p.lastPriceSol / entry - 1) * 100;
            const pnl = value - p.costSol;
            return (
              <tr key={p.key} className="transition hover:bg-neutral-900/60">
                <Td>
                  <Link href={coinPage(p.mint)} className="font-medium hover:text-violet-300">{p.symbol}</Link>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="max-w-[140px] truncate text-xs text-neutral-500">{p.name}</span>
                    {p.mode === "sim" && <Badge tone="violet">SIM</Badge>}
                    {p.venue === "pump_amm" && <Badge>AMM</Badge>}
                  </div>
                </Td>
                <Td className="text-neutral-400">{p.walletName}</Td>
                <Td className="text-right font-mono tabular-nums">{compact(p.tokens)}</Td>
                <Td className="text-right font-mono text-xs tabular-nums text-neutral-400">
                  {price(entry)}
                  <div className="text-neutral-200">{price(p.lastPriceSol)}</div>
                </Td>
                <Td className="text-right font-mono tabular-nums">{value.toFixed(4)}</Td>
                <Td className={cx("text-right font-mono tabular-nums", pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {signed(pnl)}
                  <div className="text-xs">{pct(change)}</div>
                </Td>
                <Td className="text-right">
                  <div className="inline-flex gap-2">
                    <Button size="sm" disabled={!!busy} onClick={() => sell(p.key, 50)}>Sell 50%</Button>
                    <Button size="sm" variant="danger" disabled={!!busy} onClick={() => sell(p.key, 100)}>
                      <Flame size={13} /> Panic 100%
                    </Button>
                    {(holders.get(p.mint) ?? 0) > 1 && (
                      <Button size="sm" variant="danger" disabled={!!busy} title={`Sell ${p.symbol} from every wallet holding it`} onClick={() => sellAll(p.mint)}>
                        <Layers size={13} /> All {holders.get(p.mint)} wallets
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
