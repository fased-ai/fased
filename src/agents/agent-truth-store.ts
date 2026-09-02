import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";
import {
  AGENT_TRUTH_MAX_EVENTS,
  AGENT_TRUTH_STORE_VERSION,
  FinancialEventSchema,
  PrivateMemoryEventSchema,
  PublicEvidenceIndexEntrySchema,
  ResearchEventSchema,
  type FinancialEvent,
  type FinancialEventInput,
  type PrivateMemoryEvent,
  type PrivateMemoryInput,
  type PublicEvidenceIndexEntry,
  type ResearchEvent,
  type ResearchEventInput,
} from "./agent-truth-contracts.js";
import { stableStringify } from "./stable-stringify.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_FILENAME = "agent-truth-memory.v1.key";
const LOCK_OPTIONS = {
  retries: { retries: 100, factor: 1.15, minTimeout: 10, maxTimeout: 200, randomize: true },
  stale: 30_000,
} as const;

type StoreSource = "creation" | "legacy-migration" | "restore";
type StoreKind = "private-memory" | "research" | "financial";

type EventStore<T> = {
  version: 1;
  agentId: string;
  kind: StoreKind;
  source: StoreSource;
  events: T[];
  createdAt: string;
  updatedAt: string;
};

type EncryptedPrivateStore = {
  version: 1;
  algorithm: "aes-256-gcm";
  agentId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

type PublicIndex = {
  version: 1;
  agentId: string;
  sourceRoots: { research: string | null; financial: string | null };
  entries: PublicEvidenceIndexEntry[];
  builtAt: string;
};

type StoreManifest = {
  version: 1;
  agentId: string;
  source: StoreSource;
  stores: {
    privateMemory: 1;
    research: 1;
    financial: 1;
    publicEvidence: 1;
  };
  createdAt: string;
};

type BackupPayload = {
  version: 1;
  agentId: string;
  manifest: StoreManifest;
  privateMemory: EventStore<PrivateMemoryEvent>;
  research: EventStore<ResearchEvent>;
  financial: EventStore<FinancialEvent>;
};

type EncryptedBackup = {
  version: 1;
  schema: "fased.agent-truth-backup.v1";
  kdf: "scrypt";
  algorithm: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type AgentTruthSnapshot = {
  manifest: StoreManifest;
  privateMemory: EventStore<PrivateMemoryEvent>;
  research: EventStore<ResearchEvent>;
  financial: EventStore<FinancialEvent>;
  publicEvidence: PublicIndex;
};

const ManifestSchema = z
  .object({
    version: z.literal(AGENT_TRUTH_STORE_VERSION),
    agentId: z.string(),
    source: z.enum(["creation", "legacy-migration", "restore"]),
    stores: z
      .object({
        privateMemory: z.literal(1),
        research: z.literal(1),
        financial: z.literal(1),
        publicEvidence: z.literal(1),
      })
      .strict(),
    createdAt: z.string(),
  })
  .strict();

const EventStoreSchema = z
  .object({
    version: z.literal(AGENT_TRUTH_STORE_VERSION),
    agentId: z.string(),
    kind: z.enum(["private-memory", "research", "financial"]),
    source: z.enum(["creation", "legacy-migration", "restore"]),
    events: z.array(z.unknown()).max(AGENT_TRUTH_MAX_EVENTS),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const EncryptedPrivateStoreSchema = z
  .object({
    version: z.literal(AGENT_TRUTH_STORE_VERSION),
    algorithm: z.literal("aes-256-gcm"),
    agentId: z.string(),
    iv: z.string(),
    authTag: z.string(),
    ciphertext: z.string(),
  })
  .strict();

const PublicIndexSchema = z
  .object({
    version: z.literal(AGENT_TRUTH_STORE_VERSION),
    agentId: z.string(),
    sourceRoots: z.object({ research: z.string().nullable(), financial: z.string().nullable() }),
    entries: z.array(PublicEvidenceIndexEntrySchema).max(AGENT_TRUTH_MAX_EVENTS),
    builtAt: z.string(),
  })
  .strict();

const EncryptedBackupSchema = z
  .object({
    version: z.literal(1),
    schema: z.literal("fased.agent-truth-backup.v1"),
    kdf: z.literal("scrypt"),
    algorithm: z.literal("aes-256-gcm"),
    salt: z.string(),
    iv: z.string(),
    authTag: z.string(),
    ciphertext: z.string(),
  })
  .strict();

function timestamp(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function requireCanonicalTimestamp(value: string, label: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function requireAgentId(value: string): string {
  const trimmed = value.trim();
  const normalized = normalizeAgentId(trimmed);
  if (!trimmed || normalized !== trimmed.toLowerCase()) {
    throw new Error("Agent truth id must be canonical");
  }
  return normalized;
}

function rootPath(agentId: string, env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "agent-truth", agentId);
}

function storePaths(agentId: string, env: NodeJS.ProcessEnv) {
  const root = rootPath(agentId, env);
  return {
    root,
    manifest: path.join(root, "manifest.v1.json"),
    privateMemory: path.join(root, "private-memory.v1.enc.json"),
    research: path.join(root, "research-provenance.v1.json"),
    financial: path.join(root, "objective-financial-ledger.v1.json"),
    publicEvidence: path.join(root, "public-evidence-index.v1.json"),
  };
}

function masterKeyPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "secrets", KEY_FILENAME);
}

function readMasterKey(env: NodeJS.ProcessEnv, create: boolean): Buffer {
  const filePath = masterKeyPath(env);
  if (fs.existsSync(filePath)) {
    const key = Buffer.from(fs.readFileSync(filePath, "utf8").trim(), "hex");
    if (key.length !== KEY_BYTES) {
      throw new Error("Agent truth private-memory key is invalid");
    }
    return key;
  }
  if (!create) {
    throw new Error("Agent truth private-memory key is unavailable");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIRECTORY_MODE });
  const key = randomBytes(KEY_BYTES);
  fs.writeFileSync(filePath, `${key.toString("hex")}\n`, { encoding: "utf8", mode: FILE_MODE });
  return key;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIRECTORY_MODE });
  writeWalletStateFileAtomically(filePath, serializeWalletState(value));
}

