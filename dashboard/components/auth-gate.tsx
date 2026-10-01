"use client";

import type { Session } from "@supabase/auth-js";
import { Crosshair, Lock } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button, Field, Input } from "./ui";

const AuthCtx = createContext<{ email: string | null; signOut: () => void }>({ email: null, signOut: () => {} });
export const useAuth = () => useContext(AuthCtx);

/**
 * With Supabase configured, nothing below renders (and nothing talks to the engine) until the owner signs in.
 * Without it (local development) the gate is open.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase) return <AuthCtx.Provider value={{ email: null, signOut: () => {} }}>{children}</AuthCtx.Provider>;
  if (session === undefined) return <div className="grid min-h-screen place-items-center text-sm text-neutral-500">Loading…</div>;
  if (!session) return <SignIn />;
  return (
    <AuthCtx.Provider value={{ email: session.user.email ?? null, signOut: () => void supabase!.auth.signOut() }}>
      {children}
    </AuthCtx.Provider>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase!.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message);
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="glass w-full max-w-sm space-y-5 rounded-2xl border border-white/[0.07] bg-ink-900/80 p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-emerald-400 text-ink-950">
            <Crosshair size={20} strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-semibold">Sniper Bot</div>
            <div className="text-xs text-neutral-500">Owner sign-in</div>
          </div>
        </div>
        <Field label="Email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}
        <Button variant="primary" className="w-full" disabled={busy}>
          <Lock size={15} /> {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-[11px] text-neutral-500">Sign-ups are closed. The account is created in Supabase.</p>
      </form>
    </div>
  );
}
