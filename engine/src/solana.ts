import { Connection } from "@solana/web3.js";
import { env, hasRpc } from "./config.js";

let conn: Connection | null = null;

/** Shared RPC connection. Throws if SOLANA_RPC_URL is not configured. */
export function connection(): Connection {
  if (!hasRpc()) throw new Error("SOLANA_RPC_URL is not set in .env");
  if (!conn) {
    conn = new Connection(env.rpcUrl, {
      commitment: "confirmed",
      wsEndpoint: env.wsUrl || undefined,
    });
  }
  return conn;
}

export const LAMPORTS = 1_000_000_000;
export const sol = (lamports: number | bigint) => Number(lamports) / LAMPORTS;
export const lamports = (solAmount: number) => Math.round(solAmount * LAMPORTS);
export const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
