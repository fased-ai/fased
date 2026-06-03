import crypto from "node:crypto";
import path from "node:path";
import type { DoctorMemoryRepairPreviewAction } from "./inventory.js";
import {
  createMemoryRepairPreviewFingerprint,
  type DoctorMemoryRepairExecutionPolicyDecision,
  type DoctorMemoryRepairExecutionPolicyInput,
} from "./repair-execution-policy.js";

export type DoctorMemoryRepairAuditPlanSchemaVersion = 1;

export type DoctorMemoryRepairBackupEntryPlan = {
  proposalId: string;
  action: DoctorMemoryRepairPreviewAction;
  targetPath: string;
  snapshotPath: string;
  strategy: "snapshot-target-before-write";
};

export type DoctorMemoryRepairRollbackEntryPlan = {
  proposalId: string;
  action: DoctorMemoryRepairPreviewAction;
  targetPath: string;
  snapshotPath: string;
  strategy: "restore-or-remove-to-prewrite-state";
};

export type DoctorMemoryRepairExecutionAuditPlanRecord = {
  schemaVersion: DoctorMemoryRepairAuditPlanSchemaVersion;
  kind: "doctor.memory.repair.execution.audit-plan";
  executionId: string;
  createdAt: string;
  agentId: string;
  surface: DoctorMemoryRepairExecutionPolicyInput["surface"];
  operatorScope: DoctorMemoryRepairExecutionPolicyInput["operatorScope"];
  confirmation: DoctorMemoryRepairExecutionPolicyInput["confirmation"];
  previewFingerprint: string;
  acceptedPreviewFingerprint: string;
  selectedProposalIds: string[];
  allowedRoots: string[];
  dryRun: true;
  noWritePerformed: true;
  transcriptAccess: "none";
  bodyAccess: "none";
  backup: {
    required: true;
    root: string;
    manifestPath: string;
    entries: DoctorMemoryRepairBackupEntryPlan[];
  };
  audit: {
    required: true;
    root: string;
    recordPath: string;
    event: "planned";
  };
  rollback: {
    required: true;
    mode: DoctorMemoryRepairExecutionPolicyInput["plan"]["rollback"];
    entries: DoctorMemoryRepairRollbackEntryPlan[];
  };
};

export type DoctorMemoryRepairAuditPlanInput = {
  executionId: string;
  createdAt: string;
  policyInput: DoctorMemoryRepairExecutionPolicyInput;
  policyDecision: DoctorMemoryRepairExecutionPolicyDecision;
  backupRoot: string;
  auditRoot: string;
};

export type DoctorMemoryRepairAuditPlanDecision = {
  ok: boolean;
  plan?: DoctorMemoryRepairExecutionAuditPlanRecord;
  fingerprint?: string;
  reasons: string[];
};

const EXECUTION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function createMemoryRepairAuditPlan(
  input: DoctorMemoryRepairAuditPlanInput,
): DoctorMemoryRepairAuditPlanDecision {
  const reasons = collectAuditPlanDenyReasons(input);
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const normalizedExecutionId = input.executionId.trim();
  const allowedRoots = input.policyInput.allowedRoots.map((root) => path.resolve(root));
  const backupRoot = path.resolve(input.backupRoot);
  const auditRoot = path.resolve(input.auditRoot);
  const selectedProposalIds = input.policyDecision.allowed.map((entry) => entry.id);
  const snapshotRoot = backupRoot;
  const entries = input.policyDecision.allowed.map((entry) => {
    if (!entry.targetPath) {
      throw new Error(`memory repair proposal ${entry.id} target path missing after validation`);
    }
    const targetPath = path.resolve(entry.targetPath);
    const snapshotPath = path.join(
      snapshotRoot,
      `${normalizedExecutionId}-${sanitizePathSegment(entry.id)}.snapshot`,
    );
    return {
      proposalId: entry.id,
      action: entry.action,
      targetPath,
      snapshotPath,
      strategy: "snapshot-target-before-write" as const,
    };
  });

  const plan: DoctorMemoryRepairExecutionAuditPlanRecord = {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.audit-plan",
    executionId: normalizedExecutionId,
    createdAt: input.createdAt,
    agentId: input.policyInput.preview.agentId,
    surface: input.policyInput.surface,
    operatorScope: input.policyInput.operatorScope,
    confirmation: input.policyInput.confirmation,
    previewFingerprint: input.policyDecision.previewFingerprint,
    acceptedPreviewFingerprint: input.policyInput.acceptedPreviewFingerprint ?? "",
    selectedProposalIds,
    allowedRoots,
    dryRun: true,
    noWritePerformed: true,
    transcriptAccess: "none",
    bodyAccess: "none",
    backup: {
      required: true,
      root: backupRoot,
      manifestPath: path.join(snapshotRoot, `${normalizedExecutionId}.manifest.json`),
      entries,
    },
    audit: {
      required: true,
      root: auditRoot,
      recordPath: path.join(auditRoot, `${normalizedExecutionId}.jsonl`),
      event: "planned",
    },
    rollback: {
      required: true,
      mode: input.policyInput.plan.rollback,
      entries: entries.map((entry) => ({
        proposalId: entry.proposalId,
        action: entry.action,
        targetPath: entry.targetPath,
        snapshotPath: entry.snapshotPath,
        strategy: "restore-or-remove-to-prewrite-state" as const,
      })),
    },
  };

  return {
    ok: true,
    plan,
    fingerprint: createMemoryRepairAuditPlanFingerprint(plan),
    reasons: [],
  };
}

