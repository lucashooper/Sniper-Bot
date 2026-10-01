import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createCloseAccountInstruction } from "@solana/spl-token";
import { hasRpc } from "./config.js";
import { bus, log } from "./bus.js";
import { getSettings } from "./settings.js";
import { connection, lamports, LAMPORTS, short } from "./solana.js";
import { getMaster, keypairOf, listWallets } from "./wallets.js";

export interface TokenBalance {
  mint: string;
  amount: number;
  program: "spl" | "token2022";
}
export interface WalletBalance {
  sol: number;
  tokens: TokenBalance[];
  updatedAt: number;
}

const balances = new Map<string, WalletBalance>();
export const getBalances = () => Object.fromEntries(balances);

export async function refreshBalances() {
  if (!hasRpc()) return;
  const conn = connection();
  const ws = listWallets();
  await Promise.all(
    ws.map(async (w) => {
      try {
        const owner = new PublicKey(w.publicKey);
        const [lam, spl, t22] = await Promise.all([
          conn.getBalance(owner),
          conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
          conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);
        const toks = (list: typeof spl, program: TokenBalance["program"]) =>
          list.value.map((a) => ({
            mint: a.account.data.parsed.info.mint as string,
            amount: a.account.data.parsed.info.tokenAmount.uiAmount as number,
            program,
          }));
        balances.set(w.id, { sol: lam / LAMPORTS, tokens: [...toks(spl, "spl"), ...toks(t22, "token2022")], updatedAt: Date.now() });
      } catch (e) {
        log.warn("wallet", `Balance refresh failed for ${w.name}: ${(e as Error).message}`);
      }
    }),
  );
  bus.changed("wallets");
}

async function send(kp: Keypair, instructions: TransactionInstruction[], label: string) {
  const conn = connection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  );
  tx.sign([kp]);
  if (getSettings().simulation) {
    const r = await conn.simulateTransaction(tx, { sigVerify: false });
    if (r.value.err) throw new Error(`${label} would fail: ${JSON.stringify(r.value.err)}`);
    log.info("wallet", `[SIM] ${label}: dry run OK, nothing sent (turn simulation off to execute)`);
    return null;
  }
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log.success("wallet", `${label}: confirmed`, { signature: sig });
  return sig;
}

/** Master -> one wallet, an exact amount. */
export async function fundWallet(walletId: string, solAmount: number) {
  const master = getMaster();
  if (!master) throw new Error("Designate a master wallet first");
  if (master.id === walletId) throw new Error("Cannot fund the master from itself");
  const target = listWallets().find((w) => w.id === walletId);
  if (!target) throw new Error("Unknown wallet");
  if (!(solAmount > 0)) throw new Error("Amount must be positive");
  const kp = keypairOf(master.id);
  const sig = await send(
    kp,
    [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(target.publicKey), lamports: lamports(solAmount) })],
    `Fund ${target.name} with ${solAmount} SOL`,
  );
  void refreshBalances();
  return sig;
}

/**
 * For every non-master wallet: close empty token accounts (recovering ~0.002 SOL rent each) and send all SOL back
 * to the master. Token accounts that still hold tokens are left alone and reported, never sold silently.
 */
export async function reclaimAll() {
  const master = getMaster();
  if (!master) throw new Error("Designate a master wallet first");
  const conn = connection();
  const results: Array<{ wallet: string; reclaimedSol: number; closed: number; skippedTokens: number; signature: string | null }> = [];
  for (const w of listWallets()) {
    if (w.isMaster) continue;
    try {
      const kp = keypairOf(w.id);
      const owner = kp.publicKey;
      const accounts = [
        ...(await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })).value.map((a) => ({ ...a, program: TOKEN_PROGRAM_ID })),
        ...(await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })).value.map((a) => ({ ...a, program: TOKEN_2022_PROGRAM_ID })),
      ];
      const empty = accounts.filter((a) => a.account.data.parsed.info.tokenAmount.amount === "0").slice(0, 20);
      const skipped = accounts.length - empty.length;
      const rent = empty.reduce((a, x) => a + x.account.lamports, 0);
      const balance = await conn.getBalance(owner);
      // Drain to exactly zero: a system account left with a few lamports would fall below rent exemption and fail.
      const fee = 5_000; // one signature, no priority fee
      const amount = balance + rent - fee;
      if (amount <= 0) continue;
      const ixs: TransactionInstruction[] = [
        ...empty.map((a) => createCloseAccountInstruction(a.pubkey, owner, owner, [], a.program)),
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(master.publicKey), lamports: amount }),
      ];
      const sig = await send(kp, ixs, `Reclaim ${(amount / LAMPORTS).toFixed(4)} SOL from ${w.name} (${empty.length} accounts closed)`);
      results.push({ wallet: w.name, reclaimedSol: amount / LAMPORTS, closed: empty.length, skippedTokens: skipped, signature: sig });
      if (skipped) log.warn("wallet", `${w.name} still holds ${skipped} token balance(s); sell them first to reclaim that rent`);
    } catch (e) {
      log.error("wallet", `Reclaim from ${w.name} (${short(w.publicKey)}) failed: ${(e as Error).message}`);
    }
  }
  void refreshBalances();
  return results;
}

/** Any wallet -> an outside address (Phantom, Axiom, an exchange). "max" sends everything but the fee. */
export async function withdraw(walletId: string, to: string, solAmount: number | "max") {
  const w = listWallets().find((x) => x.id === walletId);
  if (!w) throw new Error("Unknown wallet");
  let dest: PublicKey;
  try {
    dest = new PublicKey(to.trim());
  } catch {
    throw new Error("That is not a valid Solana address");
  }
  if (dest.toBase58() === w.publicKey) throw new Error("Destination is the same wallet");
  const kp = keypairOf(w.id);
  let lam: number;
  if (solAmount === "max") {
    // Drain to zero (a system account cannot sit below rent exemption): balance minus one signature's fee.
    lam = (await connection().getBalance(kp.publicKey)) - 5_000;
    if (lam <= 0) throw new Error(`${w.name} has nothing to withdraw`);
  } else {
    if (!(solAmount > 0)) throw new Error("Amount must be positive");
    lam = lamports(solAmount);
  }
  const sig = await send(
    kp,
    [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: lam })],
    `Withdraw ${(lam / LAMPORTS).toFixed(4)} SOL from ${w.name} to ${short(dest.toBase58())}`,
  );
  void refreshBalances();
  return { signature: sig, sol: lam / LAMPORTS };
}
