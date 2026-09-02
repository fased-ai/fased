import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { resolveStateDir } from "../config/paths.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";

const STORE_VERSION = 1;
const REATTACH_DOMAIN = "fased.financial-agent-reattach.v1";
const MAX_PENDING_CHALLENGES = 32;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type FinalizedAgentNamespaceBinding = {
  address: string;
  networkAgentId: string;
  name: string;
  handle: string;
  ticker: string;
  boundSlot: number;
  recordAuthorityGeneration: string;
};

export type FinalizedAgentMiningBinding = {
  address: string;
  satAgentRecord: string;
  satcoinProgramId: string;
  permanentMiningId: string;
  boundSlot: number;
};

export type FinalizedFinancialAgentReadback = {
  programId: string;
  genesisHash: string;
  fasedAgentRecord: string;
  status: "active" | "retired";
  controller: string;
  recoveryAuthority: string;
  authorityGeneration: string;
  finalizedSlot: number;
  namespaceBinding?: FinalizedAgentNamespaceBinding;
  miningBinding?: FinalizedAgentMiningBinding;
  launchBinding?: string;
};

export type FinancialAgentWorkspaceAttachment = {
  localAgentId: string;
  state: "attached" | "detached";
  attachedAt: string;
  detachedAt?: string;
};

export type FinancialAgentBinding = FinalizedFinancialAgentReadback & {
  updatedAt: string;
  attachments: FinancialAgentWorkspaceAttachment[];
};

export type FinancialAgentReattachmentChallenge = {
  version: 1;
  fasedAgentRecord: string;
  localAgentId: string;
  nonce: string;
  authorityGeneration: string;
  expiresAt: string;
};

type PendingChallenge = FinancialAgentReattachmentChallenge & { issuedAt: string };
type FinancialAgentBindingStore = {
  version: 1;
  bindings: Record<string, FinancialAgentBinding>;
  pendingChallenges: Record<string, PendingChallenge>;
  consumedChallengeDigests: string[];
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function storePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "financial-agents", "bindings.v1.json");
}

function emptyStore(): FinancialAgentBindingStore {
  return {
    version: STORE_VERSION,
    bindings: {},
    pendingChallenges: {},
    consumedChallengeDigests: [],
    updatedAt: nowIso(),
  };
}

function requireAddress(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a Solana address`);
  }
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    throw new Error(`${label} must be a Solana address`);
  }
}

function requireUnsignedIntegerString(value: unknown, label: string): string {
  const normalized =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number" || typeof value === "string"
        ? String(value).trim()
        : "";
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${label} must be an unsigned integer string`);
  }
  return normalized;
}

function requireSlot(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function validateReadback(value: FinalizedFinancialAgentReadback): FinalizedFinancialAgentReadback {
  const fasedAgentRecord = requireAddress(value.fasedAgentRecord, "FasedAgentRecord");
  const authorityGeneration = requireUnsignedIntegerString(
    value.authorityGeneration,
    "authority generation",
  );
  if (value.status !== "active" && value.status !== "retired") {
    throw new Error("FasedAgentRecord status is invalid");
  }
  const namespaceBinding = value.namespaceBinding
    ? {
        ...value.namespaceBinding,
        address: requireAddress(value.namespaceBinding.address, "namespace binding"),
        boundSlot: requireSlot(value.namespaceBinding.boundSlot, "namespace bound slot"),
        recordAuthorityGeneration: requireUnsignedIntegerString(
          value.namespaceBinding.recordAuthorityGeneration,
          "namespace authority generation",
        ),
      }
    : undefined;
  const miningBinding = value.miningBinding
    ? {
        ...value.miningBinding,
        address: requireAddress(value.miningBinding.address, "mining binding"),
        satAgentRecord: requireAddress(value.miningBinding.satAgentRecord, "SatAgentRecord"),
        satcoinProgramId: requireAddress(value.miningBinding.satcoinProgramId, "Satcoin program"),
        permanentMiningId: requireAddress(value.miningBinding.permanentMiningId, "Mining ID"),
        boundSlot: requireSlot(value.miningBinding.boundSlot, "mining bound slot"),
      }
    : undefined;
  if (
    namespaceBinding &&
    BigInt(namespaceBinding.recordAuthorityGeneration) > BigInt(authorityGeneration)
  ) {
    throw new Error("namespace binding generation is newer than the Agent record");
  }
  return {
    ...value,
    programId: requireAddress(value.programId, "Agent program"),
    genesisHash: requireAddress(value.genesisHash, "genesis hash"),
    fasedAgentRecord,
    controller: requireAddress(value.controller, "controller"),
    recoveryAuthority: requireAddress(value.recoveryAuthority, "recovery authority"),
    authorityGeneration,
    finalizedSlot: requireSlot(value.finalizedSlot, "finalized slot"),
    ...(namespaceBinding ? { namespaceBinding } : {}),
    ...(miningBinding ? { miningBinding } : {}),
    ...(value.launchBinding
      ? { launchBinding: requireAddress(value.launchBinding, "launch binding") }
      : {}),
  };
}

function validateStore(parsed: unknown): FinancialAgentBindingStore {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("financial Agent binding store is not an object");
  }
  const value = parsed as Partial<FinancialAgentBindingStore>;
  if (
    value.version !== STORE_VERSION ||
    !value.bindings ||
    Array.isArray(value.bindings) ||
    !value.pendingChallenges ||
    Array.isArray(value.pendingChallenges) ||
    !Array.isArray(value.consumedChallengeDigests)
  ) {
    throw new Error("financial Agent binding store has an unsupported shape");
  }
  for (const [record, binding] of Object.entries(value.bindings)) {
    if (requireAddress(record, "binding key") !== record || binding.fasedAgentRecord !== record) {
      throw new Error("financial Agent binding key does not match its record");
    }
    validateReadback(binding);
    if (!Array.isArray(binding.attachments)) {
      throw new Error("financial Agent attachments are invalid");
    }
    for (const attachment of binding.attachments) {
      if (
        !attachment.localAgentId?.trim() ||
        (attachment.state !== "attached" && attachment.state !== "detached") ||
        !attachment.attachedAt ||
        (attachment.state === "detached" && !attachment.detachedAt)
      ) {
        throw new Error("financial Agent attachment is invalid");
      }
    }
  }
  return value as FinancialAgentBindingStore;
}

