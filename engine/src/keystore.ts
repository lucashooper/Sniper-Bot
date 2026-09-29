import crypto from "node:crypto";
import { env } from "./config.js";
import { loadJson, saveJson } from "./store.js";

/**
 * Encrypted-at-rest secret storage.
 * Key: scrypt(KEYSTORE_PASSPHRASE, per-file random salt) -> 32 bytes. Cipher: AES-256-GCM, fresh 12-byte IV per secret.
 * The passphrase never touches disk; without it the file is useless.
 */
export interface Sealed {
  iv: string;
  tag: string;
  ct: string;
}

interface KeystoreHeader {
  version: 1;
  salt: string;
  /** Encrypts a constant so a wrong passphrase is detected on start instead of on first trade. */
  check: Sealed;
}

const CHECK_PLAINTEXT = "sniper-bot-keystore-v1";
let key: Buffer | null = null;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function seal(plain: Buffer): Sealed {
  if (!key) throw new Error("Keystore is locked: set KEYSTORE_PASSPHRASE in .env");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function unseal(s: Sealed): Buffer {
  if (!key) throw new Error("Keystore is locked: set KEYSTORE_PASSPHRASE in .env");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  decipher.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(s.ct, "base64")), decipher.final()]);
}

/** Returns "unlocked", "locked" (no passphrase configured) or throws on a wrong passphrase. */
export function initKeystore(): "unlocked" | "locked" {
  if (!env.keystorePassphrase) return "locked";
  if (env.keystorePassphrase.length < 12) throw new Error("KEYSTORE_PASSPHRASE must be at least 12 characters");
  let header = loadJson<KeystoreHeader | null>("keystore.json", null);
  if (!header) {
    const salt = crypto.randomBytes(16);
    key = deriveKey(env.keystorePassphrase, salt);
    header = { version: 1, salt: salt.toString("base64"), check: seal(Buffer.from(CHECK_PLAINTEXT)) };
    saveJson("keystore.json", header);
    return "unlocked";
  }
  key = deriveKey(env.keystorePassphrase, Buffer.from(header.salt, "base64"));
  try {
    if (unseal(header.check).toString() !== CHECK_PLAINTEXT) throw new Error();
  } catch {
    key = null;
    throw new Error("KEYSTORE_PASSPHRASE does not match the existing keystore in data/keystore.json");
  }
  return "unlocked";
}

export const isUnlocked = () => key !== null;
