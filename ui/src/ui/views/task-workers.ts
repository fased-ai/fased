import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import type { CronStatus } from "../types.ts";

type TaskQueueStatus = NonNullable<CronStatus["queue"]>;
type TaskQueueActiveRun = TaskQueueStatus["activeRuns"][number];
type TaskQueueRecentRun = TaskQueueStatus["recentRuns"][number];
type QueueControlAction = "cancel" | "retry" | "clear-stale";

type WorkerRow = {
  workerId: string;
  running: number;
  expired: number;
  activeRuns: TaskQueueActiveRun[];
  nextLeaseExpiresAtMs?: number;
  lastLeaseAtMs?: number;
};

type ManagedWorkerService = {
  name?: string;
  workerId?: string;
  status?: string;
  running?: boolean;
  enabled?: boolean;
  detail?: string;
};

export type TaskWorkersPanelProps = {
  queue?: TaskQueueStatus;
  agentId?: string;
  loading?: boolean;
  onRefresh?: () => void;
  onRunDetail?: (runId: string) => void;
  onQueueControl?: (action: QueueControlAction, runId: string) => void;
};

function matchesAgent(
  run: Pick<TaskQueueActiveRun | TaskQueueRecentRun, "agentId">,
  agentId?: string,
) {
  return !agentId || (run.agentId ?? "main") === agentId;
}

function queuedRunsFor(queue: TaskQueueStatus, agentId?: string) {
  return queue.recentRuns.filter((run) => run.status === "queued" && matchesAgent(run, agentId));
}

function activeRunsFor(queue: TaskQueueStatus, agentId?: string) {
  return queue.activeRuns.filter((run) => matchesAgent(run, agentId));
}

function workerRowsFor(activeRuns: TaskQueueActiveRun[]): WorkerRow[] {
  const rows = new Map<string, WorkerRow>();
  for (const run of activeRuns) {
    const workerId = run.leaseOwner?.trim() || "unleased";
    const row =
      rows.get(workerId) ??
      ({
        workerId,
        running: 0,
        expired: 0,
        activeRuns: [],
      } satisfies WorkerRow);
    row.running += 1;
    if (run.leaseExpired) {
      row.expired += 1;
    }
    row.activeRuns.push(run);
    if (typeof run.leaseExpiresAtMs === "number") {
      row.nextLeaseExpiresAtMs =
        typeof row.nextLeaseExpiresAtMs === "number"
          ? Math.min(row.nextLeaseExpiresAtMs, run.leaseExpiresAtMs)
          : run.leaseExpiresAtMs;
    }
    if (typeof run.startedAtMs === "number") {
      row.lastLeaseAtMs =
        typeof row.lastLeaseAtMs === "number"
          ? Math.max(row.lastLeaseAtMs, run.startedAtMs)
          : run.startedAtMs;
    }
    rows.set(workerId, row);
  }
  return Array.from(rows.values()).toSorted((a, b) => a.workerId.localeCompare(b.workerId));
}

function renderWorkerCounter(params: {
  value: number;
  label: string;
  title: string;
  tone?: "ok" | "warn";
}) {
  if (params.value <= 0) {
    return nothing;
  }
  return html`
    <span
      class=${`chip ${params.tone === "ok" ? "chip-ok" : params.tone === "warn" ? "chip-warn" : ""}`}
      title=${params.title}
    >
      ${params.value} ${params.label}
    </span>
  `;
}

export function renderTaskWorkerCounters(params: { queue?: TaskQueueStatus; agentId?: string }) {
  const queue = params.queue;
  if (!queue) {
    return nothing;
  }
  const queuedRuns = queuedRunsFor(queue, params.agentId);
  const activeRuns = activeRunsFor(queue, params.agentId);
  const expiredRuns = activeRuns.filter((run) => run.leaseExpired);
  const workerRows = workerRowsFor(activeRuns);
  const queuedCount = params.agentId ? queuedRuns.length : queue.queued;
  const rendered = [
    renderWorkerCounter({
      value: queuedCount,
      label: "queued",
      title: `${queuedCount} queued task run${queuedCount === 1 ? "" : "s"}`,
    }),
    renderWorkerCounter({
      value: activeRuns.length,
      label: "running",
      title: `${activeRuns.length} running task run${activeRuns.length === 1 ? "" : "s"}`,
      tone: "ok",
    }),
    renderWorkerCounter({
      value: expiredRuns.length,
      label: "expired",
      title: `${expiredRuns.length} expired lease${expiredRuns.length === 1 ? "" : "s"}`,
      tone: "warn",
    }),
    renderWorkerCounter({
      value: workerRows.length,
      label: workerRows.length === 1 ? "worker" : "workers",
      title: `${workerRows.length} active task worker${workerRows.length === 1 ? "" : "s"}`,
      tone: "ok",
    }),
  ].filter((entry) => entry !== nothing);
  if (rendered.length === 0) {
    return nothing;
  }
  return html`
    <div class="task-worker-counters" aria-label="Task worker counters">
      ${rendered}
    </div>
  `;
}

