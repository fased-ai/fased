import { bindDescriptor } from "./descriptor.mjs";
// This operation needs its own acknowledgement. Native mint claims cannot admit it.
export async function bindInventoryClaimDescriptor(bytes, pin, capability, awardVersion = 1) {
  if (![1, 2].includes(awardVersion)) {
    throw Error("invalid inventory award capability version");
  }
  const d = await bindDescriptor(bytes, pin),
    h = d.interfaces.inventoryClaimHandoff;
  const hash = async (x) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(x))),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (
    !h ||
    h.schema !== "wen.inventory-claim-handoff.v1" ||
    h.operation !== "inventory-staking-claim" ||
    h.portableClient !== "client/staking-claim-client.mjs" ||
    !digest(h.sourceDigest) ||
    !digest(h.contractDigest) ||
    d.source.sourceDigest !== h.sourceDigest ||
    d.interfaces.contractDigest !== h.contractDigest
  ) {
    throw Error("inventory claim handoff missing");
  }
  const i = h.instruction;
  if (
    i?.opcode !== 103 ||
    i.dataLength !== 57 ||
    i.accounts?.length !== (awardVersion === 2 ? 15 : 13) ||
    i.accounts.some(
      (a, n) => a.signer !== (n === 0) || a.writable !== [0, 3, 4, 7, 8, 9, 13, 14].includes(n),
    ) ||
    h.instructionDigest !== (await hash(i))
  ) {
    throw Error("inventory claim instruction mismatch");
  }
  const actual = await hash({
    operation: h.operation,
    instructionDigest: h.instructionDigest,
    sourceDigest: h.sourceDigest,
    contractDigest: h.contractDigest,
    portableClient: h.portableClient,
  });
  if (
    !digest(capability) ||
    actual !== capability ||
    h.capabilityDigest !== actual ||
    d.componentGenerations.inventoryClaimCapability !== actual ||
    d.runtimeCompatibility.status !== "BOUND" ||
    d.runtimeCompatibility.inventoryClaimCapability !== actual
  ) {
    throw Error("inventory claim capability mismatch");
  }
  return d;
}
