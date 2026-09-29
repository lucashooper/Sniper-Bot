"use client";

import { useState } from "react";
import { useEngine } from "@/lib/engine";
import { Terminal } from "@/components/terminal";
import { Card, cx } from "@/components/ui";

const FILTERS: { label: string; sources?: string[] }[] = [
  { label: "All" },
  { label: "Detection", sources: ["stream", "detect"] },
  { label: "Jito bundles", sources: ["jito"] },
  { label: "Trades & exits", sources: ["trade", "exit", "safety"] },
  { label: "Wallets", sources: ["wallet"] },
  { label: "Engine", sources: ["engine", "sim"] },
];

export default function FeedPage() {
  const { connected, logs } = useEngine();
  const [f, setF] = useState(0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Live Feed &amp; Logs</h1>
        <p className="mt-1 text-sm text-neutral-400">Streamed from the engine over WebSocket: launch detection, safety verdicts, Jito bundle status and confirmed signatures.</p>
      </div>
      <Card
        title={
          <span className="flex items-center gap-2">
            <i className={cx("h-2 w-2 rounded-full", connected ? "animate-pulse bg-emerald-400" : "bg-neutral-600")} />
            terminal
            <span className="font-normal text-neutral-500">{logs.length} lines</span>
          </span>
        }
        action={
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((x, i) => (
              <button
                key={x.label}
                onClick={() => setF(i)}
                className={cx("rounded-lg px-2.5 py-1 text-xs", f === i ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-200")}
              >
                {x.label}
              </button>
            ))}
          </div>
        }
      >
        <Terminal height="h-[calc(100vh-260px)] min-h-[420px]" sources={FILTERS[f].sources} />
      </Card>
    </div>
  );
}
