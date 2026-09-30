// Candidate codecs/read-only presentation. No accepted deployment or send path.
// An eventual spending adapter must authenticate RPC snapshots, PDAs and the
// deployed binary before using these values. This module alone grants no trust.
const specs = Object.freeze({
  131: 8,
  132: 7,
  133: 0,
  134: 0,
  135: 0,
  136: 0,
  137: 0,
  138: 1,
  139: 0,
  140: 0,
  141: 0,
  142: 0,
  143: 1,
  144: 1,
  145: 0,
  146: 0,
  147: 9,
  148: 0,
  149: 0,
  157: 1,
  159: 0,
  160: 6,
  161: 7,
  162: 8,
  163: 9,
  166: 8,
  167: 9,
});
const U64 = (1n << 64n) - 1n,
  SAT = 100_000_000_000n;
function uint(n) {
  if (typeof n !== "bigint" || n < 0n || n > U64) {
    throw Error("u64 required");
  }
  return n;
}
export const validCampaignWindowFlags = (flags) =>
  Number.isInteger(flags) &&
  ((flags >= 0 && flags <= 7) ||
    (flags >= 12 && flags <= 15) ||
    (flags >= 30 && flags <= 31) ||
    (flags >= 62 && flags <= 63));
export function campaignTariff(flags) {
  if (!validCampaignWindowFlags(flags)) {
    throw Error("campaign tariff flags");
  }
  const selected = (flags & 8) !== 0;
  return Object.freeze({
    version: selected ? 2 : 1,
    teamBps: selected ? 1000 : 2000,
    executionBps: 500,
    protocolBps: selected ? 8500 : 7500,
  });
}
export function campaignProceedsAllocation(gross, flags) {
  uint(gross);
  const tariff = campaignTariff(flags),
    teamLamports = gross / BigInt(tariff.version === 2 ? 10 : 5),
    executionLamports = gross / 20n;
  return Object.freeze({
    teamLamports,
    executionLamports,
    protocolLamports: gross - teamLamports - executionLamports,
  });
}
export function encodeCampaignCandidate(op, values = []) {
  if (!Object.hasOwn(specs, op) || values.length !== specs[op]) {
    throw Error("candidate instruction shape");
  }
  const out = new Uint8Array(1 + values.length * 8),
    v = new DataView(out.buffer);
  out[0] = op;
  values.forEach((n, i) => v.setBigUint64(1 + i * 8, uint(n), true));
  return out;
}
const ceil = (n, d) => (n + d - 1n) / d;
export const campaignNet = (g) => uint(g) - ceil(g * 300n, 10000n);
function bytes(record, program, magic, size) {
  if (
    record?.owner !== program ||
    record.executable !== false ||
    !Array.isArray(record.data) ||
    record.data.length !== size ||
    record.data.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    throw Error("candidate account identity");
  }
  const b = Uint8Array.from(record.data);
  if (new TextDecoder().decode(b.slice(0, 8)) !== magic || b[8] !== 1 || b[9] !== 0) {
    throw Error("candidate account version");
  }
  return {
    b,
    n: (at) => new DataView(b.buffer).getBigUint64(at, true),
    key: (at) => Array.from(b.slice(at, at + 32), (x) => x.toString(16).padStart(2, "0")).join(""),
  };
}
export function reviewCampaignCandidate({
  program,
  owner,
  window,
  position,
  receipt,
  now,
  positionRent,
}) {
  if (!/^[0-9a-f]{64}$/.test(program) || !/^[0-9a-f]{64}$/.test(owner)) {
    throw Error("candidate identity");
  }
  uint(now);
  uint(positionRent);
  const w = bytes(window, program, "WENRCMP2", 256),
    p = bytes(position, program, "WENRPOS2", 256),
    r = bytes(receipt, program, "WENRBUY2", 192);
  if (
    w.b[10] > 2 ||
    !validCampaignWindowFlags(w.b[11]) ||
    p.b[225] > 1 ||
    p.b[10] > 1 ||
    p.b[184] !== 0 ||
    r.b[10] < 1 ||
    r.b[10] > 4 ||
    r.b[136] !== 0 ||
    p.key(16) !== owner ||
    r.key(80) !== owner ||
    p.key(48) !== w.key(16) ||
    p.key(80) !== w.key(48) ||
    (r.b[10] === 1 && p.key(192) !== window.address) ||
    r.key(16) !== window.address ||
    r.key(48) !== position.address
  ) {
    throw Error("candidate account binding");
  }
  const maximum = r.n(112),
    day = r.n(144),
    cutoff = w.n(128),
    deadline = w.n(136),
    price = w.n(120);
  if (w.n(232) === 0n || w.n(248) > w.n(240)) {
    throw Error("candidate execution funding");
  }
  if (
    price === 0n ||
    cutoff >= deadline ||
    w.n(144) < cutoff ||
    w.n(144) >= deadline ||
    day !== cutoff / 86400n
  ) {
    throw Error("candidate terms");
  }
  const lamports = BigInt(position.lamports);
  uint(lamports);
  if (lamports < positionRent) {
    throw Error("candidate rent");
  }
  let gross = r.n(128),
    charge = r.n(120),
    status = "waiting";
  if (r.b[10] === 1) {
    gross = 0n;
    charge = 0n;
    if (w.b[10] === 1) {
      const demand = w.n(168),
        stock = w.n(152);
      if (w.n(216) !== w.n(224)) {
        throw Error("incomplete registered intent set");
      }
      if (demand > 0n) {
        gross = [(stock * maximum) / demand, (maximum * SAT) / price].reduce((a, b) =>
          a < b ? a : b,
        );
        if (campaignNet(gross) === 0n) {
          gross = 0n;
        }
        charge = ceil(campaignNet(gross) * price, SAT);
      }
      status = "purchase-committed";
    } else if (now >= deadline) {
      status = "timeout-recovery";
    } else if (now > w.n(144)) {
      status = "quote-expired";
    } else if (now >= cutoff) {
      status = w.n(216) === w.n(224) ? "ready-to-clear" : "incomplete-intents";
    }
  } else {
    status = { 2: "claimable", 3: "claimed", 4: "refunded" }[r.b[10]];
  }
  if (charge > maximum) {
    throw Error("candidate overspend");
  }
  return Object.freeze({
    candidate: true,
    spendingEnabled: false,
    status,
    standingOrder: p.b[225] === 1,
    windowMembershipSnapshot: (w.b[11] & 1) !== 0,
    fundedSource: (w.b[11] & 2) !== 0,
    proceedsTariff: campaignTariff(w.b[11]),
    expectedMembers: w.n(216),
    processedMembers: w.n(224),
    capitalAvailableLamports: lamports - positionRent,
    reservedLamports: r.b[10] === 1 ? maximum : 0n,
    purchaseLamports: charge,
    netSatRaw: campaignNet(gross),
    grossSatRaw: gross,
    unusedReservationLamports: maximum - charge,
    partialFills: true,
    executionJobFeeLamports: w.n(232),
    executionFloatLamports: w.n(240),
    reservedExecutionLamports: w.n(248),
    cutoff,
    deadline,
    quoteValidUntil: w.n(144),
    budgetUtcDay: day,
    cancellation:
      "Before cutoff: cancel and release. At cutoff: accepted clearing or deadline recovery. Committed claims never expire.",
    costBoundary:
      "Purchase amount excludes transaction fees and account rent. No non-fill acquisition charge.",
  });
}

