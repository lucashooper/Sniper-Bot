"use client";

import type { Settings, SnipeFilters } from "@/lib/types";
import { Field, Input, Toggle } from "./ui";

/** Auto-snipe filter fields. Works on a settings draft from useSettingsDraft; the caller saves. */
export function FiltersPanel({ draft, set }: { draft: Settings; set: (patch: Partial<Settings>) => void }) {
  const f = draft.filters;
  const up = (patch: Partial<SnipeFilters>) => set({ filters: { ...f, ...patch } });
  const num = (k: keyof SnipeFilters) => ({
    value: f[k] as number,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => up({ [k]: Math.max(0, Number(e.target.value) || 0) } as Partial<SnipeFilters>),
    type: "number",
    min: 0,
  });
  const toggles: [keyof SnipeFilters, string, string][] = [
    ["requireSocials", "Require social links", "At least one of X/Twitter, Telegram or website in the coin's metadata."],
    ["requireImage", "Require an image", "Skip coins with no image uploaded."],
    ["skipIfDevSold", "Skip if the dev sold", "Drop the coin as soon as its creator wallet sells any amount."],
    ["onlyFollowedDevs", "Only followed devs", "Buy only coins created by devs you follow in the dev list. Hidden devs are always skipped."],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Min market cap"><Input {...num("minMarketCapSol")} suffix="SOL" /></Field>
        <Field label="Max market cap" hint="0 = no limit"><Input {...num("maxMarketCapSol")} suffix="SOL" /></Field>
        <Field label="Min liquidity" hint="SOL in the curve"><Input {...num("minLiquiditySol")} step="0.1" suffix="SOL" /></Field>
        <Field label="Max dev holding" hint="0 = no limit"><Input {...num("maxDevHoldPct")} suffix="%" /></Field>
        <Field label="Bonding curve trigger" hint="0 = buy at launch"><Input {...num("curveTriggerPct")} max={99} suffix="%" /></Field>
        <Field label="Watch window" hint="Give up after"><Input {...num("maxWatchSec")} suffix="sec" /></Field>
      </div>
      <div className="space-y-2.5">
        {toggles.map(([k, label, hint]) => (
          <label key={k} className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm text-neutral-200">{label}</span>
              <span className="block text-xs text-neutral-500">{hint}</span>
            </span>
            <Toggle checked={!!f[k]} onChange={(v) => up({ [k]: v } as Partial<SnipeFilters>)} />
          </label>
        ))}
      </div>
    </div>
  );
}