function serviceRowsFor(queue?: TaskQueueStatus): ManagedWorkerService[] {
  const raw =
    (queue as unknown as { managedWorkers?: unknown })?.managedWorkers ??
    (queue as unknown as { workerServices?: unknown })?.workerServices;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is ManagedWorkerService =>
    Boolean(entry && typeof entry === "object"),
  );
}

function renderWorkerPanelStyles() {
  return html`
    <style>
      .task-workers-panel {
        display: grid;
        gap: 12px;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid var(--border);
      }
      .task-workers-panel__head,
      .task-workers-panel__stats,
      .task-workers-panel__actions,
      .task-worker-row__head,
      .task-worker-row__runs,
      .task-worker-services {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .task-workers-panel__head {
        justify-content: space-between;
      }
      .task-workers-panel__title {
        font-weight: 800;
      }
      .task-workers-panel__subtitle {
        color: var(--muted);
        font-size: 0.82rem;
      }
      .task-workers-panel__actions {
        justify-content: flex-end;
      }
      .task-worker-list {
        display: grid;
        gap: 8px;
      }
      .task-worker-row {
        display: grid;
        gap: 8px;
        min-width: 0;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: color-mix(in srgb, var(--surface) 78%, transparent);
      }
      .task-worker-row[data-expired="true"] {
        border-color: color-mix(in srgb, var(--warning) 42%, var(--border));
      }
      .task-worker-row__head {
        justify-content: space-between;
      }
      .task-worker-row__identity {
        display: inline-flex;
        align-items: center;
        min-width: 0;
        gap: 8px;
        font-weight: 800;
      }
      .task-worker-row__dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--success);
        flex: 0 0 auto;
      }
      .task-worker-row[data-expired="true"] .task-worker-row__dot {
        background: var(--warning);
      }
      .task-worker-row__meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        gap: 8px;
      }
      .task-worker-row__meta-item {
        min-width: 0;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-xs);
      }
      .task-worker-row__meta-item span {
        display: block;
        color: var(--muted);
        font-size: 0.76rem;
      }
      .task-worker-row__meta-item strong {
        display: block;
        margin-top: 2px;
        overflow-wrap: anywhere;
        font-size: 0.86rem;
      }
      .task-worker-run-button,
      .task-worker-icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
      }
      .task-worker-run-button {
        min-width: 0;
        max-width: 100%;
        padding: 6px 8px;
        border-radius: var(--radius-xs);
        font-size: 0.78rem;
      }
      .task-worker-run-button:hover,
      .task-worker-icon-button:hover {
        background: var(--chip-bg-hover);
      }
      .task-worker-icon-button {
        width: 32px;
        height: 32px;
        border-radius: var(--radius-sm);
      }
      .task-worker-icon-button svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .task-worker-empty {
        color: var(--muted);
        font-size: 0.88rem;
      }
    </style>
  `;
}

function renderMeta(label: string, value: string | number | undefined) {
  if (value === undefined || value === "") {
    return nothing;
  }
  return html`
    <div class="task-worker-row__meta-item">
      <span>${label}</span>
      <strong class=${String(value).includes(":") ? "mono" : ""}>${value}</strong>
    </div>
  `;
}

function renderTaskRunButton(run: TaskQueueActiveRun, onRunDetail?: (runId: string) => void) {
  if (!onRunDetail) {
    return html`<span class="chip mono">${run.runId}</span>`;
  }
  return html`
    <button
      class="task-worker-run-button mono"
      type="button"
      aria-label=${`Open active run ${run.runId}`}
      @click=${() => onRunDetail(run.runId)}
      title=${`${run.jobName} · ${run.stepId} · attempt ${run.attempt}/${run.maxAttempts}`}
    >
      ${run.runId}
    </button>
  `;
}

