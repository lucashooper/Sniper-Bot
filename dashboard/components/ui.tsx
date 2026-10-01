"use client";

import { AnimatePresence, m } from "framer-motion";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({ className, children, title, action }: { className?: string; children: React.ReactNode; title?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={cx("glass rounded-xl border border-white/[0.06] bg-ink-900/70", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-3">
          <h2 className="text-[13px] font-medium text-neutral-200">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone = "neutral", icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "neutral" | "up" | "down"; icon?: React.ReactNode }) {
  return (
    <div className="glass rounded-xl border border-white/[0.06] bg-ink-900/70 p-4">
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        {icon}
        {label}
      </div>
      <div
        className={cx(
          "mt-2 text-xl font-semibold tracking-tight",
          tone === "up" && "text-emerald-400",
          tone === "down" && "text-rose-400",
          tone === "neutral" && "text-neutral-100",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
export function Button({ variant = "secondary", size = "md", className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "h-8 px-3 text-xs",
        size === "md" && "h-9 px-3.5 text-sm",
        size === "lg" && "h-11 px-5 text-sm",
        variant === "primary" && "bg-neutral-100 text-ink-950 hover:bg-white",
        variant === "success" && "bg-emerald-500 text-emerald-950 hover:bg-emerald-400",
        variant === "secondary" && "border border-white/[0.07] bg-white/[0.03] text-neutral-200 hover:border-white/[0.12] hover:bg-white/[0.06]",
        variant === "ghost" && "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100",
        variant === "danger" && "border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
        className,
      )}
    />
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "green" | "violet" | "amber" | "red"; children: React.ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[10.5px] font-medium leading-4",
        tone === "neutral" && "bg-white/[0.06] text-neutral-400",
        tone === "green" && "bg-emerald-500/10 text-emerald-300",
        tone === "violet" && "bg-violet-500/10 text-violet-300",
        tone === "amber" && "bg-amber-500/10 text-amber-300",
        tone === "red" && "bg-rose-500/10 text-rose-300",
      )}
    >
      {children}
    </span>
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-6 w-11 shrink-0 rounded-full border transition disabled:opacity-40",
        checked ? "border-emerald-500/50 bg-emerald-500/30" : "border-neutral-700 bg-neutral-800",
      )}
    >
      <span className={cx("absolute left-0.5 top-0.5 h-4.5 w-4.5 rounded-full transition-transform duration-200", checked ? "translate-x-5 bg-emerald-300" : "bg-neutral-400")} />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-neutral-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-500">{hint}</span>}
    </label>
  );
}

export function Input({ className, suffix, wrapperClassName, ...p }: React.InputHTMLAttributes<HTMLInputElement> & { suffix?: string; wrapperClassName?: string }) {
  return (
    <div className={cx("relative", wrapperClassName)}>
      <input
        {...p}
        className={cx(
          "h-9 w-full rounded-lg border border-white/[0.07] bg-ink-950 px-3 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-white/20",
          suffix && (suffix.length <= 2 ? "pr-7" : "pr-14"),
          className,
        )}
      />
      {suffix && <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-neutral-500">{suffix}</span>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  // Portal to <body>: a parent with backdrop-filter (the sticky header) would otherwise trap position:fixed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div className="fixed inset-0 z-50 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
          <m.div
            role="dialog"
            aria-modal="true"
            initial={{ y: 16, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 16, scale: 0.98 }}
            className="relative w-full max-w-lg rounded-xl border border-white/[0.08] bg-ink-900 shadow-2xl shadow-black/60"
          >
            <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
              <h3 className="font-semibold">{title}</h3>
              <button onClick={onClose} className="rounded-lg p-1 text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200" aria-label="Close">
                <X size={18} />
              </button>
            </header>
            <div className="space-y-4 px-5 py-4">{children}</div>
            {footer && <footer className="flex justify-end gap-2 border-t border-white/[0.07] px-5 py-4">{footer}</footer>}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="rounded-md p-1 text-neutral-500 hover:bg-white/[0.06] hover:text-neutral-200"
      aria-label="Copy"
    >
      {done ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
    </button>
  );
}

export function Empty({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3 text-neutral-500">{icon}</div>
      <div className="text-sm font-medium text-neutral-300">{title}</div>
      {children && <div className="max-w-sm text-xs text-neutral-500">{children}</div>}
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cx("px-4 py-2 text-left text-[11px] font-medium text-neutral-500", className)}>{children}</th>;
}
export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cx("px-4 py-2.5 text-[13px]", className)}>{children}</td>;
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Errors stay up long enough to read the reason (or until clicked away); a newer toast replaces the old one's timer.
  const show = (text: string, tone: "ok" | "err" = "ok") => {
    setMsg({ text, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), tone === "err" ? 15_000 : 3500);
  };
  const node = (
    <AnimatePresence>
      {msg && (
        <m.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          onClick={() => setMsg(null)}
          title="Click to dismiss"
          className={cx(
            "fixed bottom-5 right-5 z-50 max-w-sm cursor-pointer rounded-xl border px-4 py-3 text-sm shadow-xl",
            msg.tone === "ok" ? "border-emerald-500/30 bg-ink-900 text-emerald-200" : "border-rose-500/30 bg-ink-900 text-rose-200",
          )}
        >
          {msg.text}
        </m.div>
      )}
    </AnimatePresence>
  );
  return { show, node };
}
