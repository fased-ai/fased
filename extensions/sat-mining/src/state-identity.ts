import { createHash } from "node:crypto";
import { SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT } from "../../../src/mining/sat-vnext-release-contract.generated.js";

export type SatMiningCluster = "local" | "devnet" | "mainnet-beta";

export type SatMiningStateIdentity = {
  cluster: SatMiningCluster;
  programId: string;
  protocolGeneration: string;
  walletId: string;
};

export function resolveSatRuntimeProtocolGeneration(release: {
  state: string;
  interfaceContractSha256: string;
}): string {
  return release.state === "ACTIVE" ? release.interfaceContractSha256 : "sat-v2";
}

export const SAT_RUNTIME_PROTOCOL_GENERATION = resolveSatRuntimeProtocolGeneration(
  SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT,
);

function requireIdentityPart(value: string, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`SAT Mining state identity requires a valid ${label}`);
  }
  return normalized;
}

export function normalizeSatMiningStateIdentity(
  identity: SatMiningStateIdentity,
): SatMiningStateIdentity {
  const cluster = requireIdentityPart(identity.cluster, "cluster");
  if (cluster !== "local" && cluster !== "devnet" && cluster !== "mainnet-beta") {
    throw new Error(`SAT Mining state identity has unsupported cluster ${cluster}`);
  }
  return {
    cluster,
    programId: requireIdentityPart(identity.programId, "program ID"),
    protocolGeneration: requireIdentityPart(identity.protocolGeneration, "protocol generation"),
    walletId: requireIdentityPart(identity.walletId, "Wallet ID"),
  };
}

export function satMiningStateIdentityKey(identity: SatMiningStateIdentity): string {
  const normalized = normalizeSatMiningStateIdentity(identity);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "fased-sat-mining-state-identity-v1",
        normalized.cluster,
        normalized.programId,
        normalized.protocolGeneration,
        normalized.walletId,
      ]),
    )
    .digest("hex");
}

export function assertSatMiningStateIdentity(
  expected: SatMiningStateIdentity,
  received: SatMiningStateIdentity,
): void {
  const expectedKey = satMiningStateIdentityKey(expected);
  const receivedKey = satMiningStateIdentityKey(received);
  if (expectedKey !== receivedKey) {
    throw new Error(
      "SAT Mining state identity mismatch across cluster, program ID, protocol generation, or Wallet",
    );
  }
}
