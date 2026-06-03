import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { getMemorySearchManager } from "./index.js";
import {
  buildMemoryInventory,
  previewMemoryInventoryRepair,
  type DoctorMemoryRepairPreviewAction,
  type DoctorMemoryRepairPreviewPayload,
} from "./inventory.js";
import { createMemoryRepairPreviewFingerprint } from "./repair-execution-policy.js";
import {
  DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionResponse,
} from "./repair-execution-request-contract.js";
import {
  evaluateMemoryRepairFsSafety,
  type DoctorMemoryRepairFsNodeKind,
  type DoctorMemoryRepairFsNodeState,
  type DoctorMemoryRepairFsPathState,
  type DoctorMemoryRepairFsSafetyDecision,
} from "./repair-executor-fs-safety-contract.js";
import { evaluateMemoryRepairExecutorGate } from "./repair-executor-gate.js";
import {
  evaluateMemoryRepairExecutionLockAdmission,
  type DoctorMemoryRepairExecutionLockRecord,
} from "./repair-executor-lock-contract.js";
import type { MemoryProviderStatus } from "./types.js";

export type DoctorMemoryRepairExecuteSurface = "cli" | "dashboard-admin";

export type DoctorMemoryRepairExecuteInput = {
  cfg: FasedAgentConfig;
  agentId: string;
  proposalIds: string[];
  surface: DoctorMemoryRepairExecuteSurface;
  confirmation: "cli-yes" | "confirmation-token";
  allowWrites: boolean;
  acceptedPreviewFingerprint?: string;
  acceptedAuditPlanFingerprint?: string;
  acceptCurrentPreview?: boolean;
  acceptCurrentAuditPlan?: boolean;
  executionId?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

export type DoctorMemoryRepairExecuteStep = {
  proposalId: string;
  action: DoctorMemoryRepairPreviewAction;
  stage: "backup" | "write" | "rollback" | "audit" | "lock" | "gate" | "fs-safety";
  status: "succeeded" | "failed" | "skipped";
  targetPath?: string;
  snapshotPath?: string;
  message?: string;
  errorCode?: string;
};

export type DoctorMemoryRepairExecuteResult = {
  schemaVersion: 1;
  kind: "doctor.memory.repair.execution.result";
  method: typeof DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD;
  dryRun: false;
  noWritePerformed: boolean;
  executionId: string;
  agentId: string;
  status: "success" | "failure" | "partial-write" | "denied" | "idempotent";
  previewFingerprint: string;
  auditPlanFingerprint?: string;
  selectedProposalIds: string[];
  backupManifestPath?: string;
  auditRecordPath?: string;
  lockPath?: string;
  summary: {
    selected: number;
    backupSucceeded: number;
    writeSucceeded: number;
    failed: number;
    skipped: number;
  };
  rollback: {
    attempted: boolean;
    status: "not-needed" | "completed" | "failed" | "manual-required";
    reasons: string[];
  };
  steps: DoctorMemoryRepairExecuteStep[];
  reasons: string[];
};

type TargetSnapshot = {
  proposalId: string;
  action: DoctorMemoryRepairPreviewAction;
  targetPath: string;
  snapshotPath: string;
  before: "missing" | "file" | "directory";
  wroteTarget: boolean;
};

const LOCK_TTL_MS = 5 * 60_000;
const EXECUTABLE_ACTIONS = new Set<DoctorMemoryRepairPreviewAction>([
  "create_file",
  "create_directory",
]);

export async function executeMemoryRepair(
  input: DoctorMemoryRepairExecuteInput,
): Promise<DoctorMemoryRepairExecuteResult> {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const executionId = normalizeExecutionId(input.executionId, input.agentId);
  const { preview, allowedRoots, stateDir } = await buildExecutionPreview(input);
  const previewFingerprint = createMemoryRepairPreviewFingerprint(preview);
  const acceptedPreviewFingerprint = input.acceptCurrentPreview
    ? previewFingerprint
    : input.acceptedPreviewFingerprint;
  const response = evaluateMemoryRepairExecutionRequest({
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.request",
    method: DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
    dryRun: true,
    executionId,
    createdAt,
    preview,
    proposalIds: input.proposalIds,
    acceptedPreviewFingerprint: acceptedPreviewFingerprint ?? "",
    surface: input.surface,
    operatorScope: "operator.admin",
    confirmation: input.confirmation,
    plan: { backup: "planned", audit: "planned", rollback: "manual" },
    allowedRoots,
    backupRoot: stateDir,
    auditRoot: stateDir,
  });

  if (response.status !== "admitted" || !response.auditPlan || !response.auditPlanFingerprint) {
    return deniedResult({
      response,
      previewFingerprint,
      reasons: response.reasons,
      executionId,
      agentId: preview.agentId,
    });
  }

  const acceptedAuditPlanFingerprint = input.acceptCurrentAuditPlan
    ? response.auditPlanFingerprint
    : input.acceptedAuditPlanFingerprint;
  const gate = evaluateMemoryRepairExecutorGate({
    response,
    gate: {
      enabled: true,
      writeExecutorRegistered: true,
      gatewayHandlerRegistered: true,
      cliCommandRegistered: input.surface === "cli",
      dashboardActionRegistered: input.surface === "dashboard-admin",
      allowWrites: input.allowWrites,
    },
    operatorScope: "operator.admin",
    confirmation: input.confirmation,
    acceptedAuditPlanFingerprint,
  });
  if (!gate.ok) {
    return deniedResult({
      response,
      previewFingerprint,
      reasons: gate.reasons,
      executionId,
      agentId: preview.agentId,
    });
  }

  const unsupportedActions = response.auditPlan.backup.entries.filter(
    (entry) => !EXECUTABLE_ACTIONS.has(entry.action),
  );
  if (unsupportedActions.length > 0) {
    return deniedResult({
      response,
      previewFingerprint,
      reasons: unsupportedActions.map(
        (entry) => `memory repair action ${entry.action} is not implemented by the write executor`,
      ),
      executionId,
      agentId: preview.agentId,
    });
  }

  const existingLocks = await readExistingLocks(stateDir);
  const lockAdmission = evaluateMemoryRepairExecutionLockAdmission({
    response,
    now: createdAt,
    ttlMs: LOCK_TTL_MS,
    existingLocks,
  });
  if (!lockAdmission.ok || !lockAdmission.record) {
    return deniedResult({
      response,
      previewFingerprint,
      reasons: lockAdmission.reasons,
      executionId,
      agentId: preview.agentId,
    });
  }
  if (!lockAdmission.canAcquire) {
    return {
      ...baseResult(response, previewFingerprint),
      status: "idempotent",
      noWritePerformed: true,
      lockPath: lockPathFor(stateDir, response.executionId),
      summary: emptySummary(response.selectedProposalIds.length),
      rollback: { attempted: false, status: "not-needed", reasons: [] },
      steps: [
        {
          proposalId: "__lock__",
          action: "manual_review",
          stage: "lock",
          status: "skipped",
          message: `memory repair execution is ${lockAdmission.status}`,
        },
      ],
      reasons: [],
    };
  }

  const lockPath = lockPathFor(stateDir, response.executionId);
  const steps: DoctorMemoryRepairExecuteStep[] = [];
  let lockRecord = lockAdmission.record;
  try {
    await writeJsonFileExclusive(lockPath, lockRecord);
  } catch (err) {
    return deniedResult({
      response,
      previewFingerprint,
      reasons: [`memory repair lock could not be acquired: ${formatFsError(err)}`],
      executionId,
      agentId: preview.agentId,
    });
  }

  const fsSafety = await evaluateCurrentFsSafety(response);
  if (!fsSafety.ok || !fsSafety.safeToOpen) {
    await finishLock(lockPath, lockRecord, "failed");
    return deniedResult({
      response,
      previewFingerprint,
      reasons: fsSafety.reasons,
      executionId,
      agentId: preview.agentId,
      lockPath,
      fsSafety,
    });
  }

  const snapshots: TargetSnapshot[] = [];
  try {
    for (const entry of response.auditPlan.backup.entries) {
      snapshots.push(await backupTarget(entry));
      steps.push({
        proposalId: entry.proposalId,
        action: entry.action,
        stage: "backup",
        status: "succeeded",
        targetPath: entry.targetPath,
        snapshotPath: entry.snapshotPath,
      });
    }
    await writeJsonFileExclusive(response.auditPlan.backup.manifestPath, {
      schemaVersion: 1,
      kind: "doctor.memory.repair.execution.backup-manifest",
      executionId: response.executionId,
      agentId: response.agentId,
      createdAt,
      auditPlanFingerprint: response.auditPlanFingerprint,
      snapshots,
    });
    await writeAuditRecord(response.auditPlan.audit.recordPath, {
      event: "started",
      response,
      auditPlanFingerprint: response.auditPlanFingerprint,
      fsSafety,
    });

    for (const entry of response.auditPlan.backup.entries) {
      const snapshot = snapshots.find((item) => item.proposalId === entry.proposalId);
      if (!snapshot) {
        throw new Error(`missing backup snapshot for ${entry.proposalId}`);
      }
      const writeStep = await writeTarget(entry.action, entry.proposalId, entry.targetPath);
      snapshot.wroteTarget =
        writeStep.status === "succeeded" && writeStep.message !== "already present";
      steps.push(writeStep);
      if (writeStep.status === "failed") {
        break;
      }
    }

    const hasFailedWrite = steps.some((step) => step.stage === "write" && step.status === "failed");
    const rollback = hasFailedWrite ? await rollbackSnapshots(snapshots, steps) : undefined;
    const result = buildExecutionResult({
      response,
      previewFingerprint,
      steps,
      rollback,
      lockPath,
    });
    await writeAuditRecord(response.auditPlan.audit.recordPath, {
      event: "finished",
      result,
    });
    lockRecord = { ...lockRecord, status: result.status === "success" ? "completed" : "failed" };
    await finishLock(lockPath, lockRecord, lockRecord.status);
    return result;
  } catch (err) {
    const rollback = await rollbackSnapshots(snapshots, steps);
    steps.push({
      proposalId: "__executor__",
      action: "manual_review",
      stage: "write",
      status: "failed",
      message: formatFsError(err),
    });
    const result = buildExecutionResult({
      response,
      previewFingerprint,
      steps,
      rollback,
      lockPath,
      extraReasons: [formatFsError(err)],
    });
    await writeAuditRecord(response.auditPlan.audit.recordPath, {
      event: "failed",
      result,
    }).catch(() => {});
    await finishLock(lockPath, lockRecord, "failed");
    return result;
  }
}

async function buildExecutionPreview(input: DoctorMemoryRepairExecuteInput): Promise<{
  preview: DoctorMemoryRepairPreviewPayload;
  allowedRoots: string[];
  stateDir: string;
}> {
  const stateDir = path.resolve(resolveStateDir(input.env ?? process.env));
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(input.cfg, input.agentId));
  let providerStatus: MemoryProviderStatus | undefined;
  let providerError: string | undefined;
  const { manager, error } = await getMemorySearchManager({
    cfg: input.cfg,
    agentId: input.agentId,
    purpose: "status",
  });
  providerError = error;
  if (manager) {
    try {
      providerStatus = manager.status();
    } catch (err) {
      providerError = `memory status failed: ${formatFsError(err)}`;
    } finally {
      await manager.close?.().catch(() => {});
    }
  }
  const inventory = await buildMemoryInventory({
    cfg: input.cfg,
    agentId: input.agentId,
    ...(providerStatus ? { providerStatus } : {}),
    ...(providerError ? { providerError } : {}),
  });
  return {
    preview: previewMemoryInventoryRepair(inventory),
    allowedRoots: [workspaceDir, stateDir],
    stateDir,
  };
}

