import crypto from "node:crypto";
import path from "node:path";
import type {
  DoctorMemoryRepairPreviewAction,
  DoctorMemoryRepairPreviewPayload,
  DoctorMemoryRepairPreviewProposal,
} from "./inventory.js";

export type DoctorMemoryRepairExecutionSurface =
  | "cli"
  | "dashboard-admin"
  | "chat"
  | "channel"
  | "plugin";

export type DoctorMemoryRepairExecutionScope =
  | "none"
  | "operator.read"
  | "operator.write"
  | "operator.admin";

export type DoctorMemoryRepairExecutionConfirmation = "none" | "cli-yes" | "confirmation-token";

export type DoctorMemoryRepairExecutionPlan = {
  backup: "none" | "planned";
  audit: "none" | "planned";
  rollback: "none" | "manual" | "automatic";
};

export type DoctorMemoryRepairExecutionPolicyInput = {
  preview: DoctorMemoryRepairPreviewPayload;
  proposalIds?: string[];
  acceptedPreviewFingerprint?: string;
  surface: DoctorMemoryRepairExecutionSurface;
  operatorScope: DoctorMemoryRepairExecutionScope;
  confirmation: DoctorMemoryRepairExecutionConfirmation;
  plan: DoctorMemoryRepairExecutionPlan;
  allowedRoots: string[];
};

export type DoctorMemoryRepairExecutionPolicyDecision = {
  ok: boolean;
  previewFingerprint: string;
  allowed: Array<{
    id: string;
    action: DoctorMemoryRepairPreviewAction;
    targetPath?: string;
  }>;
  blocked: Array<{
    id: string;
    action?: DoctorMemoryRepairPreviewAction;
    reasons: string[];
  }>;
  reasons: string[];
};

const EXECUTABLE_ACTIONS = new Set<DoctorMemoryRepairPreviewAction>([
  "create_file",
  "create_directory",
  "rebuild_index",
]);

const ALLOWED_SURFACES = new Set<DoctorMemoryRepairExecutionSurface>(["cli", "dashboard-admin"]);

const TARGET_REQUIRED_ACTIONS = new Set<DoctorMemoryRepairPreviewAction>([
  "create_file",
  "create_directory",
  "rebuild_index",
]);

export function createMemoryRepairPreviewFingerprint(
  preview: DoctorMemoryRepairPreviewPayload,
): string {
  const stable = {
    agentId: preview.agentId,
    dryRun: preview.dryRun,
    proposals: preview.proposals.map((proposal) => ({
      id: proposal.id,
      area: proposal.area,
      sourceCode: proposal.sourceCode,
      action: proposal.action,
      targetPath: proposal.targetPath ?? null,
      supported: proposal.supported,
      blockReason: proposal.blockReason ?? null,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function evaluateMemoryRepairExecutionPolicy(
  input: DoctorMemoryRepairExecutionPolicyInput,
): DoctorMemoryRepairExecutionPolicyDecision {
  const previewFingerprint = createMemoryRepairPreviewFingerprint(input.preview);
  const globalReasons = collectGlobalDenyReasons(input, previewFingerprint);
  const selected = selectProposals(input.preview, input.proposalIds);
  const allowed: DoctorMemoryRepairExecutionPolicyDecision["allowed"] = [];
  const blocked: DoctorMemoryRepairExecutionPolicyDecision["blocked"] = [];

  for (const selection of selected) {
    if (!selection.proposal) {
      blocked.push({
        id: selection.id,
        reasons: [...globalReasons, "proposal not found in preview"],
      });
      continue;
    }

    const proposalReasons = collectProposalDenyReasons(selection.proposal, input.allowedRoots);
    const reasons = [...globalReasons, ...proposalReasons];
    if (reasons.length > 0) {
      blocked.push({
        id: selection.proposal.id,
        action: selection.proposal.action,
        reasons,
      });
      continue;
    }

    allowed.push({
      id: selection.proposal.id,
      action: selection.proposal.action,
      ...(selection.proposal.targetPath
        ? { targetPath: path.resolve(selection.proposal.targetPath) }
        : {}),
    });
  }

  return {
    ok: allowed.length > 0 && blocked.length === 0 && globalReasons.length === 0,
    previewFingerprint,
    allowed,
    blocked,
    reasons: globalReasons,
  };
}

function collectGlobalDenyReasons(
  input: DoctorMemoryRepairExecutionPolicyInput,
  previewFingerprint: string,
): string[] {
  const reasons: string[] = [];
  if (!ALLOWED_SURFACES.has(input.surface)) {
    reasons.push("memory repair execution is unavailable from this surface");
  }
  if (input.operatorScope !== "operator.admin") {
    reasons.push("memory repair execution requires operator.admin");
  }
  if (input.confirmation === "none") {
    reasons.push("memory repair execution requires explicit confirmation");
  }
  if (input.plan.backup !== "planned") {
    reasons.push("memory repair execution requires a backup plan");
  }
  if (input.plan.audit !== "planned") {
    reasons.push("memory repair execution requires an audit record plan");
  }
  if (input.plan.rollback === "none") {
    reasons.push("memory repair execution requires a rollback or manual recovery plan");
  }
  if (!input.allowedRoots.length) {
    reasons.push("memory repair execution requires allowed workspace/state roots");
  }
  if (input.acceptedPreviewFingerprint !== previewFingerprint) {
    reasons.push("memory repair preview fingerprint was not accepted");
  }
  return reasons;
}

function collectProposalDenyReasons(
  proposal: DoctorMemoryRepairPreviewProposal,
  allowedRoots: string[],
): string[] {
  const reasons: string[] = [];
  if (!proposal.supported) {
    reasons.push(proposal.blockReason ?? "proposal is not supported by repair preview");
  }
  if (!EXECUTABLE_ACTIONS.has(proposal.action)) {
    reasons.push("proposal action is review-only and cannot be executed automatically");
  }
  if (TARGET_REQUIRED_ACTIONS.has(proposal.action) && !proposal.targetPath) {
    reasons.push("proposal action requires a target path");
  }
  if (proposal.targetPath) {
    if (proposal.targetPath.startsWith("[redacted:")) {
      reasons.push("proposal target path is redacted");
    } else if (!isPathWithinAnyRoot(proposal.targetPath, allowedRoots)) {
      reasons.push("proposal target path is outside allowed roots");
    }
  }
  return reasons;
}

function selectProposals(
  preview: DoctorMemoryRepairPreviewPayload,
  proposalIds: string[] | undefined,
): Array<{ id: string; proposal?: DoctorMemoryRepairPreviewProposal }> {
  if (!proposalIds?.length) {
    return preview.proposals.map((proposal) => ({ id: proposal.id, proposal }));
  }
  const byId = new Map(preview.proposals.map((proposal) => [proposal.id, proposal]));
  return proposalIds.map((id) => ({ id, proposal: byId.get(id) }));
}

function isPathWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
  const resolvedCandidate = path.resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
