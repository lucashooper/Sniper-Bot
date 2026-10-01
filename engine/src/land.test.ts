import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DetailedError } from "./bus.js";
import { explainError, landTransaction, type LandDeps } from "./land.js";

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
  const calls = { bundles: 0, jitoTx: 0, rpcSends: [] as Uint8Array[] };
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
      sendTransaction: async () => {
        calls.jitoTx++;
        return "sig";
      },
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

const ctx = { label: "BUY TEST", lastValidBlockHeight: 150, mint: "Mint111", numbers: { jitoTipSol: 0.005 } };

test("a bundle Jito loses is re-broadcast as the same signed bytes and confirmed from the chain", async () => {
  const tx = signedTx();
  const { deps, calls } = fakes({ bundle: "Invalid", landsAfterRebroadcasts: 1 });
  const res = await landTransaction(tx, ctx, deps);
  assert.equal(res.slot, 7);
  assert.equal(calls.bundles, 1);
  assert.ok(calls.rpcSends.length >= 1);
  for (const raw of calls.rpcSends) assert.deepEqual(Buffer.from(raw), Buffer.from(tx.serialize()), "only ever the one signed transaction");
  assert.ok(res.steps.some((s) => s.result.includes("Invalid")));
});

test("if Jito refuses the bundle the transaction is sent directly at once", async () => {
  const { deps, calls } = fakes({ bundle: "refuse", landsAfterRebroadcasts: 1 });
  const res = await landTransaction(signedTx(), ctx, deps);
  assert.equal(res.bundleId, null);
  assert.equal(calls.jitoTx, 1);
  assert.equal(res.steps[0].result.startsWith("refused: Jito sendBundle HTTP 429"), true);
});

test("never-landed is reported only after the blockhash expires, with Jito's answer", async () => {
  const { deps } = fakes({ bundle: "Invalid" });
  await assert.rejects(landTransaction(signedTx(), ctx, deps), (e: unknown) => {
    assert.ok(e instanceof DetailedError);
    assert.equal(e.details.stage, "not_landed");
    assert.match(e.message, /no record of it/);
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
