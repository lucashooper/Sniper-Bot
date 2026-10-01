"use client";

import { AuthClient } from "@supabase/auth-js";

// NEXT_PUBLIC_* values are baked in at build time: set them on Netlify, then redeploy.
// The publishable (anon) key is designed to be public; Row Level Security is what protects the data.
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

function storageKey() {
  try {
    // Same key supabase-js uses, so an existing sign-in carries over.
    return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  } catch {
    return "sb-auth-token";
  }
}

export const supabaseEnabled = !!(url && key);
/**
 * Only Supabase Auth is used here (sign-in and the session token the engine checks), so this loads the auth client
 * alone rather than all of supabase-js (database, realtime, storage): a much smaller first download.
 */
export const supabase: { auth: InstanceType<typeof AuthClient> } | null = supabaseEnabled
  ? {
      auth: new AuthClient({
        url: `${url}/auth/v1`,
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        storageKey: storageKey(),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      }),
    }
  : null;

/** Current access token, refreshed by the auth client when close to expiry. */
export async function accessToken(): Promise<string> {
  if (!supabase) return "";
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";
}
