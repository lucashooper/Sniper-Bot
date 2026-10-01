import { bus, log } from "./bus.js";
import { cloudStatus, ownerUserId, supabaseRest as rest } from "./cloud.js";
import { trades } from "./portfolio.js";
import { getSettings } from "./settings.js";
import { listWallets } from "./wallets.js";

/**
 * Mirrors wallets (public metadata only), settings and trades into owner-readable tables so they can be browsed in
 * Supabase and survive the engine host. Best effort: a failed sync is retried on the next change.
 */
export function startCloudSync() {
  const uid = ownerUserId();
  if (!uid) return;
  const synced = new Set<string>();
  let busy = false;
  const dirty = new Set<string>(["wallets", "settings", "trades"]);

  const syncWallets = async () => {
    const ws = listWallets();
    if (ws.length) {
      await rest("/rest/v1/wallets?on_conflict=id", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=minimal" },
        body: ws.map((w) => ({
          id: w.id,
          user_id: uid,
          name: w.name,
          public_key: w.publicKey,
          is_master: w.isMaster,
          active: w.active,
          created_at: new Date(w.createdAt).toISOString(),
        })),
      });
    }
    const keep = ws.length ? `&id=not.in.(${ws.map((w) => w.id).join(",")})` : "";
    await rest(`/rest/v1/wallets?user_id=eq.${uid}${keep}`, { method: "DELETE", headers: { prefer: "return=minimal" } });
  };

  const syncSettings = () =>
    rest("/rest/v1/bot_settings?on_conflict=user_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: { user_id: uid, settings: getSettings(), updated_at: new Date().toISOString() },
    });

  const syncTrades = async () => {
    const all = trades();
    const local = new Set(all.map((t) => t.id));
    // "Reset simulation" drops paper trades locally; drop them in the mirror too.
    if ([...synced].some((id) => !local.has(id))) {
      await rest(`/rest/v1/trade_logs?user_id=eq.${uid}&mode=eq.sim`, { method: "DELETE", headers: { prefer: "return=minimal" } });
      synced.clear();
    }
    const fresh = all.filter((t) => !synced.has(t.id));
    for (let i = 0; i < fresh.length; i += 500) {
      const batch = fresh.slice(i, i + 500);
      await rest("/rest/v1/trade_logs?on_conflict=id", {
        method: "POST",
        headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
        body: batch.map((t) => ({
          id: t.id,
          user_id: uid,
          ts: new Date(t.ts).toISOString(),
          mode: t.mode,
          side: t.side,
          reason: t.reason,
          wallet_id: t.walletId,
          wallet_name: t.walletName,
          mint: t.mint,
          symbol: t.symbol,
          venue: t.venue,
          sol_amount: t.solAmount,
          token_amount: t.tokenAmount,
          price_sol: t.priceSol,
          priority_fee_sol: t.priorityFeeSol,
          jito_tip_sol: t.jitoTipSol,
          network_fee_sol: t.networkFeeSol,
          realized_pnl_sol: t.realizedPnlSol,
          signature: t.signature ?? null,
          bundle_id: t.bundleId ?? null,
        })),
      });
      batch.forEach((t) => synced.add(t.id));
    }
  };

  const run = async () => {
    if (busy) return;
    busy = true;
    const topics = [...dirty];
    dirty.clear();
    try {
      for (const t of topics) {
        if (t === "wallets") await syncWallets();
        else if (t === "settings") await syncSettings();
        else if (t === "trades") await syncTrades();
      }
      cloudStatus.lastBackupAt = Date.now();
    } catch (e) {
      topics.forEach((t) => dirty.add(t));
      if (cloudStatus.lastError !== (e as Error).message) log.warn("engine", `Supabase sync failed, will retry: ${(e as Error).message}`);
      cloudStatus.lastError = (e as Error).message;
    } finally {
      busy = false;
    }
  };

  bus.on("changed", (topic: string) => {
    if (topic === "wallets" || topic === "settings" || topic === "trades") dirty.add(topic);
  });
  setInterval(() => dirty.size && void run(), 5_000);
  void run();
  log.success("engine", "Supabase backup on: settings, wallets and trades are mirrored to your project");
}