function readStore(env: NodeJS.ProcessEnv): FinancialAgentBindingStore {
  const filePath = storePath(env);
  if (!fs.existsSync(filePath)) {
    return emptyStore();
  }
  try {
    return validateStore(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch (error) {
    throw new Error("financial Agent binding store is unreadable; refusing identity mutation", {
      cause: error,
    });
  }
}

function writeStore(store: FinancialAgentBindingStore, env: NodeJS.ProcessEnv): void {
  const filePath = storePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  store.updatedAt = nowIso();
  writeWalletStateFileAtomically(filePath, serializeWalletState(store));
}

function canonicalChallenge(challenge: FinancialAgentReattachmentChallenge): string {
  return [
    REATTACH_DOMAIN,
    challenge.fasedAgentRecord,
    challenge.localAgentId,
    challenge.nonce,
    challenge.authorityGeneration,
    challenge.expiresAt,
  ].join("\n");
}

function challengeDigest(challenge: FinancialAgentReattachmentChallenge): string {
  return createHash("sha256").update(canonicalChallenge(challenge)).digest("hex");
}

function verifySolanaSignature(params: {
  publicKey: string;
  signatureBase64: string;
  message: string;
}): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(params.signatureBase64, "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) {
    return false;
  }
  const publicKeyBytes = new PublicKey(params.publicKey).toBuffer();
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: "der",
    type: "spki",
  });
  return verify(null, Buffer.from(params.message, "utf8"), key, signature);
}

export function issueFinancialAgentReattachmentChallenge(params: {
  fasedAgentRecord: string;
  localAgentId: string;
  authorityGeneration: string | number | bigint;
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
}): FinancialAgentReattachmentChallenge {
  const env = params.env ?? process.env;
  const localAgentId = params.localAgentId.trim();
  if (!localAgentId) {
    throw new Error("local Agent id is required");
  }
  const ttlMs = params.ttlMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000) {
    throw new Error("reattachment challenge TTL must be between 1 and 15 minutes");
  }
  const challenge: FinancialAgentReattachmentChallenge = {
    version: 1,
    fasedAgentRecord: requireAddress(params.fasedAgentRecord, "FasedAgentRecord"),
    localAgentId,
    nonce: randomBytes(32).toString("base64url"),
    authorityGeneration: requireUnsignedIntegerString(
      params.authorityGeneration,
      "authority generation",
    ),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  const store = readStore(env);
  const now = Date.now();
  store.pendingChallenges = Object.fromEntries(
    Object.entries(store.pendingChallenges)
      .filter(([, pending]) => Date.parse(pending.expiresAt) > now)
      .slice(-(MAX_PENDING_CHALLENGES - 1)),
  );
  store.pendingChallenges[challenge.nonce] = { ...challenge, issuedAt: nowIso() };
  writeStore(store, env);
  return challenge;
}

