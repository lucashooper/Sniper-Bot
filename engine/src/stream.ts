import { PublicKey, type Logs } from "@solana/web3.js";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_SDK, pumpIdl } from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda, pumpAmmJson } from "@pump-fun/pump-swap-sdk";
import { log } from "./bus.js";
import { market } from "./events.js";
import { isTrackedLaunch } from "./feed.js";
import { heldMints } from "./portfolio.js";
import { connection, LAMPORTS } from "./solana.js";

/**
 * Live detection over standard Solana WebSocket `logsSubscribe` (works with Helius, Triton, QuickNode or any RPC).
 * Pump.fun emits Anchor events as `Program data:` log lines, so one subscription per program is enough to see every
 * launch, trade and graduation without polling. For the lowest latency swap this for a Yellowstone gRPC /
 * Helius LaserStream subscriber; the rest of the engine only consumes MarketEvents and does not care.
 */

const disc = (idl: { events?: Array<{ name: string; discriminator: number[] }> }, name: string) =>
  Buffer.from(idl.events!.find((e) => e.name === name)!.discriminator).toString("hex");

const PUMP = {
  create: disc(pumpIdl as never, "CreateEvent"),
  trade: disc(pumpIdl as never, "TradeEvent"),
  complete: disc(pumpIdl as never, "CompleteEvent"),
};
const ammCoder = new BorshCoder(pumpAmmJson as unknown as Idl);
const TOKEN_DECIMALS = 6;

const lastPrice = new Map<string, number>();
const creators = new Map<string, string>();
const subs: number[] = [];

function dataLines(l: Logs) {
  return l.logs.filter((x) => x.startsWith("Program data: ")).map((x) => x.slice(14));
}

export function onPumpLogs(l: Logs) {
  if (l.err) return;
  const held = new Set(heldMints());
  for (const b64 of dataLines(l)) {
    const buf = Buffer.from(b64, "base64");
    const d = buf.subarray(0, 8).toString("hex");
    try {
      if (d === PUMP.create) {
        const e = PUMP_SDK.decodeCreateEventBc(buf.subarray(8));
        const price = e.virtualSolReserves.toNumber() / LAMPORTS / (e.virtualTokenReserves.toNumber() / 10 ** TOKEN_DECIMALS);
        const mint = e.mint.toBase58();
        creators.set(mint, e.creator.toBase58());
        market.publish({
          type: "launch",
          mint,
          name: e.name,
          symbol: e.symbol,
          uri: e.uri,
          creator: e.creator.toBase58(),
          priceSol: price,
          marketCapSol: (price * e.tokenTotalSupply.toNumber()) / 10 ** TOKEN_DECIMALS,
          ts: Date.now(),
          signature: l.signature,
          simulated: false,
          curveTokens: e.realTokenReserves.toNumber() / 10 ** TOKEN_DECIMALS,
        });
      } else if (d === PUMP.trade) {
        const e = PUMP_SDK.decodeTradeEventBc(buf.subarray(8));
        const mint = e.mint.toBase58();
        // Only follow coins we hold or show in the feed; the rest of Pump.fun's volume is noise here.
        if (!held.has(mint) && !isTrackedLaunch(mint)) continue;
        const price = e.virtualSolReserves.toNumber() / LAMPORTS / (e.virtualTokenReserves.toNumber() / 10 ** TOKEN_DECIMALS);
        const prev = lastPrice.get(mint);
        if (lastPrice.size > 5_000) lastPrice.clear(); // feed coins rotate out; keep the map bounded
        lastPrice.set(mint, price);
        market.publish({
          type: "trade",
          mint,
          priceSol: price,
          prevPriceSol: prev,
          isBuy: e.isBuy,
          solAmount: e.solAmount.toNumber() / LAMPORTS,
          tokenAmount: e.tokenAmount.toNumber() / 10 ** TOKEN_DECIMALS,
          realSolReserves: e.realSolReserves.toNumber() / LAMPORTS,
          realTokenReserves: e.realTokenReserves.toNumber() / 10 ** TOKEN_DECIMALS,
          trader: e.user.toBase58(),
          byCreator: e.user.equals(e.creator),
          venue: "pump_curve",
          signature: l.signature,
        });
      } else if (d === PUMP.complete) {
        const e = PUMP_SDK.decodeCompleteEventBc(buf.subarray(8));
        market.publish({ type: "migration", mint: e.mint.toBase58(), pool: canonicalPumpPoolPda(e.mint).toBase58(), signature: l.signature });
      }
    } catch {
      /* layout we do not know (new program version); skip the line rather than crash the stream */
    }
  }
}

