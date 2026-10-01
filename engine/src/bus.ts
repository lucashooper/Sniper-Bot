import { EventEmitter } from "node:events";

export type LogLevel = "info" | "success" | "warn" | "error" | "debug";
export type LogSource = "engine" | "stream" | "detect" | "jito" | "trade" | "safety" | "exit" | "wallet" | "sim";

export interface LogLine {
  id: number;
  ts: number;
  level: LogLevel;
  source: LogSource;
  msg: string;
  signature?: string;
  mint?: string;
}

class Bus extends EventEmitter {
  private seq = 0;
  readonly history: LogLine[] = [];

  log(level: LogLevel, source: LogSource, msg: string, extra: Partial<Pick<LogLine, "signature" | "mint">> = {}) {
    const line: LogLine = { id: ++this.seq, ts: Date.now(), level, source, msg, ...extra };
    this.history.push(line);
    if (this.history.length > 1000) this.history.shift();
    const tag = `[${source}]`.padEnd(9);
    // eslint-disable-next-line no-console
    console.log(`${new Date(line.ts).toISOString()} ${level.toUpperCase().padEnd(7)} ${tag} ${msg}`);
    this.emit("log", line);
  }

  /** Tell dashboard clients that a slice of state changed and should be re-fetched / re-rendered. */
  changed(topic: "positions" | "wallets" | "settings" | "trades" | "launches") {
    this.emit("changed", topic);
  }
}

export const bus = new Bus();
export const log = {
  info: (s: LogSource, m: string, e?: Partial<LogLine>) => bus.log("info", s, m, e),
  success: (s: LogSource, m: string, e?: Partial<LogLine>) => bus.log("success", s, m, e),
  warn: (s: LogSource, m: string, e?: Partial<LogLine>) => bus.log("warn", s, m, e),
  error: (s: LogSource, m: string, e?: Partial<LogLine>) => bus.log("error", s, m, e),
  debug: (s: LogSource, m: string, e?: Partial<LogLine>) => bus.log("debug", s, m, e),
};

/**
 * An error that carries the facts behind it (which check failed, the numbers it compared) so the API can return
 * them to the dashboard, which shows the message and logs the details to the browser console.
 */
export class DetailedError extends Error {
  constructor(message: string, public details: Record<string, unknown>) {
    super(message);
  }
}
