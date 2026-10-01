import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { env, hasRpc, hasSupabase, isPublicBind } from "./config.js";
import { checkOwnerToken, cloudStatus, type AuthResult } from "./cloud.js";
import { bus, DetailedError, log, type LogLine } from "./bus.js";
import { feedList, solUsd, takeDirty, tapeBounds, tapeSince, tokenDetail, touchView, type Launch } from "./feed.js";
import { isUnlocked } from "./keystore.js";
import { short } from "./solana.js";
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
import { DevTagError, getSettings, removeDevTag, setDevTag, updateSettings, type Settings } from "./settings.js";
import { createGroup, generateIntoGroup, listGroups, removeGroup, updateGroup } from "./groups.js";
import { executeBuy, executeSell, groupBuy, groupSell, isLive, sellAll } from "./trader.js";
import { fundGroup, fundWallet, getBalances, reclaimAll, refreshBalances, withdraw } from "./walletOps.js";
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
    auth: hasSupabase() ? "supabase" : env.apiToken ? "token" : "none",
    cloud: { ...cloudStatus },
  };
}

route("GET", "/api/status", () => status());
route("GET", "/api/state", () => ({
  status: status(),
  settings: getSettings(),
  wallets: listWallets(),
  groups: listGroups(),
  balances: getBalances(),
  positions: openPositions(),
  metrics: metrics(),
  launches: feedList(),
  solUsd: solUsd(),
}));
route("GET", "/api/launches", () => ({ launches: feedList(), solUsd: solUsd() }));
route("GET", "/api/token/:mint", (_b, p, url) => {
  const d = tokenDetail(decodeURIComponent(p.mint), Number(url.searchParams.get("after") ?? 0) || 0);
  return d ? { tracked: true, ...d, solUsd: solUsd() } : { tracked: false, solUsd: solUsd() };
});
route("GET", "/api/settings", () => getSettings());
route("PUT", "/api/settings", (b: Partial<Settings>) => {
  if (b.simulation === false && !env.allowLive) {
    throw new HttpError(400, "Live trading is disabled. Set ALLOW_LIVE_TRADING=true in .env and restart the engine first.");
  }
  const s = updateSettings(b);
  if (b.simulation !== undefined) log.warn("engine", s.simulation ? "Simulation mode ON: no real transactions" : "LIVE MODE: trades now spend real SOL");
  return s;
});

// Dev labels: one wallet at a time, so two open dashboards never overwrite each other's labels.
route("PUT", "/api/devs/:address", (b, p) => {
  const address = decodeURIComponent(p.address);
  try {
    const tag = setDevTag(address, { name: b.name, emoji: b.emoji, mode: b.mode });
    log.info("engine", `Dev ${short(address)} labelled ${[tag.emoji, tag.name].filter(Boolean).join(" ") || "(no name)"}${tag.mode !== "none" ? ` (${tag.mode})` : ""}`);
    return { address, ...tag };
  } catch (e) {
    if (e instanceof DevTagError) throw new HttpError(400, e.message);
    throw e;
  }
});
route("DELETE", "/api/devs/:address", (_b, p) => {
  const address = decodeURIComponent(p.address);
  if (!removeDevTag(address)) throw new HttpError(404, `No label saved for ${address}`);
  log.info("engine", `Dev label removed from ${short(address)}`);
  return { ok: true };
});

route("GET", "/api/wallets", () => ({ wallets: listWallets(), groups: listGroups(), balances: getBalances() }));
route("POST", "/api/wallets/import", (b) => importWallet(String(b.secret ?? ""), String(b.name ?? ""), Number(b.accountIndex ?? 0)));
route("POST", "/api/wallets/generate", (b) => generateWallet(String(b.name ?? "")));
route("PATCH", "/api/wallets/:id", (b, p) => updateWallet(p.id, b));
route("DELETE", "/api/wallets/:id", (_b, p) => removeWallet(p.id));
route("POST", "/api/wallets/refresh", async () => (await refreshBalances(), getBalances()));
route("POST", "/api/wallets/:id/fund", (b, p) => fundWallet(p.id, Number(b.sol)));
route("POST", "/api/wallets/reclaim", (b) => reclaimAll(b.groupId ? String(b.groupId) : undefined));
route("POST", "/api/wallets/:id/withdraw", (b, p) => withdraw(p.id, String(b.to ?? ""), b.sol === "max" ? "max" : Number(b.sol)));

route("POST", "/api/groups", (b) => createGroup(b.name, b.walletIds));
route("PATCH", "/api/groups/:id", (b, p) => updateGroup(p.id, b));
route("DELETE", "/api/groups/:id", (_b, p) => removeGroup(p.id));
route("POST", "/api/groups/:id/generate", (b, p) => generateIntoGroup(p.id, Number(b.count)));
route("POST", "/api/groups/:id/fund", (b, p) => fundGroup(p.id, Number(b.sol)));

