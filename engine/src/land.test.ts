import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DetailedError } from "./bus.js";
import { explainError, landBundle, landTransaction, type LandDeps } from "./land.js";

function signedTx() {
  const kp = Keypair.generate();
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);
  return tx;
}

/** A fake chain + Jito on a fake clock: each sleep advances time, each block-height read advances a block. */
function fakes(opts: {
  bundle?: "Invalid" | "Pending" | "Landed" | "refuse";
  landsAfterRebroadcasts?: number;
  chainErr?: unknown;
  rpcDown?: boolean;
}) {
  let t = 0;
  let height = 100;
  const calls = { bundles: 0, sender: [] as Uint8Array[], rpcSends: [] as Uint8Array[] };
  let landed = false;
  const status = () => (landed ? { slot: 7, confirmations: 1, err: opts.chainErr ?? null, confirmationStatus: "confirmed" as const } : null);
  const deps: LandDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    jito: {
      sendBundle: async () => {
        calls.bundles++;
        if (opts.bundle === "refuse") throw new Error("Jito sendBundle HTTP 429: rate limited");
        return "bundle-1";
      },
      bundleStatus: async () => ({ status: opts.bundle === "refuse" ? "Invalid" : (opts.bundle ?? "Invalid") }),
    },
    sender: async (tx) => {
      calls.sender.push(tx.serialize());
      return "sig";
    },
    conn: {
      getSignatureStatuses: (async () => {
        if (opts.rpcDown) throw new Error("fetch failed");
        return { context: { slot: 1 }, value: [status()] };
      }) as unknown as LandDeps["conn"]["getSignatureStatuses"],
      sendRawTransaction: (async (raw: Uint8Array) => {
        calls.rpcSends.push(raw);
        if (opts.landsAfterRebroadcasts !== undefined && calls.rpcSends.length >= opts.landsAfterRebroadcasts) landed = true;
        return "sig";
      }) as unknown as LandDeps["conn"]["sendRawTransaction"],
      getBlockHeight: (async () => {
        if (opts.rpcDown) throw new Error("fetch failed");
        return (height += 3);
      }) as unknown as LandDeps["conn"]["getBlockHeight"],
      getTransaction: (async () => ({
        meta: { logMessages: ["Program log: Instruction: Buy", "Program log: AnchorError occurred. Error Code: TooMuchSolRequired. Error Number: 6002. Error Message: slippage: Too much SOL required to buy the given amount of tokens."] },
      })) as unknown as LandDeps["conn"]["getTransaction"],
    },
  };
  return { deps, calls };
}

const ctx = { label: "BUY TEST", mode: "fast" as const, lastValidBlockHeight: 150, mint: "Mint111", numbers: { jitoTipSol: 0.005 } };

test("fast mode sends the same signed bytes to Helius Sender and the RPC at once, never as a bundle", async () => {
  const tx = signedTx();
  const { deps, calls } = fakes({ landsAfterRebroadcasts: 2 });
  const res = await landTransaction(tx, ctx, deps);
  assert.equal(res.slot, 7);
  assert.equal(calls.bundles, 0);
  assert.ok(calls.sender.length >= 1 && calls.rpcSends.length >= 2);
  for (const raw of [...calls.sender, ...calls.rpcSends]) assert.deepEqual(Buffer.from(raw), Buffer.from(tx.serialize()), "only ever the one signed transaction");
  assert.equal(res.steps[0].step, "Helius Sender");
});

test("protected mode only ever sends the bundle, and re-submits it while Jito has no record", async () => {
  const { deps, calls } = fakes({ bundle: "Invalid" });
  await assert.rejects(landTransaction(signedTx(), { ...ctx, mode: "protected" }, deps), (e: unknown) => {
    assert.ok(e instanceof DetailedError);
    assert.equal(e.details.stage, "not_landed");
    assert.match(e.message, /no record of it/);
    return true;
  });
  assert.ok(calls.bundles > 1);
  assert.equal(calls.sender.length + calls.rpcSends.length, 0, "protected mode never goes public");
});

test("a refused bundle is reported with Jito's own answer", async () => {
  const { deps } = fakes({ bundle: "refuse" });
  await assert.rejects(landTransaction(signedTx(), { ...ctx, mode: "protected" }, deps), (e: unknown) => {
    assert.ok(e instanceof DetailedError);
    assert.match(e.message, /Jito sendBundle refused: Jito sendBundle HTTP 429/);
    return true;
  });
});

