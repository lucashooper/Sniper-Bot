"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { m as motion } from "framer-motion";
import { ExternalLink } from "lucide-react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Logical,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { TapeTrade, Trade } from "@/lib/types";
import { compact, short, solscan } from "@/lib/format";
import { cx } from "@/components/ui";

export const INTERVALS = [
  { label: "1s", sec: 1 },
  { label: "5s", sec: 5 },
  { label: "15s", sec: 15 },
  { label: "1m", sec: 60 },
  { label: "5m", sec: 300 },
] as const;

export type ChartUnit = "mcap" | "price";

const SUPPLY = 1_000_000_000;
const UP = "#34d399";
const DOWN = "#fb7185";

interface Candle {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVol: number;
}

/**
 * Buckets the trade tape into candles. Each candle opens at the previous close (the way Axiom and Pump.fun draw
 * thin coins), so a quiet stretch reads as a flat line instead of floating gaps.
 */
export function buildCandles(trades: TapeTrade[], intervalSec: number, value: (priceSol: number) => number, startPriceSol?: number, startTs?: number): Candle[] {
  const out: Candle[] = [];
  let prev = startPriceSol !== undefined ? value(startPriceSol) : undefined;
  if (prev !== undefined && startTs && (!trades.length || trades[0].ts > startTs)) {
    const t = (Math.floor(startTs / 1000 / intervalSec) * intervalSec) as UTCTimestamp;
    out.push({ time: t, open: prev, high: prev, low: prev, close: prev, volume: 0, buyVol: 0 });
  }
  for (const tr of trades) {
    const t = (Math.floor(tr.ts / 1000 / intervalSec) * intervalSec) as UTCTimestamp;
    const v = value(tr.priceSol);
    let c = out[out.length - 1];
    if (!c || c.time !== t) {
      const open = prev ?? v;
      c = { time: t, open, high: Math.max(open, v), low: Math.min(open, v), close: v, volume: 0, buyVol: 0 };
      out.push(c);
    }
    c.high = Math.max(c.high, v);
    c.low = Math.min(c.low, v);
    c.close = v;
    c.volume += tr.solAmount;
    if (tr.isBuy) c.buyVol += tr.solAmount;
    prev = v;
  }
  return out;
}

export function fmtAxis(n: number, usd: boolean) {
  // The volume pane's margin lets the scale dip below zero; a market cap or price never does.
  if (n < 0) return "";
  const a = Math.abs(n);
  const p = usd ? "$" : "";
  if (a >= 1e9) return `${p}${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${p}${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${p}${(n / 1e3).toFixed(1)}K`;
  if (a >= 100) return `${p}${n.toFixed(0)}`;
  if (a >= 1) return `${p}${n.toFixed(2)}`;
  if (a === 0) return `${p}0`;
  return `${p}${n.toPrecision(3)}`;
}

/**
 * Live candle chart for one coin, drawn from the engine's own trade stream so it works on the bonding curve from the
 * first trade and in simulation. Dev trades are marked on the candles; your own fills
 * are badges pinned to their exact fill price and time.
 */
