import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

type JsonRecord = Record<string, unknown>;

export type MiningRetirementEvidenceV1 = {
  version: 1;
  walletId: string;
  publicKey: string;
  observedAt: string;
  newJobsStopped: true;
  workersDrained: true;
  clearingDrained: true;
  submissionsReconciled: true;
  pendingCommits: number;
  pendingReveals: number;
  pendingSettlements: number;
  pendingClaims: number;
  pendingCleanup: number;
  pendingAltMutations: number;
  solBalanceLamports: string;
  satBalanceRaw: string;
  runtimeStateHash: string;
  submissionLedgerHash: string;
};

export type MiningRecoveryVerification = {
  packageHash: string;
  walletId: string;
  publicKey: string;
  role: "mining";
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function decimal(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`Mining retirement cannot verify ${field}`);
  }
  return normalized;
}

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function requiredNonNegativeCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SQLite-bound Mining retirement snapshot has invalid ${field}`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`SQLite-bound Mining retirement snapshot has invalid ${field}`);
  }
  return value.trim();
}

function sha256(raw: Buffer | string): string {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function base64UrlByteLength(value: unknown): number {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return -1;
  }
  try {
    return Buffer.from(value, "base64url").byteLength;
  } catch {
    return -1;
  }
}

function normalizedWalletStateKey(walletId: string): string {
  return walletId.replace(/[^a-zA-Z0-9._-]+/gu, "_") || "unattached";
}

function readStrictJSONFile(
  filePath: string,
  maxBytes: number,
): { raw: Buffer; value: JsonRecord } {
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) {
    throw new Error(`Mining retirement evidence file is invalid: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`Mining retirement evidence file is not valid JSON: ${filePath}`);
  }
  const value = record(parsed);
  if (!value) {
    throw new Error(`Mining retirement evidence file must contain one JSON object: ${filePath}`);
  }
  return { raw, value };
}

export function unwrapMiningGatewayPayload(value: unknown): JsonRecord {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    const currentRecord = record(current);
    if (!currentRecord) {
      break;
    }
    if (record(currentRecord.status)) {
      return record(currentRecord.status)!;
    }
    if (!("payload" in currentRecord)) {
      return currentRecord;
    }
    current = currentRecord.payload;
  }
  return record(current) ?? {};
}

export function verifyMiningRecoveryPackage(params: {
  recoveryFile: string;
  walletId: string;
  publicKey: string;
}): MiningRecoveryVerification {
  const recoveryFile = params.recoveryFile.trim();
  if (!path.isAbsolute(recoveryFile) || path.resolve(recoveryFile) !== recoveryFile) {
    throw new Error("--recovery-file must be an absolute clean path");
  }
  const info = fs.lstatSync(recoveryFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077) {
    throw new Error("Mining recovery package must be one owner-only regular non-symlink file");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Mining recovery package must be owned by the current terminal user");
  }
  const { raw, value } = readStrictJSONFile(recoveryFile, 16 * 1024);
  const kdf = record(value.kdf);
  const encryption = record(value.encryption);
  if (
    value.kind !== "fased-signer-wallet-recovery" ||
    value.version !== 1 ||
    value.walletId !== params.walletId ||
    value.role !== "mining" ||
    value.publicKey !== params.publicKey ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    kdf?.name !== "argon2id" ||
    kdf.memoryKiB !== 64 * 1024 ||
    kdf.iterations !== 3 ||
    kdf.parallelism !== 1 ||
    base64UrlByteLength(kdf.salt) !== 16 ||
    encryption?.name !== "aes-256-gcm" ||
    base64UrlByteLength(encryption.nonce) !== 12 ||
    base64UrlByteLength(encryption.ciphertext) !== 80
  ) {
    throw new Error("Encrypted recovery package does not match the source Mining wallet");
  }
  return {
    packageHash: sha256(raw),
    walletId: params.walletId,
    publicKey: params.publicKey,
    role: "mining",
  };
}

