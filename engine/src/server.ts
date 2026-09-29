import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { env, hasRpc } from "./config.js";
import { bus, log, type LogLine } from "./bus.js";
import { recentLaunches } from "./engine.js";
import { isUnlocked } from "./keystore.js";
import {
  closedPositions,
  metrics,
  openPositions,
  pnlSeries,
  resetSimulation,
  trades,
  tradesCsv,
} from "./portfolio.js";
import { checkMint } from "./safety.js";
import { getSettings, updateSettings, type Settings } from "./settings.js";
import { executeBuy, executeSell, isLive } from "./trader.js";
import { fundWallet, getBalances, reclaimAll, refreshBalances } from "./walletOps.js";
import { generateWallet, importWallet, listWallets, removeWallet, updateWallet } from "./wallets.js";

type Handler = (body: any, params: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)"))}$`);
  routes.push({ method, pattern, keys, handler });
}

export function status() {
  return {
    live: isLive(),
    simulation: getSettings().simulation,
    liveAllowed: env.allowLive,
    rpcConfigured: hasRpc(),
    marketSource: hasRpc() ? "stream" : "synthetic",
    keystoreUnlocked: isUnlocked(),
    jitoBlockEngine: env.jitoBlockEngineUrl,
  };
}

route("GET", "/api/status", () => status());
route("GET", "/api/state", () => ({
  status: status(),
  settings: getSettings(),
  wallets: listWallets(),
  balances: getBalances(),
  positions: openPositions(),
  metrics: metrics(),
  launches: recentLaunches().slice(0, 50),
}));
route("GET", "/api/settings", () => getSettings());
route("PUT", "/api/settings", (b: Partial<Settings>) => {
  if (b.simulation === false && !env.allowLive) {
    throw new HttpError(400, "Live trading is disabled. Set ALLOW_LIVE_TRADING=true in .env and restart the engine first.");
  }
  const s = updateSettings(b);
  if (b.simulation !== undefined) log.warn("engine", s.simulation ? "Simulation mode ON: no real transactions" : "LIVE MODE: trades now spend real SOL");
  return s;
});

route("GET", "/api/wallets", () => ({ wallets: listWallets(), balances: getBalances() }));
route("POST", "/api/wallets/import", (b) => importWallet(String(b.secret ?? ""), String(b.name ?? ""), Number(b.accountIndex ?? 0)));
route("POST", "/api/wallets/generate", (b) => generateWallet(String(b.name ?? "")));
route("PATCH", "/api/wallets/:id", (b, p) => updateWallet(p.id, b));
route("DELETE", "/api/wallets/:id", (_b, p) => removeWallet(p.id));
route("POST", "/api/wallets/refresh", async () => (await refreshBalances(), getBalances()));
route("POST", "/api/wallets/:id/fund", (b, p) => fundWallet(p.id, Number(b.sol)));
route("POST", "/api/wallets/reclaim", () => reclaimAll());

route("POST", "/api/safety", (b) => checkMint(String(b.mint)));
route("POST", "/api/snipe", (b) =>
  executeBuy({ mint: String(b.mint).trim(), walletId: String(b.walletId ?? ""), sol: Number(b.sol), reason: "manual" }),
);
route("POST", "/api/positions/:key/sell", (b, p) =>
  executeSell(decodeURIComponent(p.key), Number(b.pct ?? 100), Number(b.pct) >= 100 ? "panic" : "manual"),
);

route("GET", "/api/positions", () => ({ open: openPositions(), closed: closedPositions() }));
route("GET", "/api/trades", () => trades().slice(-500).reverse());
route("GET", "/api/pnl", (_b, _p, url) => {
  const mode = url.searchParams.get("mode") as "sim" | "live" | null;
  return { metrics: metrics(mode ?? undefined), series: pnlSeries(mode ?? undefined) };
});
route("POST", "/api/sim/reset", () => resetSimulation());
route("GET", "/api/logs", () => bus.history.slice(-300));

class HttpError extends Error {
  constructor(public code: number, msg: string) {
    super(msg);
  }
}

function authorized(req: http.IncomingMessage, url: URL) {
  if (!env.apiToken) return true;
  const header = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(header);
  const b = Buffer.from(env.apiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Browsers send Origin on cross-site requests; only the dashboard may drive the engine (blocks drive-by CSRF from
// any other site open in the same browser). Non-browser clients (curl) send no Origin and are allowed.
function originAllowed(req: http.IncomingMessage) {
  const o = req.headers.origin;
  return !o || env.dashboardOrigins.includes(o);
}

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers.origin && originAllowed(req)) res.setHeader("access-control-allow-origin", req.headers.origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (!originAllowed(req)) return res.writeHead(403).end('{"error":"origin not allowed"}');
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return res.writeHead(415).end('{"error":"content-type must be application/json"}');
    }
    if (!authorized(req, url)) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');

    if (req.method === "GET" && url.pathname === "/api/export/trades.csv") {
      res.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="sniper-trades-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      return res.end(tradesCsv());
    }

    const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
    if (!r) return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
    const m = url.pathname.match(r.pattern)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    let body: unknown = {};
    if (req.method !== "GET") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString();
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return res.writeHead(400).end('{"error":"invalid json"}');
      }
    }
    try {
      const out = await r.handler(body, params, url);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 400;
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });

  // Live push: log lines as they happen, plus "changed" hints so the dashboard re-fetches only what moved.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !originAllowed(req) || !authorized(req, url)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "hello", logs: bus.history.slice(-200), status: status() }));
    ws.on("close", () => clients.delete(ws));
  });
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    clients.forEach((c) => c.readyState === c.OPEN && c.send(s));
  };
  bus.on("log", (line: LogLine) => broadcast({ type: "log", line }));
  // Coalesce bursts of change notifications (price ticks) to at most one per topic every 250ms.
  const pending = new Set<string>();
  let flush: NodeJS.Timeout | null = null;
  bus.on("changed", (topic: string) => {
    pending.add(topic);
    flush ??= setTimeout(() => {
      broadcast({ type: "changed", topics: [...pending] });
      pending.clear();
      flush = null;
    }, 250);
  });

  server.listen(env.apiPort, env.apiHost, () => {
    log.info("engine", `API listening on http://${env.apiHost}:${env.apiPort}${env.apiToken ? " (token required)" : ""}`);
  });
}
