import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import type { AgentConfig } from "../config/types.agents.js";
import { withFileLock } from "../infra/file-lock.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";
import {
  AGENT_PROFILE_KINDS,
  AGENT_PROFILE_SCHEMAS,
  createDenyAllCapitalPolicy,
  type AgentProfileKind,
  type AgentProfilePayloadByKind,
} from "./agent-profile-contracts.js";
import { stableStringify } from "./stable-stringify.js";

const STORE_VERSION = 1;
const GENERATION_VERSION = 1;
const DIGEST_DOMAIN = "fased.agent.profile-generation.v1";
const HEX_256 = /^[a-f0-9]{64}$/u;
const MAX_PROFILE_GENERATIONS = 1_024;
const MUTATION_LOCK_OPTIONS = {
  retries: { retries: 100, factor: 1.15, minTimeout: 10, maxTimeout: 200, randomize: true },
  stale: 30_000,
} as const;

export type AgentProfileGeneration<K extends AgentProfileKind = AgentProfileKind> = {
  version: 1;
  agentId: string;
  kind: K;
  generation: number;
  previousDigest: string | null;
  digest: string;
  createdAt: string;
  source: "creation" | "legacy-migration" | "owner" | "system";
  payload: AgentProfilePayloadByKind[K];
};

export type AgentProfileReference = {
  generation: number;
  digest: string;
};

export type AgentProfileState = {
  version: 1;
  agentId: string;
  active: Record<AgentProfileKind, AgentProfileReference>;
  history: Record<AgentProfileKind, AgentProfileGeneration[]>;
  createdAt: string;
  updatedAt: string;
};

type AgentProfileStore = {
  version: 1;
  agents: Record<string, AgentProfileState>;
  updatedAt: string;
};

const GenerationEnvelopeSchema = z
  .object({
    version: z.literal(GENERATION_VERSION),
    agentId: z.string().min(1).max(64),
    kind: z.enum(AGENT_PROFILE_KINDS),
    generation: z.number().int().positive().max(MAX_PROFILE_GENERATIONS),
    previousDigest: z.string().regex(HEX_256).nullable(),
    digest: z.string().regex(HEX_256),
    createdAt: z.string(),
    source: z.enum(["creation", "legacy-migration", "owner", "system"]),
    payload: z.unknown(),
  })
  .strict();

const StoreEnvelopeSchema = z
  .object({
    version: z.literal(STORE_VERSION),
    agents: z.record(z.string(), z.unknown()),
    updatedAt: z.string(),
  })
  .strict();

const StateEnvelopeSchema = z
  .object({
    version: z.literal(STORE_VERSION),
    agentId: z.string().min(1).max(64),
    active: z.record(z.string(), z.unknown()),
    history: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const ProfileReferenceSchema = z
  .object({
    generation: z.number().int().positive().max(MAX_PROFILE_GENERATIONS),
    digest: z.string().regex(HEX_256),
  })
  .strict();

function storePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "agent-profiles", "profiles.v1.json");
}

