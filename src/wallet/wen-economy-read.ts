// Read-only WEN v1 snapshot consumer. The local endpoint is an information
// source, never a wallet, quote, NAV oracle or signing authority.
export type WenEconomyReadPin = {
  economy: string;
  genesis: string;
  program: string;
  mint: string;
  deployedBytesHash: string;
  deploymentSlot: string;
  upgradeAuthority: string | null;
};

type EconomyRow =
  | { id: string; status: "unavailable"; value: null; reason: string }
  | {
      id: string;
      status: "reported";
      value: string;
      unit: string;
      evidence: string;
      source: string;
      scope: string;
      observedAtMs: number;
    };

const required = ["issuedSupply", "unmintedObligations", "protocolAsset", "economicNav"];
// Exact v1 field vocabulary from WEN's economy-factsheet contract. A new field
// needs an explicit consumer review before an agent can treat it as a fact.
const knownRows = new Set(
  "usdBacking protocolAsset protocolAssetCustodyCoverage protocolAssetSourceCoverage issuedSupply unmintedObligations otherLiabilities coveredAssetPaid coveredAssetRewards coveredPendingRewardCash coveredFallbackCash coveredFallbackPaid coveredInventoryUnpaid coveredInventoryDelivered coveredInventoryNetPaid coveredNativeUnminted coveredNativeUnpaid participantClaims stakingCustody monetaryBacking economicNav exitAllocatedCash exitCapacity liquidity ownedLpUnits ownedLpBacking treasuryBooked treasuryReserved mandatoryCash cashAfterObligations cashCoverageDeficit programUpgradeAuthority authority".split(
    " ",
  ),
);
const incomplete = new Set([
  "usdBacking",
  "otherLiabilities",
  "participantClaims",
  "monetaryBacking",
  "economicNav",
  "authority",
]);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export async function readWenEconomyLocal(input: {
  url: string;
  pin: WenEconomyReadPin;
  fetcher?: typeof fetch;
  nowMs?: number;
  maxAgeMs?: number;
}) {
  const url = new URL(input.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/api/v1/economies/sat-v1/factsheet" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw Error("WEN local read endpoint required");
  }
  const maxAgeMs = input.maxAgeMs ?? 60000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60000) {
    throw Error("Invalid WEN read clock");
  }
  const pin = structuredClone(input.pin);
  if (
    ![
      pin.economy,
      pin.genesis,
      pin.program,
      pin.mint,
      pin.deployedBytesHash,
      pin.deploymentSlot,
    ].every(nonempty) ||
    !/^[a-f0-9]{64}$/.test(pin.deployedBytesHash) ||
    !/^(0|[1-9][0-9]*)$/.test(pin.deploymentSlot) ||
    (pin.upgradeAuthority !== null && !nonempty(pin.upgradeAuthority))
  ) {
    throw Error("Invalid WEN read pin");
  }
  const response = await (input.fetcher ?? fetch)(url, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok || !response.body) {
    throw Error("WEN read unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > 65536) {
        throw Error("WEN read response too large");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const data = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw Error("Invalid WEN read clock");
  }
  const identity = data.identity as Record<string, unknown> | undefined;
  const deployment = data.deployment as Record<string, unknown> | undefined;
  if (
    data.schema !== "wen.economy.read.v1" ||
    data.mode !== "local-devnet-read-only" ||
    data.signingEnabled !== false ||
    ["economy", "genesis", "program", "mint"].some(
      (key) => identity?.[key] !== pin[key as keyof WenEconomyReadPin],
    ) ||
    ["deployedBytesHash", "deploymentSlot", "upgradeAuthority"].some(
      (key) => deployment?.[key] !== pin[key as keyof WenEconomyReadPin],
    ) ||
    typeof data.slot !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(data.slot) ||
    BigInt(data.slot) < BigInt(pin.deploymentSlot) ||
    !Number.isSafeInteger(data.observedAtMs) ||
    (data.observedAtMs as number) < 0 ||
    (data.observedAtMs as number) > nowMs ||
    nowMs - (data.observedAtMs as number) > maxAgeMs ||
    !Array.isArray(data.rows) ||
    data.rows.length === 0 ||
    data.rows.length > 40
  ) {
    throw Error("Invalid WEN read snapshot");
  }
  const rows = data.rows as EconomyRow[];
  const seen = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9]{1,48}$/.test(row.id) ||
      !knownRows.has(row.id) ||
      seen.has(row.id)
    ) {
      throw Error("Invalid WEN read row");
    }
    seen.add(row.id);
    if (row.status === "unavailable") {
      if (row.value !== null || !nonempty(row.reason)) {
        throw Error("Invalid unavailable WEN value");
      }
    } else if (row.status === "reported") {
      if (
        incomplete.has(row.id) ||
        ![row.value, row.unit, row.evidence, row.source, row.scope].every(nonempty) ||
        !["onchain", "attestation", "estimate"].includes(row.evidence) ||
        !Number.isSafeInteger(row.observedAtMs) ||
        row.observedAtMs < 0 ||
        row.observedAtMs > (data.observedAtMs as number) ||
        row.observedAtMs > nowMs ||
        nowMs - row.observedAtMs > maxAgeMs
      ) {
        throw Error("Invalid reported WEN value");
      }
    } else {
      throw Error("Invalid WEN read status");
    }
  }
  if (required.some((id) => !seen.has(id))) {
    throw Error("Incomplete WEN read contract");
  }
  return Object.freeze({
    identity: pin,
    slot: data.slot,
    observedAtMs: data.observedAtMs as number,
    expiresAtMs:
      Math.min(
        data.observedAtMs as number,
        ...rows.flatMap((row) => (row.status === "reported" ? [row.observedAtMs] : [])),
      ) +
      maxAgeMs +
      1,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    signingEnabled: false as const,
  });
}
