import { createTaskRecord } from "../tasks/task-registry.js";
import type {
  TaskRecord,
  TaskRegistryStep,
  TaskRegistryStepStatus,
  TaskStatus,
} from "../tasks/task-registry.types.js";

const READINESS_METHOD = "sat.getMiningReadiness";

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeLedgerId(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function extractPayload(responsePayload: unknown): Record<string, unknown> {
  const response = asRecord(responsePayload) ?? {};
  return asRecord(response.payload) ?? response;
}

function extractStatus(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(payload.status) ?? payload;
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumberLike(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readStringLike(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSubmittedTxHash(payload: Record<string, unknown>): string | undefined {
  const submitted = asRecord(payload.submitted);
  const txHash =
    trimString(submitted?.txHash) ||
    trimString(asRecord(payload.result)?.txHash) ||
    trimString(payload.txHash);
  return txHash || undefined;
}

function readReadinessChecks(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const checks = payload.checks;
  if (!Array.isArray(checks)) {
    return [];
  }
  return checks.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)));
}

function hasFailedReadinessCheck(payload: Record<string, unknown>): boolean {
  return readReadinessChecks(payload).some((check) => check.ok === false);
}

function compactReadinessChecks(
  checks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> | undefined {
  const compacted = checks.map((check) =>
    compactRecord({
      key: trimString(check.key) || undefined,
      ok: typeof check.ok === "boolean" ? check.ok : undefined,
      detail: trimString(check.detail) || undefined,
      remediation: trimString(check.remediation) || undefined,
    }),
  );
  return compacted.length > 0 ? compacted : undefined;
}

function methodAction(method: string): string {
  return method.startsWith("sat.") ? method.slice("sat.".length) : method;
}

function miningTaskKind(method: string): string {
  const action = methodAction(method);
  if (method === READINESS_METHOD) {
    return "mining_readiness";
  }
  if (["startMining", "stopMining"].includes(action)) {
    return "mining_control";
  }
  if (
    [
      "initMinerCapital",
      "depositMinerCapital",
      "withdrawMinerCapital",
      "setActiveCommit",
      "bootstrapRegistryReserve",
    ].includes(action)
  ) {
    return "mining_capital";
  }
  if (
    [
      "submitCycle",
      "settleCyclePage",
      "scoreCyclePage",
      "distributeCyclePage",
      "finalizeCycleSettlement",
    ].includes(action)
  ) {
    return "mining_cycle";
  }
  if (["claimCycleRewards", "claimCycleRewardsBatch"].includes(action)) {
    return "mining_claim";
  }
  if (["resolveDispute", "republishEpochRoots", "openDispute"].includes(action)) {
    return "mining_recovery";
  }
  return "mining_action";
}

function miningActionLabel(method: string): string {
  const action = methodAction(method);
  switch (action) {
    case "getMiningReadiness":
      return "Readiness check";
    case "startMining":
      return "Start mining";
    case "stopMining":
      return "Stop mining";
    case "initMinerCapital":
      return "Initialize capital";
    case "depositMinerCapital":
      return "Deposit capital";
    case "withdrawMinerCapital":
      return "Withdraw capital";
    case "setActiveCommit":
      return "Set active commit";
    case "submitCycle":
      return "Submit cycle";
    case "settleCyclePage":
      return "Settle cycle page";
    case "scoreCyclePage":
      return "Score cycle page";
    case "distributeCyclePage":
      return "Distribute cycle page";
    case "finalizeCycleSettlement":
      return "Finalize cycle";
    case "claimCycleRewards":
      return "Claim rewards";
    case "claimCycleRewardsBatch":
      return "Claim rewards batch";
    case "resolveDispute":
      return "Resolve dispute";
    case "republishEpochRoots":
      return "Republish roots";
    case "openDispute":
      return "Open dispute";
    default:
      return action;
  }
}

function taskStatusForMiningMethod(params: {
  method: string;
  payload: Record<string, unknown>;
  status: Record<string, unknown> | undefined;
}): TaskStatus {
  const readinessFailed = hasFailedReadinessCheck(params.payload);
  if (readinessFailed) {
    return "blocked";
  }
  const action = methodAction(params.method);
  if (action === "startMining") {
    const running = readBoolean(params.status, "running") === true;
    const drainOnly = readBoolean(params.status, "drainOnly") === true;
    return params.payload.started === true || (running && !drainOnly) ? "succeeded" : "blocked";
  }
  if (action === "stopMining") {
    return params.payload.stopped === true ||
      readBoolean(params.status, "drainOnly") === true ||
      readBoolean(params.status, "running") === false
      ? "succeeded"
      : "blocked";
  }
  return "succeeded";
}

function summaryForMiningMethod(params: {
  method: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  statusPayload: Record<string, unknown> | undefined;
}): Pick<TaskRecord, "progressSummary" | "terminalSummary"> {
  const action = methodAction(params.method);
  if (params.status === "blocked") {
    const checks = readReadinessChecks(params.payload);
    const failed = checks.find((check) => check.ok === false);
    return {
      progressSummary:
        trimString(failed?.remediation) ||
        trimString(failed?.detail) ||
        trimString(params.statusPayload?.nextActionDetail) ||
        trimString(params.statusPayload?.bootstrapReason) ||
        "Mining action is blocked.",
    };
  }
  if (action === "stopMining" && readBoolean(params.statusPayload, "drainOnly") === true) {
    return {
      terminalSummary: "Stop requested; clearing continues in Mining.",
    };
  }
  return { terminalSummary: `${miningActionLabel(params.method)} completed.` };
}

function buildMiningSteps(params: {
  method: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  txHash?: string;
  now: number;
}): TaskRegistryStep[] {
  const readinessFailed = hasFailedReadinessCheck(params.payload);
  const submitted = Boolean(params.payload.submitted) || Boolean(params.txHash);
  const chainStepStatus: TaskRegistryStepStatus =
    params.status === "blocked" || readinessFailed
      ? "blocked"
      : params.status === "failed"
        ? "failed"
        : submitted
          ? "succeeded"
          : "skipped";
  return [
    {
      id: "request",
      label: "Gateway request",
      status: "succeeded",
      updatedAt: params.now,
    },
    {
      id: "readiness",
      label: "Readiness/policy",
      status: readinessFailed ? "blocked" : "succeeded",
      updatedAt: params.now,
      error: (() => {
        const failed = readReadinessChecks(params.payload).find((check) => check.ok === false);
        return trimString(failed?.remediation) || trimString(failed?.detail) || undefined;
      })(),
    },
    {
      id: "chain",
      label: "Runtime/chain action",
      status: chainStepStatus,
      updatedAt: submitted ? params.now : undefined,
    },
  ];
}

export function shouldMirrorMiningGatewayTask(params: {
  method: string;
  responsePayload: unknown;
  requestParams?: Record<string, unknown>;
  mutationMethods: ReadonlySet<string>;
}): boolean {
  const explicitMirror =
    params.requestParams?.recordTaskLedger === true || params.requestParams?.ledger === true;
  if (!explicitMirror) {
    return false;
  }
  return params.mutationMethods.has(params.method) || params.method === READINESS_METHOD;
}

export function syncMiningGatewayTask(params: {
  method: string;
  requestId?: string;
  requestParams?: Record<string, unknown>;
  responsePayload: unknown;
  nowMs?: number;
}): TaskRecord {
  const now = params.nowMs ?? Date.now();
  const payload = extractPayload(params.responsePayload);
  const statusPayload = extractStatus(payload);
  const action = methodAction(params.method);
  const status = taskStatusForMiningMethod({
    method: params.method,
    payload,
    status: statusPayload,
  });
  const summary = summaryForMiningMethod({
    method: params.method,
    status,
    payload,
    statusPayload,
  });
  const requestId = normalizeLedgerId(params.requestId ?? `${action}-${now}`, `${action}-${now}`);
  const txHash = readSubmittedTxHash(payload);
  const walletId =
    trimString(params.requestParams?.walletId) ||
    trimString(statusPayload?.walletId) ||
    trimString(payload.selectedWalletId);
  return createTaskRecord({
    taskId: `mining:${action}:${requestId}`,
    runId: `mining-${action}-${requestId}`,
    source: "mining",
    runtime: "mining",
    taskKind: miningTaskKind(params.method),
    sourceId: action,
    agentId: "main",
    ownerKey: "agent:main:mining",
    task: `Mining: ${miningActionLabel(params.method)}`,
    status,
    deliveryStatus: "not_applicable",
    notifyPolicy: "state_changes",
    createdAt: now,
    startedAt: now,
    endedAt: status === "queued" || status === "running" ? undefined : now,
    updatedAt: now,
    scopeKind: "agent",
    progressSummary: summary.progressSummary,
    terminalSummary: summary.terminalSummary,
    steps: buildMiningSteps({
      method: params.method,
      status,
      payload,
      txHash,
      now,
    }),
    metadata: compactRecord({
      domain: "mining",
      method: params.method,
      action,
      walletId,
      txHash,
      started: payload.started,
      stopped: payload.stopped,
      running: readBoolean(statusPayload, "running"),
      drainOnly: readBoolean(statusPayload, "drainOnly"),
      enabledWanted: readBoolean(statusPayload, "enabledWanted"),
      currentCycleId: readNumberLike(statusPayload, "currentCycleId"),
      currentEpochId: readNumberLike(statusPayload, "currentEpochId"),
      currentMicroRoundId: readNumberLike(statusPayload, "currentMicroRoundId"),
      activeCommitLamports:
        readNumberLike(statusPayload, "activeCommitLamports") ??
        readNumberLike(params.requestParams, "lamports"),
      currentCapitalFundedLamports: readNumberLike(statusPayload, "currentCapitalFundedLamports"),
      currentCapitalFreeLamports: readNumberLike(statusPayload, "currentCapitalFreeLamports"),
      currentCapitalLockedLamports: readNumberLike(statusPayload, "currentCapitalLockedLamports"),
      currentCapitalPendingCycleCount: readNumberLike(
        statusPayload,
        "currentCapitalPendingCycleCount",
      ),
      currentCapitalAddress: readStringLike(statusPayload, "currentCapitalAddress"),
      bootstrapReason: readStringLike(statusPayload, "bootstrapReason"),
      blockedReason: readStringLike(statusPayload, "blockedReason"),
      nextActionDetail: readStringLike(statusPayload, "nextActionDetail"),
      lastAction: readStringLike(statusPayload, "lastAction"),
      lastActionTxHash: readStringLike(statusPayload, "lastActionTxHash"),
      strategyMode: readStringLike(statusPayload, "strategyMode"),
      strategyExecution: readStringLike(statusPayload, "strategyExecution"),
      strategyPreset: readStringLike(statusPayload, "strategyPreset"),
      cycleId: readNumberLike(params.requestParams, "cycleId"),
      epochId: readNumberLike(params.requestParams, "epochId"),
      microRoundId: readNumberLike(params.requestParams, "microRoundId"),
      pageIndex: readNumberLike(params.requestParams, "pageIndex"),
      chunkIndex: readNumberLike(params.requestParams, "chunkIndex"),
      lamports: readNumberLike(params.requestParams, "lamports"),
      readinessChecks: compactReadinessChecks(readReadinessChecks(payload)),
    }),
  });
}
