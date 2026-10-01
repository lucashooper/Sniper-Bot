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
  /** Only auto-snipe coins created by devs marked "follow" in the dev list. Hidden devs are never auto-sniped. */
  onlyFollowedDevs: boolean;
}

/**
 * A wallet the owner labelled, like Axiom's wallet labels: shown wherever that wallet appears (feed, coin page,
 * trades, holders). "follow" lets the feed and auto-snipe narrow to these devs; "hide" drops their coins from both.
 */
export interface DevTag {
  name: string;
  emoji: string;
  mode: "none" | "follow" | "hide";
  updatedAt: number;
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
  /** Labelled wallets by address. Changed through /api/devs, never by a plain settings save. */
  devs: Record<string, DevTag>;
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
    onlyFollowedDevs: false,
  },
  devs: {},
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
let current: Settings = { ...defaultSettings, ...saved, filters: { ...defaultSettings.filters, ...(saved.filters ?? {}) }, devs: saved.devs ?? {} };

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  // Dev labels have their own endpoint, so a stale settings form saved from another tab cannot wipe them.
  const { devs: _ignored, ...rest } = patch;
  patch = rest;
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

/* ---------------------------------------------------------------- dev labels */

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Real Solana addresses, plus the simulation market's fake trader names so labels can be tried in paper mode. */
export const isDevAddress = (a: string) => ADDRESS.test(a) || /^sim-trader-\d{1,4}$/.test(a);
const MAX_DEVS = 2_000;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** One emoji (or character) as the eye sees it, so skin tones and joined emoji stay whole. */
const firstSymbol = (s: string) => (graphemes.segment(s.trim())[Symbol.iterator]().next().value?.segment ?? "").slice(0, 16);

export class DevTagError extends Error {}

/** Adds or changes one labelled wallet. Name is trimmed to 32 characters, the emoji to one symbol. */
export function setDevTag(address: string, patch: Partial<Pick<DevTag, "name" | "emoji" | "mode">>): DevTag {
  const a = address.trim();
  if (!isDevAddress(a)) throw new DevTagError(`"${a.slice(0, 60)}" is not a Solana wallet address (32 to 44 base58 characters)`);
  const prev = current.devs[a];
  if (!prev && Object.keys(current.devs).length >= MAX_DEVS) throw new DevTagError(`The dev list is full (${MAX_DEVS} wallets). Remove some first.`);
  const mode = patch.mode ?? prev?.mode ?? "none";
  if (!["none", "follow", "hide"].includes(mode)) throw new DevTagError(`Unknown mode "${String(mode)}": use none, follow or hide`);
  const tag: DevTag = {
    name: String(patch.name ?? prev?.name ?? "").trim().slice(0, 32),
    emoji: firstSymbol(String(patch.emoji ?? prev?.emoji ?? "")),
    mode,
    updatedAt: Date.now(),
  };
  current = { ...current, devs: { ...current.devs, [a]: tag } };
  saveJson("settings.json", current);
  bus.changed("settings");
  return tag;
}

export function removeDevTag(address: string): boolean {
  if (!current.devs[address]) return false;
  const { [address]: _gone, ...devs } = current.devs;
  current = { ...current, devs };
  saveJson("settings.json", current);
  bus.changed("settings");
  return true;
}
