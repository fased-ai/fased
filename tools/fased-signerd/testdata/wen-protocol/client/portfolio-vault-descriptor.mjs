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
const hash = async (v) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(v)))),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
// Reservation only: this acknowledgement does not admit payment, withdrawals,
// arbitrary instructions or any automatic/delegated signer.
export async function portfolioReservationHandoff(vector, sourceDigest, contractDigest) {
  if (
    !valid(sourceDigest) ||
    !valid(contractDigest) ||
    vector?.name !== "reserve" ||
    !Array.isArray(vector.data) ||
    vector.data.length !== 33 ||
    vector.data[0] !== 116 ||
    !Array.isArray(vector.accounts) ||
    vector.accounts.length !== 4
  ) {
    throw Error("unsupported vault reservation vector");
  }
  const roles = ["owner", "vault", "action", "systemProgram"];
  if (
    vector.accounts.some(
      (a, i) => a.role !== roles[i] || a.signer !== (i === 0) || a.writable !== i < 3,
    )
  ) {
    throw Error("unsupported vault reservation accounts");
  }
  const instruction = {
    opcode: 116,
    dataLength: 33,
    accounts: vector.accounts.map((a) => ({
      role: a.role,
      signer: a.signer,
      writable: a.writable,
    })),
  };
  const h = {
    schema: "wen.portfolio-reservation-handoff.v1",
    requiredFeature: "portfolio-vault-candidate",
    operations: ["reserve"],
    portableClient: "client/portfolio-vault-preparation.mjs",
    sourceDigest,
    contractDigest,
    instruction,
  };
  return Object.freeze({ ...h, capabilityDigest: await hash(h) });
}
export async function bindPortfolioReservationDescriptor(bytes, pin, expectedCapability) {
  const d = await bindDescriptor(bytes, pin),
    h = d.interfaces.portfolioReservationHandoff;
  if (
    !valid(expectedCapability) ||
    !h ||
    h.schema !== "wen.portfolio-reservation-handoff.v1" ||
    h.requiredFeature !== "portfolio-vault-candidate" ||
    h.portableClient !== "client/portfolio-vault-preparation.mjs" ||
    JSON.stringify(h.operations) !== '["reserve"]' ||
    h.sourceDigest !== d.source.sourceDigest ||
    h.contractDigest !== d.interfaces.contractDigest ||
    d.build.candidateFeatures?.["portfolio-vault-candidate"] !== true
  ) {
    throw Error("vault reservation feature not bound");
  }
  const vector = {
    name: "reserve",
    data: [h.instruction?.opcode, ...Array(32).fill(0)],
    accounts: h.instruction?.accounts,
  };
  const expected = await portfolioReservationHandoff(vector, h.sourceDigest, h.contractDigest);
  if (
    h.instruction.dataLength !== 33 ||
    JSON.stringify(canonical(h)) !== JSON.stringify(canonical(expected)) ||
    h.capabilityDigest !== expectedCapability ||
    d.componentGenerations.portfolioReservationCapability !== expectedCapability ||
    d.runtimeCompatibility.status !== "BOUND" ||
    d.runtimeCompatibility.portfolioReservationCapability !== expectedCapability
  ) {
    throw Error("vault reservation capability not acknowledged");
  }
  return d;
}
