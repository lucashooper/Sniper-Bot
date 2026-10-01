import http from "node:http";
import { env, hasSupabase, isPublicBind } from "./config.js";
import { flushBackups, initCloud } from "./cloud.js";

// Boot order matters: the Supabase restore has to land in engine/data before the stores read their files, so the
// rest of the engine is imported only afterwards.
async function boot() {
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

/**
 * When boot fails, keep answering on the engine's port instead of exiting: a crash loop only shows the host's
 * generic "failed to respond" page, while this lets the dashboard print the exact reason. Nothing else is served,
 * and no secret values appear in these messages.
 */
function serveStartupError(message: string) {
  const server = http.createServer((req, res) => {
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/health") return res.writeHead(200, headers).end(JSON.stringify({ ok: false, startupError: message }));
    res.writeHead(503, headers).end(JSON.stringify({ error: `Engine failed to start: ${message}` }));
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("error", (e) => {
    console.error(`Could not serve the startup error either: ${e.message}`);
    process.exit(1);
  });
  server.listen(env.apiPort, env.apiHost, () =>
    console.error(`Serving the startup error on http://${env.apiHost}:${env.apiPort}/health until the engine is fixed and redeployed`),
  );
}

boot().catch((e) => {
  const message = (e as Error).message;
  console.error(`Engine failed to start: ${message}`);
  serveStartupError(message);
});
