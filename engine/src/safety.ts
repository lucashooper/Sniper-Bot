import { PublicKey } from "@solana/web3.js";
import { ExtensionType, getExtensionTypes, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { bondingCurvePda } from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import { log } from "./bus.js";
import { getSettings } from "./settings.js";
import { connection } from "./solana.js";
import { isSimMint, simCoin } from "./sim.js";

export interface SafetyCheck {
  name: string;
  pass: boolean;
  detail: string;
}
export interface SafetyReport {
  mint: string;
  ok: boolean;
  checks: SafetyCheck[];
}

// Token-2022 extensions that let the issuer block, claw back or tax sells: the practical "honeypot" vectors.
const DANGEROUS: Partial<Record<ExtensionType, string>> = {
  [ExtensionType.TransferHook]: "transfer hook (arbitrary program runs on every transfer)",
  [ExtensionType.PermanentDelegate]: "permanent delegate (issuer can move or burn your tokens)",
  [ExtensionType.NonTransferable]: "non-transferable",
  [ExtensionType.DefaultAccountState]: "default account state (new accounts can start frozen)",
};

/**
 * Pre-trade screen. Pump.fun curve coins always pass the authority checks (the program revokes both at create),
 * so these matter most for arbitrary mints and for PumpSwap coins created with Token-2022.
 */
export async function checkMint(mintStr: string): Promise<SafetyReport> {
  const s = getSettings().safety;
  if (isSimMint(mintStr)) {
    const c = simCoin(mintStr)!;
    return {
      mint: mintStr,
      ok: true,
      checks: [
        { name: "Mint authority", pass: true, detail: "revoked (simulated coin)" },
        { name: "Freeze authority", pass: true, detail: "revoked (simulated coin)" },
        { name: "Creator", pass: true, detail: c.creator },
      ],
    };
  }
  const mint = new PublicKey(mintStr);
  const conn = connection();
  const info = await conn.getAccountInfo(mint);
  if (!info) return { mint: mintStr, ok: false, checks: [{ name: "Mint exists", pass: false, detail: "account not found" }] };
  const m = unpackMint(mint, info, info.owner);
  const checks: SafetyCheck[] = [];

  checks.push({
    name: "Mint authority",
    pass: !s.requireMintAuthorityRevoked || m.mintAuthority === null,
    detail: m.mintAuthority ? `active: ${m.mintAuthority.toBase58()}` : "revoked",
  });
  checks.push({
    name: "Freeze authority",
    pass: !s.requireFreezeAuthorityRevoked || m.freezeAuthority === null,
    detail: m.freezeAuthority ? `active: ${m.freezeAuthority.toBase58()}` : "revoked",
  });

  if (m.tlvData.length > 0) {
    const exts = getExtensionTypes(m.tlvData);
    const bad = exts.filter((e) => DANGEROUS[e]).map((e) => DANGEROUS[e]!);
    const fee = getTransferFeeConfig(m);
    const feeBps = fee ? fee.newerTransferFee.transferFeeBasisPoints : 0;
    if (feeBps > 100) bad.push(`transfer fee ${feeBps / 100}%`);
    checks.push({
      name: "Token-2022 extensions",
      pass: !s.rejectDangerousExtensions || bad.length === 0,
      detail: bad.length ? bad.join(", ") : `${exts.length} extension(s), none dangerous`,
    });
  }

  if (s.maxTopHolderPct > 0) {
    try {
      const largest = await conn.getTokenLargestAccounts(mint);
      const owners = await conn.getMultipleParsedAccounts(largest.value.slice(0, 6).map((a) => a.address));
      const excluded = new Set([bondingCurvePda(mint).toBase58(), canonicalPumpPoolPda(mint).toBase58()]);
      const supply = Number(m.supply);
      let top = 0;
      let topOwner = "";
      largest.value.slice(0, 6).forEach((a, i) => {
        const data = owners.value[i]?.data;
        const owner = data && "parsed" in data ? (data.parsed.info.owner as string) : "";
        if (excluded.has(owner)) return;
        const pct = supply ? (Number(a.amount) / supply) * 100 : 0;
        if (pct > top) [top, topOwner] = [pct, owner];
      });
      checks.push({
        name: "Top holder",
        pass: top <= s.maxTopHolderPct,
        detail: topOwner ? `${top.toFixed(1)}% held by ${topOwner.slice(0, 4)}…${topOwner.slice(-4)}` : "no concentrated holder",
      });
    } catch (e) {
      checks.push({ name: "Top holder", pass: true, detail: `skipped: ${(e as Error).message}` });
    }
  }

  const ok = checks.every((c) => c.pass);
  const failed = checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
  if (ok) log.success("safety", `Checks passed for ${mintStr.slice(0, 6)}…`, { mint: mintStr });
  else log.warn("safety", `Blocked ${mintStr.slice(0, 6)}…: ${failed.join("; ")}`, { mint: mintStr });
  return { mint: mintStr, ok, checks };
}