// A session cost forecast is not a minimum-fill veto or promised profit.
export function campaignAdmissionTerms({
  maximumLamports,
  pricePerNetSat,
  referencePerNetSat,
  minimumBenefitLamports,
  incrementalCostLamports,
}) {
  for (const n of [
    maximumLamports,
    pricePerNetSat,
    referencePerNetSat,
    minimumBenefitLamports,
    incrementalCostLamports,
  ]) {
    uint(n);
  }
  if (maximumLamports === 0n || pricePerNetSat === 0n || referencePerNetSat <= pricePerNetSat) {
    return Object.freeze({ admitted: false, reason: "No positive quoted acquisition advantage" });
  }
  const gross = (maximumLamports * SAT) / pricePerNetSat;
  if (gross > U64) {
    throw Error("gross inventory exceeds u64");
  }
  const expectedBenefit =
    (campaignNet(gross) * referencePerNetSat) / SAT -
    ceil(campaignNet(gross) * pricePerNetSat, SAT) -
    incrementalCostLamports;
  return Object.freeze({
    admitted: expectedBenefit >= minimumBenefitLamports,
    partialFills: true,
    maximumReservedLamports: maximumLamports,
    sessionBenefitForecastLamports: expectedBenefit,
    claimReadinessTargetLamports: minimumBenefitLamports,
    minimumFillPercent: 0,
    warning:
      "Forecast assumes fills and quotes; actual partial fills have no minimum benefit guarantee. Small owned claims remain recoverable.",
  });
}
export function campaignClaimReadiness({
  executableNetValueLamports,
  acquisitionLamports,
  incrementalClaimLamports,
  targetLamports,
}) {
  for (const n of [
    executableNetValueLamports,
    acquisitionLamports,
    incrementalClaimLamports,
    targetLamports,
  ]) {
    uint(n);
  }
  const benefit = executableNetValueLamports - acquisitionLamports - incrementalClaimLamports;
  return Object.freeze({
    economical: benefit >= targetLamports,
    benefitLamports: benefit,
    ownerCanClaim: true,
    ownerSignatureRequired: true,
  });
}

