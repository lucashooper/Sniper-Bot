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

test("feed tracks curve progress, dev holdings and liquidity from trades", async () => {
  const { addLaunch, applyTrade, getLaunch, markMigrated } = await import("./feed.js");
  const mint = Keypair.generate().publicKey.toBase58();
  addLaunch({ mint, name: "Feed", symbol: "FEED", uri: "", creator: "dev", priceSol: 30 / 1_073_000_000, marketCapSol: 28, ts: Date.now(), simulated: false, curveTokens: 793_100_000 });
  // Dev buys 50M tokens (5% of supply), then a trader buys and the curve is ~25% sold.
  applyTrade({ mint, priceSol: 3.2e-8, isBuy: true, solAmount: 1.5, tokenAmount: 50_000_000, trader: "dev", byCreator: true, realTokenReserves: 743_100_000, realSolReserves: 1.5 });
  applyTrade({ mint, priceSol: 5e-8, isBuy: true, solAmount: 10, tokenAmount: 150_000_000, trader: "t1", byCreator: false, realTokenReserves: 594_825_000, realSolReserves: 11.5 });
  let l = getLaunch(mint)!;
  assert.ok(Math.abs(l.devHoldPct - 5) < 1e-9);
  assert.ok(Math.abs(l.curvePct - 25) < 1e-6);
  assert.equal(l.liquiditySol, 11.5);
  assert.equal(l.buys, 2);
  assert.equal(l.traders, 2);
  assert.ok(Math.abs(l.marketCapSol - 50) < 1e-9);
  applyTrade({ mint, priceSol: 4e-8, isBuy: false, solAmount: 1, tokenAmount: 20_000_000, trader: "dev", byCreator: true });
  l = getLaunch(mint)!;
  assert.equal(l.devSold, true);
  assert.ok(Math.abs(l.devHoldPct - 3) < 1e-9);
  markMigrated(mint);
  assert.equal(getLaunch(mint)!.curvePct, 100);
});

test("coin page detail: trade tape, incremental fetch and holders from net buys", async () => {
  const { addLaunch, applyTrade, tokenDetail } = await import("./feed.js");
  const mint = Keypair.generate().publicKey.toBase58();
  addLaunch({ mint, name: "Tape", symbol: "TAPE", uri: "", creator: "dev", priceSol: 3e-8, marketCapSol: 30, ts: Date.now(), simulated: false });
  applyTrade({ mint, priceSol: 3.2e-8, isBuy: true, solAmount: 1, tokenAmount: 40_000_000, trader: "dev", byCreator: true });
  applyTrade({ mint, priceSol: 4e-8, isBuy: true, solAmount: 3, tokenAmount: 80_000_000, trader: "a", byCreator: false });
  applyTrade({ mint, priceSol: 3.8e-8, isBuy: false, solAmount: 1, tokenAmount: 80_000_000, trader: "a", byCreator: false, signature: "sig3" });
  const d = tokenDetail(mint)!;
  assert.equal(d.trades.length, 3);
  assert.deepEqual(d.trades.map((t) => t.seq), [1, 2, 3]);
  assert.equal(d.lastSeq, 3);
  assert.equal(tokenDetail(mint, 2)!.trades.length, 1);
  assert.equal(tokenDetail(mint, 2)!.trades[0].signature, "sig3");
  // "a" sold everything, so only the dev is left holding 4%.
  assert.equal(d.holderCount, 1);
  assert.equal(d.holders[0].isCreator, true);
  assert.ok(Math.abs(d.holders[0].pct - 4) < 1e-9);
  assert.equal(tokenDetail("unknown-mint"), null);
});

test("live push: changed coins are batched and a coin's new trades come by sequence", async () => {
  const { addLaunch, applyTrade, takeDirty, tapeSince, tapeBounds } = await import("./feed.js");
  const { bus } = await import("./bus.js");
  takeDirty();
  const mint = Keypair.generate().publicKey.toBase58();
  const pushed = new Promise<void>((r) => bus.once("feed", () => r()));
  addLaunch({ mint, name: "Push", symbol: "PUSH", uri: "", creator: "dev", priceSol: 3e-8, marketCapSol: 30, ts: Date.now(), simulated: false });
  for (let i = 0; i < 5; i++) applyTrade({ mint, priceSol: 3e-8 + i * 1e-9, isBuy: true, solAmount: 0.1, trader: `t${i}`, byCreator: false });
  await pushed;
  // Six changes to one coin arrive as one entry.
  assert.deepEqual(takeDirty(), [mint]);
  assert.deepEqual(takeDirty(), []);
  assert.deepEqual(tapeSince(mint, 3).map((t) => t.seq), [4, 5]);
  assert.deepEqual(tapeSince(mint, 5), []);
  assert.equal(tapeBounds(mint)!.lastSeq, 5);
});

