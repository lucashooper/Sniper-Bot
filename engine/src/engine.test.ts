import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BorshCoder } from "@coral-xyz/anchor";
import { pumpIdl } from "@pump-fun/pump-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";

// Isolated data dir and passphrase must be set before any engine module reads config.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sniper-test-"));
process.env.ENGINE_DATA_DIR = dir;
process.env.KEYSTORE_PASSPHRASE = "correct horse battery staple";

test("keystore encrypts wallets at rest and round-trips keys", async () => {
  const { initKeystore } = await import("./keystore.js");
  const { importWallet, keypairOf, generateWallet } = await import("./wallets.js");
  assert.equal(initKeystore(), "unlocked");
  const kp = Keypair.generate();
  const w = importWallet(bs58.encode(kp.secretKey), "Imported");
  assert.equal(w.publicKey, kp.publicKey.toBase58());
  assert.equal(w.isMaster, true);
  assert.deepEqual(keypairOf(w.id).secretKey, kp.secretKey);
  generateWallet("Second");
  const raw = fs.readFileSync(path.join(dir, "wallets.json"), "utf8");
  assert.ok(!raw.includes(bs58.encode(kp.secretKey)), "secret key must not appear in plaintext");
  assert.equal((fs.statSync(path.join(dir, "wallets.json")).mode & 0o777).toString(8), "600");
});

test("seed phrases derive Phantom-path accounts and reject bad phrases", async () => {
  const { parseSecret } = await import("./wallets.js");
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const a0 = parseSecret(phrase, 0).publicKey.toBase58();
  const a1 = parseSecret(phrase, 1).publicKey.toBase58();
  assert.notEqual(a0, a1);
  assert.equal(parseSecret(phrase, 0).publicKey.toBase58(), a0);
  assert.throws(() => parseSecret(phrase.replace("about", "abandon")), /Invalid seed phrase/);
});

test("ledger PnL: partial then full exit, fees counted in cost basis", async () => {
  const { recordBuy, recordSell, metrics, openPositions, tradesCsv } = await import("./portfolio.js");
  const base = { mode: "sim" as const, reason: "manual" as const, walletId: "paper", walletName: "Paper", mint: "MintA", symbol: "AAA", venue: "pump_curve" as const };
  recordBuy({ ...base, solAmount: 1, tokenAmount: 1000, priceSol: 0.001, priorityFeeSol: 0.01, jitoTipSol: 0.01, networkFeeSol: 0 }, { name: "A", creator: "C", decimals: 6 });
  // cost basis 1.02 SOL for 1000 tokens
  const s1 = recordSell({ ...base, solAmount: 1, tokenAmount: 500, priceSol: 0.002, priorityFeeSol: 0, jitoTipSol: 0, networkFeeSol: 0 });
  assert.ok(Math.abs(s1.realizedPnlSol - (1 - 0.51)) < 1e-9);
  const s2 = recordSell({ ...base, solAmount: 0.25, tokenAmount: 500, priceSol: 0.0005, priorityFeeSol: 0, jitoTipSol: 0.01, networkFeeSol: 0 });
  assert.ok(Math.abs(s2.realizedPnlSol - (0.25 - 0.51 - 0.01)) < 1e-9);
  assert.equal(openPositions().length, 0);
  const m = metrics("sim");
  assert.ok(Math.abs(m.realizedPnlSol - (0.49 - 0.27)) < 1e-9);
  assert.equal(m.winRatePct, 100);
  assert.equal(tradesCsv().split("\n").length, 4);
});

test("stream decodes a Pump.fun CreateEvent from program logs", async () => {
  const { market } = await import("./events.js");
  const { onPumpLogs } = await import("./stream.js");

  // Anchor 0.32 encodes with the IDL's snake_case field names.
  const coder = new BorshCoder(pumpIdl as never);
  const mint = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const body = coder.types.encode("CreateEvent", {
    name: "Test Coin",
    symbol: "TEST",
    uri: "https://example.com/meta.json",
    mint,
    bonding_curve: Keypair.generate().publicKey,
    user: creator,
    creator,
    timestamp: new BN(1_700_000_000),
    virtual_token_reserves: new BN("1073000000000000"),
    virtual_sol_reserves: new BN("30000000000"),
    real_token_reserves: new BN("793100000000000"),
    token_total_supply: new BN("1000000000000000"),
    token_program: PublicKey.default,
    is_mayhem_mode: false,
    is_cashback_enabled: false,
    quote_mint: PublicKey.default,
    virtual_quote_reserves: new BN("30000000000"),
    creator_fee_bps: new BN(0),
    is_holder_reward: false,
  });
  const disc = Buffer.from((pumpIdl as any).events.find((e: any) => e.name === "CreateEvent").discriminator);
  const events: any[] = [];
  market.subscribe((e) => events.push(e));
  onPumpLogs({
    err: null,
    signature: "sig",
    logs: ["Program log: Instruction: Create", `Program data: ${Buffer.concat([disc, body]).toString("base64")}`],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "launch");
  assert.equal(events[0].mint, mint.toBase58());
  assert.equal(events[0].symbol, "TEST");
  assert.equal(events[0].creator, creator.toBase58());
  // 30 SOL / 1.073B tokens
  assert.ok(Math.abs(events[0].priceSol - 30 / 1_073_000_000) < 1e-15);
});

test("stream flags PumpSwap liquidity withdrawals and prices AMM trades for held mints", async () => {
  const { pumpAmmJson, canonicalPumpPoolPda } = await import("@pump-fun/pump-swap-sdk");
  const { market } = await import("./events.js");
  const { onAmmLogs, trackPool } = await import("./stream.js");
  const coder = new BorshCoder(pumpAmmJson as never);
  const idl = pumpAmmJson as any;
  const disc = (n: string) => Buffer.from(idl.events.find((e: any) => e.name === n).discriminator);
  const zeroFields = (n: string) =>
    Object.fromEntries(
      idl.types.find((t: any) => t.name === n).type.fields.map((f: any) => [f.name, f.type === "pubkey" ? PublicKey.default : f.type === "bool" ? false : new BN(0)]),
    );
  const mint = Keypair.generate().publicKey;
  const pool = canonicalPumpPoolPda(mint);
  trackPool(mint.toBase58());
  const events: any[] = [];
  market.subscribe((e) => events.push(e));

  const sell = { ...zeroFields("SellEvent"), pool, user: Keypair.generate().publicKey, pool_base_token_reserves: new BN("200000000000000"), pool_quote_token_reserves: new BN("80000000000"), quote_amount_out: new BN(1_000_000_000) };
  const w = { ...zeroFields("WithdrawEvent"), pool };
  const line = (n: string, d: object) => `Program data: ${Buffer.concat([disc(n), coder.types.encode(n, d)]).toString("base64")}`;
  onAmmLogs({ err: null, signature: "s", logs: [line("SellEvent", sell), line("WithdrawEvent", w)] });

  const trade = events.find((e) => e.type === "trade");
  assert.ok(trade, "sell event should produce a trade");
  assert.equal(trade.isBuy, false);
  assert.ok(Math.abs(trade.priceSol - 80 / 200_000_000) < 1e-15);
  assert.ok(events.some((e) => e.type === "liquidity_removed" && e.mint === mint.toBase58()));
});
