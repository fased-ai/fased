import type { TaskRecord } from "./task-registry.types.js";

const RECENT_TASK_WINDOW_MS = 10 * 60_000;
const TITLE_LIMIT = 82;
const DETAIL_LIMIT = 112;

export type TaskStatusSnapshot = {
  line?: string;
  activeCount: number;
  recentFailureCount: number;
  tasks: TaskRecord[];
};

function truncateText(value: string | undefined, limit: number): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function isActive(task: TaskRecord): boolean {
  return task.status === "queued" || task.status === "running";
}

function isRecentFailure(task: TaskRecord, now: number): boolean {
  if (!["failed", "timed_out", "lost", "blocked"].includes(task.status)) {
    return false;
  }
  const at = task.endedAt ?? task.updatedAt ?? task.createdAt;
  return now - at <= RECENT_TASK_WINDOW_MS;
}

function formatTaskLine(task: TaskRecord): string {
  const runtime = task.runtime || task.source;
  const title = truncateText(task.task, TITLE_LIMIT);
  const detail = truncateText(
    task.progressSummary ?? task.terminalSummary ?? task.error,
    DETAIL_LIMIT,
  );
  return detail ? `${runtime} · ${title} · ${detail}` : `${runtime} · ${title}`;
}

export function buildTaskStatusSnapshot(
  tasks: TaskRecord[],
  opts?: { nowMs?: number; now?: number },
): TaskStatusSnapshot {
  const now = opts?.nowMs ?? opts?.now ?? Date.now();
  const active = tasks
    .filter(isActive)
    .toSorted((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  if (active.length > 0) {
    const count = active.length;
    const suffix = count === 1 ? "active" : "active";
    const rows = active.slice(0, 2).map(formatTaskLine);
    return {
      activeCount: count,
      recentFailureCount: 0,
      tasks: active,
      line: [`📌 Tasks: ${count} ${suffix}`, ...rows].join("\n"),
    };
  }

  const failures = tasks
    .filter((task) => isRecentFailure(task, now))
    .toSorted(
      (a, b) =>
        (b.endedAt ?? b.updatedAt ?? b.createdAt) - (a.endedAt ?? a.updatedAt ?? a.createdAt),
    );
  if (failures.length > 0) {
    const count = failures.length;
    const suffix = count === 1 ? "recent failure" : "recent failures";
    const rows = failures.slice(0, 2).map(formatTaskLine);
    return {
      activeCount: 0,
      recentFailureCount: count,
      tasks: failures,
      line: [`📌 Tasks: ${count} ${suffix}`, ...rows].join("\n"),
    };
  }

  return {
    activeCount: 0,
    recentFailureCount: 0,
    tasks: [],
  };
}
