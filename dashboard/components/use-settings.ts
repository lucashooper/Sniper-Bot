"use client";

import { useEffect, useState } from "react";
import { api, useEngine } from "@/lib/engine";
import type { Settings } from "@/lib/types";

/** Local draft of engine settings; `save` PUTs a patch and adopts the engine's answer. */
export function useSettingsDraft() {
  const { state, refresh } = useEngine();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (state && !dirty) setDraft(state.settings);
  }, [state, dirty]);

  const set = (patch: Partial<Settings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };
  const save = async (patch?: Partial<Settings>) => {
    const body = patch ?? draft ?? {};
    const next = await api<Settings>("/api/settings", { method: "PUT", body });
    setDraft(next);
    setDirty(false);
    await refresh();
    return next;
  };
  return { draft, set, save, dirty, reset: () => setDirty(false) };
}