function eventDigest(domain: string, event: Record<string, unknown>): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(stableStringify(event))
    .digest("hex");
}

function validateChain<
  T extends { sequence: number; previousDigest: string | null; digest: string },
>(events: T[], domain: string): void {
  let previousDigest: string | null = null;
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1 || event.previousDigest !== previousDigest) {
      throw new Error("Agent truth event chain is invalid");
    }
    const { digest, ...unsigned } = event;
    if (eventDigest(domain, unsigned) !== digest) {
      throw new Error("Agent truth event digest is invalid");
    }
    previousDigest = digest;
  }
}

function parseStoreBase(raw: unknown, agentId: string, kind: StoreKind) {
  const value = EventStoreSchema.parse(raw);
  if (value.agentId !== agentId || value.kind !== kind) {
    throw new Error(`Agent ${kind} store identity is invalid`);
  }
  requireCanonicalTimestamp(value.createdAt, `${kind} creation timestamp`);
  requireCanonicalTimestamp(value.updatedAt, `${kind} update timestamp`);
  return value;
}

function parsePrivateStore(raw: unknown, agentId: string): EventStore<PrivateMemoryEvent> {
  const value = parseStoreBase(raw, agentId, "private-memory");
  const events = value.events.map((event) => PrivateMemoryEventSchema.parse(event));
  validateChain(events, "fased.agent.private-memory-event.v1");
  return { ...value, kind: "private-memory", events };
}

function parseResearchStore(raw: unknown, agentId: string): EventStore<ResearchEvent> {
  const value = parseStoreBase(raw, agentId, "research");
  const events = value.events.map((event) => ResearchEventSchema.parse(event));
  validateChain(events, "fased.agent.research-event.v1");
  return { ...value, kind: "research", events };
}

