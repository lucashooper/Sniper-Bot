"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { diagnose, type Check } from "./diagnose";
import { accessToken, supabaseEnabled } from "./supabase";
import type { EngineState, Launch, LogLine, TapeTrade } from "./types";

/** Accepts "host", "host/" or a full URL; a bare host gets https:// (what Railway's domains need). */
export function normalizeUrl(raw: string) {
  const u = raw.trim().replace(/\/+$/, "");
  if (!u) return u;
  return /^https?:\/\//i.test(u) ? u : `${/^(localhost|127\.0\.0\.1)(:|$)/.test(u) ? "http" : "https"}://${u}`;
}

export const DEFAULT_URL = normalizeUrl(process.env.NEXT_PUBLIC_ENGINE_URL || "http://127.0.0.1:8787");

export function readConn() {
  if (typeof window === "undefined") return { url: DEFAULT_URL, token: "" };
  try {
    const saved = localStorage.getItem("engine.url") ?? "";
    // A localhost address saved while testing locally is never right for the deployed https site.
    const stale = window.location.protocol === "https:" && /\/\/(127\.0\.0\.1|localhost)/.test(saved);
    return {
      url: (!stale && normalizeUrl(saved)) || DEFAULT_URL,
      token: localStorage.getItem("engine.token") || "",
    };
  } catch {
    return { url: DEFAULT_URL, token: "" };
  }
}

export function saveConn(url: string, token: string) {
  try {
    localStorage.setItem("engine.url", url);
    localStorage.setItem("engine.token", token);
  } catch {
    /* storage blocked; the values still apply until reload */
  }
}