function baseResult(
  response: DoctorMemoryRepairExecutionResponse,
  previewFingerprint: string,
): Omit<DoctorMemoryRepairExecuteResult, "status" | "summary" | "rollback" | "steps" | "reasons"> {
  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.result",
    method: DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
    dryRun: false,
    noWritePerformed: false,
    executionId: response.executionId,
    agentId: response.agentId,
    previewFingerprint,
    ...(response.auditPlanFingerprint
      ? { auditPlanFingerprint: response.auditPlanFingerprint }
      : {}),
    selectedProposalIds: response.selectedProposalIds,
    ...(response.auditPlan?.backup.manifestPath
      ? { backupManifestPath: response.auditPlan.backup.manifestPath }
      : {}),
    ...(response.auditPlan?.audit.recordPath
      ? { auditRecordPath: response.auditPlan.audit.recordPath }
      : {}),
  };
}

function deniedResult(params: {
  response?: DoctorMemoryRepairExecutionResponse;
  previewFingerprint: string;
  reasons: string[];
  executionId: string;
  agentId: string;
  lockPath?: string;
  fsSafety?: DoctorMemoryRepairFsSafetyDecision;
}): DoctorMemoryRepairExecuteResult {
  const selected = params.response?.selectedProposalIds ?? [];
  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.result",
    method: DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
    dryRun: false,
    noWritePerformed: true,
    executionId: params.executionId,
    agentId: params.agentId,
    status: "denied",
    previewFingerprint: params.previewFingerprint,
    ...(params.response?.auditPlanFingerprint
      ? { auditPlanFingerprint: params.response.auditPlanFingerprint }
      : {}),
    selectedProposalIds: selected,
    ...(params.response?.auditPlan?.backup.manifestPath
      ? { backupManifestPath: params.response.auditPlan.backup.manifestPath }
      : {}),
    ...(params.response?.auditPlan?.audit.recordPath
      ? { auditRecordPath: params.response.auditPlan.audit.recordPath }
      : {}),
    ...(params.lockPath ? { lockPath: params.lockPath } : {}),
    summary: emptySummary(selected.length),
    rollback: { attempted: false, status: "not-needed", reasons: [] },
    steps: params.fsSafety
      ? params.fsSafety.checkedPaths.map((entry) => ({
          proposalId: "__fs_safety__",
          action: entry.action ?? "manual_review",
          stage: "fs-safety" as const,
          status: entry.ok ? ("succeeded" as const) : ("failed" as const),
          targetPath: entry.path,
          message: entry.reasons.join("; "),
        }))
      : [],
    reasons: Array.from(new Set(params.reasons)),
  };
}

