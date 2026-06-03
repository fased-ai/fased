import path from "node:path";
import type { DoctorMemoryRepairPreviewPayload } from "./inventory.js";
import { createMemoryRepairPreviewFingerprint } from "./repair-execution-policy.js";
import type { DoctorMemoryRepairExecutionPolicyInput } from "./repair-execution-policy.js";
import {
  DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
  type DoctorMemoryRepairExecutionRequest,
} from "./repair-execution-request-contract.js";

export const MEMORY_REPAIR_FIXTURE_CREATED_AT = "2026-05-01T12:00:00.000Z";
export const MEMORY_REPAIR_FIXTURE_EXECUTION_ID = "repair-main-0001";

type MemoryRepairProposalFixtureId =
  | "create-memory-file"
  | "create-memory-dir"
  | "rebuild-index"
  | "review-backend"
  | "redacted-path";

export type MemoryRepairPreviewFixtureOptions = {
  root?: string;
  proposalIds?: MemoryRepairProposalFixtureId[];
  validation?: DoctorMemoryRepairPreviewPayload["validation"];
};

export function makeMemoryRepairPreviewFixture(
  options: MemoryRepairPreviewFixtureOptions = {},
): DoctorMemoryRepairPreviewPayload {
  const root = options.root ?? "/tmp/fased-memory-repair-fixture";
  const proposalIds = options.proposalIds ?? ["create-memory-file", "review-backend"];
  const proposalMap = createProposalMap(root);
  const proposals = proposalIds.map((id) => proposalMap[id]);
  return {
    agentId: "main",
    dryRun: true,
    ok: false,
    validation: options.validation ?? { errors: 1, warnings: 1, info: 0 },
    summary: {
      proposals: proposals.length,
      supported: proposals.filter((proposal) => proposal.supported).length,
      blocked: proposals.filter((proposal) => !proposal.supported).length,
    },
    proposals,
  };
}

export type MemoryRepairRequestFixtureOptions = {
  root?: string;
  preview?: DoctorMemoryRepairPreviewPayload;
  surface?: DoctorMemoryRepairExecutionRequest["surface"];
  confirmation?: DoctorMemoryRepairExecutionRequest["confirmation"];
  proposalIds?: string[];
  overrides?: Partial<DoctorMemoryRepairExecutionRequest>;
};

export function makeMemoryRepairExecutionRequestFixture(
  options: MemoryRepairRequestFixtureOptions = {},
): DoctorMemoryRepairExecutionRequest {
  const root = options.root ?? "/tmp/fased-memory-repair-fixture";
  const preview = options.preview ?? makeMemoryRepairPreviewFixture({ root });
  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.request",
    method: DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
    dryRun: true,
    executionId: MEMORY_REPAIR_FIXTURE_EXECUTION_ID,
    createdAt: MEMORY_REPAIR_FIXTURE_CREATED_AT,
    preview,
    proposalIds: options.proposalIds ?? ["create-memory-file"],
    acceptedPreviewFingerprint: createMemoryRepairPreviewFingerprint(preview),
    surface: options.surface ?? "cli",
    operatorScope: "operator.admin",
    confirmation: options.confirmation ?? "cli-yes",
    plan: { backup: "planned", audit: "planned", rollback: "manual" },
    allowedRoots: [root, path.join(root, ".state")],
    backupRoot: path.join(root, ".state", "memory-repair-backups"),
    auditRoot: path.join(root, ".state", "memory-repair-audit"),
    ...options.overrides,
  };
}

export function makeMemoryRepairPolicyInputFixture(params: {
  root: string;
  preview: DoctorMemoryRepairPreviewPayload;
  overrides?: Partial<DoctorMemoryRepairExecutionPolicyInput>;
}): DoctorMemoryRepairExecutionPolicyInput {
  return {
    preview: params.preview,
    acceptedPreviewFingerprint: createMemoryRepairPreviewFingerprint(params.preview),
    surface: "cli",
    operatorScope: "operator.admin",
    confirmation: "cli-yes",
    plan: { backup: "planned", audit: "planned", rollback: "manual" },
    allowedRoots: [params.root, path.join(params.root, ".state")],
    ...params.overrides,
  };
}

function createProposalMap(
  root: string,
): Record<MemoryRepairProposalFixtureId, DoctorMemoryRepairPreviewPayload["proposals"][number]> {
  return {
    "create-memory-file": {
      id: "create-memory-file",
      area: "workspace",
      sourceCode: "workspace.MEMORY.md.missing",
      severity: "warn",
      action: "create_file",
      description: "Would create an empty workspace memory markdown file.",
      targetPath: path.join(root, "MEMORY.md"),
      dryRun: true,
      wouldMutate: true,
      requiresOperatorWrite: true,
      supported: true,
    },
    "create-memory-dir": {
      id: "create-memory-dir",
      area: "workspace",
      sourceCode: "workspace.memory-dir.missing",
      severity: "info",
      action: "create_directory",
      description: "Would create the missing memory artifact directory.",
      targetPath: path.join(root, "memory"),
      dryRun: true,
      wouldMutate: true,
      requiresOperatorWrite: true,
      supported: true,
    },
    "rebuild-index": {
      id: "rebuild-index",
      area: "qmd",
      sourceCode: "qmd.index.missing",
      severity: "warn",
      action: "rebuild_index",
      description: "Would rebuild or initialize the QMD index.",
      targetPath: path.join(root, ".state", "agents", "main", "qmd", "index.sqlite"),
      dryRun: true,
      wouldMutate: true,
      requiresOperatorWrite: true,
      supported: true,
    },
    "review-backend": {
      id: "review-backend",
      area: "backend",
      sourceCode: "backend.status.unavailable",
      severity: "error",
      action: "review_backend",
      description: "Would review backend configuration and health.",
      dryRun: true,
      wouldMutate: true,
      requiresOperatorWrite: true,
      supported: false,
      blockReason: "backend repair requires a dedicated admin flow",
    },
    "redacted-path": {
      id: "redacted-path",
      area: "workspace",
      sourceCode: "workspace.memory-dir.outside_roots",
      severity: "warn",
      action: "manual_review",
      description: "Review the configured path.",
      targetPath: "[redacted:memory]",
      dryRun: true,
      wouldMutate: true,
      requiresOperatorWrite: true,
      supported: false,
      blockReason: "outside allowed roots",
    },
  };
}