const poolToMint = new Map<string, string>();
export function trackPool(mint: string) {
  poolToMint.set(canonicalPumpPoolPda(new PublicKey(mint)).toBase58(), mint);
}

function decodeAmm(b64: string): { name: string; data: Record<string, unknown> } | null {
  try {
    return ammCoder.events.decode(b64) as { name: string; data: Record<string, unknown> } | null;
  } catch {
    return null;
  }
}

export function onAmmLogs(l: Logs) {
  if (l.err) return;
  for (const b64 of dataLines(l)) {
    const ev = decodeAmm(b64);
    if (!ev) continue;
    const g = (k: string) => ev.data[k] ?? ev.data[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    const pool = (g("pool") as PublicKey | undefined)?.toBase58();
    const mint = pool && poolToMint.get(pool);
    if (!mint) continue;
    if (ev.name === "WithdrawEvent") {
      market.publish({ type: "liquidity_removed", mint, pool: pool!, signature: l.signature });
    } else if (ev.name === "BuyEvent" || ev.name === "SellEvent") {
      const base = Number(g("pool_base_token_reserves"));
      const quote = Number(g("pool_quote_token_reserves")) + Number(g("virtual_quote_reserves") ?? 0);
      if (!base) continue;
      const price = quote / LAMPORTS / (base / 10 ** TOKEN_DECIMALS);
      const prev = lastPrice.get(mint);
      lastPrice.set(mint, price);
      const user = (g("user") as PublicKey).toBase58();
      market.publish({
        type: "trade",
        mint,
        priceSol: price,
        prevPriceSol: prev,
        isBuy: ev.name === "BuyEvent",
        solAmount: Number(g(ev.name === "BuyEvent" ? "quote_amount_in" : "quote_amount_out")) / LAMPORTS,
        trader: user,
        byCreator: creators.get(mint) === user || (g("coin_creator") as PublicKey | undefined)?.toBase58() === user,
        venue: "pump_amm",
        signature: l.signature,
      });
    }
  }
}

/** Watches held mints for supply changes (someone minting more). */
const mintSubs = new Map<string, number>();
export function watchSupply(mint: string) {
  if (mintSubs.has(mint)) return;
  let supply: bigint | null = null;
  const id = connection().onAccountChange(new PublicKey(mint), (acc) => {
    const s = acc.data.readBigUInt64LE(36);
    if (supply !== null && s > supply) {
      market.publish({ type: "supply_increase", mint, before: supply.toString(), after: s.toString() });
    }
    supply = s;
  });
  mintSubs.set(mint, id);
}
export function unwatchSupply(mint: string) {
  const id = mintSubs.get(mint);
  if (id !== undefined) void connection().removeAccountChangeListener(id);
  mintSubs.delete(mint);
}

export function startStream() {
  const conn = connection();
  subs.push(conn.onLogs(PUMP_PROGRAM_ID, onPumpLogs, "processed"));
  subs.push(conn.onLogs(PUMP_AMM_PROGRAM_ID, onAmmLogs, "processed"));
  log.success("stream", `Subscribed to Pump.fun (${PUMP_PROGRAM_ID.toBase58().slice(0, 6)}…) and PumpSwap (${PUMP_AMM_PROGRAM_ID.toBase58().slice(0, 6)}…) logs`);
}

export function stopStream() {
  const conn = connection();
  subs.splice(0).forEach((id) => void conn.removeOnLogsListener(id));
}