function buildExecutionResult(params: {
  response: DoctorMemoryRepairExecutionResponse;
  previewFingerprint: string;
  steps: DoctorMemoryRepairExecuteStep[];
  rollback?: DoctorMemoryRepairExecuteResult["rollback"];
  lockPath: string;
  extraReasons?: string[];
}): DoctorMemoryRepairExecuteResult {
  const failed = params.steps.filter((step) => step.status === "failed").length;
  const writeSucceeded = params.steps.filter(
    (step) => step.stage === "write" && step.status === "succeeded",
  ).length;
  const backupSucceeded = params.steps.filter(
    (step) => step.stage === "backup" && step.status === "succeeded",
  ).length;
  const skipped = params.steps.filter((step) => step.status === "skipped").length;
  const status =
    failed === 0 && writeSucceeded === params.response.selectedProposalIds.length
      ? "success"
      : writeSucceeded > 0
        ? "partial-write"
        : "failure";
  const reasons = [
    ...params.steps.filter((step) => step.status === "failed").map((step) => step.message ?? ""),
    ...(params.extraReasons ?? []),
  ].filter(Boolean);
  const noWritePerformed = writeSucceeded === 0;
  return {
    ...baseResult(params.response, params.previewFingerprint),
    status,
    noWritePerformed,
    lockPath: params.lockPath,
    summary: {
      selected: params.response.selectedProposalIds.length,
      backupSucceeded,
      writeSucceeded,
      failed,
      skipped,
    },
    rollback: params.rollback ?? { attempted: false, status: "not-needed", reasons: [] },
    steps: params.steps,
    reasons: Array.from(new Set(reasons)),
  };
}

