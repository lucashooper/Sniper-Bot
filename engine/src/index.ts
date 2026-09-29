import { env, hasRpc } from "./config.js";
import { log } from "./bus.js";
import { startEngine } from "./engine.js";
import { initKeystore } from "./keystore.js";
import { refreshTipAccounts } from "./jito.js";
import { startServer } from "./server.js";
import { getSettings, updateSettings } from "./settings.js";
import { startSimMarket } from "./sim.js";
import { startStream } from "./stream.js";
import { refreshBalances } from "./walletOps.js";

async function main() {
  const ks = initKeystore();
  if (ks === "locked") log.warn("engine", "KEYSTORE_PASSPHRASE not set: wallets cannot be added or used. Paper trading still works.");
  else log.success("engine", "Keystore unlocked (AES-256-GCM, scrypt key)");

  if (!env.allowLive && !getSettings().simulation) updateSettings({ simulation: true });
  if (!env.allowLive) log.info("engine", "ALLOW_LIVE_TRADING is off: engine is locked to simulation mode");

  startEngine();
  startServer();

  if (hasRpc()) {
    startStream();
    void refreshTipAccounts();
    void refreshBalances();
    setInterval(() => void refreshBalances(), 20_000);
  } else {
    log.warn("engine", "SOLANA_RPC_URL not set: running the synthetic market so you can try the bot end to end");
    startSimMarket();
  }
}

main().catch((e) => {
  log.error("engine", (e as Error).message);
  process.exit(1);
});