test("never-landed is reported only after the blockhash expires", async () => {
  const { deps } = fakes({});
  await assert.rejects(landTransaction(signedTx(), ctx, deps), (e: unknown) => {
    assert.ok(e instanceof DetailedError);
    assert.equal(e.details.stage, "not_landed");
    assert.match(e.message, /no leader included it/);
    assert.match(e.message, /nothing was spent/);
    assert.ok(Array.isArray(e.details.steps));
    return true;
  });
});

test("a transaction that ran and failed on chain says why in the program's words", async () => {
  const { deps } = fakes({ bundle: "Landed", landsAfterRebroadcasts: 1, chainErr: { InstructionError: [2, { Custom: 6002 }] } });
  await assert.rejects(landTransaction(signedTx(), ctx, deps), (e: unknown) => {
    assert.ok(e instanceof DetailedError);
    assert.equal(e.details.stage, "chain");
    assert.match(e.message, /Too much SOL required.*slippage/);
    return true;
  });
});

test("when the RPC stops answering the fate is reported as unknown, never as failed", async () => {
  const { deps } = fakes({ bundle: "Pending", rpcDown: true });
  await assert.rejects(landTransaction(signedTx(), ctx, deps), (e: unknown) => {
    assert.ok(e instanceof DetailedError);
    assert.equal(e.details.stage, "unknown");
    assert.match(e.message, /MAY have gone through/);
    return true;
  });
});

test("explainError turns a lamports shortfall into numbers", () => {
  const msg = explainError({ InstructionError: [3, { Custom: 1 }] }, ["Transfer: insufficient lamports 21000000, need 23000000"]);
  assert.match(msg, /had 0\.021000 SOL where 0\.023000 SOL was needed/);
});

function bundleFakes(opts: { landAfterSends?: number; err?: unknown }) {
  let t = 0;
  let height = 100;
  const sent: string[][] = [];
  const deps: LandDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    jito: {
      sendBundle: async (txs) => {
        sent.push(txs.map((x) => Buffer.from(x.serialize()).toString("base64")));
        return "bundle-9";
      },
      bundleStatus: async () => ({ status: "Pending" as const }),
    },
    sender: async () => {
      throw new Error("protected bundles must never use Helius Sender");
    },
    conn: {
      getSignatureStatuses: (async (sigs: string[]) => {
        const landed = opts.landAfterSends !== undefined && sent.length >= opts.landAfterSends;
        return { context: { slot: 1 }, value: sigs.map(() => (landed ? { slot: 42, confirmations: 1, err: opts.err ?? null, confirmationStatus: "confirmed" } : null)) };
      }) as unknown as LandDeps["conn"]["getSignatureStatuses"],
      sendRawTransaction: (async () => {
        throw new Error("protected bundles must never go to the public RPC");
      }) as unknown as LandDeps["conn"]["sendRawTransaction"],
      getBlockHeight: (async () => (height += 3)) as unknown as LandDeps["conn"]["getBlockHeight"],
      getTransaction: (async () => ({ meta: { logMessages: [] } })) as unknown as LandDeps["conn"]["getTransaction"],
    },
  };
  return { deps, sent };
}

const bctx = { label: "PRESET BUY", lastValidBlockHeight: 150, mint: "Mint111", numbers: {} };

test("a preset bundle re-sends the very same transactions to Jito only and settles once every one is confirmed", async () => {
  const txs = [signedTx(), signedTx(), signedTx()];
  const { deps, sent } = bundleFakes({ landAfterSends: 3 });
  const res = await landBundle(txs, bctx, deps);
  assert.equal(res.slot, 42);
  assert.equal(res.signatures.length, 3);
  assert.ok(sent.length >= 3);
  for (const s of sent) assert.deepEqual(s, txs.map((x) => Buffer.from(x.serialize()).toString("base64")));
});

test("a preset bundle that never lands fails only after the blockhash expires, saying nothing was spent", async () => {
  const { deps } = bundleFakes({});
  await assert.rejects(landBundle([signedTx(), signedTx()], bctx, deps), (e: unknown) => {
    assert.ok(e instanceof DetailedError);
    assert.equal(e.details.stage, "not_landed");
    assert.match(e.message, /nothing was spent/);
    return true;
  });
});

test("a bundle holds at most 5 transactions", async () => {
  const { deps } = bundleFakes({});
  await assert.rejects(landBundle(Array.from({ length: 6 }, signedTx), bctx, deps), /1 to 5/);
});