test("a coin open on its page stays tracked after it scrolls out of the feed", async () => {
  const { addLaunch, tokenDetail, getLaunch, _resetFeed } = await import("./feed.js");
  _resetFeed();
  const add = (mint: string) => addLaunch({ mint, name: mint, symbol: mint, uri: "", creator: "c", priceSol: 3e-8, marketCapSol: 30, ts: Date.now(), simulated: true });
  add("viewed");
  add("ignored");
  tokenDetail("viewed");
  for (let i = 0; i < 150; i++) add(`filler-${i}`);
  assert.ok(getLaunch("viewed"), "viewed coin should be kept");
  assert.equal(getLaunch("ignored"), undefined);
  _resetFeed();
});

test("metadata parsing keeps only http(s) links and normalises socials", async () => {
  const { parseMeta, hasSocials } = await import("./feed.js");
  const m = parseMeta({ image: "ipfs://QmImage", twitter: "@coin", telegram: "t.me/coin", website: "javascript:alert(1)" });
  assert.equal(m.image, "https://ipfs.io/ipfs/QmImage");
  assert.equal(m.twitter, "https://x.com/coin");
  assert.equal(m.telegram, "https://t.me/coin");
  assert.equal(m.website, undefined);
  assert.equal(hasSocials(m), true);
  assert.equal(hasSocials(parseMeta({ image: "https://x/y.png" })), false);
});

test("auto-snipe filters: final vs. waiting verdicts", async () => {
  const { evaluateFilters } = await import("./engine.js");
  const { defaultSettings } = await import("./settings.js");
  const f = { ...defaultSettings.filters };
  const base: any = {
    mint: "m", name: "Cosmic Cat", symbol: "CC", ts: Date.now(), marketCapSol: 40, liquiditySol: 5, curvePct: 10,
    devHoldPct: 4, devSold: false, migrated: false, meta: { twitter: "https://x.com/cc" }, metaStatus: "ok",
  };
  assert.deepEqual(evaluateFilters(base, f, []), { pass: true });
  assert.equal((evaluateFilters(base, f, ["dog"]) as any).final, true);
  assert.equal((evaluateFilters({ ...base, devHoldPct: 15 }, f, []) as any).final, false);
  assert.equal((evaluateFilters({ ...base, devSold: true }, f, []) as any).final, true);
  const waitCurve = evaluateFilters(base, { ...f, curveTriggerPct: 30 }, []) as any;
  assert.equal(waitCurve.pass, false);
  assert.equal(waitCurve.final, false);
  assert.equal(evaluateFilters({ ...base, curvePct: 31 }, { ...f, curveTriggerPct: 30 }, []).pass, true);
  assert.equal((evaluateFilters({ ...base, meta: { image: "https://i" } }, { ...f, requireSocials: true }, []) as any).final, true);
  assert.equal((evaluateFilters({ ...base, metaStatus: "pending", meta: null }, { ...f, requireSocials: true }, []) as any).final, false);
  assert.equal((evaluateFilters({ ...base, ts: Date.now() - 400_000 }, f, []) as any).final, true);
  assert.equal(evaluateFilters({ ...base, marketCapSol: 500 }, { ...f, maxMarketCapSol: 300 }, []).pass, false);
  assert.equal(evaluateFilters(base, { ...f, minLiquiditySol: 10 }, []).pass, false);
});

