import { createHash } from "node:crypto";
import { SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT } from "../../../src/mining/sat-vnext-release-contract.generated.js";
import { SAT_VNEXT_ACTIVATION } from "./vnext-activation-manifest.js";

export type SatMiningCluster = "local" | "devnet" | "mainnet-beta";

export type SatMiningStateIdentity = {
  cluster: SatMiningCluster;
  programId: string;
  protocolGeneration: string;
  walletId: string;
};

export function resolveSatRuntimeProtocolGeneration(
  release: {
    state: string;
    interfaceContractSha256: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    SAT_VNEXT_ACTIVATION.state !== "ACTIVE" ||
    SAT_VNEXT_ACTIVATION.interfaceContractSha256 !== release.interfaceContractSha256
  ) {
    return "sat-v2";
  }
  const exactDeployment =
    String(env.FASED_SAT_DEPLOYMENT_ID ?? "").trim() === SAT_VNEXT_ACTIVATION.deploymentId &&
    String(env.FASED_SAT_PROGRAM_ID ?? "").trim() ===
      SAT_VNEXT_ACTIVATION.programs.mining.programId &&
    String(env.FASED_SAT_MINT_PROGRAM_ID ?? "").trim() ===
      SAT_VNEXT_ACTIVATION.programs.mint.programId &&
    String(env.FASED_SAT_BOND_PROGRAM_ID ?? "").trim() ===
      SAT_VNEXT_ACTIVATION.programs.bond.programId &&
    String(env.FASED_SAT_MINT_ADDRESS ?? "").trim() === SAT_VNEXT_ACTIVATION.satMint;
  return exactDeployment ? release.interfaceContractSha256 : "sat-v2";
}

export function assertSatVNextRuntimeBinding(
  network: SatMiningCluster,
  env: NodeJS.ProcessEnv,
): void {
  if (SAT_RUNTIME_PROTOCOL_GENERATION === "sat-v2") return;
  if (
    network !== SAT_VNEXT_ACTIVATION.cluster ||
    resolveSatRuntimeProtocolGeneration(SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT, env) === "sat-v2"
  ) {
    throw new Error(
      "SAT generation 2 requires the exact active SAT-DEP-0011 Devnet contract and complete runtime ID tuple",
    );
  }
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