// New income/reward wire domain: window identity precedes existing typed payload.
// This is a codec, not route admission or signing authorization.
export function encodeCampaignIncomeCandidate(op, window, payload) {
  if (
    !Number.isInteger(op) ||
    op < 150 ||
    op > 156 ||
    typeof window !== "string" ||
    !/^[0-9a-f]{64}$/.test(window) ||
    !(payload instanceof Uint8Array)
  ) {
    throw Error("campaign source wire");
  }
  const length = payload.length;
  if (
    (op === 150 && (length <= 33 || payload[32] > 1)) ||
    ([151, 152, 153, 155, 156].includes(op) && length !== 16) ||
    (op === 154 && length <= 8)
  ) {
    throw Error("campaign source payload");
  }
  const out = new Uint8Array(33 + length);
  out[0] = op;
  for (let i = 0; i < 32; i++) {
    out[i + 1] = Number.parseInt(window.slice(i * 2, i * 2 + 2), 16);
  }
  out.set(payload, 33);
  return out;
}

// Bounded batch: each selected slot retains its original vault and transfer fee.
export function encodeCampaignClaimBatch(mask) {
  if (
    !Number.isInteger(mask) ||
    mask < 1 ||
    mask > 255 ||
    mask.toString(2).replaceAll("0", "").length > 4
  ) {
    throw Error("claim mask must select one to four slots");
  }
  return Uint8Array.of(158, mask);
}
export function reviewCampaignClaimPage({ program, owner, position, page }) {
  if (!/^[0-9a-f]{64}$/.test(program) || !/^[0-9a-f]{64}$/.test(owner)) {
    throw Error("candidate identity");
  }
  const closed = page?.data?.length === 96;
  const p = bytes(position, program, "WENRPOS2", 256),
    c = bytes(page, program, closed ? "WENRCLS2" : "WENRCLM2", closed ? 96 : 576);
  if (closed && (c.b.slice(10, 16).some(Boolean) || c.b.slice(88).some(Boolean))) {
    throw Error("terminal claim page encoding");
  }
  if (p.key(16) !== owner || c.key(16) !== position.address) {
    throw Error("claim owner binding");
  }
  const claims = [];
  for (let slot = 0; slot < (closed ? 0 : 8); slot++) {
    const at = 128 + slot * 56,
      occupied = c.b[at + 48];
    if (occupied === 0) {
      if (c.b.slice(at, at + 56).some((x) => x !== 0)) {
        throw Error("dirty empty claim slot");
      }
      continue;
    }
    if (occupied !== 1 || c.b.slice(at + 49, at + 56).some((x) => x !== 0) || c.n(at + 32) === 0n) {
      throw Error("claim slot encoding");
    }
    claims.push(
      Object.freeze({
        slot,
        window: c.key(at),
        grossSatRaw: c.n(at + 32),
        netSatRaw: campaignNet(c.n(at + 32)),
        purchaseLamports: c.n(at + 40),
      }),
    );
  }
  return Object.freeze({
    candidate: true,
    spendingEnabled: false,
    ownerSignatureRequired: true,
    claims: Object.freeze(claims),
    netSatRaw: claims.reduce((sum, x) => sum + x.netSatRaw, 0n),
    purchaseLamports: claims.reduce((sum, x) => sum + x.purchaseLamports, 0n),
    pageState: closed ? "closed" : "active",
    pageIndex: c.n(80),
    rentBeneficiary: c.key(48),
    maximumClaimsPerInstruction: 4,
    validationBoundary:
      "Read-only decoding; authenticate account PDAs, vaults and deployment before signing.",
  });
}
