import { listTaskRecords, updateTaskRecord } from "./task-registry.js";
import type { TaskDeliveryStatus, TaskRecord } from "./task-registry.types.js";

function compactRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeMetadata(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!current && !patch) {
    return undefined;
  }
  return compactRecord({
    ...current,
    ...patch,
  });
}

function sessionMatches(task: TaskRecord, sessionKey: string): boolean {
  return (
    task.sessionKey === sessionKey ||
    task.requesterSessionKey === sessionKey ||
    task.ownerKey === sessionKey
  );
}

export function updateLatestChannelTaskDelivery(params: {
  sessionKey?: string;
  channel?: string;
  deliveryStatus: TaskDeliveryStatus;
  delivery?: TaskRecord["delivery"];
  summary?: string;
  metadata?: Record<string, unknown>;
}): TaskRecord | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const channel = params.channel?.trim().toLowerCase();
  const candidate = listTaskRecords({ source: "channel", limit: 1_000 }).tasks.find((task) => {
    if (task.taskKind !== "channel-triggered-agent") {
      return false;
    }
    if (!sessionMatches(task, sessionKey)) {
      return false;
    }
    if (channel && task.channel?.toLowerCase() !== channel) {
      return false;
    }
    return true;
  });
  if (!candidate) {
    return undefined;
  }
  return updateTaskRecord(candidate.taskId, (task) => ({
    deliveryStatus: params.deliveryStatus,
    delivery: params.delivery ?? task.delivery,
    terminalSummary: params.summary ?? task.terminalSummary,
    metadata: mergeMetadata(task.metadata, params.metadata),
  }));
}
