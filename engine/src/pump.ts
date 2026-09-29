import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { connection, LAMPORTS } from "./solana.js";
import type { Venue } from "./events.js";

/**
 * Pump.fun venue adapter built on the official SDKs (@pump-fun/pump-sdk for the bonding curve,
 * @pump-fun/pump-swap-sdk for PumpSwap, where graduated coins migrate since March 2025).
 * The program's account list has changed several times (creator vaults, volume accumulators, fee config,
 * v2 instructions); the SDKs track that so this file does not hand-roll instruction layouts.
 */

let pumpSdk: OnlinePumpSdk | null = null;
let ammSdk: OnlinePumpAmmSdk | null = null;
let globalCache: { global: Global; feeConfig: FeeConfig | null; at: number } | null = null;

const sdk = () => (pumpSdk ??= new OnlinePumpSdk(connection()));
const amm = () => (ammSdk ??= new OnlinePumpAmmSdk(connection()));

async function globals() {
  if (!globalCache || Date.now() - globalCache.at > 60_000) {
    const [global, feeConfig] = await Promise.all([sdk().fetchGlobal(), sdk().fetchFeeConfig().catch(() => null)]);
    globalCache = { global, feeConfig, at: Date.now() };
  }
  return globalCache;
}

const mintProgramCache = new Map<string, { program: PublicKey; decimals: number }>();
export async function mintInfo(mint: PublicKey) {
  const k = mint.toBase58();
  const hit = mintProgramCache.get(k);
  if (hit) return hit;
  const info = await connection().getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${k} not found`);
  // Mint layout: decimals at byte 44 for both SPL Token and Token-2022.
  const v = { program: info.owner, decimals: info.data[44] };
  mintProgramCache.set(k, v);
  return v;
}

export interface VenueState {
  venue: Venue;
  priceSol: number;
  decimals: number;
  creator: string;
  complete: boolean;
}

function curvePrice(c: BondingCurve, decimals: number) {
  if (c.virtualTokenReserves.isZero()) return 0;
  return c.virtualQuoteReserves.toNumber() / LAMPORTS / (c.virtualTokenReserves.toNumber() / 10 ** decimals);
}

/** Where the coin trades right now and at what price (SOL per whole token). */
export async function venueState(mint: PublicKey): Promise<VenueState> {
  const { program, decimals } = await mintInfo(mint);
  const { bondingCurve } = await sdk().fetchBuyState(mint, PublicKey.default, program).catch(() => ({
    bondingCurve: null as BondingCurve | null,
  }));
  if (bondingCurve && !bondingCurve.complete) {
    return {
      venue: "pump_curve",
      priceSol: curvePrice(bondingCurve, decimals),
      decimals,
      creator: bondingCurve.creator.toBase58(),
      complete: false,
    };
  }
  const state = await amm().swapSolanaState(canonicalPumpPoolPda(mint), PublicKey.default);
  // PumpSwap pools can carry virtual quote reserves; the swap math prices off real + virtual.
  const quote = state.poolQuoteAmount.add(state.pool.virtualQuoteReserves ?? new BN(0));
  const priceSol = quote.toNumber() / LAMPORTS / (state.poolBaseAmount.toNumber() / 10 ** state.baseMintAccount.decimals);
  return {
    venue: "pump_amm",
    priceSol,
    decimals: state.baseMintAccount.decimals,
    creator: state.pool.coinCreator.toBase58(),
    complete: true,
  };
}

export interface BuiltSwap {
  venue: Venue;
  instructions: TransactionInstruction[];
  /** Expected tokens (raw units) for a buy, or expected SOL lamports for a sell, before slippage. */
  expectedOut: bigint;
  decimals: number;
  /** Accounts worth passing to the priority-fee estimator. */
  hotAccounts: PublicKey[];
}

export async function buildBuy(mint: PublicKey, user: PublicKey, lamportsIn: bigint, slippagePct: number): Promise<BuiltSwap> {
  const { program, decimals } = await mintInfo(mint);
  const solAmount = new BN(lamportsIn.toString());
  const st = await sdk().fetchBuyState(mint, user, program).catch(() => null);
  if (st && !st.bondingCurve.complete) {
    if (!st.quoteMint.equals(NATIVE_MINT)) throw new Error("Only SOL-quoted Pump.fun curves are supported");
    const { global, feeConfig } = await globals();
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: st.bondingCurve.tokenTotalSupply,
      bondingCurve: st.bondingCurve,
      amount: solAmount,
      quoteMint: st.quoteMint,
    });
    const instructions = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: st.bondingCurveAccountInfo,
      bondingCurve: st.bondingCurve,
      associatedUserAccountInfo: st.associatedUserAccountInfo,
      mint,
      user,
      amount,
      solAmount,
      slippage: slippagePct,
      tokenProgram: program,
    });
    return { venue: "pump_curve", instructions, expectedOut: BigInt(amount.toString()), decimals, hotAccounts: [mint] };
  }
  const pool = canonicalPumpPoolPda(mint);
  const state = await amm().swapSolanaState(pool, user);
  if (!state.pool.quoteMint.equals(NATIVE_MINT)) throw new Error("Only SOL-quoted PumpSwap pools are supported");
  const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, solAmount, slippagePct);
  const q = BigInt(state.poolQuoteAmount.add(state.pool.virtualQuoteReserves ?? new BN(0)).toString());
  const out = (BigInt(state.poolBaseAmount.toString()) * lamportsIn) / (q + lamportsIn);
  return { venue: "pump_amm", instructions, expectedOut: out, decimals: state.baseMintAccount.decimals, hotAccounts: [pool] };
}

export async function buildSell(mint: PublicKey, user: PublicKey, rawTokens: bigint, slippagePct: number): Promise<BuiltSwap> {
  const { program, decimals } = await mintInfo(mint);
  const amount = new BN(rawTokens.toString());
  const st = await sdk().fetchSellState(mint, user, program).catch(() => null);
  if (st && !st.bondingCurve.complete) {
    const { global, feeConfig } = await globals();
    const solAmount = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: st.bondingCurve.tokenTotalSupply,
      bondingCurve: st.bondingCurve,
      amount,
    });
    const instructions = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo: st.bondingCurveAccountInfo,
      bondingCurve: st.bondingCurve,
      mint,
      user,
      amount,
      solAmount,
      slippage: slippagePct,
      tokenProgram: program,
      mayhemMode: st.bondingCurve.isMayhemMode,
      cashback: st.bondingCurve.isCashbackCoin,
    });
    return { venue: "pump_curve", instructions, expectedOut: BigInt(solAmount.toString()), decimals, hotAccounts: [mint] };
  }
  const pool = canonicalPumpPoolPda(mint);
  const state = await amm().swapSolanaState(pool, user);
  const instructions = await PUMP_AMM_SDK.sellBaseInput(state, amount, slippagePct);
  const q = BigInt(state.poolQuoteAmount.add(state.pool.virtualQuoteReserves ?? new BN(0)).toString());
  const out = (q * rawTokens) / (BigInt(state.poolBaseAmount.toString()) + rawTokens);
  return { venue: "pump_amm", instructions, expectedOut: out, decimals: state.baseMintAccount.decimals, hotAccounts: [pool] };
}