function nowIso(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

function requireCanonicalAgentId(value: string): string {
  const normalized = normalizeAgentId(value);
  if (!value.trim() || normalized !== value.trim().toLowerCase()) {
    throw new Error("Agent profile id must be canonical");
  }
  return normalized;
}

function requireCanonicalTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function generationDigest<K extends AgentProfileKind>(
  value: Omit<AgentProfileGeneration<K>, "digest">,
): string {
  return createHash("sha256")
    .update(DIGEST_DOMAIN)
    .update("\0")
    .update(stableStringify(value))
    .digest("hex");
}

function parseGeneration<K extends AgentProfileKind>(params: {
  raw: unknown;
  agentId: string;
  kind: K;
  expectedGeneration: number;
  expectedPreviousDigest: string | null;
}): AgentProfileGeneration<K> {
  const envelope = GenerationEnvelopeSchema.parse(params.raw);
  if (
    envelope.agentId !== params.agentId ||
    envelope.kind !== params.kind ||
    envelope.generation !== params.expectedGeneration ||
    envelope.previousDigest !== params.expectedPreviousDigest
  ) {
    throw new Error(`Agent ${params.kind} profile generation chain is invalid`);
  }
  requireCanonicalTimestamp(envelope.createdAt, "profile generation timestamp");
  const payload = AGENT_PROFILE_SCHEMAS[params.kind].parse(
    envelope.payload,
  ) as AgentProfilePayloadByKind[K];
  const generation: AgentProfileGeneration<K> = { ...envelope, kind: params.kind, payload };
  const { digest, ...unsigned } = generation;
  if (generationDigest(unsigned) !== digest) {
    throw new Error(`Agent ${params.kind} profile digest is invalid`);
  }
  return generation;
}

function parseState(raw: unknown, agentId: string): AgentProfileState {
  const value = StateEnvelopeSchema.parse(raw);
  if (value.agentId !== agentId) {
    throw new Error("Agent profile state has an unsupported shape");
  }
  requireCanonicalTimestamp(value.createdAt, "profile state creation timestamp");
  requireCanonicalTimestamp(value.updatedAt, "profile state update timestamp");
  const expectedKinds = new Set<string>(AGENT_PROFILE_KINDS);
  if (
    Object.keys(value.active).length !== AGENT_PROFILE_KINDS.length ||
    Object.keys(value.history).length !== AGENT_PROFILE_KINDS.length ||
    Object.keys(value.active).some((kind) => !expectedKinds.has(kind)) ||
    Object.keys(value.history).some((kind) => !expectedKinds.has(kind))
  ) {
    throw new Error("Agent profile state contains unsupported profile kinds");
  }
  const active = {} as AgentProfileState["active"];
  const history = {} as AgentProfileState["history"];
  for (const kind of AGENT_PROFILE_KINDS) {
    const rawHistory = value.history[kind];
    if (
      !Array.isArray(rawHistory) ||
      rawHistory.length < 1 ||
      rawHistory.length > MAX_PROFILE_GENERATIONS
    ) {
      throw new Error(`Agent ${kind} profile history is invalid`);
    }
    let previousDigest: string | null = null;
    const parsedHistory = rawHistory.map((rawGeneration, index) => {
      const generation = parseGeneration({
        raw: rawGeneration,
        agentId,
        kind,
        expectedGeneration: index + 1,
        expectedPreviousDigest: previousDigest,
      });
      previousDigest = generation.digest;
      return generation;
    });
    const rawActive = ProfileReferenceSchema.parse(value.active[kind]);
    const latest = parsedHistory.at(-1);
    if (
      !latest ||
      rawActive.generation !== latest.generation ||
      rawActive.digest !== latest.digest
    ) {
      throw new Error(`Agent ${kind} active profile does not match immutable history`);
    }
    active[kind] = { generation: latest.generation, digest: latest.digest };
    history[kind] = parsedHistory;
  }
  return {
    version: STORE_VERSION,
    agentId,
    active,
    history,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function emptyStore(timestamp: string): AgentProfileStore {
  return { version: STORE_VERSION, agents: {}, updatedAt: timestamp };
}

function readStore(env: NodeJS.ProcessEnv, timestamp = nowIso(undefined)): AgentProfileStore {
  const filePath = storePath(env);
  if (!fs.existsSync(filePath)) {
    return emptyStore(timestamp);
  }
  try {
    const envelope = StoreEnvelopeSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
    requireCanonicalTimestamp(envelope.updatedAt, "profile store update timestamp");
    const agents: Record<string, AgentProfileState> = {};
    for (const [rawAgentId, rawState] of Object.entries(envelope.agents)) {
      const agentId = requireCanonicalAgentId(rawAgentId);
      agents[agentId] = parseState(rawState, agentId);
    }
    return { version: STORE_VERSION, agents, updatedAt: envelope.updatedAt };
  } catch (error) {
    throw new Error("Agent profile store is unreadable; refusing profile mutation", {
      cause: error,
    });
  }
}

function writeStore(store: AgentProfileStore, env: NodeJS.ProcessEnv): void {
  const filePath = storePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeWalletStateFileAtomically(filePath, serializeWalletState(store));
}

function taskModelRoutes(config: AgentConfig | undefined): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const [role, model] of Object.entries(config?.taskModels ?? {})) {
    const normalized = typeof model === "string" ? model.trim() : "";
    if (normalized) {
      routes[role] = normalized;
    }
  }
  return routes;
}

export function createLegacyProfilePayloads(params: {
  agentId: string;
  config?: AgentConfig;
}): AgentProfilePayloadByKind {
  const agentId = requireCanonicalAgentId(params.agentId);
  const displayName =
    params.config?.identity?.name?.trim() || params.config?.name?.trim() || agentId;
  return {
    persona: {
      schema: "fased.agent.persona-profile.v1",
      displayName,
      biography: "",
      tone: "owner-defined",
      interests: [],
      socialBoundaries: [],
    },
    research: {
      schema: "fased.agent.research-profile.v1",
      sourceAllowlist: [],
      horizons: [],
      methods: [],
      citationRequired: true,
      uncertaintyRequired: true,
    },
    strategy: {
      schema: "fased.agent.strategy-profile.v1",
      miningAllocationMethod: "owner-controlled",
      watchlists: [],
      hypotheses: [],
      entryExitRules: [],
      capabilityPacks: [],
      taskModelRoutes: taskModelRoutes(params.config),
    },
    capitalPolicy: createDenyAllCapitalPolicy(),
  };
}

function createGeneration<K extends AgentProfileKind>(params: {
  agentId: string;
  kind: K;
  generation: number;
  previousDigest: string | null;
  createdAt: string;
  source: AgentProfileGeneration["source"];
  payload: AgentProfilePayloadByKind[K];
}): AgentProfileGeneration<K> {
  const unsigned: Omit<AgentProfileGeneration<K>, "digest"> = {
    version: GENERATION_VERSION,
    agentId: params.agentId,
    kind: params.kind,
    generation: params.generation,
    previousDigest: params.previousDigest,
    createdAt: params.createdAt,
    source: params.source,
    payload: AGENT_PROFILE_SCHEMAS[params.kind].parse(
      params.payload,
    ) as AgentProfilePayloadByKind[K],
  };
  return { ...unsigned, digest: generationDigest(unsigned) };
}

function createState(params: {
  agentId: string;
  config?: AgentConfig;
  source: "creation" | "legacy-migration";
  timestamp: string;
  initialPayloads?: AgentProfilePayloadByKind;
}): AgentProfileState {
  if (params.initialPayloads && params.source !== "creation") {
    throw new Error("Initial Agent profile payloads are permitted only during creation");
  }
  const payloads =
    params.initialPayloads ??
    createLegacyProfilePayloads({ agentId: params.agentId, config: params.config });
  if (params.source === "creation" && payloads.capitalPolicy.mode !== "deny-all") {
    throw new Error("New Agent profiles must begin with deny-all financial authority");
  }
  const active = {} as AgentProfileState["active"];
  const history = {} as AgentProfileState["history"];
  for (const kind of AGENT_PROFILE_KINDS) {
    const generation = createGeneration({
      agentId: params.agentId,
      kind,
      generation: 1,
      previousDigest: null,
      createdAt: params.timestamp,
      source: params.source,
      payload: payloads[kind],
    });
    active[kind] = { generation: 1, digest: generation.digest };
    history[kind] = [generation];
  }
  return {
    version: STORE_VERSION,
    agentId: params.agentId,
    active,
    history,
    createdAt: params.timestamp,
    updatedAt: params.timestamp,
  };
}

export function readAgentProfileState(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): AgentProfileState | undefined {
  const agentId = requireCanonicalAgentId(params.agentId);
  return readStore(params.env ?? process.env).agents[agentId];
}

export function readActiveAgentProfile<K extends AgentProfileKind>(
  state: AgentProfileState,
  kind: K,
): AgentProfilePayloadByKind[K] {
  const generation = state.history[kind].at(-1);
  if (!generation || generation.kind !== kind) {
    throw new Error(`Agent ${kind} active profile is unavailable`);
  }
  return AGENT_PROFILE_SCHEMAS[kind].parse(generation.payload) as AgentProfilePayloadByKind[K];
}

export async function ensureAgentProfileState(params: {
  agentId: string;
  config?: AgentConfig;
  source?: "creation" | "legacy-migration";
  env?: NodeJS.ProcessEnv;
  now?: Date;
  initialPayloads?: AgentProfilePayloadByKind;
}): Promise<AgentProfileState> {
  const agentId = requireCanonicalAgentId(params.agentId);
  const states = await ensureAgentProfileStates({
    agents: [
      {
        agentId,
        config: params.config,
        source: params.source ?? "legacy-migration",
        initialPayloads: params.initialPayloads,
      },
    ],
    env: params.env,
    now: params.now,
  });
  const state = states[agentId];
  if (!state) {
    throw new Error("Agent profile initialization did not return the requested Agent");
  }
  return state;
}

export async function ensureAgentProfileStates(params: {
  agents: Array<{
    agentId: string;
    config?: AgentConfig;
    source: "creation" | "legacy-migration";
    initialPayloads?: AgentProfilePayloadByKind;
  }>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<Record<string, AgentProfileState>> {
  const env = params.env ?? process.env;
  const timestamp = nowIso(params.now);
  const normalized = params.agents.map((entry) => ({
    ...entry,
    agentId: requireCanonicalAgentId(entry.agentId),
  }));
  if (new Set(normalized.map((entry) => entry.agentId)).size !== normalized.length) {
    throw new Error("Agent profile initialization contains duplicate Agent ids");
  }
  if (normalized.length === 0) {
    return {};
  }
  const filePath = storePath(env);
  return await withFileLock(filePath, MUTATION_LOCK_OPTIONS, async () => {
    const store = readStore(env, timestamp);
    const states: Record<string, AgentProfileState> = {};
    let changed = false;
    for (const entry of normalized) {
      const existing = store.agents[entry.agentId];
      const state =
        existing ??
        createState({
          agentId: entry.agentId,
          config: entry.config,
          source: entry.source,
          timestamp,
          initialPayloads: entry.initialPayloads,
        });
      if (!existing) {
        store.agents[entry.agentId] = state;
        changed = true;
      }
      states[entry.agentId] = state;
    }
    if (changed) {
      store.updatedAt = timestamp;
      writeStore(store, env);
    }
    return states;
  });
}

export async function appendAgentProfileGeneration<K extends AgentProfileKind>(params: {
  agentId: string;
  kind: K;
  expectedGeneration: number;
  expectedDigest: string;
  payload: AgentProfilePayloadByKind[K];
  source: "owner" | "system";
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<AgentProfileState> {
  const env = params.env ?? process.env;
  const agentId = requireCanonicalAgentId(params.agentId);
  const timestamp = nowIso(params.now);
  const filePath = storePath(env);
  return await withFileLock(filePath, MUTATION_LOCK_OPTIONS, async () => {
    const store = readStore(env, timestamp);
    const state = store.agents[agentId];
    if (!state) {
      throw new Error("Agent profile state must be initialized before update");
    }
    const current = state.active[params.kind];
    if (
      current.generation !== params.expectedGeneration ||
      current.digest !== params.expectedDigest
    ) {
      throw new Error("Agent profile generation changed; reload before updating");
    }
    if (current.generation >= MAX_PROFILE_GENERATIONS) {
      throw new Error("Agent profile generation limit reached");
    }
    const generation = createGeneration({
      agentId,
      kind: params.kind,
      generation: current.generation + 1,
      previousDigest: current.digest,
      createdAt: timestamp,
      source: params.source,
      payload: params.payload,
    });
    state.history[params.kind].push(generation);
    state.active[params.kind] = {
      generation: generation.generation,
      digest: generation.digest,
    };
    state.updatedAt = timestamp;
    store.updatedAt = timestamp;
    writeStore(store, env);
    return parseState(state, agentId);
  });
}