function parseFinancialStore(raw: unknown, agentId: string): EventStore<FinancialEvent> {
  const value = parseStoreBase(raw, agentId, "financial");
  const events = value.events.map((event) => FinancialEventSchema.parse(event));
  validateChain(events, "fased.agent.financial-event.v1");
  return { ...value, kind: "financial", events };
}

function encryptPrivateStore(
  store: EventStore<PrivateMemoryEvent>,
  env: NodeJS.ProcessEnv,
): EncryptedPrivateStore {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", readMasterKey(env, true), iv);
  cipher.setAAD(Buffer.from(`fased.agent.private-memory.v1\0${store.agentId}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(stableStringify(store), "utf8")),
    cipher.final(),
  ]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    agentId: store.agentId,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptPrivateStore(
  raw: unknown,
  agentId: string,
  env: NodeJS.ProcessEnv,
): EventStore<PrivateMemoryEvent> {
  try {
    const encrypted = EncryptedPrivateStoreSchema.parse(raw);
    if (encrypted.agentId !== agentId) {
      throw new Error("private-memory Agent identity mismatch");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      readMasterKey(env, false),
      Buffer.from(encrypted.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`fased.agent.private-memory.v1\0${agentId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return parsePrivateStore(JSON.parse(plaintext), agentId);
  } catch (error) {
    throw new Error("Agent private-memory store is unreadable", { cause: error });
  }
}

function emptyStore<T>(params: {
  agentId: string;
  kind: StoreKind;
  source: StoreSource;
  timestamp: string;
}): EventStore<T> {
  return {
    version: 1,
    agentId: params.agentId,
    kind: params.kind,
    source: params.source,
    events: [],
    createdAt: params.timestamp,
    updatedAt: params.timestamp,
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readManifest(agentId: string, env: NodeJS.ProcessEnv): StoreManifest {
  const value = ManifestSchema.parse(readJson(storePaths(agentId, env).manifest));
  if (value.agentId !== agentId) {
    throw new Error("Agent truth manifest identity is invalid");
  }
  requireCanonicalTimestamp(value.createdAt, "Agent truth manifest timestamp");
  return value;
}

function latestDigest(events: Array<{ digest: string }>): string | null {
  return events.at(-1)?.digest ?? null;
}

function derivePublicIndex(params: {
  agentId: string;
  research: EventStore<ResearchEvent>;
  financial: EventStore<FinancialEvent>;
  builtAt: string;
}): PublicIndex {
  const entries: PublicEvidenceIndexEntry[] = [];
  for (const event of params.research.events) {
    if (event.publicEvidence) {
      entries.push({
        ...event.publicEvidence,
        sourceStore: "research",
        sourceEventId: event.eventId,
        sourceDigest: event.digest,
      });
    }
  }
  for (const event of params.financial.events) {
    if (event.publicEvidence) {
      entries.push({
        ...event.publicEvidence,
        sourceStore: "financial",
        sourceEventId: event.eventId,
        sourceDigest: event.digest,
      });
    }
  }
  return {
    version: 1,
    agentId: params.agentId,
    sourceRoots: {
      research: latestDigest(params.research.events),
      financial: latestDigest(params.financial.events),
    },
    entries,
    builtAt: params.builtAt,
  };
}

function parsePublicIndex(raw: unknown, agentId: string): PublicIndex {
  const value = PublicIndexSchema.parse(raw);
  if (value.agentId !== agentId) {
    throw new Error("Agent public-evidence index identity is invalid");
  }
  requireCanonicalTimestamp(value.builtAt, "public-evidence build timestamp");
  return value;
}

function readSnapshot(agentId: string, env: NodeJS.ProcessEnv): AgentTruthSnapshot {
  const paths = storePaths(agentId, env);
  const manifest = readManifest(agentId, env);
  const privateMemory = decryptPrivateStore(readJson(paths.privateMemory), agentId, env);
  const research = parseResearchStore(readJson(paths.research), agentId);
  const financial = parseFinancialStore(readJson(paths.financial), agentId);
  const publicEvidence = parsePublicIndex(readJson(paths.publicEvidence), agentId);
  const expected = derivePublicIndex({
    agentId,
    research,
    financial,
    builtAt: publicEvidence.builtAt,
  });
  if (stableStringify(expected) !== stableStringify(publicEvidence)) {
    throw new Error("Agent public-evidence index is stale or invalid");
  }
  return { manifest, privateMemory, research, financial, publicEvidence };
}

function writeSnapshot(snapshot: AgentTruthSnapshot, env: NodeJS.ProcessEnv): void {
  const paths = storePaths(snapshot.manifest.agentId, env);
  writeJson(paths.manifest, snapshot.manifest);
  writeJson(paths.privateMemory, encryptPrivateStore(snapshot.privateMemory, env));
  writeJson(paths.research, snapshot.research);
  writeJson(paths.financial, snapshot.financial);
  writeJson(paths.publicEvidence, snapshot.publicEvidence);
}

function makeEvent<T extends Record<string, unknown>>(params: {
  domain: string;
  sequence: number;
  previousDigest: string | null;
  createdAt: string;
  input: T;
}): T & {
  version: 1;
  sequence: number;
  createdAt: string;
  previousDigest: string | null;
  digest: string;
} {
  const unsigned = {
    version: 1 as const,
    sequence: params.sequence,
    createdAt: params.createdAt,
    previousDigest: params.previousDigest,
    ...params.input,
  };
  return { ...unsigned, digest: eventDigest(params.domain, unsigned) };
}

function findIdempotent<T extends { eventId: string }>(
  events: T[],
  eventId: string,
  input: Record<string, unknown>,
): T | undefined {
  const existing = events.find((event) => event.eventId === eventId);
  if (!existing) {
    return undefined;
  }
  const {
    version: _version,
    sequence: _sequence,
    createdAt: _createdAt,
    previousDigest: _previous,
    digest: _digest,
    ...persisted
  } = existing as T & Record<string, unknown>;
  if (stableStringify(persisted) !== stableStringify(input)) {
    throw new Error("Agent truth eventId is already bound to a different immutable event");
  }
  return existing;
}

export async function ensureAgentTruthStores(params: {
  agentId: string;
  source: "creation" | "legacy-migration";
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<AgentTruthSnapshot> {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    if (fs.existsSync(paths.manifest)) {
      return readSnapshot(agentId, env);
    }
    if (fs.existsSync(paths.root) && fs.readdirSync(paths.root).length > 0) {
      throw new Error("Partial Agent truth state exists; refusing initialization");
    }
    const createdAt = timestamp(params.now);
    const manifest: StoreManifest = {
      version: 1,
      agentId,
      source: params.source,
      stores: { privateMemory: 1, research: 1, financial: 1, publicEvidence: 1 },
      createdAt,
    };
    const privateMemory = emptyStore<PrivateMemoryEvent>({
      agentId,
      kind: "private-memory",
      source: params.source,
      timestamp: createdAt,
    });
    const research = emptyStore<ResearchEvent>({
      agentId,
      kind: "research",
      source: params.source,
      timestamp: createdAt,
    });
    const financial = emptyStore<FinancialEvent>({
      agentId,
      kind: "financial",
      source: params.source,
      timestamp: createdAt,
    });
    const publicEvidence = derivePublicIndex({ agentId, research, financial, builtAt: createdAt });
    const snapshot = { manifest, privateMemory, research, financial, publicEvidence };
    writeSnapshot(snapshot, env);
    return readSnapshot(agentId, env);
  });
}

export function readAgentTruthSnapshot(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): AgentTruthSnapshot {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  try {
    return readSnapshot(agentId, env);
  } catch (error) {
    throw new Error("Agent truth stores are unreadable; refusing financial use", { cause: error });
  }
}

export async function appendPrivateMemory(
  params: PrivateMemoryInput & {
    agentId: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  },
): Promise<PrivateMemoryEvent> {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    const snapshot = readSnapshot(agentId, env);
    const input = {
      eventId: params.eventId,
      kind: "memory" as const,
      memoryId: params.memoryId,
      content: params.content,
    };
    const existing = findIdempotent(snapshot.privateMemory.events, params.eventId, input);
    if (existing) {
      return existing;
    }
    const event = PrivateMemoryEventSchema.parse(
      makeEvent({
        domain: "fased.agent.private-memory-event.v1",
        sequence: snapshot.privateMemory.events.length + 1,
        previousDigest: latestDigest(snapshot.privateMemory.events),
        createdAt: timestamp(params.now),
        input,
      }),
    );
    snapshot.privateMemory.events.push(event);
    snapshot.privateMemory.updatedAt = event.createdAt;
    writeJson(paths.privateMemory, encryptPrivateStore(snapshot.privateMemory, env));
    return event;
  });
}

export async function redactPrivateMemory(params: {
  agentId: string;
  eventId: string;
  memoryId: string;
  redactsDigest: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<PrivateMemoryEvent> {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    const snapshot = readSnapshot(agentId, env);
    const target = snapshot.privateMemory.events.find(
      (event) =>
        event.kind === "memory" &&
        event.memoryId === params.memoryId &&
        event.digest === params.redactsDigest,
    );
    if (!target) {
      throw new Error("Private-memory redaction target is unavailable");
    }
    if (
      snapshot.privateMemory.events.some(
        (event) => event.kind === "redaction" && event.redactsDigest === target.digest,
      )
    ) {
      throw new Error("Private-memory event is already redacted");
    }
    const input = {
      eventId: params.eventId,
      kind: "redaction" as const,
      memoryId: params.memoryId,
      redactsDigest: params.redactsDigest,
    };
    const existing = findIdempotent(snapshot.privateMemory.events, params.eventId, input);
    if (existing) {
      return existing;
    }
    const event = PrivateMemoryEventSchema.parse(
      makeEvent({
        domain: "fased.agent.private-memory-event.v1",
        sequence: snapshot.privateMemory.events.length + 1,
        previousDigest: latestDigest(snapshot.privateMemory.events),
        createdAt: timestamp(params.now),
        input,
      }),
    );
    snapshot.privateMemory.events.push(event);
    snapshot.privateMemory.updatedAt = event.createdAt;
    writeJson(paths.privateMemory, encryptPrivateStore(snapshot.privateMemory, env));
    return event;
  });
}

export function listActivePrivateMemories(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): PrivateMemoryEvent[] {
  const events = readAgentTruthSnapshot(params).privateMemory.events;
  const redacted = new Set(
    events.flatMap((event) =>
      event.kind === "redaction" && event.redactsDigest ? [event.redactsDigest] : [],
    ),
  );
  return events.filter((event) => event.kind === "memory" && !redacted.has(event.digest));
}

export async function appendResearchEvent(
  params: ResearchEventInput & {
    agentId: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  },
): Promise<ResearchEvent> {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    const snapshot = readSnapshot(agentId, env);
    const { agentId: _agentId, env: _env, now: _now, ...input } = params;
    const existing = findIdempotent(snapshot.research.events, params.eventId, input);
    if (existing) {
      return existing;
    }
    if (
      params.kind === "correction" &&
      !snapshot.research.events.some((event) => event.eventId === params.correctsEventId)
    ) {
      throw new Error("Research correction target is unavailable");
    }
    const event = ResearchEventSchema.parse(
      makeEvent({
        domain: "fased.agent.research-event.v1",
        sequence: snapshot.research.events.length + 1,
        previousDigest: latestDigest(snapshot.research.events),
        createdAt: timestamp(params.now),
        input,
      }),
    );
    snapshot.research.events.push(event);
    snapshot.research.updatedAt = event.createdAt;
    snapshot.publicEvidence = derivePublicIndex({
      agentId,
      research: snapshot.research,
      financial: snapshot.financial,
      builtAt: event.createdAt,
    });
    writeJson(paths.research, snapshot.research);
    writeJson(paths.publicEvidence, snapshot.publicEvidence);
    return event;
  });
}