export function attachFinancialAgentFromFinalizedReadback(params: {
  readback: FinalizedFinancialAgentReadback;
  challenge: FinancialAgentReattachmentChallenge;
  signer: string;
  signatureBase64: string;
  env?: NodeJS.ProcessEnv;
}): FinancialAgentBinding {
  const env = params.env ?? process.env;
  const readback = validateReadback(params.readback);
  const challenge = params.challenge;
  const store = readStore(env);
  const pending = store.pendingChallenges[challenge.nonce];
  const digest = challengeDigest(challenge);
  if (!pending || canonicalChallenge(pending) !== canonicalChallenge(challenge)) {
    throw new Error("reattachment challenge was not issued by this installation");
  }
  if (store.consumedChallengeDigests.includes(digest)) {
    throw new Error("reattachment challenge has already been consumed");
  }
  if (Date.parse(challenge.expiresAt) <= Date.now()) {
    throw new Error("reattachment challenge has expired");
  }
  if (
    challenge.fasedAgentRecord !== readback.fasedAgentRecord ||
    challenge.authorityGeneration !== readback.authorityGeneration
  ) {
    throw new Error("reattachment challenge does not match finalized Agent state");
  }
  const signer = requireAddress(params.signer, "reattachment signer");
  if (signer !== readback.controller && signer !== readback.recoveryAuthority) {
    throw new Error("reattachment signer is not the finalized controller or recovery authority");
  }
  if (
    !verifySolanaSignature({
      publicKey: signer,
      signatureBase64: params.signatureBase64,
      message: canonicalChallenge(challenge),
    })
  ) {
    throw new Error("reattachment signature is invalid");
  }
  for (const binding of Object.values(store.bindings)) {
    const active = binding.attachments.find(
      (entry) => entry.localAgentId === challenge.localAgentId && entry.state === "attached",
    );
    if (active && binding.fasedAgentRecord !== readback.fasedAgentRecord) {
      throw new Error("local Agent is already attached to another financial Agent");
    }
  }
  const previous = store.bindings[readback.fasedAgentRecord];
  const attachments = (previous?.attachments ?? []).map((entry) =>
    entry.state === "attached" && entry.localAgentId !== challenge.localAgentId
      ? { ...entry, state: "detached" as const, detachedAt: nowIso() }
      : entry,
  );
  const existingIndex = attachments.findIndex(
    (entry) => entry.localAgentId === challenge.localAgentId,
  );
  const attachment: FinancialAgentWorkspaceAttachment = {
    localAgentId: challenge.localAgentId,
    state: "attached",
    attachedAt: nowIso(),
  };
  if (existingIndex >= 0) {
    attachments[existingIndex] = attachment;
  } else {
    attachments.push(attachment);
  }
  const binding: FinancialAgentBinding = { ...readback, attachments, updatedAt: nowIso() };
  store.bindings[readback.fasedAgentRecord] = binding;
  delete store.pendingChallenges[challenge.nonce];
  store.consumedChallengeDigests = [...store.consumedChallengeDigests, digest].slice(-128);
  writeStore(store, env);
  return binding;
}

export function detachFinancialAgentWorkspace(params: {
  localAgentId: string;
  env?: NodeJS.ProcessEnv;
}): { detached: boolean; fasedAgentRecord?: string } {
  const env = params.env ?? process.env;
  const localAgentId = params.localAgentId.trim();
  const store = readStore(env);
  for (const binding of Object.values(store.bindings)) {
    const index = binding.attachments.findIndex(
      (entry) => entry.localAgentId === localAgentId && entry.state === "attached",
    );
    if (index >= 0) {
      binding.attachments[index] = {
        ...binding.attachments[index],
        state: "detached",
        detachedAt: nowIso(),
      };
      binding.updatedAt = nowIso();
      writeStore(store, env);
      return { detached: true, fasedAgentRecord: binding.fasedAgentRecord };
    }
  }
  return { detached: false };
}

export function findFinancialAgentBindingForLocalAgent(
  localAgentId: string,
  env: NodeJS.ProcessEnv = process.env,
): FinancialAgentBinding | null {
  const normalized = localAgentId.trim();
  return (
    Object.values(readStore(env).bindings).find((binding) =>
      binding.attachments.some(
        (entry) => entry.localAgentId === normalized && entry.state === "attached",
      ),
    ) ?? null
  );
}

export function findFinancialAuthorityUse(
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): { fasedAgentRecord: string; role: "controller" | "recovery" } | null {
  let normalized: string;
  try {
    normalized = requireAddress(address, "wallet address");
  } catch {
    return null;
  }
  for (const binding of Object.values(readStore(env).bindings)) {
    if (binding.controller === normalized) {
      return { fasedAgentRecord: binding.fasedAgentRecord, role: "controller" };
    }
    if (binding.recoveryAuthority === normalized) {
      return { fasedAgentRecord: binding.fasedAgentRecord, role: "recovery" };
    }
  }
  return null;
}

export function listFinancialAgentBindings(
  env: NodeJS.ProcessEnv = process.env,
): FinancialAgentBinding[] {
  return Object.values(readStore(env).bindings).toSorted((a, b) =>
    a.fasedAgentRecord.localeCompare(b.fasedAgentRecord),
  );
}

export function financialAgentReattachmentMessage(
  challenge: FinancialAgentReattachmentChallenge,
): string {
  return canonicalChallenge(challenge);
}
