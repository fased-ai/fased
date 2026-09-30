import { validateRewardCohort } from "./btc-readback.mjs";
import { validateStakingAccount } from "./staking-accounts.mjs";
import {
  validateNativeReleaseRecords,
  deriveNativeReleaseAccounts,
} from "./staking-release-readback.mjs";
// Historical entitlement only. Custody, activation, mint, destination and coherent
// finalized RPC still gate any transaction. No signing or claim-ready flag.
export async function validateNativeClaimEntitlement(sdk, records, identity) {
  const r = structuredClone(records),
    id = structuredClone(identity);
  for (const f of ["program", "sale", "policy", "owner"]) {
    sdk.assertIsAddress(id[f]);
  }
  for (const f of ["award", "from", "now"]) {
    if (typeof id[f] !== "bigint" || id[f] < 0n || id[f] > 0xffffffffffffffffn) {
      throw new Error("invalid claim time");
    }
  }
  const day = id.award / 3n;
  if (id.now / 86400n <= day || id.from > day) {
    throw new Error("claim day not eligible");
  }
  const linked = await validateNativeReleaseRecords(sdk, r, id);
  if (!linked.authorizationComplete || linked.release.lastRelease > id.now / 28800n) {
    throw new Error("incomplete or future release");
  }
  const eligible = await validateRewardCohort(sdk, r.cohort, { ...id, day });
  const enc = sdk.getAddressEncoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, id.from, true);
  const [history, bump] = await sdk.getProgramDerivedAddress({
    programAddress: id.program,
    seeds: ["wen-stake-history-v1", enc.encode(id.sale), enc.encode(id.owner), bytes],
  });
  const interval = validateStakingAccount("history", r.history, {
    address: hex(history),
    program: hex(id.program),
    sale: hex(id.sale),
    owner: hex(id.owner),
    from: id.from,
    bump,
  });
  if (day >= interval.until || interval.weight === 0n || interval.weight > eligible) {
    throw new Error("invalid historical claim weight");
  }
  const pdas = await deriveNativeReleaseAccounts(sdk, id);
  const [claim] = await sdk.getProgramDerivedAddress({
    programAddress: id.program,
    seeds: ["wen-native-stake-claim-v1", enc.encode(pdas.source), enc.encode(id.owner)],
  });
  // Caller must supply an explicit absent account, not omit the read.
  if (r.claim !== null) {
    throw new Error("claim already exists or was not read");
  }
  const gross = (linked.release.amount * interval.weight) / eligible;
  if (gross === 0n || gross > linked.release.unpaid) {
    throw new Error("insufficient unpaid release");
  }
  return Object.freeze({
    gross,
    eligibleWeight: eligible,
    ownerWeight: interval.weight,
    day,
    claimAddress: claim,
    unpaid: linked.release.unpaid,
  });
}
