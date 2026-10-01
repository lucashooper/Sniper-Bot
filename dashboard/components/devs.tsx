"use client";

import { Eye, EyeOff, Plus, Star, Tag, Trash2 } from "lucide-react";
import { createContext, memo, useCallback, useContext, useMemo, useState } from "react";
import { api, useEngine } from "@/lib/engine";
import { short } from "@/lib/format";
import type { DevTag } from "@/lib/types";
import { Button, Field, Input, Modal, cx, useToast } from "./ui";

/**
 * Dev labels, like Axiom's wallet labels: a name and an emoji per wallet, saved on the engine (so every device sees
 * them and they ride the Supabase backup) and shown wherever that wallet appears. A dev can also be followed (the
 * feed and auto-snipe can narrow to followed devs) or hidden (their coins drop out of the feed and auto-snipe).
 */

const EMOJIS = ["🐸", "🐳", "🦈", "🐍", "🤡", "💀", "🚀", "🔥", "💎", "👑", "⭐", "🎯", "🧠", "🐂", "🐻", "🦄", "🍀", "⚠️", "🚫", "💩", "🤖", "👀", "💰", "🧪"];
const MODES: { id: DevTag["mode"]; label: string; hint: string }[] = [
  { id: "none", label: "Label only", hint: "Shows the name wherever this wallet appears." },
  { id: "follow", label: "Follow", hint: "Highlighted in the feed. \"Followed devs\" narrows the feed (and auto-snipe, if you turn that on) to these." },
  { id: "hide", label: "Hide", hint: "Their coins drop out of the feed and auto-snipe never buys them." },
];

interface DevsCtx {
  devs: Record<string, DevTag>;
  /** Opens the label editor for a wallet. */
  edit: (address: string) => void;
  /** Opens the list of every labelled wallet. */
  manage: () => void;
  /** False on engines older than dev labels: the editor explains instead of failing. */
  supported: boolean;
}

const Ctx = createContext<DevsCtx | null>(null);
const NONE: Record<string, DevTag> = {};

export function useDevs(): DevsCtx {
  return useContext(Ctx) ?? { devs: NONE, edit: () => {}, manage: () => {}, supported: false };
}

/** "🐸 Name", or the short address when the wallet has no label. */
export function devLabel(address: string, tag?: DevTag) {
  const text = [tag?.emoji, tag?.name].filter(Boolean).join(" ");
  return text || short(address);
}

/** The haystack the feed's search matches a dev against: address plus label. */
export const devSearchText = (address: string, tag?: DevTag) => `${address} ${tag?.name ?? ""} ${tag?.emoji ?? ""}`;

export function DevsProvider({ children }: { children: React.ReactNode }) {
  const { state } = useEngine();
  const devs = state?.settings.devs ?? NONE;
  const supported = !!state && state.settings.devs !== undefined;
  const [editing, setEditing] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const edit = useCallback((a: string) => setEditing(a), []);
  const manage = useCallback(() => setListOpen(true), []);
  const value = useMemo(() => ({ devs, edit, manage, supported }), [devs, edit, manage, supported]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <DevEditor address={editing} onClose={() => setEditing(null)} supported={supported} />
      <DevList open={listOpen} onClose={() => setListOpen(false)} onEdit={(a) => setEditing(a)} />
    </Ctx.Provider>
  );
}

/**
 * A wallet shown as its label (or short address), with a click to label it. Labelled devs read in violet; followed
 * ones get a star, hidden ones an eye-off.
 */
export const DevChip = memo(function DevChip({ address, prefix, className }: { address: string; prefix?: string; className?: string }) {
  const { devs, edit } = useDevs();
  const tag = devs[address];
  const named = !!(tag && (tag.name || tag.emoji));
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        edit(address);
      }}
      title={named ? `${devLabel(address, tag)} · ${address}\nClick to edit the label` : `${address}\nClick to label this wallet`}
      className={cx(
        "group/dev inline-flex max-w-[150px] items-center gap-1 rounded px-1 text-[11px] leading-4 transition",
        named ? "bg-violet-500/10 text-violet-200 hover:bg-violet-500/20" : "text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200",
        tag?.mode === "hide" && "opacity-60",
        className,
      )}
    >
      {prefix && <span className={named ? "text-violet-300/70" : "text-neutral-600"}>{prefix}</span>}
      {tag?.mode === "follow" && <Star size={9} className="shrink-0 fill-amber-300 text-amber-300" />}
      {tag?.mode === "hide" && <EyeOff size={9} className="shrink-0" />}
      <span className="truncate">{named ? devLabel(address, tag) : address.startsWith("sim-") ? address.replace("sim-trader-", "trader ") : short(address, 4)}</span>
      {!named && <Tag size={9} className="shrink-0 opacity-0 transition group-hover/dev:opacity-100" />}
    </button>
  );
});

