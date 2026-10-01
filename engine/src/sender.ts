import { PublicKey, SystemProgram, type VersionedTransaction } from "@solana/web3.js";

/**
 * Helius Sender: one sendTransaction that Helius routes to Jito and to staked validator connections at once, so the
 * transaction can land with whichever leader is up. No API credits; free on every Helius plan; 50 tx/s by default.
 * Requirements (helius.dev/docs/sending-transactions/sender): skipPreflight true, maxRetries 0, a compute-unit price,
 * and a SOL tip to one of the accounts below, at least 0.001 SOL to use every route.
 */
export const SENDER_URL = (process.env.HELIUS_SENDER_URL ?? "https://sender.helius-rpc.com/fast").replace(/\/$/, "");
export const SENDER_MIN_TIP_SOL = 0.001;

const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

export function senderTipInstruction(payer: PublicKey, lamports: number) {
  const to = new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]);
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports });
}

export async function sendViaSender(tx: VersionedTransaction): Promise<string> {
  const res = await fetch(SENDER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  let json: { result?: string; error?: { message?: string } } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* plain-text body; reported below */
  }
  if (!res.ok || json.error) throw new Error(`Helius Sender HTTP ${res.status}: ${json.error?.message ?? (text.slice(0, 200) || "empty body")}`);
  return json.result ?? "";
}
