"use client";

import { useMemo, useRef, useState } from "react";

/** Cumulative realized PnL, one series: 2px line, zero baseline, crosshair + tooltip on hover. */
export function PnlChart({ series }: { series: { ts: number; pnl: number }[] }) {
  const W = 800;
  const H = 220;
  const P = { l: 56, r: 16, t: 16, b: 28 };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const pts = useMemo(() => (series.length ? [{ ts: series[0].ts - 1, pnl: 0 }, ...series] : []), [series]);
  if (pts.length < 2) {
    return <div className="grid h-[220px] place-items-center text-sm text-neutral-500">PnL appears here after your first sell.</div>;
  }
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const lo = Math.min(0, ...pts.map((p) => p.pnl));
  const hi = Math.max(0, ...pts.map((p) => p.pnl));
  const pad = (hi - lo || 1) * 0.1;
  const y = (v: number) => P.t + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - P.t - P.b);
  const x = (t: number) => P.l + ((t - t0) / (t1 - t0 || 1)) * (W - P.l - P.r);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.pnl).toFixed(1)}`).join("");
  const last = pts[pts.length - 1].pnl;
  const stroke = last >= 0 ? "#34d399" : "#fb7185";
  const ticks = [hi + pad, (hi + lo) / 2, lo - pad].map((v) => Number(v.toFixed(3)));
  const h = hover !== null ? pts[hover] : null;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="h-[220px] w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cumulative realized PnL, currently ${last.toFixed(4)} SOL`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          pts.forEach((p, i) => Math.abs(x(p.ts) - px) < Math.abs(x(pts[best].ts) - px) && (best = i));
          setHover(best);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#26282d" strokeWidth={1} />
            <text x={P.l - 8} y={y(t) + 4} textAnchor="end" className="fill-neutral-500 font-mono text-[11px]">{t}</text>
          </g>
        ))}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="#52525b" strokeWidth={1} strokeDasharray="3 3" />
        <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {h && (
          <>
            <line x1={x(h.ts)} x2={x(h.ts)} y1={P.t} y2={H - P.b} stroke="#71717a" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={x(h.ts)} cy={y(h.pnl)} r={4} fill={stroke} stroke="#121316" strokeWidth={2} />
          </>
        )}
      </svg>
      {h && hover! > 0 && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-neutral-700 bg-ink-900 px-3 py-2 text-xs shadow-lg"
          style={{ left: `clamp(8px, calc(${(x(h.ts) / W) * 100}% - 70px), calc(100% - 150px))` }}
        >
          <div className="text-neutral-400">{new Date(h.ts).toLocaleTimeString([], { hour12: false })}</div>
          <div className="font-mono text-neutral-100">{h.pnl >= 0 ? "+" : ""}{h.pnl.toFixed(4)} SOL</div>
        </div>
      )}
    </div>
  );
}