/** Supabase session when sign-in is configured, else the optional ENGINE_API_TOKEN saved in Settings. */
async function authToken() {
  return supabaseEnabled ? accessToken() : readConn().token;
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const { url } = readConn();
  const token = await authToken();
  const res = await fetch(`${url}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Downloads the trades CSV with the auth header (a plain link cannot carry it). */
export async function downloadTradesCsv() {
  const { url } = readConn();
  const token = await authToken();
  const res = await fetch(`${url}/api/export/trades.csv`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = `sniper-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** New trades of the coin open on the coin page, pushed by the engine as they happen. */
export interface TapePush {
  mint: string;
  /** Only sent when the coin is no longer in the feed list (the feed carries it otherwise). */
  launch?: Launch;
  trades: TapeTrade[];
  firstSeq: number;
  lastSeq: number;
}

interface Watch {
  mint: string;
  after: () => number;
  onTape: (p: TapePush) => void;
}

/** How many coins the feed list holds; matches the engine. */
const FEED_SIZE = 60;

/** Applies pushed coin updates to the feed list. Unchanged coins keep their object, so their rows skip re-rendering. */
function mergeLaunches(cur: Launch[], upd: Launch[]): Launch[] {
  const byMint = new Map(cur.map((l) => [l.mint, l]));
  let added = false;
  for (const u of upd) {
    if (!byMint.has(u.mint)) added = true;
    byMint.set(u.mint, u);
  }
  if (!added) return cur.map((l) => byMint.get(l.mint)!);
  return [...byMint.values()].sort((a, b) => b.ts - a.ts).slice(0, FEED_SIZE);
}

interface Ctx {
  state: EngineState | null;
  logs: LogLine[];
  connected: boolean;
  /** "unreachable" | "unauthorized" | "bad-url" | an API error message. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Bumps whenever the engine says trades changed, so pages holding trade lists can re-fetch. */
  tradesVersion: number;
  /** Bumps whenever the engine says the token feed moved (new launches, trades), so the coin page can re-fetch. */
  feedVersion: number;
  reconnect: () => void;
  /** True when the engine pushes feed and coin updates over the live connection (newer engines). */
  push: boolean;
  /** Streams new trades of one coin; returns a function that stops it. */
  watchTape: (mint: string, after: () => number, onTape: (p: TapePush) => void) => () => void;
  /** Hop-by-hop connection check, filled in while the engine is unreachable. */
  diagnosis: Check[] | null;
  runDiagnosis: () => Promise<void>;
}

const EngineCtx = createContext<Ctx | null>(null);

export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<EngineState | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<Check[] | null>(null);
  const lastDiag = useRef(0);
  const runDiagnosis = useCallback(async () => {
    lastDiag.current = Date.now();
    const checks = await diagnose(readConn().url, supabaseEnabled ? undefined : readConn().token);
    const bad = checks.find((c) => !c.ok);
    // eslint-disable-next-line no-console
    if (bad) console.warn(`[engine] ${bad.label}: ${bad.detail}`, checks);
    setDiagnosis(checks);
  }, []);
  const [tradesVersion, setTradesVersion] = useState(0);
  const [feedVersion, setFeedVersion] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [push, setPush] = useState(false);
  const pushRef = useRef(false);
  const sock = useRef<WebSocket | null>(null);
  const watch = useRef<Watch | null>(null);
  const sendWatch = useCallback(() => {
    const ws = sock.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !pushRef.current) return;
    const w = watch.current;
    ws.send(JSON.stringify(w ? { type: "watch", mint: w.mint, after: w.after() } : { type: "watch", mint: null }));
  }, []);
  const watchTape = useCallback(
    (mint: string, after: () => number, onTape: (p: TapePush) => void) => {
      const w: Watch = { mint, after, onTape };
      watch.current = w;
      sendWatch();
      return () => {
        if (watch.current !== w) return;
        watch.current = null;
        sendWatch();
      };
    },
    [sendWatch],
  );

  const refresh = useCallback(async () => {
    try {
      setState(await api<EngineState>("/api/state"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = async () => {
      const { url } = readConn();
      const token = await authToken();
      if (closed) return;
      let authFailed = false;
      try {
        ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
        sock.current = ws;
      } catch {
        setError("bad-url");
        retry = setTimeout(() => void connect(), 5000);
        return;
      }
      // First message authenticates; the engine sends nothing until it accepts the token.
      ws.onopen = () => ws?.send(JSON.stringify({ type: "auth", token }));
      ws.onclose = (ev) => {
        setConnected(false);
        // Explain the failure, at most every 20s while it keeps failing.
        if (!closed && Date.now() - lastDiag.current > 20_000) void runDiagnosis();
        if (ev.code === 4401) {
          authFailed = true;
          setError("unauthorized");
        }
        if (!closed) retry = setTimeout(() => void connect(), authFailed ? 10_000 : 3000);
      };
      ws.onerror = () => !authFailed && setError("unreachable");
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "hello") {
          pushRef.current = !!msg.push;
          setPush(!!msg.push);
          setConnected(true);
          setError(null);
          setDiagnosis(null);
          setLogs(msg.logs);
          sendWatch();
          void refresh();
        } else if (msg.type === "feed") {
          setState((s) => (s ? { ...s, launches: mergeLaunches(s.launches, msg.launches), solUsd: msg.solUsd ?? s.solUsd } : s));
        } else if (msg.type === "tape") {
          const w = watch.current;
          if (w && w.mint === msg.mint) w.onTape(msg as TapePush);
        } else if (msg.type === "log") setLogs((l) => (l.length > 800 ? [...l.slice(-600), msg.line] : [...l, msg.line]));
        else if (msg.type === "changed") {
          if (msg.topics.includes("trades")) setTradesVersion((v) => v + 1);
          // A pushing engine already sent the coins that changed; nothing to fetch for them.
          if (pushRef.current) {
            const rest = (msg.topics as string[]).filter((t) => t !== "launches");
            if (!rest.length) return;
          } else if (msg.topics.includes("launches")) setFeedVersion((v) => v + 1);
          // Older engines: the token feed ticks constantly; fetch just the launches for it instead of the whole state.
          if (!pushRef.current && msg.topics.length === 1 && msg.topics[0] === "launches") {
            api<Pick<EngineState, "launches" | "solUsd">>("/api/launches").then(
              (r) => setState((s) => (s ? { ...s, ...r } : s)),
              () => {},
            );
            return;
          }
          refreshTimer.current ??= setTimeout(() => {
            refreshTimer.current = null;
            void refresh();
          }, 150);
        }
      };
    };
    void connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [refresh, epoch, runDiagnosis, sendWatch]);

  return (
    <EngineCtx.Provider
      value={{ state, logs, connected, error, refresh, tradesVersion, feedVersion, reconnect: () => setEpoch((e) => e + 1), diagnosis, runDiagnosis, push, watchTape }}
    >
      {children}
    </EngineCtx.Provider>
  );
}

export function useEngine() {
  const c = useContext(EngineCtx);
  if (!c) throw new Error("useEngine outside EngineProvider");
  return c;
}
