import crypto from "node:crypto";
import { bus, log } from "./bus.js";
import { loadJson, saveJson } from "./store.js";
import { generateWallet, getWallet, listWallets } from "./wallets.js";

/**
 * A named set of wallets ("preset"). Groups drive funding, sweeping and selling across several wallets at once.
 * Buys always come from a single wallet; a group never fans one buy out across its members.
 */
export interface WalletGroup {
  id: string;
  name: string;
  walletIds: string[];
  createdAt: number;
}

let groups: WalletGroup[] = loadJson<WalletGroup[]>("groups.json", []);
const persist = () => {
  saveJson("groups.json", groups);
  bus.changed("wallets");
};

/** Drops ids of wallets that no longer exist, so a removed wallet never lingers in a group. */
export function listGroups(): WalletGroup[] {
  const known = new Set(listWallets().map((w) => w.id));
  return groups.map((g) => ({ ...g, walletIds: g.walletIds.filter((id) => known.has(id)) }));
}

export function getGroup(id: string): WalletGroup {
  const g = listGroups().find((x) => x.id === id);
  if (!g) throw new Error("Unknown wallet group");
  return g;
}

function cleanIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out = [...new Set(ids.map(String))];
  for (const id of out) if (!getWallet(id)) throw new Error(`Unknown wallet ${id}`);
  return out;
}

function cleanName(name: unknown) {
  const n = String(name ?? "").trim().slice(0, 40);
  if (!n) throw new Error("Give the group a name");
  return n;
}

export function createGroup(name: unknown, walletIds: unknown = []): WalletGroup {
  const g: WalletGroup = { id: crypto.randomUUID(), name: cleanName(name), walletIds: cleanIds(walletIds), createdAt: Date.now() };
  groups.push(g);
  persist();
  log.info("wallet", `Created group ${g.name} with ${g.walletIds.length} wallet(s)`);
  return g;
}

export function updateGroup(id: string, patch: { name?: unknown; walletIds?: unknown }): WalletGroup {
  const g = groups.find((x) => x.id === id);
  if (!g) throw new Error("Unknown wallet group");
  if (patch.name !== undefined) g.name = cleanName(patch.name);
  if (patch.walletIds !== undefined) g.walletIds = cleanIds(patch.walletIds);
  persist();
  return getGroup(id);
}

export function removeGroup(id: string) {
  const g = groups.find((x) => x.id === id);
  if (!g) return;
  groups = groups.filter((x) => x.id !== id);
  persist();
  log.info("wallet", `Deleted group ${g.name}; its wallets are kept`);
}

/** Generates `count` fresh wallets and adds them to the group, named after it ("Snipers 1", "Snipers 2", ...). */
export function generateIntoGroup(id: string, count: number): WalletGroup {
  const g = groups.find((x) => x.id === id);
  if (!g) throw new Error("Unknown wallet group");
  const n = Math.floor(Number(count));
  if (!(n >= 1 && n <= 20)) throw new Error("Generate between 1 and 20 wallets at a time");
  const start = g.walletIds.length;
  for (let i = 1; i <= n; i++) g.walletIds.push(generateWallet(`${g.name} ${start + i}`).id);
  persist();
  return getGroup(id);
}
