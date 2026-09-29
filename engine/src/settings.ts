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

export interface Settings {
  simulation: boolean;
  /** Auto-buy newly detected Pump.fun launches that pass filters. Off by default: manual snipes only. */
  autoSnipe: boolean;
  autoSnipeSol: number;
  autoSnipeMaxPerHour: number;
  /** Case-insensitive substrings; if non-empty a launch must match one in name or symbol. */
  autoSnipeKeywords: string[];
  slippagePct: number;
  /** Compute-unit price in micro-lamports. 0 = fetch dynamically each trade. */
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  jitoTipSol: number;
  /** When true, use the live Jito tip floor (75th percentile) if it is above jitoTipSol, capped at jitoTipMaxSol. */
  jitoTipDynamic: boolean;
  jitoTipMaxSol: number;
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
  slippagePct: 15,
  priorityFeeMicroLamports: 0,
  computeUnitLimit: 200_000,
  jitoTipSol: 0.003,
  jitoTipDynamic: true,
  jitoTipMaxSol: 0.01,
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

let current: Settings = { ...defaultSettings, ...loadJson<Partial<Settings>>("settings.json", {}) };

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = {
    ...current,
    ...patch,
    antiRug: { ...current.antiRug, ...(patch.antiRug ?? {}) },
    safety: { ...current.safety, ...(patch.safety ?? {}) },
  };
  saveJson("settings.json", current);
  bus.changed("settings");
  return current;
}
