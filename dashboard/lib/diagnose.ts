"use client";

import { accessToken, supabaseEnabled } from "./supabase";

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

const timeout = (ms: number) => AbortSignal.timeout(ms);

/**
 * Walks the path from this page to the engine one hop at a time and stops at the first broken hop, so the
 * dashboard can say exactly what to fix instead of "cannot reach the engine".
 */
export async function diagnose(url: string, token?: string): Promise<Check[]> {
  const out: Check[] = [];
  const add = (label: string, ok: boolean, detail: string) => (out.push({ label, ok, detail }), ok);
  const here = window.location.origin;

  // 1. The address itself.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    add("Engine address", false, `"${url}" is not a valid URL. Set NEXT_PUBLIC_ENGINE_URL to https://your-engine-domain and redeploy.`);
    return out;
  }
  if (window.location.protocol === "https:" && parsed.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) {
    add("Engine address", false, `${url} uses http://; an https site may only call https://. Use https://${parsed.host}.`);
    return out;
  }
  if (window.location.protocol === "https:" && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) {
    add("Engine address", false, `${url} is your own computer, not the server. Set NEXT_PUBLIC_ENGINE_URL on Netlify to the engine's https address and redeploy.`);
    return out;
  }
  add("Engine address", true, url);

  // 2. Is anything there, and is it the engine?
  let health: { ok?: boolean; startupError?: string; auth?: string; origin?: string | null; originAllowed?: boolean; allowedOrigins?: string[] } | null = null;
  try {
    const r = await fetch(`${url}/health`, { signal: timeout(10_000), cache: "no-store" });
    health = await r.json().catch(() => null);
    if (health?.startupError) {
      add("Engine responds", false, `The engine is running but failed to start: ${health.startupError.replace(/\.+$/, "")}. Once that is fixed the engine starts by itself within about 20 seconds (a changed Railway variable redeploys it).`);
      return out;
    }
    if (!r.ok || !health?.ok) {
      add("Engine responds", false, `${url}/health answered HTTP ${r.status}${health ? "" : " without the engine's reply"}. Something else is answering at that address.`);
      return out;
    }
  } catch {
    // CORS-less retry: resolves if any server answered (e.g. the host's own error page), rejects if nothing did.
    const answered = await fetch(`${url}/health`, { mode: "no-cors", signal: timeout(10_000), cache: "no-store" }).then(() => true, () => false);
    add(
      "Engine responds",
      false,
      answered
        ? `${parsed.host} answers, but not as the engine. On Railway ("Application failed to respond") the engine is crashing or the domain points at the wrong port: open the deploy logs. An "Engine failed to start: …" line names the missing variable; otherwise make Settings → Networking's port match "API listening on …".`
        : `No usable answer from ${parsed.host}. If opening ${url}/health in a new tab shows Railway's "Application failed to respond", the engine is crashing: open Railway's deploy logs, where an "Engine failed to start: …" line names the missing variable. If the page doesn't load at all, check the domain under Railway → Settings → Networking.`,
    );
    return out;
  }
  add("Engine responds", true, `Up, sign-in mode: ${health.auth}`);

  // 3. Does the engine accept this site?
  if (!health.originAllowed) {
    add(
      "Engine accepts this site",
      false,
      `This page is ${here}, but the engine's DASHBOARD_ORIGINS is ${(health.allowedOrigins ?? []).join(", ") || "empty"}. Add ${here} exactly (no trailing slash) on the engine host and redeploy.`,
    );
    return out;
  }
  add("Engine accepts this site", true, here);

  // 4. Does it accept the sign-in?
  const tok = token ?? (supabaseEnabled ? await accessToken() : "");
  if (supabaseEnabled && !tok) {
    add("Sign-in accepted", false, "This browser has no Supabase session. Sign out and back in.");
    return out;
  }
  try {
    const r = await fetch(`${url}/api/status`, { headers: tok ? { authorization: `Bearer ${tok}` } : {}, signal: timeout(15_000), cache: "no-store" });
    const body = (await r.json().catch(() => ({}))) as { error?: string; reason?: string };
    if (r.status === 401) {
      add("Sign-in accepted", false, body.reason ?? body.error ?? "The engine rejected the sign-in.");
      return out;
    }
    if (!r.ok) {
      add("Sign-in accepted", false, `/api/status answered HTTP ${r.status}: ${body.error ?? "unknown error"}`);
      return out;
    }
  } catch (e) {
    add("Sign-in accepted", false, `The status request failed: ${(e as Error).message}`);
    return out;
  }
  add("Sign-in accepted", true, "The engine accepts your session");

  // 5. Live connection.
  const ws = await new Promise<string | null>((resolve) => {
    let s: WebSocket;
    try {
      s = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
    } catch (e) {
      return resolve(`Could not open a WebSocket: ${(e as Error).message}`);
    }
    const t = setTimeout(() => (s.close(), resolve("No reply on the live connection within 10s.")), 10_000);
    s.onopen = () => s.send(JSON.stringify({ type: "auth", token: tok }));
    s.onmessage = (ev) => {
      clearTimeout(t);
      s.close();
      resolve(String(ev.data).includes('"hello"') ? null : "Unexpected first message on the live connection.");
    };
    s.onclose = (ev) => {
      clearTimeout(t);
      resolve(ev.code === 4401 ? `Live connection refused: ${ev.reason || "sign-in rejected"}` : `Live connection closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}). HTTP works, so a proxy or extension may be blocking WebSockets.`);
    };
  });
  add("Live connection", ws === null, ws ?? "Connected");
  return out;
}
