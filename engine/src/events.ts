import { EventEmitter } from "node:events";

export type Venue = "pump_curve" | "pump_amm";

export type MarketEvent =
  | {
      type: "launch";
      mint: string;
      name: string;
      symbol: string;
      uri: string;
      creator: string;
      priceSol: number;
      marketCapSol: number;
      ts: number;
      signature?: string;
      simulated: boolean;
    }
  | {
      type: "trade";
      mint: string;
      priceSol: number;
      /** Price before this trade, when known; used for crash detection. */
      prevPriceSol?: number;
      isBuy: boolean;
      solAmount: number;
      trader: string;
      byCreator: boolean;
      venue: Venue;
      signature?: string;
    }
  | { type: "migration"; mint: string; pool?: string; signature?: string }
  | { type: "liquidity_removed"; mint: string; pool: string; signature?: string }
  | { type: "supply_increase"; mint: string; before: string; after: string };

class Market extends EventEmitter {
  publish(e: MarketEvent) {
    this.emit("event", e);
  }
  subscribe(fn: (e: MarketEvent) => void) {
    this.on("event", fn);
  }
}

export const market = new Market();
