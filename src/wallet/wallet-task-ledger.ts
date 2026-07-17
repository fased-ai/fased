import { createTaskRecord } from "../tasks/task-registry.js";
import type {
  TaskRecord,
  TaskRegistryStep,
  TaskRegistryStepStatus,
  TaskStatus,
} from "../tasks/task-registry.types.js";
import type { WalletPolicySimulationCheck } from "./wallet-policy-simulation.js";
import type {
  WalletSendApprovalRequest,
  WalletSettlementContext,
} from "./wallet-send-approvals.js";

export function walletApprovalTaskId(requestId: string): string {
  const normalized = requestId.trim().replace(/[^a-zA-Z0-9:_-]+/g, "-") || "unknown";
  return `wallet:approval:${normalized}`;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeAgentIdFromRequester(requestedBy: string): string | undefined {
  const value = requestedBy.trim();
  if (!value) {
    return undefined;
  }
  if (value === "control-ui") {
    return "main";
  }
  if (["agent", "owner", "operator", "sat-mining"].includes(value)) {
    return undefined;
  }
  if (/^[a-zA-Z0-9_-]+$/.test(value)) {
    return value;
  }
  return undefined;
}

function approvalStatusToTaskStatus(request: WalletSendApprovalRequest): TaskStatus {
  switch (request.status) {
    case "pending":
      return "blocked";
    case "approved":
      return "running";
    case "executed":
      return "succeeded";
    case "failed":
      return "failed";
    case "rejected":
      return "cancelled";
    case "expired":
      return "timed_out";
    default:
      return "blocked";
  }
}

function approvalStatusToSummary(request: WalletSendApprovalRequest): {
  progressSummary?: string;
  terminalSummary?: string;
  error?: string;
} {
  switch (request.status) {
    case "pending":
      return { progressSummary: "Waiting for wallet approval." };
    case "approved":
      return { progressSummary: "Wallet approval accepted; broadcast is in progress." };
    case "executed":
      return {
        terminalSummary: request.result?.txHash
          ? `Wallet action executed: ${request.result.txHash}`
          : "Wallet action executed.",
      };
    case "failed":
      return {
        terminalSummary: request.reason ?? request.result?.error ?? "Wallet action failed.",
        error: request.result?.error ?? request.reason,
      };
    case "rejected":
      return { terminalSummary: request.reason ?? "Wallet approval rejected." };
    case "expired":
      return { terminalSummary: "Wallet approval expired." };
    default:
      return {};
  }
}

function policyStepStatus(request: WalletSendApprovalRequest): TaskRegistryStepStatus {
  if (request.payload.actionKind === "signer_review" && request.payload.signerPolicyHash) {
    return "succeeded";
  }
  if (!request.simulation) {
    return "queued";
  }
  return request.simulation.ok ? "succeeded" : "failed";
}

function approvalStepStatus(request: WalletSendApprovalRequest): TaskRegistryStepStatus {
  switch (request.status) {
    case "pending":
      return "blocked";
    case "approved":
    case "executed":
      return "succeeded";
    case "rejected":
      return "cancelled";
    case "expired":
      return "lost";
    case "failed":
      return request.simulation && !request.simulation.ok ? "skipped" : "failed";
    default:
      return "blocked";
  }
}

function broadcastStepStatus(request: WalletSendApprovalRequest): TaskRegistryStepStatus {
  switch (request.status) {
    case "pending":
      return "queued";
    case "approved":
      return "running";
    case "executed":
      return "succeeded";
    case "failed":
      return request.simulation && !request.simulation.ok ? "skipped" : "failed";
    case "rejected":
    case "expired":
      return "skipped";
    default:
      return "queued";
  }
}

function buildApprovalSteps(request: WalletSendApprovalRequest): TaskRegistryStep[] {
  const decisionAt = parseTime(request.decisionAt);
  return [
    {
      id: "policy",
      label:
        request.payload.actionKind === "signer_review"
          ? "Signer policy binding"
          : "Policy simulation",
      status: policyStepStatus(request),
      updatedAt: request.simulation ? parseTime(request.createdAt) : undefined,
      error: request.simulation?.checks.find((check) => check.status === "fail")?.detail,
    },
    {
      id: "approval",
      label: "Operator approval",
      status: approvalStepStatus(request),
      updatedAt: decisionAt,
      error:
        request.status === "rejected" || request.status === "expired" ? request.reason : undefined,
    },
    {
      id: "broadcast",
      label:
        request.payload.signerArtifactKind === "domain-separated-message"
          ? "Complete reviewed signature"
          : "Broadcast transaction",
      status: broadcastStepStatus(request),
      updatedAt:
        request.status === "executed" || request.status === "failed" ? decisionAt : undefined,
      error: request.status === "failed" ? (request.result?.error ?? request.reason) : undefined,
    },
  ];
}

function formatApprovalTaskTitle(request: WalletSendApprovalRequest): string {
  if (request.payload.actionKind === "signer_review" && request.payload.memo?.trim()) {
    return `Wallet approval: ${request.payload.memo.trim()}`;
  }
  const diff = request.approvalDiff ?? request.simulation?.diff;
  const amount =
    diff?.amountDisplay ||
    request.payload.amountDisplay ||
    diff?.amount ||
    request.payload.amount ||
    "amount";
  const token =
    diff?.token ||
    request.payload.assetSymbol ||
    request.payload.inputSymbol ||
    request.payload.outputSymbol ||
    diff?.mint ||
    request.payload.program ||
    request.payload.contract ||
    request.payload.chain;
  const target = diff?.to || request.payload.to;
  const amountWithToken =
    token && amount.toLowerCase().includes(token.toLowerCase()) ? amount : `${amount} ${token}`;
  return `Wallet approval: ${amountWithToken}${target ? ` to ${target}` : ""}`;
}

function compactSimulationChecks(
  checks: WalletPolicySimulationCheck[] | undefined,
): Array<Pick<WalletPolicySimulationCheck, "id" | "label" | "status" | "detail" | "code">> {
  return (checks ?? []).map(
    (check) =>
      compactRecord({
        id: check.id,
        label: check.label,
        status: check.status,
        detail: check.detail,
        code: check.code,
      }) as Pick<WalletPolicySimulationCheck, "id" | "label" | "status" | "detail" | "code">,
  );
}

export function syncWalletApprovalTask(params: {
  request: WalletSendApprovalRequest;
  settlementContext?: WalletSettlementContext | null;
}): TaskRecord {
  const request = params.request;
  const diff = request.approvalDiff ?? request.simulation?.diff;
  const taskId = request.taskLedgerId?.trim() || walletApprovalTaskId(request.id);
  const createdAt = parseTime(request.createdAt) ?? Date.now();
  const decisionAt = parseTime(request.decisionAt);
  const terminal = ["executed", "failed", "rejected", "expired"].includes(request.status);
  const summary = approvalStatusToSummary(request);
  const sessionKey = diff?.sessionId?.trim() || undefined;
  const settlementTaskId = params.settlementContext?.taskId || diff?.taskId;
  return createTaskRecord({
    taskId,
    runId: `wallet-approval-${request.id}`,
    source: "wallet",
    runtime: "wallet",
    taskKind: "wallet_approval",
    sourceId: request.id,
    requesterSessionKey: sessionKey,
    sessionKey,
    ownerKey: sessionKey,
    agentId: sessionKey ? undefined : normalizeAgentIdFromRequester(request.requestedBy),
    task: formatApprovalTaskTitle(request),
    status: approvalStatusToTaskStatus(request),
    deliveryStatus: "not_applicable",
    notifyPolicy: "state_changes",
    createdAt,
    startedAt: createdAt,
    endedAt: terminal ? (decisionAt ?? Date.now()) : undefined,
    updatedAt: decisionAt ?? Date.now(),
    scopeKind: sessionKey ? "session" : "agent",
    progressSummary: summary.progressSummary,
    terminalSummary: summary.terminalSummary,
    error: summary.error,
    steps: buildApprovalSteps(request),
    metadata: compactRecord({
      domain: "wallet",
      approvalId: request.id,
      approvalStatus: request.status,
      actionKind: request.payload.actionKind ?? "send",
      chain: request.payload.chain,
      walletId: request.payload.walletId ?? diff?.fromWalletId,
      walletName: request.payload.walletName ?? diff?.fromWalletName,
      walletRole: diff?.fromRole,
      providerId: request.payload.providerId ?? diff?.providerId,
      amount: request.payload.amount ?? diff?.amount,
      amountDisplay: request.payload.amountDisplay ?? diff?.amountDisplay,
      token: diff?.token ?? request.payload.assetSymbol,
      mint: diff?.mint ?? request.payload.program ?? request.payload.contract,
      to: request.payload.to ?? diff?.to,
      requestedBy: request.requestedBy,
      approvedBy: request.approvedBy,
      rejectedBy: request.rejectedBy,
      expiresAt: request.expiresAt,
      decisionAt: request.decisionAt,
      relatedTaskId: settlementTaskId,
      invoiceId: params.settlementContext?.invoiceId,
      senderHandle: params.settlementContext?.senderHandle,
      txHash: request.result?.txHash,
      simulationDecision: request.simulation?.decision,
      simulationOk: request.simulation?.ok,
      simulationChecks: compactSimulationChecks(request.simulation?.checks),
      approvalDiff: diff,
    }),
  });
}