export function createMemoryRepairAuditPlanFingerprint(
  plan: DoctorMemoryRepairExecutionAuditPlanRecord,
): string {
  return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function collectAuditPlanDenyReasons(input: DoctorMemoryRepairAuditPlanInput): string[] {
  const reasons: string[] = [];
  const executionId = input.executionId.trim();
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    reasons.push("memory repair audit plan requires a safe execution id");
  }
  if (!isIsoDateTime(input.createdAt)) {
    reasons.push("memory repair audit plan requires an ISO createdAt timestamp");
  }
  if (!input.policyDecision.ok) {
    reasons.push("memory repair audit plan requires an admitted execution policy decision");
  }
  if (input.policyDecision.blocked.length > 0) {
    reasons.push("memory repair audit plan cannot include blocked proposals");
  }
  if (input.policyDecision.allowed.length === 0) {
    reasons.push("memory repair audit plan requires at least one allowed proposal");
  }

  const previewFingerprint = createMemoryRepairPreviewFingerprint(input.policyInput.preview);
  if (input.policyDecision.previewFingerprint !== previewFingerprint) {
    reasons.push("memory repair audit plan preview fingerprint is stale");
  }
  if (input.policyInput.acceptedPreviewFingerprint !== previewFingerprint) {
    reasons.push("memory repair audit plan requires the accepted preview fingerprint");
  }
  if (input.policyInput.plan.backup !== "planned") {
    reasons.push("memory repair audit plan requires a planned backup");
  }
  if (input.policyInput.plan.audit !== "planned") {
    reasons.push("memory repair audit plan requires a planned audit record");
  }
  if (input.policyInput.plan.rollback === "none") {
    reasons.push("memory repair audit plan requires a rollback or manual recovery mode");
  }

  const allowedRoots = input.policyInput.allowedRoots;
  if (!isSafePlannedPath(input.backupRoot, allowedRoots)) {
    reasons.push("memory repair backup root must stay inside allowed roots");
  }
  if (!isSafePlannedPath(input.auditRoot, allowedRoots)) {
    reasons.push("memory repair audit root must stay inside allowed roots");
  }
  for (const entry of input.policyDecision.allowed) {
    if (!entry.targetPath) {
      reasons.push(`memory repair proposal ${entry.id} requires a target path for audit planning`);
      continue;
    }
    if (!isSafePlannedPath(entry.targetPath, allowedRoots)) {
      reasons.push(`memory repair proposal ${entry.id} target path must stay inside allowed roots`);
    }
  }
  return Array.from(new Set(reasons));
}

function isIsoDateTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSafePlannedPath(candidate: string, roots: readonly string[]): boolean {
  if (!candidate || candidate.startsWith("[redacted:")) {
    return false;
  }
  const resolvedCandidate = path.resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "proposal";
}
