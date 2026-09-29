import crypto from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { derivePath } from "ed25519-hd-key";
import { bus, log } from "./bus.js";
import { isUnlocked, seal, unseal, type Sealed } from "./keystore.js";
import { loadJson, saveJson } from "./store.js";

export interface WalletRecord {
  id: string;
  name: string;
  publicKey: string;
  isMaster: boolean;
  active: boolean;
  createdAt: number;
  secret: Sealed;
}

export type PublicWallet = Omit<WalletRecord, "secret">;

let wallets: WalletRecord[] = loadJson<WalletRecord[]>("wallets.json", []);
const persist = () => {
  saveJson("wallets.json", wallets);
  bus.changed("wallets");
};

export const listWallets = (): PublicWallet[] => wallets.map(({ secret: _s, ...w }) => w);
export const getWallet = (id: string) => wallets.find((w) => w.id === id);
export const getMaster = () => wallets.find((w) => w.isMaster);

export function keypairOf(id: string): Keypair {
  const w = getWallet(id);
  if (!w) throw new Error(`Unknown wallet ${id}`);
  return Keypair.fromSecretKey(unseal(w.secret));
}

/** Accepts a base58 secret key, a JSON byte array (solana-keygen format), or a 12/24-word seed phrase. */
export function parseSecret(input: string, accountIndex = 0): Keypair {
  const s = input.trim();
  if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  const words = s.split(/\s+/);
  if (words.length >= 12) {
    const phrase = words.join(" ").toLowerCase();
    if (!validateMnemonic(phrase, wordlist)) throw new Error("Invalid seed phrase");
    const seed = Buffer.from(mnemonicToSeedSync(phrase)).toString("hex");
    // Phantom / Solflare / Backpack default derivation path.
    const { key } = derivePath(`m/44'/501'/${accountIndex}'/0'`, seed);
    return Keypair.fromSeed(key);
  }
  const bytes = bs58.decode(s);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error("Unrecognised private key format");
}

function add(kp: Keypair, name: string): PublicWallet {
  if (!isUnlocked()) throw new Error("Keystore is locked: set KEYSTORE_PASSPHRASE in .env and restart the engine");
  const publicKey = kp.publicKey.toBase58();
  if (wallets.some((w) => w.publicKey === publicKey)) throw new Error("Wallet already imported");
  const rec: WalletRecord = {
    id: crypto.randomUUID(),
    name: name || `Wallet ${wallets.length + 1}`,
    publicKey,
    isMaster: wallets.length === 0,
    active: true,
    createdAt: Date.now(),
    secret: seal(Buffer.from(kp.secretKey)),
  };
  wallets.push(rec);
  persist();
  log.info("wallet", `Added ${rec.name} ${publicKey.slice(0, 4)}…${publicKey.slice(-4)}${rec.isMaster ? " as master" : ""}`);
  const { secret: _s, ...pub } = rec;
  return pub;
}

export const importWallet = (secret: string, name: string, accountIndex?: number) =>
  add(parseSecret(secret, accountIndex), name);
export const generateWallet = (name: string) => add(Keypair.generate(), name);

export function updateWallet(id: string, patch: { name?: string; active?: boolean; isMaster?: boolean }) {
  const w = getWallet(id);
  if (!w) throw new Error(`Unknown wallet ${id}`);
  if (patch.name !== undefined) w.name = patch.name;
  if (patch.active !== undefined) w.active = patch.active;
  if (patch.isMaster) wallets.forEach((x) => (x.isMaster = x.id === id));
  persist();
  return listWallets().find((x) => x.id === id)!;
}

export function removeWallet(id: string) {
  const w = getWallet(id);
  if (!w) return;
  wallets = wallets.filter((x) => x.id !== id);
  if (w.isMaster && wallets[0]) wallets[0].isMaster = true;
  persist();
  log.warn("wallet", `Removed ${w.name}. Its key is gone from the keystore; make sure you have a backup.`);
}

export const toPublicKey = (s: string) => new PublicKey(s);
