// Mirrors of the engine's API shapes (engine/src). Kept by hand: the engine is the source of truth.
export type Venue = "pump_curve" | "pump_amm";

export interface Status {
  live: boolean;
  simulation: boolean;
  liveAllowed: boolean;
  rpcConfigured: boolean;
  marketSource: "stream" | "synthetic";
  keystoreUnlocked: boolean;
  jitoBlockEngine: string;
  auth: "supabase" | "token" | "none";
  cloud: { enabled: boolean; ownerResolved: boolean; lastBackupAt: number; lastError: string };
}

export interface ExitRule {
  id: string;
  kind: "take_profit" | "stop_loss";
  triggerPct: number;
  sellPct: number;
  enabled: boolean;
}

export interface SnipeFilters {
  minMarketCapSol: number;
  maxMarketCapSol: number;
  minLiquiditySol: number;
  maxDevHoldPct: number;
  skipIfDevSold: boolean;
  requireSocials: boolean;
  requireImage: boolean;
  curveTriggerPct: number;
  maxWatchSec: number;
}

export interface Settings {
  simulation: boolean;
  autoSnipe: boolean;
  autoSnipeSol: number;
  autoSnipeMaxPerHour: number;
  autoSnipeKeywords: string[];
  filters: SnipeFilters;
  quickBuyPresets: number[];
  slippagePct: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  jitoTipSol: number;
  jitoTipDynamic: boolean;
  jitoTipMaxSol: number;
  exitRules: ExitRule[];
  antiRug: {
    enabled: boolean;
    onCreatorSell: boolean;
    crashPct: number;
    onSupplyIncrease: boolean;
    onLiquidityRemoval: boolean;
    emergencyTipSol: number;
  };
  safety: {
    requireMintAuthorityRevoked: boolean;
    requireFreezeAuthorityRevoked: boolean;
    rejectDangerousExtensions: boolean;
    maxTopHolderPct: number;
  };
}

export interface Wallet {
  id: string;
  name: string;
  publicKey: string;
  isMaster: boolean;
  active: boolean;
  createdAt: number;
}

export interface WalletGroup {
  id: string;
  name: string;
  walletIds: string[];
  createdAt: number;
}

export interface SellAllResult {
  sold: number;
  failed: number;
  results: { wallet: string; symbol: string; ok: boolean; solReceived?: number; error?: string }[];
}

export interface WalletBalance {
  sol: number;
  tokens: { mint: string; amount: number; program: string }[];
  updatedAt: number;
}

export interface Position {
  key: string;
  walletId: string;
  walletName: string;
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  venue: Venue;
  mode: "sim" | "live";
  tokens: number;
  costSol: number;
  entryPriceSol: number;
  lastPriceSol: number;
  peakPriceSol: number;
  realizedPnlSol: number;
  firedRules: string[];
  openedAt: number;
}

export interface Metrics {
  totalInvestedSol: number;
  portfolioValueSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  winRatePct: number;
  closedCount: number;
  openCount: number;
  tradeCount: number;
  jitoTipsSol: number;
  feesSol: number;
}

export interface TokenMeta {
  image?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface Launch {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  uri: string;
  ts: number;
  signature?: string;
  simulated: boolean;
  priceSol: number;
  marketCapSol: number;
  athMarketCapSol: number;
  curvePct: number;
  liquiditySol: number;
  volumeSol: number;
  buys: number;
  sells: number;
  traders: number;
  devHoldPct: number;
  devSold: boolean;
  migrated: boolean;
  spark: number[];
  meta: TokenMeta | null;
  metaStatus: "pending" | "ok" | "none";
  sniped?: boolean;
  skipped?: string;
}

export interface Trade {
  id: string;
  ts: number;
  mode: "sim" | "live";
  side: "buy" | "sell";
  reason: string;
  walletName: string;
  mint: string;
  symbol: string;
  venue: Venue;
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  priorityFeeSol: number;
  jitoTipSol: number;
  networkFeeSol: number;
  realizedPnlSol: number;
  signature?: string;
  bundleId?: string;
}

export interface LogLine {
  id: number;
  ts: number;
  level: "info" | "success" | "warn" | "error" | "debug";
  source: string;
  msg: string;
  signature?: string;
  mint?: string;
}

export interface EngineState {
  status: Status;
  settings: Settings;
  wallets: Wallet[];
  /** Missing on engines older than wallet groups. */
  groups?: WalletGroup[];
  balances: Record<string, WalletBalance>;
  positions: Position[];
  metrics: Metrics;
  launches: Launch[];
  /** SOL/USD spot from the engine; null when it could not fetch one. */
  solUsd: number | null;
}
