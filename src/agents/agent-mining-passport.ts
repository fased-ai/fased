import {
  assertAgentPublicViewIndex,
  type AgentPublicViewIndex,
  type AgentPublicViewIndexConflict,
  type AgentPublicViewIndexedRecord,
} from "./agent-public-view-indexer.js";
import {
  type AgentEvidenceRef,
  type AgentIdentityView,
  type AgentMiningView,
  type AgentQualificationView,
  validateAgentPublicView,
} from "./fased-agent-public-views.generated.js";
import { stableStringify } from "./stable-stringify.js";

export type AgentMiningPassportState =
  | "network_only"
  | "identity_only"
  | "mining_only"
  | "bound_active"
  | "stale"
  | "paused"
  | "draining"
  | "drained"
  | "retired"
  | "conflict";

export type AgentMiningPassportSource = Pick<
  AgentPublicViewIndexedRecord,
  "viewKind" | "source" | "sourceRef" | "ordinal" | "observedAt" | "eventId" | "viewId"
>;

export type AgentMiningPassport = {
  schema: "fased.agent-mining-passport.v1";
  subjectId: string;
  state: AgentMiningPassportState;
  freshness: "fresh" | "stale";
  integrity: "verified" | "conflict";
  lookup: {
    fasedAgentRecord?: string;
    networkAgentId?: string;
    satAgentRecord?: string;
    permanentMiningId?: string;
  };
  identity?: AgentIdentityView;
  mining?: AgentMiningView;
  qualification?: AgentQualificationView;
  evidence: AgentEvidenceRef[];
  conflicts: AgentPublicViewIndexConflict[];
  sources: AgentMiningPassportSource[];
};

export type AgentMiningPassportDirectory = {
  schema: "fased.agent-mining-passport-directory.v1";
  indexDigest: string;
  sourceCursors: AgentPublicViewIndex["cursors"];
  passports: AgentMiningPassport[];
};

export type AgentMiningPassportLookup =
  | { subjectId: string }
  | { fasedAgentRecord: string }
  | { networkAgentId: string }
  | { satAgentRecord: string }
  | { permanentMiningId: string };

function validatedView<T>(
  record: AgentPublicViewIndexedRecord | undefined,
  schema: T extends AgentIdentityView
    ? AgentIdentityView["schema"]
    : T extends AgentMiningView
      ? AgentMiningView["schema"]
      : AgentQualificationView["schema"],
): T | undefined {
  if (!record) {
    return undefined;
  }
  const result = validateAgentPublicView(record.view);
  if (!result.ok) {
    throw new Error(`Indexed Agent public view is invalid: ${result.errors.join("; ")}`);
  }
  if (result.value.schema !== schema) {
    throw new Error(`Indexed ${record.viewKind} record contains ${result.value.schema}`);
  }
  return result.value as T;
}

function evidenceFrom(records: readonly AgentPublicViewIndexedRecord[]): AgentEvidenceRef[] {
  const evidence = new Map<string, AgentEvidenceRef>();
  for (const record of records) {
    const validation = validateAgentPublicView(record.view);
    if (!validation.ok) {
      throw new Error(`Indexed Agent public view is invalid: ${validation.errors.join("; ")}`);
    }
    const entries =
      validation.value.schema === "fased.agent-evidence-ref.v1"
        ? [validation.value]
        : validation.value.evidence;
    for (const entry of entries) {
      const prior = evidence.get(entry.evidenceId);
      if (prior && stableStringify(prior) !== stableStringify(entry)) {
        throw new Error(`Evidence ${entry.evidenceId} has conflicting current representations`);
      }
      evidence.set(entry.evidenceId, entry);
    }
  }
  return [...evidence.values()].toSorted((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId),
  );
}