function emptySummary(selected: number): DoctorMemoryRepairExecuteResult["summary"] {
  return { selected, backupSucceeded: 0, writeSucceeded: 0, failed: 0, skipped: 0 };
}

async function evaluateCurrentFsSafety(
  response: DoctorMemoryRepairExecutionResponse,
): Promise<DoctorMemoryRepairFsSafetyDecision> {
  if (!response.auditPlan) {
    return {
      ok: false,
      safeToOpen: false,
      dryRun: true,
      noWritePerformed: true,
      checkedPaths: [],
      reasons: ["memory repair fs safety requires an audit plan"],
    };
  }
  return evaluateMemoryRepairFsSafety({
    auditPlan: response.auditPlan,
    pathStates: await collectFsPathStates(response.auditPlan),
  });
}

async function collectFsPathStates(
  auditPlan: NonNullable<DoctorMemoryRepairExecutionResponse["auditPlan"]>,
): Promise<DoctorMemoryRepairFsPathState[]> {
  const paths = new Set<string>([
    auditPlan.backup.root,
    auditPlan.backup.manifestPath,
    auditPlan.audit.root,
    auditPlan.audit.recordPath,
  ]);
  for (const entry of auditPlan.backup.entries) {
    paths.add(entry.targetPath);
    paths.add(entry.snapshotPath);
  }
  const states = await Promise.all(Array.from(paths).map((entry) => inspectPath(entry)));
  return states;
}

