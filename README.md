# Sniper Bot

A Solana Pump.fun sniper with a Whop-style dashboard. It detects new launches in real time, screens them, buys through Jito bundles, manages exits (take-profit, stop-loss, anti-rug) and keeps a full PnL ledger you can export as CSV. It starts in simulation mode and needs no keys to try.

```
engine/      Node + TypeScript trading engine (HTTP + WebSocket API on 127.0.0.1:8787)
dashboard/   Next.js App Router + Tailwind + Framer Motion UI (localhost:3000)
```

## Quick start (paper trading, no keys)

Requires Node 22+.

```bash
npm install
npm run dev:engine      # terminal 1: engine with a synthetic Pump.fun market
npm run dev:dashboard   # terminal 2: http://localhost:3000
```

Without an RPC URL the engine runs a synthetic market: fake launches every few seconds with prices that moon, bleed or get rugged, so you can test auto-snipe, exits and anti-rug end to end. Turn on **Auto-snipe** on the Snipe page to watch it trade.

## Production (Netlify + Railway + Supabase)

The dashboard deploys to Netlify as a static site and the engine runs on an always-on host with a persistent volume (Railway, via the root `Dockerfile`). Supabase provides owner-only sign-in and an encrypted backup. Step-by-step setup, the exact environment variables for each host and a first-live-trade checklist are in **[DEPLOY.md](DEPLOY.md)**.

## Configuration

1. `cp .env.example .env`
2. **RPC.** Set `SOLANA_RPC_URL` and `SOLANA_WS_URL`. A Helius key works well: the engine uses Helius `getPriorityFeeEstimate` automatically when the URL is a Helius one, and falls back to `getRecentPrioritizationFees` otherwise.
3. **Jito.** Set `JITO_BLOCK_ENGINE_URL` to the region closest to where the engine runs. No key is required; `JITO_AUTH_UUID` only raises rate limits.
4. **Keystore.** Set `KEYSTORE_PASSPHRASE` (12+ characters). Restart the engine, then import or generate wallets on the Wallets page. Keys are encrypted with AES-256-GCM under a scrypt-derived key in `engine/data/` (git-ignored, file mode 600) and never leave the engine.
5. **Stay in simulation first.** With an RPC set and simulation still on, snipes of real mints quote from the live curve and dry-run the real transaction through `simulateTransaction`, so you can prove the route works without spending SOL.
6. **Go live** only when ready: set `ALLOW_LIVE_TRADING=true`, restart, then use the Simulation / Live switch in the header (type `LIVE` to confirm). Both are required.

## How it works

| Piece | Implementation |
|---|---|
| Launch detection | `logsSubscribe` on the Pump.fun and PumpSwap programs; Anchor events are decoded from `Program data:` logs (`engine/src/stream.ts`). Works on any RPC. |
| Token feed | Every new launch is tracked from its own trade events: market cap, bonding-curve %, SOL in the curve, volume, buys/sells, unique traders, and the dev wallet's share of supply. Image and socials come from the coin's metadata JSON (IPFS), fetched by the engine (`engine/src/feed.ts`). Shown in USD when the engine can fetch the SOL price, otherwise in SOL. |
| Auto-snipe filters | Keywords, min/max market cap, min liquidity, max dev holding, skip if the dev sold, require socials or an image, and a bonding-curve trigger that waits until the curve is X% complete instead of buying at launch (`evaluateFilters` in `engine/src/engine.ts`). |
| Buy / sell | Official `@pump-fun/pump-sdk` (bonding curve) and `@pump-fun/pump-swap-sdk` (graduated coins). The engine picks the venue per coin (`engine/src/pump.ts`). |
| Landing | One transaction `[CU limit, CU price, swap, tip]`, simulated first, then sent as a Jito bundle via the Block Engine JSON-RPC API. A bundle is all-or-nothing and never hits the public mempool, so a failed buy costs nothing and cannot be sandwiched (`engine/src/jito.ts`, `engine/src/trader.ts`). |
| Tips and fees | Tip = your setting, raised to the live 75th-percentile landed tip when dynamic tips are on, capped at your max. Priority fee is fetched per trade unless you pin it. |
| Safety checks | Mint and freeze authority revoked; Token-2022 extensions that enable honeypots (transfer hook, permanent delegate, non-transferable, default-frozen, >1% transfer fee); top-holder concentration excluding the curve and pool vaults (`engine/src/safety.ts`). |
| Exits | Per-position take-profit / stop-loss ladder, each rule fires once. Anti-rug emergency sells (higher slippage and tip) on creator sells, single-trade crashes, PumpSwap liquidity withdrawals and mint supply increases (`engine/src/engine.ts`). |
| Ledger | Every fill with Jito tip, priority fee and network fee; live fills are settled from the confirmed transaction, not the quote. CSV export on the PnL page. |
| Wallets | Generate or import, a **Deposit** drawer (address, QR, copy) for the master, withdraw to any address, fund a wallet from the master, and **Reclaim all**: closes empty token accounts and sweeps SOL back to the master (dry run only while in simulation). |

## Scripts

```bash
npm run dev:engine        # engine with hot reload
npm run dev:dashboard     # dashboard
npm run build             # compile engine to engine/dist and build the dashboard
npm test -w engine        # keystore, seed import, PnL math and event decoding tests
```

## Notes and limits

- Only SOL-quoted coins are traded; Pump.fun's newer USDC/token-quoted curves are rejected by design.
- Detection latency is bounded by your RPC's WebSocket. For the fastest path, replace the subscriber in `stream.ts` with a Yellowstone gRPC or Helius LaserStream client; the rest of the engine only consumes `MarketEvent`s.
- Locally the engine API binds to 127.0.0.1. On a public host it refuses to start unless Supabase sign-in (or `ENGINE_API_TOKEN`) is configured, and it only accepts browser requests from `DASHBOARD_ORIGINS`.
- Trading memecoins is extremely risky. Use a dedicated wallet with only what you can lose.
