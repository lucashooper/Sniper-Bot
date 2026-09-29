import { Keypair } from "@solana/web3.js";
import { log } from "./bus.js";
import { market } from "./events.js";

/**
 * Synthetic Pump.fun-like market for simulation mode when no RPC is configured (or for demoing the dashboard).
 * Coins follow a noisy constant-product-ish random walk; some moon, most bleed, some get rugged by their creator.
 * Everything it publishes goes through the same MarketEvent pipeline as the live stream.
 */
interface SimCoin {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  price: number;
  fate: "moon" | "bleed" | "rug";
  age: number;
  rugAt: number;
  migrated: boolean;
}

const coins = new Map<string, SimCoin>();
const ADJ = ["Based", "Tiny", "Giga", "Sleepy", "Cosmic", "Angry", "Degen", "Frog", "Moon", "Turbo", "Wif", "Baby"];
const NOUN = ["Cat", "Pepe", "Doge", "Hamster", "Goblin", "Penguin", "Chad", "Otter", "Wizard", "Banana", "Duck", "Bonk"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
// Fresh Pump.fun curve: ~30 SOL virtual / ~1.073B virtual tokens.
const START_PRICE = 30 / 1_073_000_000;
const SUPPLY = 1_000_000_000;

let timers: NodeJS.Timeout[] = [];

export const isSimMint = (mint: string) => coins.has(mint);
export const simPrice = (mint: string) => coins.get(mint)?.price ?? null;
export const simCoin = (mint: string) => coins.get(mint);

function launch() {
  const name = `${pick(ADJ)} ${pick(NOUN)}`;
  const symbol = name.replace(/[^A-Z]/g, "") + pick(["", "AI", "X", "INU", ""]);
  const r = Math.random();
  const coin: SimCoin = {
    mint: Keypair.generate().publicKey.toBase58(),
    name,
    symbol: symbol.slice(0, 8),
    creator: Keypair.generate().publicKey.toBase58(),
    price: START_PRICE,
    fate: r < 0.2 ? "moon" : r < 0.75 ? "bleed" : "rug",
    age: 0,
    rugAt: 10 + Math.floor(Math.random() * 40),
    migrated: false,
  };
  coins.set(coin.mint, coin);
  market.publish({
    type: "launch",
    mint: coin.mint,
    name: coin.name,
    symbol: coin.symbol,
    uri: "",
    creator: coin.creator,
    priceSol: coin.price,
    marketCapSol: coin.price * SUPPLY,
    ts: Date.now(),
    simulated: true,
  });
}

function tick() {
  for (const c of coins.values()) {
    c.age++;
    const prev = c.price;
    const drift = c.fate === "moon" ? 0.035 : c.fate === "bleed" ? -0.012 : 0.01;
    const shock = (Math.random() - 0.5) * 0.18;
    let byCreator = false;
    if (c.fate === "rug" && c.age === c.rugAt) {
      c.price *= 0.25;
      byCreator = true;
    } else {
      c.price = Math.max(START_PRICE * 0.05, c.price * Math.exp(drift + shock));
    }
    const isBuy = c.price >= prev;
    market.publish({
      type: "trade",
      mint: c.mint,
      priceSol: c.price,
      prevPriceSol: prev,
      isBuy,
      solAmount: Math.abs(c.price - prev) * 50_000_000,
      trader: byCreator ? c.creator : "sim-trader",
      byCreator,
      venue: c.migrated ? "pump_amm" : "pump_curve",
    });
    // Pump.fun curves complete at roughly 85 SOL raised, ~ 400+ SOL market cap.
    if (!c.migrated && c.price * SUPPLY > 400) {
      c.migrated = true;
      market.publish({ type: "migration", mint: c.mint });
    }
    if (c.age > 400) coins.delete(c.mint);
  }
}

export function startSimMarket() {
  if (timers.length) return;
  log.info("sim", "Synthetic market running: fake launches every ~10s, prices tick every 2s");
  launch();
  const scheduleLaunch = () => {
    timers.push(setTimeout(() => (launch(), scheduleLaunch()), 6_000 + Math.random() * 9_000));
  };
  scheduleLaunch();
  timers.push(setInterval(tick, 2_000));
}

export function stopSimMarket() {
  timers.forEach((t) => clearTimeout(t));
  timers = [];
}
