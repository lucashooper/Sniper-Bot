"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// NEXT_PUBLIC_* values are baked in at build time: set them on Netlify, then redeploy.
// The publishable (anon) key is designed to be public; Row Level Security is what protects the data.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export const supabaseEnabled = !!(url && key);
export const supabase: SupabaseClient | null = supabaseEnabled
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

/** Current access token, refreshed by supabase-js when close to expiry. */
export async function accessToken(): Promise<string> {
  if (!supabase) return "";
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? "";
}
