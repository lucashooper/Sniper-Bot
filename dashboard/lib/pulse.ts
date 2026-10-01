import type { Launch } from "./types";

/**
 * Pulse columns, mirroring engine/src/feed.ts: New pairs under STRETCH_PCT curve, Final stretch from STRETCH_PCT
 * until graduation, Graduated once the coin moved to PumpSwap. The list view's tabs use the same split.
 */
export const STRETCH_PCT = 40;
export type PulseBucket = "new" | "stretch" | "graduated";
export const pulseBucket = (l: Pick<Launch, "migrated" | "curvePct">): PulseBucket =>
  l.migrated ? "graduated" : l.curvePct >= STRETCH_PCT ? "stretch" : "new";

/** Coins per column the engine sends; the dashboard keeps the same caps when merging pushed updates. */
export const FEED_KEEP: Record<PulseBucket, number> = { new: 50, stretch: 30, graduated: 30 };

/** Newest first within a column; graduated coins by when they graduated. */
export const bucketTime = (l: Launch) => (l.migrated ? (l.migratedAt ?? l.ts) : l.ts);

/** The newest `caps[b]` coins of each column. */
export function takePerBucket(list: Launch[], caps: Record<PulseBucket, number> = FEED_KEEP): Launch[] {
  const count: Record<PulseBucket, number> = { new: 0, stretch: 0, graduated: 0 };
  const keep = new Set<Launch>();
  for (const l of [...list].sort((a, b) => bucketTime(b) - bucketTime(a))) {
    const b = pulseBucket(l);
    if (count[b]++ < caps[b]) keep.add(l);
  }
  return list.filter((l) => keep.has(l));
}
