import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";
import { validateAgentPublicView } from "./fased-agent-public-views.generated.js";
import { stableStringify } from "./stable-stringify.js";

const MAX_EVENTS = 100_000;
const INDEX_PATH = "agent-public-view-index.v1.json";
const LOCK_OPTIONS = {
  retries: { retries: 100, factor: 1.15, minTimeout: 10, maxTimeout: 200, randomize: true },
  stale: 30_000,
} as const;

const SourceSchema = z.enum(["owner-declared", "fased-signed", "solana-finalized"]);
const ViewKindSchema = z.enum(["identity", "mining", "qualification", "evidence"]);
const IdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:@/-]+$/u);
const OrdinalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/u)
  .max(40);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CanonicalTimestampSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "must be a canonical ISO timestamp");

export const AgentPublicViewSourceEventSchema = z
  .object({
    schema: z.literal("fased.agent-public-view-source-event.v1"),
    eventId: IdentifierSchema,
    subjectId: IdentifierSchema,
    viewKind: ViewKindSchema,
    source: SourceSchema,
    sourceRef: IdentifierSchema,
    ordinal: OrdinalSchema,
    observedAt: CanonicalTimestampSchema,
    view: z.unknown(),
  })
  .strict();

export type AgentPublicViewSourceEvent = z.infer<typeof AgentPublicViewSourceEventSchema>;

export type AgentPublicViewIndexedRecord = {
  subjectId: string;
  viewKind: z.infer<typeof ViewKindSchema>;
  source: z.infer<typeof SourceSchema>;
  sourceRef: string;
  ordinal: string;
  observedAt: string;
  eventId: string;
  eventDigest: string;
  viewId: string;
  view: unknown;
};

export type AgentPublicViewIndexConflict = {
  conflictId: string;
  subjectId: string;
  viewKind: z.infer<typeof ViewKindSchema>;
  winnerEventId: string;
  otherEventId: string;
  reason: "higher-precedence-source" | "lower-precedence-source" | "same-source-update";
};

export type AgentPublicViewIndex = {
  schema: "fased.agent-public-view-index.v1";
  cursors: Record<z.infer<typeof SourceSchema>, string>;
  records: Record<string, AgentPublicViewIndexedRecord>;
  conflicts: AgentPublicViewIndexConflict[];
  events: Array<AgentPublicViewSourceEvent & { eventDigest: string }>;
  indexDigest: string;
};

const SOURCE_PRIORITY: Record<z.infer<typeof SourceSchema>, number> = {
  "owner-declared": 1,
  "fased-signed": 2,
  "solana-finalized": 3,
};

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(stableStringify(value))
    .digest("hex");
}

function emptyIndex(): AgentPublicViewIndex {
  const base = {
    schema: "fased.agent-public-view-index.v1" as const,
    cursors: {
      "owner-declared": "0",
      "fased-signed": "0",
      "solana-finalized": "0",
    },
    records: {},
    conflicts: [],
    events: [],
  };
  return { ...base, indexDigest: digest("fased.agent-public-view-index.v1", base) };
}

function indexWithoutDigest(index: AgentPublicViewIndex) {
  const { indexDigest: _indexDigest, ...value } = index;
  return value;
}

export function assertAgentPublicViewIndex(index: AgentPublicViewIndex): void {
  if (digest("fased.agent-public-view-index.v1", indexWithoutDigest(index)) !== index.indexDigest) {
    throw new Error("Agent public-view index digest is invalid");
  }
}

function recordKey(event: AgentPublicViewSourceEvent): string {
  return `${event.subjectId}:${event.viewKind}`;
}

function viewId(view: unknown): string {
  if (!view || typeof view !== "object" || Array.isArray(view)) {
    throw new Error("Agent public-view source event must contain one generated public view");
  }
  const validation = validateAgentPublicView(view);
  if (!validation.ok) {
    throw new Error(`Agent public view is invalid: ${validation.errors.join("; ")}`);
  }
  const id = (view as { viewId?: unknown }).viewId;
  if (typeof id === "string" && DigestSchema.safeParse(id).success) {
    return id;
  }
  if ((view as { schema?: unknown }).schema === "fased.agent-evidence-ref.v1") {
    return digest("fased.agent-evidence-ref.v1", view);
  }
  throw new Error("Agent public view must contain its generated viewId");
}

function assertEvidenceTrustMatchesSource(event: AgentPublicViewSourceEvent): void {
  if (
    !event.view ||
    typeof event.view !== "object" ||
    Array.isArray(event.view) ||
    (event.view as { schema?: unknown }).schema !== "fased.agent-evidence-ref.v1"
  ) {
    return;
  }
  const expected =
    event.source === "solana-finalized"
      ? "finalized"
      : event.source === "fased-signed"
        ? "signed"
        : "declared";
  if ((event.view as { trust?: unknown }).trust !== expected) {
    throw new Error("Agent evidence trust does not match its indexed source authority");
  }
}