export async function appendFinancialEvent(
  params: FinancialEventInput & {
    agentId: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  },
): Promise<FinancialEvent> {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    const snapshot = readSnapshot(agentId, env);
    const { agentId: _agentId, env: _env, now: _now, ...input } = params;
    const existing = findIdempotent(snapshot.financial.events, params.eventId, input);
    if (existing) {
      return existing;
    }
    if (
      params.kind === "correction" &&
      !snapshot.financial.events.some((event) => event.eventId === params.correctsEventId)
    ) {
      throw new Error("Financial correction target is unavailable");
    }
    if (params.publicEvidence && !["settled", "reconciled"].includes(params.status)) {
      throw new Error("Only settled or reconciled financial events may become public evidence");
    }
    const event = FinancialEventSchema.parse(
      makeEvent({
        domain: "fased.agent.financial-event.v1",
        sequence: snapshot.financial.events.length + 1,
        previousDigest: latestDigest(snapshot.financial.events),
        createdAt: timestamp(params.now),
        input,
      }),
    );
    snapshot.financial.events.push(event);
    snapshot.financial.updatedAt = event.createdAt;
    snapshot.publicEvidence = derivePublicIndex({
      agentId,
      research: snapshot.research,
      financial: snapshot.financial,
      builtAt: event.createdAt,
    });
    writeJson(paths.financial, snapshot.financial);
    writeJson(paths.publicEvidence, snapshot.publicEvidence);
    return event;
  });
}

