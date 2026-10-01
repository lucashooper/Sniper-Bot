import http from "node:http";
import { env, hasSupabase, isPublicBind } from "./config.js";
import { flushBackups, initCloud } from "./cloud.js";

// Boot order matters: the Supabase restore has to land in engine/data before the stores read their files, so the
// rest of the engine is imported only afterwards.
async function preflight() {
  if (isPublicBind() && !hasSupabase() && !env.apiToken) {
    throw new Error(
      `ENGINE_HOST=${env.apiHost} exposes the engine to the network, but no sign-in is configured. ` +
        "Set SUPABASE_URL, SUPABASE_SECRET_KEY and OWNER_EMAIL (or at least ENGINE_API_TOKEN), or bind to 127.0.0.1.",
    );
  }
  if (env.supabaseUrl && !hasSupabase()) {
    throw new Error("SUPABASE_URL is set but SUPABASE_SECRET_KEY or OWNER_EMAIL is missing");
  }
  if (hasSupabase()) await initCloud();
}

async function boot() {
  const { start } = await import("./app.js");
  await start();

  const stop = async (sig: string) => {
    console.log(`${sig}: saving state to Supabase before exit`);
    await flushBackups().catch(() => {});
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

const errorHandler = (message: string) => (req: http.IncomingMessage, res: http.ServerResponse) => {
  const headers = { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" };
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/health") return void res.writeHead(200, headers).end(JSON.stringify({ ok: false, startupError: message }));
  res.writeHead(503, headers).end(JSON.stringify({ error: `Engine failed to start: ${message}` }));
};

/**
 * When boot fails, keep answering on the engine's port instead of exiting: a crash loop only shows the host's
 * generic "failed to respond" page, while this lets the dashboard print the exact reason. Nothing else is served,
 * and no secret values appear in these messages.
 */
function serveStartupError(message: string): http.Server {
  const server = http.createServer(errorHandler(message));
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("error", (e) => {
    console.error(`Could not serve the startup error either: ${e.message}`);
    process.exit(1);
  });
  server.listen(env.apiPort, env.apiHost, () =>
    console.error(`Serving the startup error on http://${env.apiHost}:${env.apiPort}/health; re-checking every ${RETRY_MS / 1000}s`),
  );
  return server;
}

const RETRY_MS = 20_000;

/**
 * Most startup failures are fixed outside the engine (running the SQL, creating the Supabase user), so the checks
 * are retried until they pass; the engine then starts without a redeploy. A failure after the checks (in the engine
 * itself) is only reported.
 */
async function main() {
  let failsafe: http.Server | null = null;
  let last = "";
  for (;;) {
    try {
      await preflight();
      break;
    } catch (e) {
      const message = (e as Error).message;
      if (message !== last) console.error(`Engine failed to start: ${message}`);
      last = message;
      if (failsafe) failsafe.removeAllListeners("request").on("request", errorHandler(message));
      else failsafe = serveStartupError(message);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  if (failsafe) {
    const closed = new Promise<void>((r) => failsafe!.close(() => r()));
    failsafe.closeAllConnections();
    await closed;
    console.log("Startup checks pass now; starting the engine");
  }
  try {
    await boot();
  } catch (e) {
    console.error(`Engine failed to start: ${(e as Error).message}`);
    serveStartupError((e as Error).message);
  }
}

void main();
