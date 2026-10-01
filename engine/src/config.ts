import path from "node:path";

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Static process config, read once from the environment (.env at the repo root). */
export const env = {
  rpcUrl: process.env.SOLANA_RPC_URL ?? "",
  wsUrl: process.env.SOLANA_WS_URL ?? "",
  /** Optional Helius key; enables getPriorityFeeEstimate. Derived from the RPC URL when it is a Helius URL. */
  heliusApiKey:
    process.env.HELIUS_API_KEY ??
    (process.env.SOLANA_RPC_URL?.match(/helius-rpc\.com\/\?api-key=([\w-]+)/)?.[1] ?? ""),
  jitoBlockEngineUrl: (process.env.JITO_BLOCK_ENGINE_URL ?? "https://mainnet.block-engine.jito.wtf").replace(/\/$/, ""),
  jitoAuthUuid: process.env.JITO_AUTH_UUID ?? "",
  keystorePassphrase: process.env.KEYSTORE_PASSPHRASE ?? "",
  apiHost: process.env.ENGINE_HOST ?? "127.0.0.1",
  /** PORT is what Railway, Fly and Render inject; ENGINE_PORT wins when both are set. */
  apiPort: num(process.env.ENGINE_PORT || process.env.PORT, 8787),
  apiToken: process.env.ENGINE_API_TOKEN ?? "",
  /** Tolerates pasted quotes, spaces and trailing slashes: browsers send the bare origin, e.g. https://x.netlify.app */
  dashboardOrigins: (process.env.DASHBOARD_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim().replace(/\/+$/, "").toLowerCase())
    .filter(Boolean),
  dataDir: path.resolve(process.env.ENGINE_DATA_DIR ?? path.join(process.cwd(), "data")),
  /** Supabase: sign-in for the dashboard and an off-host backup of the engine's state. Optional for local use. */
  supabaseUrl: (process.env.SUPABASE_URL ?? "").replace(/\/$/, ""),
  /** Secret (sb_secret_...) or legacy service_role key. Engine host only; never put it on Netlify. */
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  /** The only account allowed to drive the engine. */
  ownerEmail: (process.env.OWNER_EMAIL ?? "").trim().toLowerCase(),
  /** Hard switch: live trading is impossible unless this is set, whatever the dashboard toggle says. */
  allowLive: bool(process.env.ALLOW_LIVE_TRADING, false),
};

export const hasRpc = () => env.rpcUrl.length > 0;
export const hasSupabase = () => !!(env.supabaseUrl && env.supabaseSecretKey && env.ownerEmail);
/** Anything but loopback is reachable from outside the machine (a cloud host binds 0.0.0.0). */
export const isPublicBind = () => !["127.0.0.1", "localhost", "::1"].includes(env.apiHost);
