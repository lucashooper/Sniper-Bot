"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { accessToken, supabaseEnabled } from "./supabase";
import type { EngineState, LogLine } from "./types";

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

interface Ctx {
  state: EngineState | null;
  logs: LogLine[];
  connected: boolean;
  /** "unreachable" | "unauthorized" | "bad-url" | an API error message. */
  error: string | null;
  refresh: () => Promise<void>;
  /** Bumps whenever the engine says trades changed, so pages holding trade lists can re-fetch. */
  tradesVersion: number;
  reconnect: () => void;
}

const EngineCtx = createContext<Ctx | null>(null);

export function EngineProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<EngineState | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tradesVersion, setTradesVersion] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      } catch {
        setError("bad-url");
        retry = setTimeout(() => void connect(), 5000);
        return;
      }
      // First message authenticates; the engine sends nothing until it accepts the token.
      ws.onopen = () => ws?.send(JSON.stringify({ type: "auth", token }));
      ws.onclose = (ev) => {
        setConnected(false);
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
          setConnected(true);
          setError(null);
          setLogs(msg.logs);
          void refresh();
        } else if (msg.type === "log") setLogs((l) => (l.length > 800 ? [...l.slice(-600), msg.line] : [...l, msg.line]));
        else if (msg.type === "changed") {
          if (msg.topics.includes("trades")) setTradesVersion((v) => v + 1);
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
  }, [refresh, epoch]);

  return (
    <EngineCtx.Provider
      value={{ state, logs, connected, error, refresh, tradesVersion, reconnect: () => setEpoch((e) => e + 1) }}
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