function passportState(params: {
  identity?: AgentIdentityView;
  mining?: AgentMiningView;
  qualification?: AgentQualificationView;
  conflicts: readonly AgentPublicViewIndexConflict[];
}): AgentMiningPassportState {
  const { identity, mining, qualification } = params;
  if (
    params.conflicts.some((conflict) => conflict.reason !== "same-source-update") ||
    identity?.integrity === "conflict" ||
    mining?.integrity === "conflict" ||
    qualification?.status === "conflict"
  ) {
    return "conflict";
  }
  if (identity?.lifecycle === "retired" || mining?.lifecycle === "retired") {
    return "retired";
  }
  if (mining?.entryState === "drained") {
    return "drained";
  }
  if (mining?.entryState === "draining") {
    return "draining";
  }
  if (mining?.entryState === "paused") {
    return "paused";
  }
  if (
    identity?.freshness === "stale" ||
    identity?.runtime?.state === "stale" ||
    mining?.freshness === "stale"
  ) {
    return "stale";
  }
  if (identity && mining) {
    return "bound_active";
  }
  if (mining) {
    return "mining_only";
  }
  if (identity?.lifecycle === "network_only") {
    return "network_only";
  }
  return "identity_only";
}

function projectPassport(index: AgentPublicViewIndex, subjectId: string): AgentMiningPassport {
  const records = Object.values(index.records)
    .filter((record) => record.subjectId === subjectId)
    .toSorted((left, right) => left.viewKind.localeCompare(right.viewKind));
  const byKind = new Map(records.map((record) => [record.viewKind, record]));
  const identity = validatedView<AgentIdentityView>(
    byKind.get("identity"),
    "fased.agent-identity-view.v1",
  );
  const mining = validatedView<AgentMiningView>(byKind.get("mining"), "fased.agent-mining-view.v1");
  const qualification = validatedView<AgentQualificationView>(
    byKind.get("qualification"),
    "fased.agent-qualification-view.v1",
  );
  const conflicts = index.conflicts
    .filter((conflict) => conflict.subjectId === subjectId)
    .toSorted((left, right) => left.conflictId.localeCompare(right.conflictId));
  const state = passportState({ identity, mining, qualification, conflicts });
  const stale =
    state === "stale" || identity?.freshness === "stale" || mining?.freshness === "stale";
  return {
    schema: "fased.agent-mining-passport.v1",
    subjectId,
    state,
    freshness: stale ? "stale" : "fresh",
    integrity: state === "conflict" ? "conflict" : "verified",
    lookup: {
      ...(identity?.fasedAgentRecord ? { fasedAgentRecord: identity.fasedAgentRecord } : {}),
      ...(identity?.networkAgentId ? { networkAgentId: identity.networkAgentId } : {}),
      ...(mining?.satAgentRecord ? { satAgentRecord: mining.satAgentRecord } : {}),
      ...(mining?.permanentMiningId ? { permanentMiningId: mining.permanentMiningId } : {}),
    },
    ...(identity ? { identity } : {}),
    ...(mining ? { mining } : {}),
    ...(qualification ? { qualification } : {}),
    evidence: evidenceFrom(records),
    conflicts,
    sources: records.map(
      ({ viewKind, source, sourceRef, ordinal, observedAt, eventId, viewId }) => ({
        viewKind,
        source,
        sourceRef,
        ordinal,
        observedAt,
        eventId,
        viewId,
      }),
    ),
  };
}

export function projectAgentMiningPassportDirectory(
  index: AgentPublicViewIndex,
): AgentMiningPassportDirectory {
  assertAgentPublicViewIndex(index);
  const subjectIds = [...new Set(Object.values(index.records).map((record) => record.subjectId))]
    .filter((subjectId) =>
      Object.values(index.records).some(
        (record) => record.subjectId === subjectId && record.viewKind !== "evidence",
      ),
    )
    .toSorted();
  return {
    schema: "fased.agent-mining-passport-directory.v1",
    indexDigest: index.indexDigest,
    sourceCursors: { ...index.cursors },
    passports: subjectIds.map((subjectId) => projectPassport(index, subjectId)),
  };
}

export function findAgentMiningPassport(
  directory: AgentMiningPassportDirectory,
  lookup: AgentMiningPassportLookup,
): AgentMiningPassport | undefined {
  const [field, value] = Object.entries(lookup)[0] ?? [];
  if (!field || !value || Object.keys(lookup).length !== 1) {
    throw new Error("Agent Mining passport lookup requires exactly one non-empty identifier");
  }
  const matches = directory.passports.filter((passport) =>
    field === "subjectId"
      ? passport.subjectId === value
      : passport.lookup[field as keyof AgentMiningPassport["lookup"]] === value,
  );
  if (matches.length > 1) {
    throw new Error(`Agent Mining passport lookup is ambiguous for ${field}`);
  }
  return matches[0];
}
