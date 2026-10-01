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
  /** Missing on engines older than dev labels. */
  onlyFollowedDevs?: boolean;
}

/** A labelled wallet (engine settings.devs). */
export interface DevTag {
  name: string;
  emoji: string;
  mode: "none" | "follow" | "hide";
  updatedAt: number;
}

export interface Settings {
  simulation: boolean;
  autoSnipe: boolean;
  autoSnipeSol: number;
  autoSnipeMaxPerHour: number;
  autoSnipeKeywords: string[];
  filters: SnipeFilters;
  /** Labelled wallets by address. Missing on engines older than dev labels. */
  devs?: Record<string, DevTag>;
  quickBuyPresets: number[];
  slippagePct: number;
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  jitoTipSol: number;
  jitoTipDynamic: boolean;
  jitoTipMaxSol: number;
  /** "fast": Helius Sender + RPC in parallel; "protected": private Jito bundle only. */
  sendMode?: "fast" | "protected";
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
  /** Market cap when the coin was created: where its chart starts. */
  launchMarketCapSol: number;
  athMarketCapSol: number;
  curvePct: number;
  liquiditySol: number;
  volumeSol: number;
  buys: number;
  sells: number;
  traders: number;
  /** Missing on engines older than the Pulse view. */
  holders?: number;
  devHoldPct: number;
  devSold: boolean;
  migrated: boolean;
  migratedAt?: number;
  spark: number[];
  meta: TokenMeta | null;
  metaStatus: "pending" | "ok" | "none";
  sniped?: boolean;
  skipped?: string;
}

export interface TapeTrade {
  seq: number;
  ts: number;
  priceSol: number;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  trader: string;
  byCreator: boolean;
  signature?: string;
}

export interface Holder {
  address: string;
  tokens: number;
  pct: number;
  isCreator: boolean;
}

/** GET /api/token/:mint. Untracked coins (launched before the engine started, or long gone from the feed) carry only solUsd. */
export type TokenDetail =
  | { tracked: false; solUsd: number | null }
  | {
      tracked: true;
      launch: Launch;
      trades: TapeTrade[];
      firstSeq: number;
      lastSeq: number;
      holders: Holder[];
      holderCount: number;
      top10Pct: number;
      solUsd: number | null;
    };

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
