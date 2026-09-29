"use client";

import { useEffect, useRef, useState } from "react";
import { useEngine } from "@/lib/engine";
import { solscan, time } from "@/lib/format";
import { cx } from "./ui";

const LEVEL: Record<string, string> = {
  info: "text-sky-300",
  success: "text-emerald-300",
  warn: "text-amber-300",
  error: "text-rose-300",
  debug: "text-neutral-500",
};

export function Terminal({ height = "h-[520px]", sources }: { height?: string; sources?: string[] }) {
  const { logs } = useEngine();
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const lines = sources ? logs.filter((l) => sources.includes(l.source)) : logs;

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, stick]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
      }}
      className={cx("overflow-y-auto scrollbar-thin bg-black/40 p-4 font-mono text-[12px] leading-relaxed", height)}
    >
      {lines.length === 0 && <div className="text-neutral-600">Waiting for events…</div>}
      {lines.map((l) => (
        <div key={l.id} className="flex gap-3 whitespace-pre-wrap break-all">
          <span className="shrink-0 text-neutral-600">{time(l.ts)}</span>
          <span className={cx("w-16 shrink-0", LEVEL[l.level])}>[{l.source}]</span>
          <span className={l.level === "error" ? "text-rose-200" : l.level === "debug" ? "text-neutral-500" : "text-neutral-200"}>
            {l.msg}
            {l.signature && (
              <a href={solscan(l.signature)} target="_blank" rel="noreferrer" className="ml-2 text-violet-400 hover:underline">
                {l.signature.slice(0, 8)}…
              </a>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