function renderWorkerRow(params: { row: WorkerRow; onRunDetail?: (runId: string) => void }) {
  const firstRun = params.row.activeRuns[0];
  return html`
    <div class="task-worker-row" data-expired=${params.row.expired > 0 ? "true" : "false"}>
      <div class="task-worker-row__head">
        <div class="task-worker-row__identity">
          <span class="task-worker-row__dot"></span>
          <span class="mono">${params.row.workerId}</span>
        </div>
        <div class="task-workers-panel__actions">
          ${
            firstRun && params.onRunDetail
              ? html`
                  <button
                    class="task-worker-icon-button"
                    type="button"
                    aria-label=${`Open active run ${firstRun.runId}`}
                    @click=${() => params.onRunDetail?.(firstRun.runId)}
                    title="Open active run"
                  >
                    ${icons.eye}
                  </button>
                `
              : nothing
          }
        </div>
      </div>
      <div class="task-worker-row__meta">
        ${renderMeta("Running", params.row.running)}
        ${renderMeta("Expired leases", params.row.expired)}
        ${renderMeta(
          "Next lease expiry",
          params.row.nextLeaseExpiresAtMs
            ? formatRelativeTimestamp(params.row.nextLeaseExpiresAtMs)
            : undefined,
        )}
        ${renderMeta(
          "Last lease",
          params.row.lastLeaseAtMs ? formatRelativeTimestamp(params.row.lastLeaseAtMs) : undefined,
        )}
      </div>
      <div class="task-worker-row__runs">
        ${params.row.activeRuns.map((run) => renderTaskRunButton(run, params.onRunDetail))}
      </div>
    </div>
  `;
}

export function renderTaskWorkersPanel(params: TaskWorkersPanelProps) {
  const queue = params.queue;
  if (!queue) {
    return nothing;
  }
  const queuedRuns = queuedRunsFor(queue, params.agentId);
  const activeRuns = activeRunsFor(queue, params.agentId);
  const expiredRuns = activeRuns.filter((run) => run.leaseExpired);
  const workerRows = workerRowsFor(activeRuns);
  const serviceRows = serviceRowsFor(queue);
  const queuedCount = params.agentId ? queuedRuns.length : queue.queued;
  const runningCount = activeRuns.length;
  const queueIdle = queuedCount === 0 && runningCount === 0 && expiredRuns.length === 0;
  const canClearExpired = expiredRuns.length > 0 && Boolean(params.onQueueControl);
  return html`
    ${renderWorkerPanelStyles()}
    <section class="task-workers-panel" aria-label="Task workers">
      <div class="task-workers-panel__head">
        <div>
          <div class="task-workers-panel__title">Task workers</div>
          <div class="task-workers-panel__subtitle">
            Queue health, active leases, and worker ownership.
          </div>
        </div>
        <div class="task-workers-panel__actions">
          ${
            canClearExpired
              ? html`
                  <button
                    class="btn btn--sm"
                    type="button"
                    aria-label="Clear all stale leases"
                    ?disabled=${params.loading}
                    @click=${() =>
                      expiredRuns.forEach((run) =>
                        params.onQueueControl?.("clear-stale", run.runId),
                      )}
                  >
                    ${icons.wrench} Clear stale leases
                  </button>
                `
              : nothing
          }
          ${
            params.onRefresh
              ? html`
                  <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${params.loading}
                    @click=${params.onRefresh}
                  >
                    ${icons.refresh} Refresh
                  </button>
                `
              : nothing
          }
        </div>
      </div>
      <div class="task-workers-panel__stats">
        <span class="chip">${queuedCount} queued</span>
        <span class=${`chip ${runningCount ? "chip-warn" : ""}`}>${runningCount} running</span>
        ${
          expiredRuns.length
            ? html`<span class="chip chip-warn">${expiredRuns.length} expired lease${
                expiredRuns.length === 1 ? "" : "s"
              }</span>`
            : html`
                <span class="chip">0 expired leases</span>
              `
        }
        <span class="chip">${workerRows.length} active worker${workerRows.length === 1 ? "" : "s"}</span>
        ${
          queueIdle
            ? html`
                <span class="chip">queue idle</span>
              `
            : nothing
        }
      </div>
      ${
        serviceRows.length
          ? html`
              <div class="task-worker-services">
                ${serviceRows.map((service) => {
                  const label = service.name ?? service.workerId ?? "worker service";
                  const state =
                    service.status ??
                    (service.running ? "running" : service.enabled ? "enabled" : "stopped");
                  return html`<span class=${`chip ${service.running ? "chip-ok" : "chip-warn"}`}>
                    ${label}: ${state}${service.detail ? ` · ${service.detail}` : ""}
                  </span>`;
                })}
              </div>
            `
          : nothing
      }
      ${
        workerRows.length
          ? html`
              <div class="task-worker-list">
                ${repeat(
                  workerRows,
                  (row) => row.workerId,
                  (row) =>
                    renderWorkerRow({
                      row,
                      onRunDetail: params.onRunDetail,
                    }),
                )}
              </div>
            `
          : html`
              <div class="task-worker-empty">No active worker leases.</div>
            `
      }
    </section>
  `;
}