function conflictFor(params: {
  winner: AgentPublicViewIndexedRecord;
  other: AgentPublicViewIndexedRecord;
  reason: AgentPublicViewIndexConflict["reason"];
}): AgentPublicViewIndexConflict {
  const ordered = [params.winner.eventDigest, params.other.eventDigest].toSorted();
  return {
    conflictId: digest("fased.agent-public-view-conflict.v1", {
      record: `${params.winner.subjectId}:${params.winner.viewKind}`,
      events: ordered,
    }),
    subjectId: params.winner.subjectId,
    viewKind: params.winner.viewKind,
    winnerEventId: params.winner.eventId,
    otherEventId: params.other.eventId,
    reason: params.reason,
  };
}

function applyInMemory(
  current: AgentPublicViewIndex,
  rawEvent: unknown,
): { index: AgentPublicViewIndex; record: AgentPublicViewIndexedRecord; replay: boolean } {
  assertAgentPublicViewIndex(current);
  const event = AgentPublicViewSourceEventSchema.parse(rawEvent);
  assertEvidenceTrustMatchesSource(event);
  const eventDigest = digest("fased.agent-public-view-source-event.v1", event);
  const replay = current.events.find((entry) => entry.eventId === event.eventId);
  if (replay) {
    if (replay.eventDigest !== eventDigest) {
      throw new Error("Agent public-view event ID was replayed with different immutable content");
    }
    return {
      index: current,
      record: current.records[recordKey(event)],
      replay: true,
    };
  }
  if (current.events.length >= MAX_EVENTS) {
    throw new Error("Agent public-view index event limit reached; checkpoint generation required");
  }
  if (BigInt(event.ordinal) <= BigInt(current.cursors[event.source])) {
    throw new Error("Agent public-view source cursor regressed or diverged");
  }

  const next: AgentPublicViewIndex = structuredClone(current);
  const record: AgentPublicViewIndexedRecord = {
    subjectId: event.subjectId,
    viewKind: event.viewKind,
    source: event.source,
    sourceRef: event.sourceRef,
    ordinal: event.ordinal,
    observedAt: event.observedAt,
    eventId: event.eventId,
    eventDigest,
    viewId: viewId(event.view),
    view: event.view,
  };
  const key = recordKey(event);
  const prior = next.records[key];
  if (!prior) {
    next.records[key] = record;
  } else if (prior.viewId === record.viewId) {
    if (
      SOURCE_PRIORITY[record.source] > SOURCE_PRIORITY[prior.source] ||
      (record.source === prior.source && BigInt(record.ordinal) > BigInt(prior.ordinal))
    ) {
      next.records[key] = record;
    }
  } else {
    const incomingWins =
      SOURCE_PRIORITY[record.source] > SOURCE_PRIORITY[prior.source] ||
      (record.source === prior.source && BigInt(record.ordinal) > BigInt(prior.ordinal));
    const winner = incomingWins ? record : prior;
    const other = incomingWins ? prior : record;
    const reason =
      record.source === prior.source
        ? "same-source-update"
        : incomingWins
          ? "higher-precedence-source"
          : "lower-precedence-source";
    next.records[key] = winner;
    const conflict = conflictFor({ winner, other, reason });
    if (!next.conflicts.some((entry) => entry.conflictId === conflict.conflictId)) {
      next.conflicts.push(conflict);
      next.conflicts = next.conflicts.toSorted((left, right) =>
        left.conflictId.localeCompare(right.conflictId),
      );
    }
  }
  next.cursors[event.source] = event.ordinal;
  next.events.push({ ...event, eventDigest });
  next.indexDigest = digest("fased.agent-public-view-index.v1", indexWithoutDigest(next));
  return { index: next, record: next.records[key], replay: false };
}

function indexPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "agent-public-index", INDEX_PATH);
}

function readIndexFile(env: NodeJS.ProcessEnv): AgentPublicViewIndex {
  const filePath = indexPath(env);
  if (!fs.existsSync(filePath)) {
    return emptyIndex();
  }
  const index = JSON.parse(fs.readFileSync(filePath, "utf8")) as AgentPublicViewIndex;
  assertAgentPublicViewIndex(index);
  return index;
}

export function readAgentPublicViewIndex(params: {
  env?: NodeJS.ProcessEnv;
}): AgentPublicViewIndex {
  return readIndexFile(params.env ?? process.env);
}

export async function applyAgentPublicViewSourceEvent(params: {
  event: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  record: AgentPublicViewIndexedRecord;
  replay: boolean;
  indexDigest: string;
}> {
  const env = params.env ?? process.env;
  const filePath = indexPath(env);
  return await withFileLock(filePath, LOCK_OPTIONS, async () => {
    const applied = applyInMemory(readIndexFile(env), params.event);
    if (!applied.replay) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      writeWalletStateFileAtomically(filePath, serializeWalletState(applied.index));
    }
    return {
      record: applied.record,
      replay: applied.replay,
      indexDigest: applied.index.indexDigest,
    };
  });
}

export function rebuildAgentPublicViewIndex(
  events: readonly AgentPublicViewSourceEvent[],
): AgentPublicViewIndex {
  return events.reduce((index, event) => applyInMemory(index, event).index, emptyIndex());
}
