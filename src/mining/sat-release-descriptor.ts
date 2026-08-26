import { createHash } from "node:crypto";
import type { SatRuntimeIds } from "../config/sat-runtime-ids.js";
import { compareFasedAgentVersions } from "../config/version.js";
import { SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT } from "./sat-vnext-release-contract.generated.js";

export type SatReleaseAcknowledgement = {
  schema: string;
  state: string;
  componentGenerations: {
    bond: string;
    cycle: string;
    economics: string;
    penalty: string;
    schema: string;
    signerCapability: string;
  };
  interfaceContractSha256: string;
  idlSha256: string;
  accountOrderSha256: string;
  stateLayoutsSha256: string;
  signerCodecsSha256: string;
};

export type VerifiedSatReleaseDescriptor = {
  descriptorDigest: string;
  sourceCommit: string;
};

type RecordValue = Record<string, unknown>;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_ID_PATTERN = /^[0-9a-f]{40}$/u;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function fail(message: string): never {
  throw new Error(`SAT release descriptor is not complete: ${message}`);
}

function requireRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    fail(`${label} is missing`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} is missing`);
  }
  return value.trim();
}

function requireBound(value: unknown, label: string): RecordValue {
  const record = requireRecord(value, label);
  if (record.status !== "BOUND") {
    fail(`${label} is not BOUND`);
  }
  return record;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!SHA256_PATTERN.test(digest)) {
    fail(`${label} is not a SHA-256 digest`);
  }
  return digest;
}

function requireSolanaAddress(value: unknown, label: string): string {
  const address = requireString(value, label);
  if (!SOLANA_ADDRESS_PATTERN.test(address)) {
    fail(`${label} is not a Solana address`);
  }
  return address;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function verifyDeployment(deployment: RecordValue, ids: SatRuntimeIds): void {
  if (deployment.commitment !== "finalized") {
    fail("deployment commitment is not finalized");
  }
  if (!Array.isArray(deployment.programs) || deployment.programs.length !== 3) {
    fail("deployment must contain exactly three programs");
  }
  const expected = new Map([
    ["mining", ids.programId],
    ["mint", ids.mintProgramId],
    ["bond", ids.bondProgramId],
  ]);
  const observed = new Set<string>();
  for (const value of deployment.programs) {
    const program = requireRecord(value, "deployment program");
    const role = requireString(program.role, "deployment program role");
    const expectedProgramId = expected.get(role);
    if (!expectedProgramId || observed.has(role)) {
      fail(`deployment program role ${role} is invalid`);
    }
    observed.add(role);
    if (requireSolanaAddress(program.programId, `${role} program ID`) !== expectedProgramId) {
      fail(`${role} program ID does not match the signed address manifest`);
    }
    requireSolanaAddress(program.programDataAddress, `${role} ProgramData address`);
    if (!Number.isSafeInteger(program.deploymentSlot) || Number(program.deploymentSlot) < 1) {
      fail(`${role} deployment slot is invalid`);
    }
    requireSha256(program.deployedByteSha256, `${role} deployed-byte digest`);
    if (!Object.hasOwn(program, "upgradeAuthority")) {
      fail(`${role} upgrade authority is missing`);
    }
    if (program.upgradeAuthority !== null) {
      requireSolanaAddress(program.upgradeAuthority, `${role} upgrade authority`);
    }
  }
}

export function verifySatReleaseDescriptor(params: {
  descriptor: unknown;
  officialIds: SatRuntimeIds;
  manifestSourceCommit: string;
  currentFasedVersion: string;
  signerAcknowledgement: unknown;
}): VerifiedSatReleaseDescriptor {
  const descriptor = requireRecord(params.descriptor, "descriptor");
  if (descriptor.$schema !== "sat.release-descriptor.v2" || descriptor.descriptorVersion !== 2) {
    fail("schema or version is invalid");
  }
  if (descriptor.stage !== "deployed-release") {
    fail("stage is not deployed-release");
  }
  const claimedDigest = requireSha256(descriptor.descriptorDigest, "descriptor digest");
  const withoutDigest = { ...descriptor };
  delete withoutDigest.descriptorDigest;
  const actualDigest = `sha256:${createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex")}`;
  if (claimedDigest !== actualDigest) {
    fail("descriptor digest does not match canonical content");
  }

  const source = requireBound(descriptor.source, "source");
  const sourceCommit = requireString(source.commit, "source commit");
  if (
    !GIT_ID_PATTERN.test(sourceCommit) ||
    !GIT_ID_PATTERN.test(requireString(source.tree, "source tree"))
  ) {
    fail("source commit or tree is invalid");
  }
  if (sourceCommit !== params.manifestSourceCommit) {
    fail("source commit does not match the signed address manifest");
  }

  const components = requireBound(descriptor.componentGenerations, "component generations");
  if (!equalJson(components.tuple, SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations)) {
    fail("component-generation tuple does not match the installed client contract");
  }
  const build = requireBound(descriptor.build, "build");
  const genesis = requireRecord(build.genesis, "build genesis");
  const programIds = requireRecord(genesis.programIds, "build genesis program IDs");
  if (
    genesis.cluster !== "mainnet-beta" ||
    genesis.satMint !== params.officialIds.mintAddress ||
    programIds.mining !== params.officialIds.programId ||
    programIds.mint !== params.officialIds.mintProgramId ||
    programIds.bond !== params.officialIds.bondProgramId
  ) {
    fail("build genesis identity does not match the signed address manifest");
  }

  const interfaces = requireBound(descriptor.interfaces, "interfaces");
  for (const field of [
    "interfaceContractSha256",
    "idlSha256",
    "accountOrderSha256",
    "stateLayoutsSha256",
    "signerCodecsSha256",
  ] as const) {
    if (
      requireSha256(interfaces[field], `interfaces.${field}`) !==
      SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT[field]
    ) {
      fail(`interfaces.${field} does not match the installed client contract`);
    }
  }

  verifyDeployment(requireBound(descriptor.deployment, "deployment"), params.officialIds);
  const compatibility = requireBound(descriptor.runtimeCompatibility, "runtime compatibility");
  const minimumVersion = requireString(
    compatibility.minimumFasedVersion,
    "minimum compatible Fased version",
  );
  const versionComparison = compareFasedAgentVersions(params.currentFasedVersion, minimumVersion);
  if (versionComparison == null || versionComparison < 0) {
    fail(`Fased ${params.currentFasedVersion} is older than required ${minimumVersion}`);
  }
  if (
    compatibility.miningContractDigest !==
      SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.interfaceContractSha256 ||
    compatibility.signerCapability !==
      SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.signerCapability
  ) {
    fail("runtime compatibility does not match the installed client contract");
  }
  if (
    !equalJson(compatibility.signerAcknowledgement, SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT) ||
    !equalJson(params.signerAcknowledgement, SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT)
  ) {
    fail("native signer acknowledgement does not match the installed client contract");
  }

  requireBound(descriptor.publication, "publication");
  const receiptBinding = requireBound(descriptor.receiptBinding, "receipt binding");
  requireSha256(receiptBinding.candidateReceiptDigest, "candidate receipt digest");
  requireSha256(receiptBinding.deploymentReceiptDigest, "deployment receipt digest");
  return { descriptorDigest: claimedDigest, sourceCommit };
}