export function buildMiningRetirementEvidence(params: {
  walletId: string;
  signerWalletId: string;
  publicKey: string;
  signerSolBalanceLamports: string;
  liveStatus: unknown;
  env?: NodeJS.ProcessEnv;
}): MiningRetirementEvidenceV1 {
  const status = unwrapMiningGatewayPayload(params.liveStatus);
  if (typeof status.retirementGatewayError === "string") {
    throw new Error(`Could not stop and inspect Mining: ${status.retirementGatewayError}`);
  }
  if (status.walletId !== params.walletId && status.walletId !== params.signerWalletId) {
    throw new Error("Live Mining status is not bound to the source wallet");
  }
  if (status.statusFresh === false || status.degraded === true) {
    throw new Error("Live Mining status is degraded; normal retirement refuses unverifiable state");
  }
  if (status.running === true || status.drainOnly === true || status.enabledWanted === true) {
    throw new Error(
      "Mining is still running or draining; retry retirement after Clearing finishes",
    );
  }
  const workers = record(status.workers) ?? {};
  if (Object.values(workers).some((worker) => record(worker)?.running === true)) {
    throw new Error("A Mining worker is still running");
  }
  const solBalanceLamports = decimal(status.currentSolBalanceLamports, "live SOL balance");
  const signerBalance = decimal(params.signerSolBalanceLamports, "signer SOL balance");
  if (solBalanceLamports !== signerBalance) {
    throw new Error("Live Mining and signer SOL balance observations disagree");
  }
  const satBalanceRaw = decimal(status.currentSatBalanceRaw, "live SAT balance");
  for (const [field, value] of [
    ["funded Mining capital", status.currentCapitalFundedLamports],
    ["locked Mining capital", status.currentCapitalLockedLamports],
    ["free Mining capital", status.currentCapitalFreeLamports],
  ] as const) {
    if (decimal(value, field) !== "0") {
      throw new Error(`${field} must be zero before normal Mining retirement`);
    }
  }
  if (
    nonNegativeCount(status.currentCapitalPendingCycleCount) !== 0 ||
    nonNegativeCount(record(status.claimBacklog)?.total) !== 0 ||
    nonNegativeCount(status.missingCycleCount) !== 0 ||
    (Array.isArray(status.pendingCycleIds) && status.pendingCycleIds.length > 0) ||
    status.exactPendingCycleId != null
  ) {
    throw new Error("Mining still has pending cycles, claims, or reconciliation gaps");
  }

  const durable = record(status.retirementEvidence);
  if (
    durable?.version !== 1 ||
    (durable.walletId !== params.walletId && durable.walletId !== params.signerWalletId) ||
    typeof durable.scopeKey !== "string" ||
    !durable.scopeKey.trim() ||
    typeof durable.protocolGeneration !== "string" ||
    !durable.protocolGeneration.trim() ||
    durable.newJobsStopped !== true ||
    durable.workersDrained !== true ||
    durable.clearingDrained !== true ||
    durable.submissionsReconciled !== true
  ) {
    throw new Error("Live Mining status lacks a complete SQLite-bound retirement snapshot");
  }
  const pendingByKind = {
    commit: requiredNonNegativeCount(durable.pendingCommits, "pending commit count"),
    reveal: requiredNonNegativeCount(durable.pendingReveals, "pending reveal count"),
    settlement: requiredNonNegativeCount(durable.pendingSettlements, "pending settlement count"),
    claim: requiredNonNegativeCount(durable.pendingClaims, "pending claim count"),
    cleanup: requiredNonNegativeCount(durable.pendingCleanup, "pending cleanup count"),
    alt: requiredNonNegativeCount(durable.pendingAltMutations, "pending ALT mutation count"),
  };
  const runtimeStateHash = requiredString(durable.runtimeStateHash, "runtime state hash");
  const submissionLedgerHash = requiredString(
    durable.submissionLedgerHash,
    "submission ledger hash",
  );
  if (
    Object.values(pendingByKind).some((count) => count > 0) ||
    !/^sha256:[0-9a-f]{64}$/u.test(runtimeStateHash) ||
    !/^sha256:[0-9a-f]{64}$/u.test(submissionLedgerHash)
  ) {
    throw new Error("SQLite-bound Mining retirement state still has unresolved work");
  }
  const observedAt = requiredString(durable.observedAt, "observation timestamp");
  const liveObservedAt = requiredString(
    typeof status.updatedAt === "string" ? status.updatedAt : status.snapshotAt,
    "live observation timestamp",
  );
  if (
    !observedAt ||
    !Number.isFinite(Date.parse(observedAt)) ||
    !liveObservedAt ||
    new Date(observedAt).toISOString() !== new Date(liveObservedAt).toISOString()
  ) {
    throw new Error("Live and durable Mining retirement observations do not match");
  }
  return {
    version: 1,
    walletId: params.signerWalletId,
    publicKey: params.publicKey,
    observedAt: new Date(observedAt).toISOString(),
    newJobsStopped: true,
    workersDrained: true,
    clearingDrained: true,
    submissionsReconciled: true,
    pendingCommits: pendingByKind.commit,
    pendingReveals: pendingByKind.reveal,
    pendingSettlements: pendingByKind.settlement,
    pendingClaims: pendingByKind.claim,
    pendingCleanup: pendingByKind.cleanup,
    pendingAltMutations: pendingByKind.alt,
    solBalanceLamports,
    satBalanceRaw,
    runtimeStateHash,
    submissionLedgerHash,
  };
}

export function writeMiningRetirementReceipt(params: {
  sourceWalletId: string;
  receipt: JsonRecord;
  env?: NodeJS.ProcessEnv;
}): string {
  const root = path.join(resolveStateDir(params.env ?? process.env), "wallet-retirements");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const filePath = path.join(root, `${normalizedWalletStateKey(params.sourceWalletId)}.json`);
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(params.receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
  return filePath;
}