export type AgentFinancialUsage = {
  dailySpentAtoms: string;
  rollingSpentAtoms: string;
  cadenceToday: number;
  currentDrawdownBps: number;
  financialRoot: string | null;
};

function sumAdmissionAmounts(events: FinancialEvent[]): bigint {
  return events.reduce((total, event) => total + BigInt(event.quantityMinor ?? "0"), 0n);
}

export async function admitAndAppendFinancialAction(params: {
  agentId: string;
  event: FinancialEventInput;
  currentDrawdownBps: number;
  admit: (usage: AgentFinancialUsage) => void;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<FinancialEvent> {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    const snapshot = readSnapshot(agentId, env);
    const existing = findIdempotent(
      snapshot.financial.events,
      params.event.eventId,
      params.event as Record<string, unknown>,
    );
    if (existing) {
      return existing;
    }
    if (
      params.event.kind !== "order" ||
      params.event.writer !== "typed-first-party-adapter" ||
      params.event.status !== "pending" ||
      !params.event.walletId ||
      !params.event.requestId ||
      !params.event.asset ||
      !params.event.quantityMinor
    ) {
      throw new Error("Financial admission requires one complete typed-adapter pending order");
    }
    const now = params.now ?? new Date();
    const day = now.toISOString().slice(0, 10);
    const rollingStart = now.getTime() - 30 * 24 * 60 * 60_000;
    const comparable = snapshot.financial.events.filter(
      (event) =>
        event.kind === "order" &&
        event.writer === "typed-first-party-adapter" &&
        event.walletId === params.event.walletId &&
        event.asset === params.event.asset &&
        event.status !== "corrected",
    );
    const daily = comparable.filter((event) => event.createdAt.slice(0, 10) === day);
    const rolling = comparable.filter((event) => Date.parse(event.createdAt) >= rollingStart);
    params.admit({
      dailySpentAtoms: sumAdmissionAmounts(daily).toString(),
      rollingSpentAtoms: sumAdmissionAmounts(rolling).toString(),
      cadenceToday: daily.length,
      currentDrawdownBps: params.currentDrawdownBps,
      financialRoot: latestDigest(snapshot.financial.events),
    });
    const event = FinancialEventSchema.parse(
      makeEvent({
        domain: "fased.agent.financial-event.v1",
        sequence: snapshot.financial.events.length + 1,
        previousDigest: latestDigest(snapshot.financial.events),
        createdAt: timestamp(params.now),
        input: params.event,
      }),
    );
    snapshot.financial.events.push(event);
    snapshot.financial.updatedAt = event.createdAt;
    snapshot.publicEvidence = derivePublicIndex({
      agentId,
      research: snapshot.research,
      financial: snapshot.financial,
      builtAt: event.createdAt,
    });
    writeJson(paths.financial, snapshot.financial);
    writeJson(paths.publicEvidence, snapshot.publicEvidence);
    return event;
  });
}

