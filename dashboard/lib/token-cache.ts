"use client";

import { api } from "./engine";
import type { TokenDetail } from "./types";

/**
 * Starts a coin's detail fetch the moment the pointer goes down on it in the feed, so the coin page usually finds
 * the data already in flight (or done) when it mounts instead of starting a round trip to the engine then.
 */
const pending = new Map<string, { at: number; p: Promise<TokenDetail> }>();
const FRESH_MS = 5_000;

export function prefetchToken(mint: string) {
  const hit = pending.get(mint);
  if (hit && Date.now() - hit.at < FRESH_MS) return;
  const p = api<TokenDetail>(`/api/token/${encodeURIComponent(mint)}`);
  p.catch(() => pending.delete(mint));
  pending.set(mint, { at: Date.now(), p });
  if (pending.size > 20) pending.delete(pending.keys().next().value!);
}

/** The prefetched full detail, if one started in the last few seconds; consumed on use. */
export function takePrefetched(mint: string): Promise<TokenDetail> | null {
  const hit = pending.get(mint);
  pending.delete(mint);
  return hit && Date.now() - hit.at < FRESH_MS ? hit.p : null;
}