route("POST", "/api/safety", (b) => checkMint(String(b.mint)));
route("POST", "/api/snipe", (b) => {
  const mint = String(b.mint).trim();
  return executeBuy({ mint, walletId: String(b.walletId ?? ""), sol: Number(b.sol), reason: "manual" }).catch((e) => {
    log.error("trade", `Buy of ${Number(b.sol)} SOL failed: ${(e as Error).message}`, { mint });
    throw e;
  });
});
route("POST", "/api/positions/:key/sell", (b, p) =>
  executeSell(decodeURIComponent(p.key), Number(b.pct ?? 100), Number(b.pct) >= 100 ? "panic" : "manual").catch((e) => {
    log.error("trade", `Sell of ${Number(b.pct ?? 100)}% failed: ${(e as Error).message}`);
    throw e;
  }),
);

// Presets: one order across every wallet of a wallet group (see groupBuy / groupSell for how each send mode lands it).
route("POST", "/api/presets/:id/buy", (b, p) => {
  const mint = String(b.mint ?? "").trim();
  const l = tokenDetail(mint)?.launch;
  return groupBuy({ mint, groupId: p.id, sol: Number(b.sol), meta: l ? { name: l.name, symbol: l.symbol, creator: l.creator } : undefined }).catch((e) => {
    log.error("trade", `Preset buy of ${Number(b.sol)} SOL per wallet failed: ${(e as Error).message}`, { mint });
    throw e;
  });
});
route("POST", "/api/presets/:id/sell", (b, p) =>
  groupSell({ mint: String(b.mint ?? "").trim(), groupId: p.id, pct: Number(b.pct ?? 100) }).catch((e) => {
    log.error("trade", `Preset sell of ${Number(b.pct ?? 100)}% failed: ${(e as Error).message}`);
    throw e;
  }),
);
route("POST", "/api/positions/sell-all", (b) =>
  sellAll({ mint: b.mint ? String(b.mint) : undefined, groupId: b.groupId ? String(b.groupId) : undefined }),
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

/**
 * Who may drive the engine: the owner's Supabase session (dashboard), or ENGINE_API_TOKEN (scripts, curl).
 * With neither configured the engine only trusts its own machine, and index.ts refuses a public bind in that case.
 */
async function authorize(token: string): Promise<AuthResult> {
  if (env.apiToken && token) {
    const a = Buffer.from(token);
    const b = Buffer.from(env.apiToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  }
  if (hasSupabase()) return checkOwnerToken(token);
  if (!env.apiToken && !isPublicBind()) return { ok: true };
  return { ok: false, reason: token ? "Wrong ENGINE_API_TOKEN" : "No API token sent; set it under Settings" };
}

/** Logs each distinct rejection at most once a minute so the host's logs explain failures without flooding. */
const lastWarned = new Map<string, number>();
function warnOnce(msg: string) {
  const now = Date.now();
  if ((lastWarned.get(msg) ?? 0) > now - 60_000) return;
  if (lastWarned.size > 100) lastWarned.clear();
  lastWarned.set(msg, now);
  log.warn("engine", msg);
}
const bearer = (req: http.IncomingMessage) => req.headers.authorization?.replace(/^Bearer /, "") ?? "";

// Browsers send Origin on cross-site requests; only the dashboard may drive the engine (blocks drive-by CSRF from
// any other site open in the same browser). Non-browser clients (curl) send no Origin and are allowed.
function originAllowed(req: http.IncomingMessage) {
  const o = req.headers.origin;
  return !o || env.dashboardOrigins.includes(o.toLowerCase());
}

function originRejected(req: http.IncomingMessage) {
  warnOnce(`Rejected a browser request from origin ${req.headers.origin}: not in DASHBOARD_ORIGINS (${env.dashboardOrigins.join(", ")})`);
}

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers.origin && originAllowed(req)) res.setHeader("access-control-allow-origin", req.headers.origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  // Every authorised request is "non-simple" and needs a preflight; let the browser reuse the answer (Chrome caps
  // this at 2 hours) instead of paying an extra round trip before each one.
  res.setHeader("access-control-max-age", "7200");
}

/** JSON reply, gzipped when it is big enough to matter and the browser accepts it (the state and feed are ~50 KB raw). */
function sendJson(req: http.IncomingMessage, res: http.ServerResponse, code: number, out: unknown) {
  const body = JSON.stringify(out);
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    return res.writeHead(code, { "content-type": "application/json", "content-encoding": "gzip", vary: "origin, accept-encoding" }).end(zlib.gzipSync(body, { level: 4 }));
  }
  res.writeHead(code, { "content-type": "application/json" }).end(body);
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Unauthenticated probe for the hosting platform and the dashboard's connection check. Readable from any origin
    // so a misconfigured DASHBOARD_ORIGINS can be diagnosed from the browser; it reveals nothing about the bot.
    if (req.method === "GET" && url.pathname === "/health") {
      const origin = req.headers.origin;
      return res
        .writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" })
        .end(JSON.stringify({ ok: true, auth: status().auth, origin: origin ?? null, originAllowed: originAllowed(req), allowedOrigins: env.dashboardOrigins }));
    }
    cors(req, res);
    if (!originAllowed(req)) {
      originRejected(req);
      return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: `Origin ${req.headers.origin} is not in the engine's DASHBOARD_ORIGINS` }));
    }
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return res.writeHead(415).end('{"error":"content-type must be application/json"}');
    }
    const auth = await authorize(bearer(req)).catch((e): AuthResult => ({ ok: false, reason: `Sign-in check failed: ${(e as Error).message}` }));
    if (!auth.ok) {
      warnOnce(`Rejected ${req.method} ${url.pathname}: ${auth.reason}`);
      return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: `Unauthorized: ${auth.reason}`, reason: auth.reason }));
    }

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
      sendJson(req, res, 200, out ?? { ok: true });
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 400;
      const details = e instanceof DetailedError ? e.details : undefined;
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message, details }));
    }
  });

  // Live push: log lines as they happen, plus "changed" hints so the dashboard re-fetches only what moved.
  // Compress larger frames (feed batches); small ones (log lines) go as-is so they are not delayed.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 } } });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return socket.destroy();
    if (!originAllowed(req)) {
      originRejected(req);
      return socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  // Browsers cannot set headers on a WebSocket, and a token in the URL ends up in proxy logs, so the first message
  // must be {"type":"auth","token":"..."}. Nothing is sent to a socket until it has authenticated.
  const clients = new Set<WebSocket>();
  /** The coin each dashboard has open on its coin page, and the last trade of it that dashboard already has. */
  const watching = new Map<WebSocket, { mint: string; seq: number }>();
  wss.on("connection", (ws, req: http.IncomingMessage) => {
    const origin = req?.headers.origin;
    const deadline = setTimeout(() => ws.close(4401, "No sign-in message within 5s"), 5_000);
    ws.once("message", async (raw) => {
      clearTimeout(deadline);
      let token = "";
      try {
        const m = JSON.parse(String(raw));
        if (m?.type === "auth") token = String(m.token ?? "");
      } catch {
        /* not JSON: falls through as unauthenticated */
      }
      const auth = await authorize(token).catch((e): AuthResult => ({ ok: false, reason: `Sign-in check failed: ${(e as Error).message}` }));
      if (!auth.ok) {
        warnOnce(`Rejected live connection: ${auth.reason}`);
        // Close reasons are capped at 123 bytes; the dashboard asks /api/status for the full reason.
        return ws.close(4401, Buffer.from(auth.reason).subarray(0, 120).toString());
      }
      clients.add(ws);
      log.debug("engine", `Dashboard connected from ${origin ?? "no origin"}`);
      // push: the dashboard can take feed updates from this socket instead of re-fetching the feed on every hint.
      ws.send(JSON.stringify({ type: "hello", logs: bus.history.slice(-200), status: status(), push: 1 }));
      ws.on("message", (raw) => {
        try {
          const m = JSON.parse(String(raw));
          if (m?.type !== "watch") return;
          if (typeof m.mint === "string" && m.mint) {
            watching.set(ws, { mint: m.mint, seq: Number(m.after) || 0 });
            touchView(m.mint);
          } else watching.delete(ws);
        } catch {
          /* ignore malformed messages */
        }
      });
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      clients.delete(ws);
      watching.delete(ws);
    });
  });
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    clients.forEach((c) => c.readyState === c.OPEN && c.send(s));
  };
  bus.on("log", (line: LogLine) => broadcast({ type: "log", line }));
  // Live feed: every ~100ms, only the coins that changed (the dashboard merges them into its list), plus new trades of
  // the coin each dashboard has open. Replaces a hint followed by a full re-fetch, which cost a round trip per tick.
  bus.on("feed", () => {
    const changed = takeDirty();
    // Older dashboards still re-fetch on this hint.
    bus.changed("launches");
    if (!clients.size) return;
    const top = feedList();
    const inFeed = new Set(top.map((l) => l.mint));
    const set = new Set(changed);
    const launches: Launch[] = top.filter((l) => set.has(l.mint));
    if (launches.length) broadcast({ type: "feed", launches, solUsd: solUsd() });
    for (const [ws, w] of watching) {
      if (ws.readyState !== ws.OPEN || !set.has(w.mint)) continue;
      const fresh = tapeSince(w.mint, w.seq);
      const d = tapeBounds(w.mint);
      if (!d) continue;
      if (fresh.length) w.seq = fresh[fresh.length - 1].seq;
      // The coin's own row rides along when it has left the feed list.
      ws.send(JSON.stringify({ type: "tape", mint: w.mint, launch: inFeed.has(w.mint) ? undefined : d.launch, trades: fresh, firstSeq: d.firstSeq, lastSeq: d.lastSeq }));
    }
  });
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
    log.info("engine", `API listening on http://${env.apiHost}:${env.apiPort} (sign-in: ${status().auth})`);
    log.info("engine", `Browser origins allowed (DASHBOARD_ORIGINS): ${env.dashboardOrigins.join(", ") || "none"}`);
  });
}
