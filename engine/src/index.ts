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

boot().catch((e) => {
  console.error(`Engine failed to start: ${(e as Error).message}`);
  process.exit(1);
});
