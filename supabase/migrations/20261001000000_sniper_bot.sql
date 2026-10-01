-- Sniper Bot schema. Apply with `supabase db push` (after `supabase link`) or paste into the SQL editor.
--
-- Who writes what:
--   * The engine writes every table with the secret (service role) key, which bypasses RLS. That key lives only on
--     the engine host, never in the browser or on Netlify.
--   * The dashboard signs in with the publishable key and can only READ its own rows (RLS below).
--   * engine_files holds the engine's encrypted keystore backup. It has RLS on and no policies, so no browser
--     session can read it at all; even the engine needs KEYSTORE_PASSPHRASE (never stored here) to decrypt it.

-- Engine state backup: keystore header, wallets (AES-256-GCM sealed secrets), settings, portfolio. Engine-only.
create table if not exists public.engine_files (
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);
alter table public.engine_files enable row level security;
revoke all on public.engine_files from anon, authenticated;

-- Public wallet metadata (no key material).
create table if not exists public.wallets (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  public_key text not null,
  is_master boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, public_key)
);
create index if not exists wallets_user_idx on public.wallets (user_id);
alter table public.wallets enable row level security;

create table if not exists public.bot_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.bot_settings enable row level security;

create table if not exists public.trade_logs (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  ts timestamptz not null,
  mode text not null check (mode in ('sim', 'live')),
  side text not null check (side in ('buy', 'sell')),
  reason text not null,
  wallet_id text,
  wallet_name text,
  mint text not null,
  symbol text,
  venue text,
  sol_amount double precision not null,
  token_amount double precision not null,
  price_sol double precision not null,
  priority_fee_sol double precision not null default 0,
  jito_tip_sol double precision not null default 0,
  network_fee_sol double precision not null default 0,
  realized_pnl_sol double precision not null default 0,
  signature text,
  bundle_id text
);
create index if not exists trade_logs_user_ts_idx on public.trade_logs (user_id, ts desc);
alter table public.trade_logs enable row level security;

-- Read-only access for the signed-in owner. No insert/update/delete policies: only the engine writes.
drop policy if exists "owner reads wallets" on public.wallets;
create policy "owner reads wallets" on public.wallets
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "owner reads settings" on public.bot_settings;
create policy "owner reads settings" on public.bot_settings
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "owner reads trades" on public.trade_logs;
create policy "owner reads trades" on public.trade_logs
  for select to authenticated using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.wallets, public.bot_settings, public.trade_logs from anon, authenticated;
revoke all on public.wallets, public.bot_settings, public.trade_logs from anon;

-- Make the API see the new tables right away.
notify pgrst, 'reload schema';
