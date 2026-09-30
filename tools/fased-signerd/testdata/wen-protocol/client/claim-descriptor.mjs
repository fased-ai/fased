import { bindDescriptor } from "./descriptor.mjs";

// Configuration preflight only: does not replace live ProgramData/account checks
// or grant signer permission. The expected capability comes from the consumer's
// generated acknowledgement, never from the descriptor service itself.
export async function bindOwnerClaimDescriptor(bytes, pin, expectedCapability) {
  const descriptor = await bindDescriptor(bytes, pin);
  const handoff = descriptor.interfaces.ownerClaimHandoff;
  const digest = async (value) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const validHash = (h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
  if (
    !validHash(expectedCapability) ||
    !handoff ||
    handoff.schema !== "wen.owner-claim-handoff-candidate.v1" ||
    handoff.operation !== "native-staking-claim" ||
    !validHash(handoff.sourceDigest) ||
    !validHash(handoff.contractDigest) ||
    descriptor.source.sourceDigest !== handoff.sourceDigest ||
    descriptor.interfaces.contractDigest !== handoff.contractDigest ||
    handoff.portableClient !== "client/staking-claim-client.mjs"
  ) {
    throw new Error("missing or mismatched successor claim binding");
  }
  const i = handoff.instruction;
  if (
    !i ||
    i.name !== "staking_release::claim_instruction" ||
    i.opcode !== 42 ||
    i.dataLength !== 17 ||
    !Array.isArray(i.accounts) ||
    i.accounts.length !== 13 ||
    i.accounts.some(
      (a, n) => a.signer !== (n === 0) || a.writable !== [0, 4, 7, 8, 9].includes(n),
    ) ||
    (await digest(i)) !== handoff.instructionDigest
  ) {
    throw new Error("invalid successor claim instruction");
  }
  const capability = await digest({
    operation: handoff.operation,
    instructionDigest: handoff.instructionDigest,
    paidLayout: handoff.paidLayout,
    sourceDigest: handoff.sourceDigest,
    contractDigest: handoff.contractDigest,
    portableClient: handoff.portableClient,
  });
  if (
    capability !== expectedCapability ||
    handoff.capabilityDigest !== capability ||
    descriptor.componentGenerations.ownerClaimCapability !== capability ||
    descriptor.runtimeCompatibility.status !== "BOUND" ||
    descriptor.runtimeCompatibility.ownerClaimCapability !== capability
  ) {
    throw new Error("successor claim capability not acknowledged");
  }
  return descriptor;
}
