import { bindDescriptor } from "./descriptor.mjs";
const valid = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .toSorted()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const json = (v) => JSON.stringify(canonical(v));
const hash = async (v) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json(v)))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
// Separate from reservation admission. No owner impersonation or arbitrary CPI.
export async function portfolioMiningFundingHandoff(vector, sourceDigest, contractDigest) {
  if (
    !valid(sourceDigest) ||
    !valid(contractDigest) ||
    vector?.name !== "fundMining" ||
    !Array.isArray(vector.data) ||
    vector.data.length !== 1 ||
    vector.data[0] !== 120 ||
    !Array.isArray(vector.accounts) ||
    vector.accounts.length !== 6
  ) {
    throw Error("unsupported mining funding vector");
  }
  const roles = ["vault", "action", "owner", "sale", "miningBudget", "miningCapital"];
  if (
    vector.accounts.some(
      (a, i) => a.role !== roles[i] || a.signer !== false || a.writable !== [0, 1, 5].includes(i),
    )
  ) {
    throw Error("unsupported mining funding accounts");
  }
  const instruction = {
    opcode: 120,
    dataLength: 1,
    accounts: vector.accounts.map((a) => ({
      role: a.role,
      signer: a.signer,
      writable: a.writable,
    })),
  };
  const h = {
    schema: "wen.portfolio-mining-funding-handoff.v1",
    requiredFeature: "portfolio-vault-candidate",
    operations: ["fundMining"],
    portableClient: "client/portfolio-mining-funding-preparation.mjs",
    sourceDigest,
    contractDigest,
    instruction,
  };
  return Object.freeze({ ...h, capabilityDigest: await hash(h) });
}
export async function bindPortfolioMiningFundingDescriptor(bytes, pin, expectedCapability) {
  const d = await bindDescriptor(bytes, pin),
    h = d.interfaces.portfolioMiningFundingHandoff;
  if (
    !valid(expectedCapability) ||
    !h ||
    h.sourceDigest !== d.source.sourceDigest ||
    h.contractDigest !== d.interfaces.contractDigest ||
    d.build.candidateFeatures?.["portfolio-vault-candidate"] !== true
  ) {
    throw Error("mining funding feature not bound");
  }
  const expected = await portfolioMiningFundingHandoff(
    { name: "fundMining", data: [h.instruction?.opcode], accounts: h.instruction?.accounts },
    h.sourceDigest,
    h.contractDigest,
  );
  if (
    json(h) !== json(expected) ||
    h.capabilityDigest !== expectedCapability ||
    d.componentGenerations.portfolioMiningFundingCapability !== expectedCapability ||
    d.runtimeCompatibility.status !== "BOUND" ||
    d.runtimeCompatibility.portfolioMiningFundingCapability !== expectedCapability
  ) {
    throw Error("mining funding capability not acknowledged");
  }
  return d;
}