function DevEditor({ address, onClose: close, supported }: { address: string | null; onClose: () => void; supported: boolean }) {
  const { state, refresh } = useEngine();
  const toast = useToast();
  const saved = address ? state?.settings.devs?.[address] : undefined;
  const [form, setForm] = useState<{ for: string | null; name: string; emoji: string; mode: DevTag["mode"] }>({ for: null, name: "", emoji: "", mode: "none" });
  const [busy, setBusy] = useState(false);
  const onClose = () => (setForm((f) => ({ ...f, for: null })), close());
  // Fresh form each time the editor opens on a wallet.
  if (address && form.for !== address) setForm({ for: address, name: saved?.name ?? "", emoji: saved?.emoji ?? "", mode: saved?.mode ?? "none" });

  const run = async (what: "save" | "remove") => {
    if (!address) return;
    setBusy(true);
    try {
      if (what === "save") {
        await api(`/api/devs/${encodeURIComponent(address)}`, { method: "PUT", body: { name: form.name, emoji: form.emoji, mode: form.mode } });
        toast.show(`Saved ${devLabel(address, { ...form, updatedAt: 0 })}`);
      } else {
        await api(`/api/devs/${encodeURIComponent(address)}`, { method: "DELETE" });
        toast.show(`Label removed from ${short(address)}`);
      }
      await refresh();
      onClose();
    } catch (e) {
      console.error(`[devs] ${what} label for ${address} failed`, e);
      toast.show(`Could not ${what === "save" ? "save" : "remove"} the label: ${(e as Error).message}`, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {toast.node}
      <Modal
        open={!!address}
        onClose={onClose}
        title={saved ? "Edit dev label" : "Label dev"}
        footer={
          <>
            {saved && (
              <Button variant="danger" className="mr-auto" disabled={busy} onClick={() => run("remove")}>
                <Trash2 size={14} /> Remove
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy || !supported} onClick={() => run("save")}>
              Save
            </Button>
          </>
        }
      >
        {!supported && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Your engine is older than dev labels. It picks them up after Railway redeploys from main.</p>}
        <div className="break-all rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 font-mono text-[11px] text-neutral-400">{address}</div>
        <div className="grid grid-cols-[88px_1fr] gap-3">
          <Field label="Emoji">
            <Input value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} placeholder="🐸" className="text-center text-base" maxLength={16} />
          </Field>
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Serial rugger, KOL, Good dev" maxLength={32} autoFocus onKeyDown={(e) => e.key === "Enter" && run("save")} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-1">
          {EMOJIS.map((em) => (
            <button
              key={em}
              type="button"
              onClick={() => setForm({ ...form, emoji: form.emoji === em ? "" : em })}
              className={cx("grid h-8 w-8 place-items-center rounded-md text-base transition", form.emoji === em ? "bg-white/[0.12] ring-1 ring-white/20" : "hover:bg-white/[0.06]")}
            >
              {em}
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          <div className="flex rounded-lg border border-white/[0.06] bg-white/[0.02] p-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setForm({ ...form, mode: m.id })}
                className={cx("flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition", form.mode === m.id ? "bg-white/[0.08] text-white" : "text-neutral-500 hover:text-neutral-200")}
              >
                {m.id === "follow" ? <Star size={12} /> : m.id === "hide" ? <EyeOff size={12} /> : <Tag size={12} />}
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-neutral-500">{MODES.find((m) => m.id === form.mode)?.hint}</p>
        </div>
      </Modal>
    </>
  );
}

function DevList({ open, onClose, onEdit }: { open: boolean; onClose: () => void; onEdit: (a: string) => void }) {
  const { devs } = useDevs();
  const [addr, setAddr] = useState("");
  const rows = Object.entries(devs).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const add = () => {
    const a = addr.trim();
    if (!a) return;
    setAddr("");
    onClose();
    onEdit(a);
  };
  return (
    <Modal open={open} onClose={onClose} title="Dev list">
      <div className="flex gap-2">
        <Input value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Paste a dev wallet address" wrapperClassName="flex-1" className="font-mono text-xs" />
        <Button onClick={add} disabled={!addr.trim()}>
          <Plus size={14} /> Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">No labelled devs yet. Click any dev address in the feed or on a coin page to label it.</p>
      ) : (
        <div className="max-h-[50vh] divide-y divide-white/[0.05] overflow-y-auto scrollbar-thin">
          {rows.map(([a, t]) => (
            <button key={a} onClick={() => (onClose(), onEdit(a))} className="flex w-full items-center gap-3 px-1 py-2 text-left transition hover:bg-white/[0.03]">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-white/[0.04] text-sm">{t.emoji || <Tag size={12} className="text-neutral-600" />}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-neutral-200">{t.name || <span className="text-neutral-500">No name</span>}</span>
                <span className="block font-mono text-[11px] text-neutral-500">{short(a, 6)}</span>
              </span>
              {t.mode === "follow" && (
                <span className="flex items-center gap-1 text-[11px] text-amber-300"><Star size={11} className="fill-amber-300" /> Following</span>
              )}
              {t.mode === "hide" && (
                <span className="flex items-center gap-1 text-[11px] text-neutral-400"><EyeOff size={11} /> Hidden</span>
              )}
              {t.mode === "none" && <Eye size={11} className="text-neutral-700" />}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