async function inspectPath(pathname: string): Promise<DoctorMemoryRepairFsPathState> {
  try {
    const stat = await fs.lstat(pathname);
    return {
      path: pathname,
      kind: kindFromStats(stat),
      ...(stat.isSymbolicLink()
        ? {}
        : { realPath: await fs.realpath(pathname).catch(() => pathname) }),
      ...(stat.isFile() ? { linkCount: stat.nlink } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        path: pathname,
        kind: "unknown",
        parent: await inspectNode(path.dirname(pathname)),
      };
    }
    return {
      path: pathname,
      kind: "missing",
      parent: await inspectNode(path.dirname(pathname)),
    };
  }
}

async function inspectNode(pathname: string): Promise<DoctorMemoryRepairFsNodeState> {
  try {
    const stat = await fs.lstat(pathname);
    return {
      path: pathname,
      kind: kindFromStats(stat),
      ...(stat.isSymbolicLink()
        ? {}
        : { realPath: await fs.realpath(pathname).catch(() => pathname) }),
      ...(stat.isFile() ? { linkCount: stat.nlink } : {}),
    };
  } catch {
    return { path: pathname, kind: "missing" };
  }
}

function kindFromStats(stat: Awaited<ReturnType<typeof fs.lstat>>): DoctorMemoryRepairFsNodeKind {
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  if (stat.isFIFO()) {
    return "fifo";
  }
  if (stat.isSocket()) {
    return "socket";
  }
  if (stat.isBlockDevice()) {
    return "block-device";
  }
  if (stat.isCharacterDevice()) {
    return "char-device";
  }
  return "unknown";
}

async function backupTarget(
  entry: NonNullable<DoctorMemoryRepairExecutionResponse["auditPlan"]>["backup"]["entries"][number],
): Promise<TargetSnapshot> {
  const beforeState = await inspectPath(entry.targetPath);
  if (beforeState.kind === "file") {
    await fs.copyFile(entry.targetPath, entry.snapshotPath, fsSync.constants.COPYFILE_EXCL);
    return {
      proposalId: entry.proposalId,
      action: entry.action,
      targetPath: entry.targetPath,
      snapshotPath: entry.snapshotPath,
      before: "file",
      wroteTarget: false,
    };
  }
  const before = beforeState.kind === "directory" ? "directory" : "missing";
  await writeJsonFileExclusive(entry.snapshotPath, {
    kind: "doctor.memory.repair.execution.snapshot-marker",
    proposalId: entry.proposalId,
    targetPath: entry.targetPath,
    before,
  });
  return {
    proposalId: entry.proposalId,
    action: entry.action,
    targetPath: entry.targetPath,
    snapshotPath: entry.snapshotPath,
    before,
    wroteTarget: false,
  };
}

