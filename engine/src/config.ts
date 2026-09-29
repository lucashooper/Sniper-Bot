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
  apiPort: num(process.env.ENGINE_PORT, 8787),
  apiToken: process.env.ENGINE_API_TOKEN ?? "",
  dashboardOrigins: (process.env.DASHBOARD_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").map((s) => s.trim()),
  dataDir: path.resolve(process.env.ENGINE_DATA_DIR ?? path.join(process.cwd(), "data")),
  /** Hard switch: live trading is impossible unless this is set, whatever the dashboard toggle says. */
  allowLive: bool(process.env.ALLOW_LIVE_TRADING, false),
};

export const hasRpc = () => env.rpcUrl.length > 0;
