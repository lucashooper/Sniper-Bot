# Running Sniper Bot in production

Two pieces, two hosts:

| Piece | Where | Why |
|---|---|---|
| Dashboard (`dashboard/`) | **Netlify**, as a static site | Just HTML and JS. Holds no secrets. |
| Engine (`engine/`) | **Railway** (Docker, always on, persistent volume) | Keeps WebSocket connections to Solana open 24/7 and holds the encrypted keys. Netlify cannot run long-lived processes, which is why the dashboard said "Cannot reach the engine". |
| Sign-in and backup | **Supabase** | Owner-only login, row-level-secured tables, and an encrypted off-host backup of the engine's data. |

```
Browser ──(Supabase session)──▶ Netlify static dashboard
   │                                   
   └──── https/wss + session token ──▶ Railway engine ──▶ Solana RPC / Jito
                                          │
                                          └─ secret key ─▶ Supabase (backup + trade log)
```

## 1. Supabase

1. **Keys.** Project Settings → API Keys. Copy the **publishable** key (`sb_publishable_…`) and create/copy a **secret** key (`sb_secret_…`). The publishable key is safe in the browser; the secret key goes on the engine host only.
2. **Schema.** SQL Editor → New query → paste [`supabase/migrations/20261001000000_sniper_bot.sql`](supabase/migrations/20261001000000_sniper_bot.sql) → Run.
   CLI alternative, from the repo root: `supabase login`, `supabase init` (keep the existing `supabase/migrations`), `supabase link --project-ref wsgytasfhjxoamlrokwa`, `supabase db push`.
3. **Close sign-ups.** Authentication → Sign In / Providers → turn off **Allow new users to sign up**. Keep Email enabled.
4. **Create your account.** Authentication → Users → Add user → Create new user: your email, a strong password, **Auto Confirm User** on.

What ends up in Supabase:

| Table | Contents | Who can read it |
|---|---|---|
| `wallets` | name, public key, master/active flags. No keys. | you, signed in |
| `bot_settings` | your bot settings | you, signed in |
| `trade_logs` | every fill with fees, tips, PnL, signature | you, signed in |
| `engine_files` | backup of the engine's data: AES-256-GCM sealed keys, keystore header, settings, ledger | nobody from a browser (RLS on, no policies). Only the engine's secret key can read it, and decrypting the keys also needs `KEYSTORE_PASSPHRASE`, which is never stored in Supabase. |

## 2. Engine on Railway

1. railway.com → New Project → Deploy from GitHub repo → this repo and branch. `railway.json` tells it to build the root `Dockerfile` and health-check `/health`.
2. Service → Settings → **Region**: EU West (Amsterdam) or US East, close to a Jito block engine.
3. Service → **Volumes** → add a volume mounted at **`/data`**. This is where the encrypted keystore lives.
4. Service → **Variables**:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://wsgytasfhjxoamlrokwa.supabase.co` |
   | `SUPABASE_SECRET_KEY` | your `sb_secret_…` key |
   | `OWNER_EMAIL` | the email of the user you created in step 1.4 |
   | `KEYSTORE_PASSPHRASE` | a long random string (`openssl rand -base64 32`). Save it in your password manager: without it the keys cannot be decrypted, from the volume or from the backup. |
   | `DASHBOARD_ORIGINS` | your Netlify URL, e.g. `https://your-site.netlify.app` (no trailing slash; comma-separate several) |
   | `SOLANA_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=…` |
   | `SOLANA_WS_URL` | `wss://mainnet.helius-rpc.com/?api-key=…` |
   | `JITO_BLOCK_ENGINE_URL` | `https://amsterdam.mainnet.block-engine.jito.wtf` (EU) or `https://ny.mainnet.block-engine.jito.wtf` (US East) |
   | `ALLOW_LIVE_TRADING` | `false` for now |

   Leave `ENGINE_HOST`, `ENGINE_PORT` and `ENGINE_DATA_DIR` unset; the image sets them and Railway provides `PORT`.
5. Settings → Networking → **Generate Domain**. Open `https://<that-domain>/health`; it should say `{"ok":true}`. Everything else answers 401 without your sign-in.

The engine refuses to start on a public address with no sign-in configured, and refuses to start if Supabase is configured but unreachable or holds a keystore that doesn't match the volume. Both are deliberate: starting blank would create a new keystore and overwrite the backup that can still decrypt your wallets.

If the volume is ever lost, redeploy with the same variables: the engine restores the keystore, wallets, settings and ledger from Supabase on boot.

## 3. Dashboard on Netlify

1. Site configuration → Build & deploy → Build settings: **Base directory empty** (repo root), and clear any custom build command / publish directory so `netlify.toml` applies. **Production branch** must be a branch that contains this setup (with `netlify.toml` at the root); the build log should say "Config file … netlify.toml", not "No config file was defined".
2. Site configuration → **Environment variables**:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_ENGINE_URL` | `https://<your-railway-domain>` |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://wsgytasfhjxoamlrokwa.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | your `sb_publishable_…` key |

   Leave **Contains secret values unticked** for all three: they are public by design and end up in the page's JavaScript. (`netlify.toml` also tells the secret scanner to skip them.)

   These are baked in at build time: after changing them, Deploys → Trigger deploy → **Clear cache and deploy site**.
3. Never put `SUPABASE_SECRET_KEY`, `KEYSTORE_PASSPHRASE`, RPC keys or wallet keys on Netlify.

Open the site, sign in, and the header should show **Simulation** instead of "Engine offline".

## 4. First live trade (tiny amounts)

1. Settings → Setup checklist is green except "Live trading unlocked".
2. Header → **Deposit** → Create main wallet → send **0.05–0.1 SOL** from Phantom/Axiom to the address or QR. The balance appears within ~20 s.
3. Still in Simulation: Wallets → withdraw arrow on the main wallet → your Phantom address → **Dry run withdrawal**. The log should say "dry run OK". This proves keys, RPC and signing.
4. Still in Simulation: snipe one real mint for 0.01 SOL. The log shows the real transaction being dry-run through `simulateTransaction`.
5. Railway → set `ALLOW_LIVE_TRADING=true` → redeploy. Keep **Auto-snipe off**.
6. Header switch → type `LIVE` → Go live. The red bar appears.
7. Manual snipe **0.01 SOL** on one coin. Open the signature on Solscan. Then sell 100% and check the PnL ledger matches Solscan (fees and tip included).
8. Withdraw 0.001 SOL to Phantom for real (type `SEND`).
9. Flip back to Simulation with one click. Only consider auto-snipe after this, with a small size and a low max-per-hour.

## Safety model, in short

- Private keys are generated or imported on the engine, encrypted with AES-256-GCM (scrypt-derived key) before touching disk, and never sent to the browser or stored in Supabase in decryptable form.
- Every engine request carries your Supabase session; the engine checks it with Supabase and only accepts `OWNER_EMAIL`. Browser origins other than `DASHBOARD_ORIGINS` are refused.
- Live trading needs two independent switches: `ALLOW_LIVE_TRADING=true` on the host and typing `LIVE` in the dashboard.
- Turn on 2FA for GitHub, Netlify, Railway and Supabase: whoever controls Railway's variables controls the passphrase. Keep only trading money in these wallets and withdraw profits.
