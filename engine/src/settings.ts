import { bus } from "./bus.js";
import { loadJson, saveJson } from "./store.js";

export interface ExitRule {
  id: string;
  kind: "take_profit" | "stop_loss";
  /** Percent change from average entry that fires the rule, e.g. 100 = +100%, -25 = -25%. */
  triggerPct: number;
  /** Percent of the current position to sell when fired. */
  sellPct: number;
  enabled: boolean;
}

export interface SnipeFilters {
  minMarketCapSol: number;
  maxMarketCapSol: number;
  /** Real SOL deposited in the bonding curve. */
  minLiquiditySol: number;
  /** Skip coins whose creator wallet holds more than this % of supply. */
  maxDevHoldPct: number;
  /** Skip coins whose creator has already sold. */
  skipIfDevSold: boolean;
  /** Need at least one of Twitter/X, Telegram or website in the coin's metadata. */
  requireSocials: boolean;
  requireImage: boolean;
  /** 0 = buy at launch. Otherwise wait until the bonding curve is at least this % complete. */
  curveTriggerPct: number;
  /** Stop watching a launch for the trigger after this many seconds. */
  maxWatchSec: number;
}

export interface Settings {
  simulation: boolean;
  /** Auto-buy newly detected Pump.fun launches that pass filters. Off by default: manual snipes only. */
  autoSnipe: boolean;
  autoSnipeSol: number;
  autoSnipeMaxPerHour: number;
  /** Case-insensitive substrings; if non-empty a launch must match one in name or symbol. */
  autoSnipeKeywords: string[];
  /** Conditions a new launch must meet before auto-snipe buys it. 0 disables a numeric limit. */
  filters: SnipeFilters;
  /** SOL amounts on the feed's one-click buy buttons. */
  quickBuyPresets: number[];
  slippagePct: number;
  /** Compute-unit price in micro-lamports. 0 = fetch dynamically each trade. */
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  jitoTipSol: number;
  /** When true, use the live Jito tip floor (75th percentile) if it is above jitoTipSol, capped at jitoTipMaxSol. */
  jitoTipDynamic: boolean;
  jitoTipMaxSol: number;
  /**
   * How live orders are sent. "fast": one transaction to Helius Sender (routes to Jito and staked validators at once)
   * and the RPC in parallel, landing with any leader. "protected": a private Jito bundle only (no sandwich exposure,
   * but only Jito leaders can include it and Jito may drop it).
   */
  sendMode: "fast" | "protected";
  exitRules: ExitRule[];
  antiRug: {
    enabled: boolean;
    /** Emergency-sell when the coin's creator (dev wallet) sells any amount. */
    onCreatorSell: boolean;
    /** Emergency-sell when a single trade moves the price down by at least this %. 0 disables. */
    crashPct: number;
    /** Emergency-sell if the mint supply increases (someone minted). */
    onSupplyIncrease: boolean;
    /** Emergency-sell if PumpSwap liquidity is withdrawn from the pool of a held token. */
    onLiquidityRemoval: boolean;
    /** Extra tip for emergency sells. */
    emergencyTipSol: number;
  };
  safety: {
    requireMintAuthorityRevoked: boolean;
    requireFreezeAuthorityRevoked: boolean;
    /** Reject Token-2022 mints with extensions that can trap buyers (transfer hook, permanent delegate, etc.). */
    rejectDangerousExtensions: boolean;
    /** Reject if the top non-curve holder owns more than this % of supply. 0 disables. */
    maxTopHolderPct: number;
  };
}

export const defaultSettings: Settings = {
  simulation: true,
  autoSnipe: false,
  autoSnipeSol: 0.1,
  autoSnipeMaxPerHour: 5,
  autoSnipeKeywords: [],
  filters: {
    minMarketCapSol: 0,
    maxMarketCapSol: 0,
    minLiquiditySol: 0,
    maxDevHoldPct: 10,
    skipIfDevSold: true,
    requireSocials: false,
    requireImage: false,
    curveTriggerPct: 0,
    maxWatchSec: 300,
  },
  quickBuyPresets: [0.1, 0.5, 1],
  slippagePct: 15,
  priorityFeeMicroLamports: 0,
  computeUnitLimit: 200_000,
  jitoTipSol: 0.005,
  jitoTipDynamic: true,
  jitoTipMaxSol: 0.01,
  sendMode: "fast",
  exitRules: [
    { id: "tp1", kind: "take_profit", triggerPct: 100, sellPct: 50, enabled: true },
    { id: "tp2", kind: "take_profit", triggerPct: 200, sellPct: 50, enabled: true },
    { id: "sl", kind: "stop_loss", triggerPct: -25, sellPct: 100, enabled: true },
  ],
  antiRug: {
    enabled: true,
    onCreatorSell: true,
    crashPct: 40,
    onSupplyIncrease: true,
    onLiquidityRemoval: true,
    emergencyTipSol: 0.01,
  },
  safety: {
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    rejectDangerousExtensions: true,
    maxTopHolderPct: 20,
  },
};

const saved = loadJson<Partial<Settings>>("settings.json", {});
let current: Settings = { ...defaultSettings, ...saved, filters: { ...defaultSettings.filters, ...(saved.filters ?? {}) } };

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = {
    ...current,
    ...patch,
    antiRug: { ...current.antiRug, ...(patch.antiRug ?? {}) },
    safety: { ...current.safety, ...(patch.safety ?? {}) },
    filters: { ...current.filters, ...(patch.filters ?? {}) },
  };
  if (patch.quickBuyPresets) {
    current.quickBuyPresets = patch.quickBuyPresets.map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 6);
  }
  saveJson("settings.json", current);
  bus.changed("settings");
  return current;
}
