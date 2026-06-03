import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { listTaskRecords } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";
import { buildTaskStatusSnapshot } from "./task-status.js";

export function listTasksForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}): TaskRecord[] {
  const related = params.relatedSessionKey.trim();
  const owner = params.callerOwnerKey.trim();
  if (!related || !owner) {
    return [];
  }
  const ownerAgentId = resolveAgentIdFromSessionKey(owner);
  const relatedAgentId = resolveAgentIdFromSessionKey(related);
  if (ownerAgentId !== relatedAgentId && owner !== related) {
    return [];
  }
  return listTaskRecords({ limit: 1_000 }).tasks.filter(
    (task) =>
      task.requesterSessionKey === related ||
      task.sessionKey === related ||
      task.ownerKey === related ||
      task.ownerKey === owner,
  );
}

export function buildTaskStatusSnapshotForRelatedSessionKeyForOwner(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
  nowMs?: number;
}) {
  return buildTaskStatusSnapshot(listTasksForRelatedSessionKeyForOwner(params), {
    nowMs: params.nowMs,
  });
}

function resolveAgentIdFromOwnerKey(ownerKey: string | undefined): string | undefined {
  const raw = ownerKey?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw.toLowerCase().startsWith("agent:")) {
    const [, agentId] = raw.split(":");
    return normalizeAgentId(agentId);
  }
  return resolveAgentIdFromSessionKey(raw);
}

export function resolveTaskRecordAgentId(
  task: Pick<TaskRecord, "agentId" | "sessionKey" | "requesterSessionKey" | "ownerKey">,
): string | undefined {
  return (
    task.agentId?.trim() ||
    (task.sessionKey ? resolveAgentIdFromSessionKey(task.sessionKey) : undefined) ||
    (task.requesterSessionKey
      ? resolveAgentIdFromSessionKey(task.requesterSessionKey)
      : undefined) ||
    resolveAgentIdFromOwnerKey(task.ownerKey)
  );
}

export function taskRecordBelongsToAgent(
  task: Pick<TaskRecord, "agentId" | "sessionKey" | "requesterSessionKey" | "ownerKey">,
  agentId: string | undefined,
): boolean {
  const selected = normalizeAgentId(agentId);
  if (!agentId?.trim()) {
    return true;
  }
  return resolveTaskRecordAgentId(task) === selected;
}