export async function rebuildPublicEvidenceIndex(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<PublicIndex> {
  const env = params.env ?? process.env;
  const agentId = requireAgentId(params.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    const research = parseResearchStore(readJson(paths.research), agentId);
    const financial = parseFinancialStore(readJson(paths.financial), agentId);
    const publicEvidence = derivePublicIndex({
      agentId,
      research,
      financial,
      builtAt: timestamp(params.now),
    });
    writeJson(paths.publicEvidence, publicEvidence);
    return parsePublicIndex(readJson(paths.publicEvidence), agentId);
  });
}

function encryptBackup(payload: BackupPayload, passphrase: string): EncryptedBackup {
  if (passphrase.length < 12) {
    throw new Error("Agent truth backup passphrase is too short");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(passphrase, salt, KEY_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("fased.agent-truth-backup.v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(stableStringify(payload), "utf8")),
    cipher.final(),
  ]);
  return {
    version: 1,
    schema: "fased.agent-truth-backup.v1",
    kdf: "scrypt",
    algorithm: "aes-256-gcm",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptBackup(raw: unknown, passphrase: string): BackupPayload {
  try {
    const encrypted = EncryptedBackupSchema.parse(raw);
    const key = scryptSync(passphrase, Buffer.from(encrypted.salt, "base64url"), KEY_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64url"));
    decipher.setAAD(Buffer.from("fased.agent-truth-backup.v1", "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    ) as BackupPayload;
  } catch (error) {
    throw new Error("Agent truth backup is unreadable", { cause: error });
  }
}

export function createAgentTruthBackup(params: {
  agentId: string;
  outputPath: string;
  passphrase: string;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!path.isAbsolute(params.outputPath)) {
    throw new Error("Backup path must be absolute");
  }
  if (fs.existsSync(params.outputPath)) {
    throw new Error("Backup path already exists");
  }
  const snapshot = readAgentTruthSnapshot({ agentId: params.agentId, env: params.env });
  const payload: BackupPayload = {
    version: 1,
    agentId: snapshot.manifest.agentId,
    manifest: snapshot.manifest,
    privateMemory: snapshot.privateMemory,
    research: snapshot.research,
    financial: snapshot.financial,
  };
  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true, mode: DIRECTORY_MODE });
  fs.writeFileSync(
    params.outputPath,
    serializeWalletState(encryptBackup(payload, params.passphrase)),
    {
      encoding: "utf8",
      mode: FILE_MODE,
      flag: "wx",
    },
  );
}

export async function restoreAgentTruthBackup(params: {
  inputPath: string;
  passphrase: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<AgentTruthSnapshot> {
  if (!path.isAbsolute(params.inputPath)) {
    throw new Error("Backup path must be absolute");
  }
  const env = params.env ?? process.env;
  const payload = decryptBackup(readJson(params.inputPath), params.passphrase);
  const agentId = requireAgentId(payload.agentId);
  const paths = storePaths(agentId, env);
  return await withFileLock(paths.root, LOCK_OPTIONS, async () => {
    if (fs.existsSync(paths.root) && fs.readdirSync(paths.root).length > 0) {
      throw new Error("Agent truth restore target is not empty");
    }
    const sourceManifest = ManifestSchema.parse(payload.manifest);
    if (sourceManifest.agentId !== agentId) {
      throw new Error("Backup Agent identity is invalid");
    }
    const privateMemory = parsePrivateStore(payload.privateMemory, agentId);
    const research = parseResearchStore(payload.research, agentId);
    const financial = parseFinancialStore(payload.financial, agentId);
    const restoredAt = timestamp(params.now);
    const manifest: StoreManifest = { ...sourceManifest, source: "restore" };
    const publicEvidence = derivePublicIndex({ agentId, research, financial, builtAt: restoredAt });
    writeSnapshot({ manifest, privateMemory, research, financial, publicEvidence }, env);
    return readSnapshot(agentId, env);
  });
}
