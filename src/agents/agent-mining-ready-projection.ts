import { createHash } from "node:crypto";
import { readActiveAgentProfile, type AgentProfileState } from "./agent-profile-store.js";
import type { AgentTruthSnapshot } from "./agent-truth-store.js";
import {
  verifySignedFirstPartyCapabilityManifest,
  type SignedFirstPartyCapabilityManifest,
} from "./capability-manifest.js";
import {
  validateAgentPublicView,
  type AgentEvidenceRef,
  type AgentIdentityView,
  type AgentMiningView,
  type AgentQualificationGate,
  type AgentQualificationView,
  type AgentRuntimeView,
  type AgentViewConflict,
} from "./fased-agent-public-views.generated.js";
import type { FinalizedFinancialAgentReadback } from "./financial-agent-binding.js";
import { stableStringify } from "./stable-stringify.js";

const REQUIRED_MINING_PACKS = ["miner", "risk-officer", "allocator", "public-host"] as const;
const REQUIRED_MINING_READS = [
  "sat.mining-status",
  "sat.miner-capital",
  "sat.pending-cycles",
  "sat.claims",
  "sat.keeper-status",
] as const;
const FRESHNESS_WINDOW_MS = 5 * 60 * 1_000;

type PublicMiningSnapshot = Omit<
  AgentMiningView,
  "schema" | "viewId" | "observedAt" | "freshness" | "integrity" | "conflicts" | "evidence"
>;

export type MiningReadyPrivateState = {
  channelAllocations: string[];
  allocationDigestSha256: string;
  allocationState: "draft" | "committed_encrypted" | "revealed";
  configuredCadenceCycles: string;
  recommendedCadenceCycles: string;
  projectedRunwayCycles: string;
  projectedRunwayDays: string;
  nextEligibleCycleId: string;
  operatingReserveState: "healthy" | "low" | "exhausted";
  lifecycleState:
    | "idle"
    | "commit_pending"
    | "reveal_pending"
    | "recovery_required"
    | "claim_pending"
    | "draining"
    | "drained";
};

export type MiningReadyAgentProjection = {
  schema: "fased.agent.mining-ready-projection.v1";
  agentId: string;
  mode: "observe" | "propose" | "guarded-auto";
  profiles: AgentProfileState["active"];
  capability: {
    capabilityId: string;
    version: number;
    adapterId: string;
    adapterOperations: string[];
    signerKeyId: string;
  };
  authority: {
    capitalPolicyMode: "deny-all" | "allowlisted";
    ownerApprovalRequired: boolean;
  };
  truth: {
    researchRoot: string | null;
    financialRoot: string | null;
    publicEvidenceBuiltAt: string;
  };
  identity?: AgentIdentityView;
  mining: AgentMiningView;
  qualification: AgentQualificationView;
  privateMining: MiningReadyPrivateState;
};

function canonicalTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function integerString(value: string, label: string): string {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be an unsigned integer string`);
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function withViewId<T extends { viewId: string }>(value: Omit<T, "viewId">): T {
  return { ...value, viewId: digest(value) } as T;
}

function validateView<T>(value: T, label: string): T {
  const result = validateAgentPublicView(value);
  if (!result.ok) {
    throw new Error(`${label} is invalid: ${result.errors.join("; ")}`);
  }
  return value;
}

function validateEvidence(evidence: AgentEvidenceRef[]): AgentEvidenceRef[] {
  const ids = new Set<string>();
  for (const entry of evidence) {
    validateView(entry, "Agent evidence reference");
    if (ids.has(entry.evidenceId)) {
      throw new Error("Agent evidence references contain a duplicate evidenceId");
    }
    ids.add(entry.evidenceId);
  }
  return evidence;
}

function validatePrivateMining(value: MiningReadyPrivateState): MiningReadyPrivateState {
  if (value.channelAllocations.length !== 16) {
    throw new Error("Mining-ready Agent requires exactly 16 channel allocations");
  }
  let total = 0n;
  for (const [index, allocation] of value.channelAllocations.entries()) {
    total += BigInt(integerString(allocation, `channel allocation ${index}`));
  }
  if (total === 0n) {
    throw new Error("Mining-ready Agent channel allocation cannot be empty");
  }
  if (!/^[0-9a-f]{64}$/u.test(value.allocationDigestSha256)) {
    throw new Error("Mining-ready Agent allocation digest is invalid");
  }
  for (const [label, integer] of [
    ["configured cadence", value.configuredCadenceCycles],
    ["recommended cadence", value.recommendedCadenceCycles],
    ["runway cycles", value.projectedRunwayCycles],
    ["runway days", value.projectedRunwayDays],
    ["next eligible cycle", value.nextEligibleCycleId],
  ] as const) {
    integerString(integer, label);
  }
  return value;
}

function identityConflict(params: {
  identity?: FinalizedFinancialAgentReadback;
  mining: PublicMiningSnapshot;
}): AgentViewConflict | undefined {
  const binding = params.identity?.miningBinding;
  if (!binding) {
    return undefined;
  }
  if (
    binding.satAgentRecord === params.mining.satAgentRecord &&
    binding.satcoinProgramId === params.mining.satcoinProgramId &&
    binding.permanentMiningId === params.mining.permanentMiningId
  ) {
    return undefined;
  }
  return {
    code: "identity:mining-binding-mismatch",
    message: "Finalized AgentMiningBinding disagrees with the selected Satcoin Mining record.",
    evidenceIds: [],
  };
}

function buildIdentityView(params: {
  identity: FinalizedFinancialAgentReadback;
  runtime?: AgentRuntimeView;
  evidence: AgentEvidenceRef[];
  observedAt: string;
  freshness: "fresh" | "stale";
  conflict?: AgentViewConflict;
}): AgentIdentityView {
  const conflicts = params.conflict ? [params.conflict] : [];
  return validateView(
    withViewId<AgentIdentityView>({
      schema: "fased.agent-identity-view.v1",
      observedAt: params.observedAt,
      freshness: params.freshness,
      integrity: params.conflict ? "conflict" : "verified",
      lifecycle: params.identity.status,
      fasedAgentRecord: params.identity.fasedAgentRecord,
      controller: params.identity.controller,
      recoveryAuthority: params.identity.recoveryAuthority,
      authorityGeneration: params.identity.authorityGeneration,
      createdSlot: params.identity.createdSlot,
      createdUnixTimestamp: params.identity.createdUnixTimestamp,
      ...(params.identity.namespaceBinding
        ? {
            networkAgentId: params.identity.namespaceBinding.networkAgentId,
            namespace: {
              binding: params.identity.namespaceBinding.address,
              networkAgentId: params.identity.namespaceBinding.networkAgentId,
              name: params.identity.namespaceBinding.name,
              handle: params.identity.namespaceBinding.handle,
              ticker: params.identity.namespaceBinding.ticker,
              boundSlot: params.identity.namespaceBinding.boundSlot.toString(),
              recordAuthorityGeneration: params.identity.namespaceBinding.recordAuthorityGeneration,
            },
          }
        : {}),
      ...(params.identity.miningBinding
        ? {
            miningBinding: {
              binding: params.identity.miningBinding.address,
              satAgentRecord: params.identity.miningBinding.satAgentRecord,
              satcoinProgramId: params.identity.miningBinding.satcoinProgramId,
              permanentMiningId: params.identity.miningBinding.permanentMiningId,
              boundSlot: params.identity.miningBinding.boundSlot.toString(),
            },
          }
        : {}),
      ...(params.runtime ? { runtime: params.runtime } : {}),
      conflicts,
      evidence: params.evidence,
    }),
    "Agent identity view",
  );
}

function gate(
  gateId: string,
  status: AgentQualificationGate["status"],
  observed: string,
  required: string,
): AgentQualificationGate {
  return { gate: gateId, status, observed, required, evidenceIds: [] };
}

export function projectMiningReadyAgent(params: {
  agentId: string;
  mode: "observe" | "propose" | "guarded-auto";
  profileState: AgentProfileState;
  truth: AgentTruthSnapshot;
  capabilityEnvelope: SignedFirstPartyCapabilityManifest;
  trustedCapabilitySignerKeys: Readonly<Record<string, string>>;
  identity?: FinalizedFinancialAgentReadback;
  runtime?: AgentRuntimeView;
  mining: PublicMiningSnapshot;
  miningObservedAt: string;
  evidence: AgentEvidenceRef[];
  privateMining: MiningReadyPrivateState;
  now?: Date;
}): MiningReadyAgentProjection {
  if (
    params.profileState.agentId !== params.agentId ||
    params.truth.manifest.agentId !== params.agentId
  ) {
    throw new Error("Mining-ready Agent identity does not match its profile/truth stores");
  }
  const strategy = readActiveAgentProfile(params.profileState, "strategy");
  const capitalPolicy = readActiveAgentProfile(params.profileState, "capitalPolicy");
  const missingPacks = REQUIRED_MINING_PACKS.filter(
    (pack) => !strategy.capabilityPacks.includes(pack),
  );
  if (missingPacks.length > 0) {
    throw new Error(`Mining-ready Agent is missing capability packs: ${missingPacks.join(", ")}`);
  }
  const capability = verifySignedFirstPartyCapabilityManifest({
    envelope: params.capabilityEnvelope,
    trustedSignerKeys: params.trustedCapabilitySignerKeys,
    now: params.now,
  });
  const missingManifestPacks = REQUIRED_MINING_PACKS.filter(
    (pack) => !capability.manifest.capabilityPacks.includes(pack),
  );
  const missingReads = REQUIRED_MINING_READS.filter(
    (operation) => !capability.manifest.adapterOperations.includes(operation),
  );
  if (missingManifestPacks.length > 0 || missingReads.length > 0) {
    throw new Error("Mining-ready Agent manifest does not cover the complete read projection");
  }

  const observedAt = canonicalTimestamp(params.miningObservedAt, "Mining observation");
  const now = params.now ?? new Date();
  const ageMs = now.getTime() - Date.parse(observedAt);
  if (ageMs < 0) {
    throw new Error("Mining observation cannot be in the future");
  }
  const freshness = ageMs <= FRESHNESS_WINDOW_MS ? "fresh" : "stale";
  const evidence = validateEvidence(params.evidence);
  const privateMining = validatePrivateMining(params.privateMining);
  const conflict = identityConflict({ identity: params.identity, mining: params.mining });
  const conflicts = conflict ? [conflict] : [];
  const mining = validateView(
    withViewId<AgentMiningView>({
      schema: "fased.agent-mining-view.v1",
      observedAt,
      freshness,
      integrity: conflict ? "conflict" : "verified",
      ...params.mining,
      conflicts,
      evidence,
    }),
    "Agent Mining view",
  );
  const identity = params.identity
    ? buildIdentityView({
        identity: params.identity,
        runtime: params.runtime,
        evidence,
        observedAt,
        freshness,
        conflict,
      })
    : undefined;

  const profilePacksGate = gate(
    "profile:mining-capability-packs",
    "pass",
    REQUIRED_MINING_PACKS.join(","),
    REQUIRED_MINING_PACKS.join(","),
  );
  const manifestGate = gate(
    "manifest:mining-read-contract",
    "pass",
    capability.manifest.adapterId,
    "trusted-signed-first-party",
  );
  const truthGate = gate(
    "truth:objective-ledger-reconciled",
    "pass",
    params.truth.publicEvidence.sourceRoots.financial ?? "empty-valid-ledger",
    "reconstructable-public-evidence",
  );
  const activeGate = gate(
    "mining:record-active",
    params.mining.lifecycle === "active" ? "pass" : "fail",
    params.mining.lifecycle,
    "active",
  );
  const entryGate = gate(
    "mining:new-entry",
    params.mining.entryState === "enabled" ? "pass" : "fail",
    params.mining.entryState,
    "enabled",
  );
  const policyGate = gate(
    "policy:selected-mode",
    params.mode !== "guarded-auto" || capitalPolicy.mode === "allowlisted" ? "pass" : "fail",
    `${params.mode}:${capitalPolicy.mode}`,
    params.mode === "guarded-auto" ? "guarded-auto:allowlisted" : `${params.mode}:any`,
  );
  const gates = [profilePacksGate, manifestGate, truthGate, activeGate, entryGate, policyGate];
  const qualificationStatus = conflict
    ? "conflict"
    : freshness === "stale"
      ? "pending"
      : gates.some((entry) => entry.status === "fail")
        ? "fail"
        : "pass";
  const qualification = validateView(
    withViewId<AgentQualificationView>({
      schema: "fased.agent-qualification-view.v1",
      evaluatedAt: now.toISOString(),
      purpose: "mining_ready",
      status: qualificationStatus,
      policyId: "fased:mining-ready:v1",
      policyGeneration: params.profileState.active.capitalPolicy.generation.toString(),
      policyDigestSha256: params.profileState.active.capitalPolicy.digest,
      subject: {
        ...(params.identity ? { fasedAgentRecord: params.identity.fasedAgentRecord } : {}),
        satAgentRecord: params.mining.satAgentRecord,
      },
      gates,
      conflicts,
      evidence,
    }),
    "Agent Mining qualification view",
  );

  return {
    schema: "fased.agent.mining-ready-projection.v1",
    agentId: params.agentId,
    mode: params.mode,
    profiles: params.profileState.active,
    capability: {
      capabilityId: capability.manifest.capabilityId,
      version: capability.manifest.version,
      adapterId: capability.manifest.adapterId,
      adapterOperations: [...capability.manifest.adapterOperations],
      signerKeyId: capability.signerKeyId,
    },
    authority: {
      capitalPolicyMode: capitalPolicy.mode,
      ownerApprovalRequired: capitalPolicy.ownerApprovalRequired,
    },
    truth: {
      researchRoot: params.truth.publicEvidence.sourceRoots.research,
      financialRoot: params.truth.publicEvidence.sourceRoots.financial,
      publicEvidenceBuiltAt: params.truth.publicEvidence.builtAt,
    },
    ...(identity ? { identity } : {}),
    mining,
    qualification,
    privateMining,
  };
}