async function writeTarget(
  action: DoctorMemoryRepairPreviewAction,
  proposalId: string,
  targetPath: string,
): Promise<DoctorMemoryRepairExecuteStep> {
  try {
    const state = await inspectPath(targetPath);
    if (action === "create_file") {
      if (state.kind === "file") {
        return {
          proposalId,
          action,
          stage: "write",
          status: "succeeded",
          targetPath,
          message: "already present",
        };
      }
      if (state.kind !== "missing") {
        return {
          proposalId,
          action,
          stage: "write",
          status: "failed",
          targetPath,
          message: `target is ${state.kind}`,
        };
      }
      await fs.writeFile(targetPath, "", { flag: "wx", mode: 0o600 });
      return { proposalId, action, stage: "write", status: "succeeded", targetPath };
    }
    if (action === "create_directory") {
      if (state.kind === "directory") {
        return {
          proposalId,
          action,
          stage: "write",
          status: "succeeded",
          targetPath,
          message: "already present",
        };
      }
      if (state.kind !== "missing") {
        return {
          proposalId,
          action,
          stage: "write",
          status: "failed",
          targetPath,
          message: `target is ${state.kind}`,
        };
      }
      await fs.mkdir(targetPath, { recursive: false, mode: 0o700 });
      return { proposalId, action, stage: "write", status: "succeeded", targetPath };
    }
    return {
      proposalId,
      action,
      stage: "write",
      status: "failed",
      targetPath,
      message: `action ${action} is not implemented by memory repair executor`,
    };
  } catch (err) {
    return {
      proposalId,
      action,
      stage: "write",
      status: "failed",
      targetPath,
      message: formatFsError(err),
      errorCode: (err as NodeJS.ErrnoException).code,
    };
  }
}

async function rollbackSnapshots(
  snapshots: TargetSnapshot[],
  steps: DoctorMemoryRepairExecuteStep[],
): Promise<DoctorMemoryRepairExecuteResult["rollback"]> {
  const wrote = snapshots.filter((snapshot) => snapshot.wroteTarget);
  if (wrote.length === 0) {
    return { attempted: false, status: "not-needed", reasons: [] };
  }
  const reasons: string[] = [];
  for (const snapshot of wrote.toReversed()) {
    try {
      if (snapshot.before === "missing") {
        if (snapshot.action === "create_directory") {
          await fs.rmdir(snapshot.targetPath);
        } else {
          await fs.unlink(snapshot.targetPath);
        }
      } else if (snapshot.before === "file") {
        await fs.copyFile(snapshot.snapshotPath, snapshot.targetPath);
      }
      steps.push({
        proposalId: snapshot.proposalId,
        action: snapshot.action,
        stage: "rollback",
        status: "succeeded",
        targetPath: snapshot.targetPath,
        snapshotPath: snapshot.snapshotPath,
      });
    } catch (err) {
      reasons.push(`rollback failed for ${snapshot.proposalId}: ${formatFsError(err)}`);
      steps.push({
        proposalId: snapshot.proposalId,
        action: snapshot.action,
        stage: "rollback",
        status: "failed",
        targetPath: snapshot.targetPath,
        snapshotPath: snapshot.snapshotPath,
        message: formatFsError(err),
        errorCode: (err as NodeJS.ErrnoException).code,
      });
    }
  }
  return {
    attempted: true,
    status: reasons.length === 0 ? "completed" : "failed",
    reasons,
  };
}

async function readExistingLocks(
  stateDir: string,
): Promise<DoctorMemoryRepairExecutionLockRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return [];
  }
  const locks: DoctorMemoryRepairExecutionLockRecord[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("memory-repair-") || !entry.endsWith(".lock.json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(stateDir, entry), "utf8"));
      if (parsed?.kind === "doctor.memory.repair.execution.lock") {
        locks.push(parsed as DoctorMemoryRepairExecutionLockRecord);
      }
    } catch {
      continue;
    }
  }
  return locks;
}

async function finishLock(
  lockPath: string,
  record: DoctorMemoryRepairExecutionLockRecord,
  status: DoctorMemoryRepairExecutionLockRecord["status"],
) {
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ ...record, status, finishedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function writeAuditRecord(pathname: string, payload: unknown) {
  await fs.appendFile(pathname, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

async function writeJsonFileExclusive(pathname: string, payload: unknown) {
  await fs.writeFile(pathname, `${JSON.stringify(payload, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function lockPathFor(stateDir: string, executionId: string): string {
  return path.join(stateDir, `memory-repair-${executionId}.lock.json`);
}

function normalizeExecutionId(value: string | undefined, agentId: string): string {
  const trimmed = value?.trim();
  if (trimmed && /^[A-Za-z0-9._-]{8,128}$/.test(trimmed)) {
    return trimmed;
  }
  const suffix = crypto.randomBytes(4).toString("hex");
  return `repair-${agentId.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}-${suffix}`.slice(0, 128);
}

function formatFsError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