test("stream publishes curve trades for coins in the feed with reserves and token amounts", async () => {
  const { market } = await import("./events.js");
  const { onPumpLogs } = await import("./stream.js");
  const { addLaunch } = await import("./feed.js");
  const coder = new BorshCoder(pumpIdl as never);
  const idl = pumpIdl as any;
  const mint = Keypair.generate().publicKey;
  addLaunch({ mint: mint.toBase58(), name: "T", symbol: "T", uri: "", creator: "c", priceSol: 1, marketCapSol: 1, ts: Date.now(), simulated: false });
  const zero = Object.fromEntries(
    idl.types.find((t: any) => t.name === "TradeEvent").type.fields.map((f: any) => [
      f.name,
      f.type === "pubkey" ? PublicKey.default : f.type === "bool" ? false : f.type === "string" ? "" : typeof f.type === "object" && "vec" in f.type ? [] : new BN(0),
    ]),
  );
  const user = Keypair.generate().publicKey;
  const body = coder.types.encode("TradeEvent", {
    ...zero,
    mint,
    user,
    creator: user,
    is_buy: true,
    sol_amount: new BN(2_000_000_000),
    token_amount: new BN("60000000000000"),
    virtual_sol_reserves: new BN("32000000000"),
    virtual_token_reserves: new BN("1013000000000000"),
    real_sol_reserves: new BN("2000000000"),
    real_token_reserves: new BN("733100000000000"),
  });
  const disc = Buffer.from(idl.events.find((e: any) => e.name === "TradeEvent").discriminator);
  const events: any[] = [];
  market.subscribe((e) => events.push(e));
  onPumpLogs({ err: null, signature: "s", logs: [`Program data: ${Buffer.concat([disc, body]).toString("base64")}`] });
  const t = events.find((e) => e.type === "trade" && e.mint === mint.toBase58());
  assert.ok(t, "trade for a feed coin should be published");
  assert.equal(t.byCreator, true);
  assert.equal(t.tokenAmount, 60_000_000);
  assert.equal(t.realSolReserves, 2);
  assert.equal(t.realTokenReserves, 733_100_000);
});

test("wallet groups: create, generate into, drop removed wallets, delete keeps wallets", async () => {
  const { createGroup, generateIntoGroup, listGroups, removeGroup, updateGroup } = await import("./groups.js");
  const { generateWallet, listWallets, removeWallet } = await import("./wallets.js");
  const a = generateWallet("Group A1");
  const g = createGroup("Snipers", [a.id, a.id]);
  assert.deepEqual(g.walletIds, [a.id], "duplicates collapse");
  assert.throws(() => createGroup("  "), /name/);
  assert.throws(() => createGroup("Bad", ["nope"]), /Unknown wallet/);
  const g2 = generateIntoGroup(g.id, 3);
  assert.equal(g2.walletIds.length, 4);
  const names = listWallets().filter((w) => g2.walletIds.includes(w.id)).map((w) => w.name);
  assert.deepEqual(names.slice(1), ["Snipers 2", "Snipers 3", "Snipers 4"]);
  assert.throws(() => generateIntoGroup(g.id, 0), /between 1 and 20/);
  removeWallet(a.id);
  assert.equal(listGroups().find((x) => x.id === g.id)!.walletIds.includes(a.id), false);
  assert.equal(updateGroup(g.id, { name: "Renamed" }).name, "Renamed");
  const before = listWallets().length;
  removeGroup(g.id);
  assert.equal(listGroups().some((x) => x.id === g.id), false);
  assert.equal(listWallets().length, before);
});

test("sell all exits one coin from every wallet (or one group) in simulation", async () => {
  const { recordBuy, openPositions } = await import("./portfolio.js");
  const { createGroup } = await import("./groups.js");
  const { generateWallet } = await import("./wallets.js");
  const { sellAll } = await import("./trader.js");
  const w1 = generateWallet("S1");
  const w2 = generateWallet("S2");
  const w3 = generateWallet("S3");
  const buy = (w: { id: string; name: string }, mint: string) =>
    recordBuy(
      { mode: "sim", reason: "manual", walletId: w.id, walletName: w.name, mint, symbol: mint.slice(0, 3), venue: "pump_curve", solAmount: 0.1, tokenAmount: 1000, priceSol: 0.0001, priorityFeeSol: 0, jitoTipSol: 0, networkFeeSol: 0 },
      { name: mint, creator: "C", decimals: 6 },
    );
  [w1, w2, w3].forEach((w) => buy(w, "MintSellAll"));
  buy(w1, "MintOther");
  const g = createGroup("Pair", [w1.id, w2.id]);

  const grouped = await sellAll({ mint: "MintSellAll", groupId: g.id });
  assert.equal(grouped.sold, 2);
  assert.deepEqual(openPositions().filter((p) => p.mint === "MintSellAll").map((p) => p.walletId), [w3.id]);

  const rest = await sellAll({ mint: "MintSellAll" });
  assert.equal(rest.sold, 1);
  assert.equal(openPositions().some((p) => p.mint === "MintSellAll"), false);
  assert.equal(openPositions().some((p) => p.mint === "MintOther"), true, "other coins are untouched");
  await assert.rejects(sellAll({ mint: "MintSellAll" }), /No open positions/);
});
