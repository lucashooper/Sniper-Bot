"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { EngineState, LogLine } from "./types";

const DEFAULT_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://127.0.0.1:8787";

function readConn() {
  if (typeof window === "undefined") return { url: DEFAULT_URL, token: "" };
  try {
    return {
      url: localStorage.getItem("engine.url") || DEFAULT_URL,
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

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const { url, token } = readConn();
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

export function exportUrl() {
  const { url, token } = readConn();
  return `${url}/api/export/trades.csv${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

interface Ctx {
  state: EngineState | null;
  logs: LogLine[];
  connected: boolean;
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

    const connect = () => {
      const { url, token } = readConn();
      const wsUrl = `${url.replace(/^http/, "ws")}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        setConnected(true);
        void refresh();
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => setError("Cannot reach the engine. Is it running? (npm run dev:engine)");
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "hello") setLogs(msg.logs);
        else if (msg.type === "log") setLogs((l) => (l.length > 800 ? [...l.slice(-600), msg.line] : [...l, msg.line]));
        else if (msg.type === "changed") {
          if (msg.topics.includes("trades")) setTradesVersion((v) => v + 1);
          refreshTimer.current ??= setTimeout(() => {
            refreshTimer.current = null;
            void refresh();
          }, 150);
        }
      };
    };
    connect();
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