export function TokenChart({
  trades,
  intervalSec,
  unit,
  solUsd,
  creator,
  startPriceSol,
  startTs,
  fills,
}: {
  trades: TapeTrade[];
  intervalSec: number;
  unit: ChartUnit;
  solUsd: number | null;
  creator: string;
  startPriceSol: number;
  startTs: number;
  fills: Trade[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const fitKey = useRef("");
  const drawn = useRef({ key: "", len: 0 });
  const intervalSecRef = useRef(intervalSec);
  intervalSecRef.current = intervalSec;

  // Market cap in USD when the engine has a SOL price (what Pump.fun and Axiom show), otherwise in SOL.
  const usd = solUsd !== null && unit === "mcap";
  const value = useMemo(() => {
    const k = unit === "mcap" ? SUPPLY * (solUsd ?? 1) : 1;
    return (p: number) => p * k;
  }, [unit, solUsd]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#737373", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(255,255,255,0.03)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "#26272b", scaleMargins: { top: 0.12, bottom: 0.22 } },
      timeScale: {
        borderColor: "#26272b",
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 3,
        // Axis labels in the viewer's local time (the library draws UTC by default).
        tickMarkFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: intervalSecRef.current < 60 ? "2-digit" : undefined }),
      },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#525252", labelBackgroundColor: "#26272b" }, horzLine: { color: "#525252", labelBackgroundColor: "#26272b" } },
      localization: { timeFormatter: (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour12: false }) },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    markers.current = createSeriesMarkers(candles.current, []);
    chart.current = c;
    drawn.current = { key: "", len: 0 };
    return () => {
      c.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      markers.current = null;
    };
  }, []);

  // Where each of your fills sits on the chart, in pixels. Recomputed whenever the view or the data moves.
  const times = useRef<number[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const fillsRef = useRef(fills);
  fillsRef.current = fills;
  const valueRef = useRef(value);
  valueRef.current = value;
  const lastSpots = useRef("");
  const place = useCallback(() => {
    const c = chart.current;
    const s = candles.current;
    const t = times.current;
    if (!c || !s || !box.current) return;
    const ts = c.timeScale();
    const iv = intervalSecRef.current;
    const width = box.current.clientWidth - c.priceScale("right").width();
    const height = box.current.clientHeight - ts.height();
    const bar = ts.options().barSpacing;
    const out: Spot[] = [];
    for (const f of fillsRef.current) {
      const sec = f.ts / 1000;
      // The candle the fill belongs to (or the last one before it), then the exact moment inside that candle.
      let lo = 0;
      let hi = t.length - 1;
      if (hi < 0 || sec < t[0]) continue;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (t[mid] <= sec) lo = mid;
        else hi = mid - 1;
      }
      const base = ts.logicalToCoordinate(lo as Logical);
      const y = s.priceToCoordinate(valueRef.current(f.priceSol));
      if (base === null || y === null) continue;
      const frac = Math.min(1, (sec - t[lo]) / iv) - 0.5;
      const x = base + frac * bar;
      if (x < 0 || x > width || y < 0 || y > height) continue;
      // Tooltips open away from the nearer edge so they are never cut off.
      out.push({ f, x, y, up: y > height * 0.5 });
    }
    const sig = out.map((o) => `${o.f.id}:${o.x.toFixed(1)}:${o.y.toFixed(1)}`).join("|");
    if (sig === lastSpots.current) return;
    lastSpots.current = sig;
    setSpots(out);
  }, []);

  useEffect(() => {
    candles.current?.applyOptions({ priceFormat: { type: "custom", minMove: 1e-12, formatter: (n: number) => fmtAxis(n, usd) } });
  }, [usd]);

  useEffect(() => {
    const s = candles.current;
    const v = volume.current;
    if (!s || !v || !chart.current) return;
    const data = buildCandles(trades, intervalSec, value, startPriceSol, startTs);
    const bar = ({ time, open, high, low, close }: Candle) => ({ time, open, high, low, close });
    const vol = (c: Candle) => ({ time: c.time, value: c.volume, color: c.buyVol >= c.volume / 2 ? "rgba(52,211,153,0.35)" : "rgba(251,113,133,0.35)" });
    // New trades only touch the last candle or add one: update those instead of redrawing the whole series.
    const dataKey = `${creator}:${intervalSec}:${unit}:${value(1)}:${data[0]?.time ?? 0}`;
    const prev = drawn.current;
    if (prev.key === dataKey && prev.len > 0 && data.length >= prev.len && data.length - prev.len < 50) {
      for (const c of data.slice(prev.len - 1)) {
        s.update(bar(c));
        v.update(vol(c));
      }
    } else {
      s.setData(data.map(bar));
      v.setData(data.map(vol));
    }
    drawn.current = { key: dataKey, len: data.length };

    const bucket = (ts: number) => (Math.floor(ts / 1000 / intervalSec) * intervalSec) as UTCTimestamp;
    const m: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      if (t.byCreator && t.trader === creator) {
        m.push({ time: bucket(t.ts), position: t.isBuy ? "belowBar" : "aboveBar", color: "#facc15", shape: "circle", text: t.isBuy ? "DB" : "DS", size: 0.6 });
      }
    }
    markers.current?.setMarkers(m.sort((a, b) => (a.time as number) - (b.time as number)));
    // Your own fills are drawn as HTML badges over the chart (below), at their exact price and time.
    times.current = data.map((c) => c.time as number);

    // Re-fit when the coin, interval or unit changes; otherwise keep the user's zoom and follow the newest candle.
    // Also re-fit once the first trades arrive (the page can open on the feed's copy before the tape loads).
    const key = `${creator}:${intervalSec}:${unit}:${trades.length > 0}`;
    if (fitKey.current !== key) {
      fitKey.current = key;
      // A fixed window of ~90 candles keeps candle width steady instead of stretching a young coin's 3 candles across the chart.
      chart.current.timeScale().setVisibleLogicalRange({ from: data.length - 90, to: data.length + 3 });
    }
    // The price scale re-fits on the next paint; place the fill badges after it.
    requestAnimationFrame(() => requestAnimationFrame(place));
  }, [trades, intervalSec, value, unit, creator, startPriceSol, startTs, place]);

  useEffect(() => place(), [fills, place]);

  // Badges follow the chart as it scrolls, zooms, resizes or re-scales.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const ts = c.timeScale();
    ts.subscribeVisibleLogicalRangeChange(place);
    ts.subscribeSizeChange(place);
    c.subscribeCrosshairMove(place);
    place();
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(place);
      ts.unsubscribeSizeChange(place);
      c.unsubscribeCrosshairMove(place);
    };
  }, [place]);

  return (
    <div className="relative h-full w-full">
      <div ref={box} className="h-full w-full" />
      <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
        {spots.map((sp) => (
          <FillBadge key={sp.f.id} spot={sp} usd={usd} solUsd={solUsd} />
        ))}
      </div>
    </div>
  );
}

