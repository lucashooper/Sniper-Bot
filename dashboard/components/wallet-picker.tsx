"use client";

import { useCallback, useEffect, useState } from "react";
import { useEngine } from "@/lib/engine";
import { short } from "@/lib/format";
import type { Wallet } from "@/lib/types";

const KEY = "wallet.picked";

/**
 * The wallet buys go out from, shared by every page and remembered across reloads. Returns "" until the user picks
 * one (each page then falls back to its own default), and forgets a pick that was removed or set idle.
 */
export function usePickedWallet(): [string, (id: string) => void] {
  const { state } = useEngine();
  const [picked, setPicked] = useState("");
  useEffect(() => {
    try {
      setPicked(localStorage.getItem(KEY) ?? "");
    } catch {
      /* storage blocked: the pick lasts for this page only */
    }
  }, []);
  const set = useCallback((id: string) => {
    setPicked(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  }, []);
  const valid = !picked || !state || state.wallets.some((w) => w.id === picked && w.active);
  return [valid ? picked : "", set];
}

/** Select value for "every wallet of this preset". Wallet ids never start with it. */
export const PRESET_PREFIX = "preset:";

/**
 * <option>s for a wallet <select>, grouped by wallet group (with its wallet count), with each wallet's SOL balance when
 * known. With `presets`, each preset is also offered as one choice that trades from all of its wallets at once.
 */
export function WalletOptions({ paper, presets }: { paper: boolean; presets?: boolean }) {
  const { state } = useEngine();
  if (!state) return null;
  const active = state.wallets.filter((w) => w.active);
  const groups = (state.groups ?? []).map((g) => ({ ...g, members: active.filter((w) => g.walletIds.includes(w.id)) })).filter((g) => g.members.length);
  const grouped = new Set(groups.flatMap((g) => g.walletIds));
  const loose = active.filter((w) => !grouped.has(w.id));
  const label = (w: Wallet) => {
    const sol = state.balances[w.id]?.sol;
    return `${w.name} · ${short(w.publicKey)}${sol !== undefined ? ` · ${sol.toFixed(3)} SOL` : ""}${w.isMaster ? " (master)" : ""}`;
  };
  return (
    <>
      {paper && <option value="">Paper wallet</option>}
      {presets && groups.length > 0 && (
        <optgroup label="Presets: trade from every wallet">
          {groups.map((g) => {
            const sol = g.members.reduce((s, w) => s + (state.balances[w.id]?.sol ?? 0), 0);
            return (
              <option key={g.id} value={`${PRESET_PREFIX}${g.id}`}>
                {g.name} [{g.members.length} wallet{g.members.length === 1 ? "" : "s"}]{sol > 0 ? ` · ${sol.toFixed(3)} SOL` : ""}
              </option>
            );
          })}
        </optgroup>
      )}
      {groups.map((g) => (
        <optgroup key={g.id} label={`${g.name} [${g.members.length} wallet${g.members.length === 1 ? "" : "s"}]`}>
          {g.members.map((w) => (
            // A wallet in several groups is listed under each; the key keeps React happy, the value is the same.
            <option key={`${g.id}:${w.id}`} value={w.id}>{label(w)}</option>
          ))}
        </optgroup>
      ))}
      {groups.length && loose.length ? (
        <optgroup label="Other wallets">
          {loose.map((w) => <option key={w.id} value={w.id}>{label(w)}</option>)}
        </optgroup>
      ) : (
        loose.map((w) => <option key={w.id} value={w.id}>{label(w)}</option>)
      )}
    </>
  );
}
