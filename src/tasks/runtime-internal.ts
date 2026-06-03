import { listTaskRecords } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

export function listTasksForOwnerKey(ownerKey: string): TaskRecord[] {
  const normalized = ownerKey.trim();
  if (!normalized) {
    return [];
  }
  return listTaskRecords({ limit: 1_000 }).tasks.filter(
    (task) =>
      task.ownerKey === normalized ||
      task.requesterSessionKey === normalized ||
      task.sessionKey === normalized,
  );
}