interface Spot {
  f: Trade;
  x: number;
  y: number;
  up: boolean;
}

/**
 * One of your buys (green B) or sells (red S), pinned to the price and time it filled at. A dot marks the exact point;
 * the badge sits just below a buy and above a sell. Hover for the details; click to open the transaction.
 */
function FillBadge({ spot, usd, solUsd }: { spot: Spot; usd: boolean; solUsd: number | null }) {
  const { f, x, y, up } = spot;
  const buy = f.side === "buy";
  // A fill from the last 20 s pulses once it appears, so a trade that just landed is easy to spot.
  const [fresh] = useState(() => Date.now() - f.ts < 20_000);
  const mc = f.priceSol * SUPPLY;
  const mcText = usd && solUsd ? fmtAxis(mc * solUsd, true) : `${fmtAxis(mc, false)} SOL`;
  const rows: [string, string][] = [
    ["Amount", `${f.solAmount.toFixed(4)} SOL · ${compact(f.tokenAmount)} ${f.symbol}`],
    ["MC", mcText],
    ["Price", `${f.priceSol.toPrecision(4)} SOL`],
    ["Slot", f.slot ? f.slot.toLocaleString() : f.mode === "sim" ? "paper trade" : "not reported"],
    ["Wallet", f.walletName],
    ["Time", new Date(f.ts).toLocaleTimeString([], { hour12: false })],
  ];
  if (!buy) rows.splice(2, 0, ["PnL", `${f.realizedPnlSol >= 0 ? "+" : ""}${f.realizedPnlSol.toFixed(4)} SOL`]);
  const open = () => f.signature && window.open(solscan(f.signature), "_blank", "noopener,noreferrer");
  return (
    <div className="group absolute hover:z-20" style={{ left: x, top: y }}>
      <span className={cx("absolute -left-[3px] -top-[3px] h-1.5 w-1.5 rounded-full ring-2 ring-ink-950", buy ? "bg-emerald-400" : "bg-rose-400")} />
      <motion.button
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 22 }}
        onClick={open}
        className={cx(
          "pointer-events-auto absolute -left-[9px] grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-bold text-white shadow-lg ring-1 ring-black/40",
          buy ? "top-[7px] bg-emerald-500 shadow-emerald-900/40" : "-top-[25px] bg-rose-500 shadow-rose-900/40",
        )}
      >
        {fresh && <span className={cx("absolute inset-0 animate-ping rounded-full opacity-60 [animation-iteration-count:3]", buy ? "bg-emerald-400" : "bg-rose-400")} />}
        <span className="relative">{buy ? "B" : "S"}</span>
      </motion.button>
      <div
        className={cx(
          "pointer-events-none absolute left-1/2 z-10 hidden w-max min-w-[190px] -translate-x-1/2 rounded-lg border border-white/[0.08] bg-ink-900 px-3 py-2 text-[11px] shadow-2xl group-hover:block",
          up ? "bottom-[32px]" : "top-[32px]",
        )}
      >
        <div className={cx("mb-1 font-semibold", buy ? "text-emerald-300" : "text-rose-300")}>
          {buy ? "Bought" : "Sold"} {f.symbol}
          {f.mode === "sim" && <span className="ml-1 font-normal text-violet-300">paper</span>}
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 tabular-nums">
            <span className="text-neutral-500">{k}</span>
            <span className="text-neutral-200">{v}</span>
          </div>
        ))}
        {f.signature && (
          <div className="mt-1 flex items-center gap-1 font-mono text-violet-300">
            {short(f.signature, 6)} <ExternalLink size={10} /> <span className="font-sans text-neutral-500">click badge</span>
          </div>
        )}
      </div>
    </div>
  );
}
