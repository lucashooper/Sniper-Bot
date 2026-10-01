"use client";

import { useEffect, useMemo, useRef } from "react";
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
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { TapeTrade, Trade } from "@/lib/types";

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
 * first trade and in simulation. Dev trades and your own fills are marked on the candles.
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
    if (prev.key === dataKey && prev.len > 0 && data.length >= prev.len) {
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
    const first = data[0]?.time ?? 0;
    const m: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      if (t.byCreator && t.trader === creator) {
        m.push({ time: bucket(t.ts), position: t.isBuy ? "belowBar" : "aboveBar", color: "#facc15", shape: "circle", text: t.isBuy ? "DB" : "DS", size: 0.6 });
      }
    }
    for (const f of fills) {
      const time = bucket(f.ts);
      if (time < first) continue;
      m.push({ time, position: f.side === "buy" ? "belowBar" : "aboveBar", color: f.side === "buy" ? UP : DOWN, shape: f.side === "buy" ? "arrowUp" : "arrowDown", text: f.side === "buy" ? "B" : "S" });
    }
    markers.current?.setMarkers(m.sort((a, b) => (a.time as number) - (b.time as number)));

    // Re-fit when the coin, interval or unit changes; otherwise keep the user's zoom and follow the newest candle.
    const key = `${creator}:${intervalSec}:${unit}`;
    if (fitKey.current !== key) {
      fitKey.current = key;
      // A fixed window of ~90 candles keeps candle width steady instead of stretching a young coin's 3 candles across the chart.
      chart.current.timeScale().setVisibleLogicalRange({ from: data.length - 90, to: data.length + 3 });
    }
  }, [trades, intervalSec, value, unit, creator, startPriceSol, startTs, fills]);

  return <div ref={box} className="h-full w-full" />;
}
