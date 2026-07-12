import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import { formatAgentDisplayLabel } from "../agent-display.ts";
import type {
  CronFieldErrors,
  CronFieldKey,
  CronJobsAdaptiveRouteFilter,
  CronJobsLastStatusFilter,
  CronJobsScheduleKindFilter,
  CronRepairAction,
} from "../controllers/cron.ts";
import {
  buildTaskPolicyPresetPatch,
  getVisibleCronJobs,
  TASK_POLICY_PRESET_OPTIONS,
} from "../controllers/cron.ts";
import { formatDurationHuman, formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab, type Tab } from "../navigation.ts";
import { formatCronPayload, formatCronState } from "../presenter.ts";
import type {
  ChannelUiMetaEntry,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  CronTaskAdaptiveRoute,
  CronTaskGraphRepairPlan,
  CronTaskRunDetail,
  CronTaskTrustedSource,
  CronTaskWorkflowGraphNode,
  GatewayAgentRow,
} from "../types.ts";
import type {
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronRunScope,
  CronRunsStatusValue,
  CronJobsSortBy,
  CronRunsStatusFilter,
  CronSortDir,
} from "../types.ts";
import type { CronFormState } from "../ui-types.ts";
import { renderTaskWorkerCounters } from "./task-workers.ts";

type CronQueueStatus = NonNullable<CronStatus["queue"]>;
type CronRepairHandler = (
  job: CronJob,
  action: CronRepairAction,
  opts?: { source?: string; sourceNodeId?: string },
) => void | Promise<void>;

function taskActiveQueueRun(queue: CronQueueStatus | undefined, jobId: string) {
  return queue?.activeRuns.find((run) => run.jobId === jobId);
}

function taskFailedQueueRun(queue: CronQueueStatus | undefined, jobId: string) {
  return queue?.recentRuns.find(
    (run) =>
      run.jobId === jobId &&
      (run.status === "error" || run.status === "blocked" || run.status === "recovered"),
  );
}

function taskRepairCheckpointRunId(job: CronJob): string | undefined {
  const state = job.state;
  const runId = state?.lastRunCheckpoint?.runId;
  if (!runId) {
    return undefined;
  }
  const stopReason = state?.stopReason ?? "";
  const repairBlocked =
    state?.lastGraphRepairStop ||
    state?.needsAccess ||
    state?.lastRunStatus === "blocked" ||
    state?.lastStatus === "blocked" ||
    stopReason.startsWith("needsSources:") ||
    stopReason.startsWith("needsAccess:");
  return repairBlocked ? runId : undefined;
}

function taskLatestRunId(queue: CronQueueStatus | undefined, job: CronJob): string | undefined {
  const repairCheckpointRunId = taskRepairCheckpointRunId(job);
  if (repairCheckpointRunId) {
    return repairCheckpointRunId;
  }
  const active = taskActiveQueueRun(queue, job.id);
  if (active?.runId) {
    return active.runId;
  }
  const failed = taskFailedQueueRun(queue, job.id);
  if (failed?.runId) {
    return failed.runId;
  }
  const recent = queue?.recentRuns.find((run) => run.jobId === job.id);
  return recent?.runId ?? job.state?.lastRunCheckpoint?.runId;
}

export type CronProps = {
  basePath: string;
  loading: boolean;
  jobsLoadingMore: boolean;
  status: CronStatus | null;
  jobs: CronJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsQuery: string;
  jobsEnabledFilter: CronJobsEnabledFilter;
  jobsScheduleKindFilter: CronJobsScheduleKindFilter;
  jobsLastStatusFilter: CronJobsLastStatusFilter;
  jobsAdaptiveRouteFilter: CronJobsAdaptiveRouteFilter;
  jobsSortBy: CronJobsSortBy;
  jobsSortDir: CronSortDir;
  error: string | null;
  busy: boolean;
  form: CronFormState;
  fieldErrors: CronFieldErrors;
  canSubmit: boolean;
  editingJobId: string | null;
  channels: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  runsJobId: string | null;
  runs: CronRunLogEntry[];
  runsTotal: number;
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runsScope: CronRunScope;
  runsStatuses: CronRunsStatusValue[];
  runsDeliveryStatuses: CronDeliveryStatus[];
  runsStatusFilter: CronRunsStatusFilter;
  runsQuery: string;
  runsSortDir: CronSortDir;
  agentSuggestions: string[];
  agentOptions?: GatewayAgentRow[];
  modelSuggestions: string[];
  thinkingSuggestions: string[];
  timezoneSuggestions: string[];
  deliveryToSuggestions: string[];
  accountSuggestions: string[];
  configForm?: Record<string, unknown> | null;
  configLoading?: boolean;
  configSaving?: boolean;
  configDirty?: boolean;
  onFormChange: (patch: Partial<CronFormState>) => void;
  onConfigPatch?: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove?: (path: Array<string | number>) => void;
  onConfigSave?: () => void;
  onConfigReload?: () => void;
  onRefresh: () => void;
  onCreate: () => void;
  onAdd: () => void;
  onEdit: (job: CronJob) => void;
  onClone: (job: CronJob) => void;
  onCancelEdit: () => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob, mode?: "force" | "due") => void;
  onRepair?: CronRepairHandler;
  onApproveCoordination?: (job: CronJob) => void | Promise<void>;
  onAskAgentEvidence?: (job: CronJob) => void | Promise<void>;
  onSourceToggle?: (source: CronTaskTrustedSource, active: boolean) => void | Promise<void>;
  onSourceRemove?: (source: CronTaskTrustedSource) => void | Promise<void>;
  onNavigate?: (tab: Tab) => void;
  onQueueControl?: (action: "cancel" | "retry" | "clear-stale", runId: string) => void;
  onRunDetail?: (runId: string) => void;
  onRemove: (job: CronJob) => void;
  onLoadRuns: (jobId: string) => void;
  onLoadMoreJobs: () => void;
  onJobsFiltersChange: (patch: {
    cronJobsQuery?: string;
    cronJobsEnabledFilter?: CronJobsEnabledFilter;
    cronJobsScheduleKindFilter?: CronJobsScheduleKindFilter;
    cronJobsLastStatusFilter?: CronJobsLastStatusFilter;
    cronJobsAdaptiveRouteFilter?: CronJobsAdaptiveRouteFilter;
    cronJobsSortBy?: CronJobsSortBy;
    cronJobsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onJobsFiltersReset: () => void | Promise<void>;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsScope?: CronRunScope;
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsStatusFilter?: CronRunsStatusFilter;
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onNavigateToChat?: (sessionKey: string) => void;
};

function configValueAtPath(root: unknown, path: Array<string | number>): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function configStringValue(root: unknown, path: Array<string | number>): string {
  const value = configValueAtPath(root, path);
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "";
  }
  return String(value);
}

function patchCronStringOrRemove(props: CronProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (next) {
    props.onConfigPatch?.(path, next);
  } else {
    props.onConfigRemove?.(path);
  }
}

function patchCronIntegerOrRemove(props: CronProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (!next) {
    props.onConfigRemove?.(path);
    return;
  }
  const parsed = Number(next);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    props.onConfigPatch?.(path, parsed);
  }
}

function patchCronRetentionOrRemove(props: CronProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (!next) {
    props.onConfigRemove?.(path);
    return;
  }
  props.onConfigPatch?.(path, next.toLowerCase() === "false" ? false : next);
}

function buildChannelOptions(props: CronProps): string[] {
  const options = ["last", ...props.channels.filter(Boolean)];
  const current = props.form.deliveryChannel?.trim();
  if (current && !options.includes(current)) {
    options.push(current);
  }
  const seen = new Set<string>();
  return options.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function resolveChannelLabel(props: CronProps, channel: string): string {
  if (channel === "last") {
    return "last";
  }
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) {
    return meta.label;
  }
  return props.channelLabels?.[channel] ?? channel;
}

function formatAgentLabel(agent: GatewayAgentRow): string {
  return formatAgentDisplayLabel(agent);
}

const TASK_ADAPTIVE_ROUTE_OPTIONS: Array<{ value: CronJobsAdaptiveRouteFilter; label: string }> = [
  { value: "all", label: "All routing" },
  { value: "no-model", label: "No model" },
  { value: "skill-only", label: "Skill-only" },
  { value: "cheap-model", label: "Cheap check" },
  { value: "strong-model", label: "Strong model" },
  { value: "agent-evidence", label: "Agent evidence" },
  { value: "agent-default", label: "Agent default" },
];

function taskAdaptiveRouteLabel(route?: CronTaskAdaptiveRoute): string {
  switch (route) {
    case "no-model":
      return "no model";
    case "skill-only":
      return "skill-only";
    case "cheap-model":
      return "cheap check";
    case "strong-model":
      return "strong model";
    case "agent-evidence":
      return "Agent evidence";
    case "agent-default":
      return "Agent default";
    default:
      return "";
  }
}

function taskAdaptiveDecision(job: CronJob) {
  return job.state?.adaptiveRouting?.lastDecision;
}

function normalizeAgentId(value?: string | null): string {
  return value?.trim() ?? "";
}

function buildAgentOptions(props: CronProps): GatewayAgentRow[] {
  const options = new Map<string, GatewayAgentRow>();
  const addAgent = (agent: GatewayAgentRow) => {
    const id = normalizeAgentId(agent.id);
    if (!id || options.has(id)) {
      return;
    }
    options.set(id, { ...agent, id });
  };
  for (const agent of props.agentOptions ?? []) {
    addAgent(agent);
  }
  for (const id of props.agentSuggestions) {
    addAgent({ id });
  }
  for (const job of props.jobs) {
    const id = normalizeAgentId(job.agentId);
    if (id) {
      addAgent({ id });
    }
  }
  const current = normalizeAgentId(props.form.agentId);
  if (current) {
    addAgent({ id: current });
  }
  return Array.from(options.values());
}

function formatAgentForId(props: CronProps, agentId?: string | null): string {
  const id = normalizeAgentId(agentId);
  if (!id) {
    return "Assistant";
  }
  const agent = buildAgentOptions(props).find((entry) => entry.id === id);
  return agent ? formatAgentLabel(agent) : formatAgentDisplayLabel({ id });
}

function csvList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function toggleCoordinationAgent(props: CronProps, agentId: string) {
  const selected = new Set(csvList(props.form.coordinationAgents));
  if (selected.has(agentId)) {
    selected.delete(agentId);
  } else {
    selected.add(agentId);
  }
  const agents = Array.from(selected);
  props.onFormChange({
    coordinationAgents: agents.join(", "),
    coordinationMode:
      agents.length > 0 && props.form.coordinationMode === "none"
        ? "consult"
        : props.form.coordinationMode,
  });
}

type TaskAccessBlock = NonNullable<NonNullable<CronJob["state"]>["needsAccess"]>;

function setupTargetForAccess(
  block?: TaskAccessBlock,
): { tab: Tab; label: string; hash?: string } | null {
  const setupPath = block?.setupPath?.trim().toLowerCase();
  const service = block?.service?.trim().toLowerCase();
  const hash = setupPath?.includes("#") ? setupPath.split("#")[1] : undefined;
  if (setupPath === "/providers" || service === "model_provider") {
    return { tab: "providers", label: "Open Providers" };
  }
  if (service === "agent_models") {
    return { tab: "agents", label: "Open Agent > Models" };
  }
  if (setupPath === "/wallet#wallet-skill-grants" || service === "wallet_grants") {
    return { tab: "wallet", label: "Open Skill Grants", hash: "wallet-skill-grants" };
  }
  if (setupPath === "/wallet" || service === "wallet") {
    return { tab: "wallet", label: "Open Wallet" };
  }
  if (setupPath === "/channels" || service === "channel_delivery") {
    return { tab: "channels", label: "Open Channels" };
  }
  if (setupPath === "/skills#skill-library" || setupPath === "/skills" || service === "skills") {
    return { tab: "skills", label: "Open Skill Library", hash: hash ?? "skill-library" };
  }
  if (setupPath === "/agents#agent-access" || service === "agent_skills") {
    return { tab: "agents", label: "Open Agent Skills", hash: "agent-access" };
  }
  if (setupPath === "/agents" || service === "task_policy") {
    return { tab: "agents", label: "Open Agent" };
  }
  if (
    setupPath?.startsWith("/services") ||
    service === "web_search" ||
    service === "task_access" ||
    service === "media_browser" ||
    service === "plugin_services"
  ) {
    if (hash) {
      const labels: Record<string, string> = {
        "service-firecrawl": "Open Firecrawl setup",
        "service-github": "Open GitHub setup",
        "service-google-workspace": "Open Google Workspace setup",
        "service-media-browser": "Open Media/browser setup",
        "service-plugin-services": "Open Plugin services",
        "service-web-search": "Open Web/search setup",
      };
      return { tab: "services", label: labels[hash] ?? "Open Services", hash };
    }
    if (service === "web_search") {
      return { tab: "services", label: "Open Web/search setup", hash: "service-web-search" };
    }
    if (service === "github") {
      return { tab: "services", label: "Open GitHub setup", hash: "service-github" };
    }
    if (service === "google_workspace") {
      return {
        tab: "services",
        label: "Open Google Workspace setup",
        hash: "service-google-workspace",
      };
    }
    if (service === "firecrawl") {
      return { tab: "services", label: "Open Firecrawl setup", hash: "service-firecrawl" };
    }
    if (service === "media_browser") {
      return {
        tab: "services",
        label: "Open Media/browser setup",
        hash: "service-media-browser",
      };
    }
    if (service === "plugin_services") {
      return {
        tab: "services",
        label: "Open Plugin services",
        hash: "service-plugin-services",
      };
    }
    return { tab: "services", label: "Open Services" };
  }
  return null;
}

function tabForSetupPath(setupPath?: string): Tab | null {
  const normalized = setupPath?.trim().toLowerCase().split("#")[0];
  switch (normalized) {
    case "/providers":
      return "providers";
    case "/wallet":
      return "wallet";
    case "/channels":
      return "channels";
    case "/skills":
      return "skills";
    case "/agents":
      return "agents";
    case "/services":
      return "services";
    default:
      return null;
  }
}

function setupTabForRepair(job: CronJob, setupPath?: string): Tab {
  return (
    tabForSetupPath(setupPath) ??
    setupTargetForAccess(job.state?.needsAccess)?.tab ??
    sourceSetupPathForTask(job)
  );
}

type TaskLogTone = "ok" | "warn" | "danger" | "info" | "muted";

type TaskLogEntry = {
  tone: TaskLogTone;
  label: string;
  detail?: string;
};

function taskStatusTone(job: CronJob): TaskLogTone {
  if (job.state?.needsAccess || job.state?.lastStatus === "blocked") {
    return "warn";
  }
  if (!job.enabled || job.state?.stopReason) {
    return "muted";
  }
  if (job.state?.runningAtMs) {
    return "info";
  }
  if (job.state?.lastStatus === "error" || job.state?.lastRunStatus === "error") {
    return "danger";
  }
  if (job.state?.lastStatus === "ok" || job.state?.lastRunStatus === "ok") {
    return "ok";
  }
  if (job.state?.lastStatus === "skipped" || job.state?.lastRunStatus === "skipped") {
    return "warn";
  }
  return "muted";
}

function taskStatusTitle(job: CronJob): string {
  if (job.state?.needsAccess || job.state?.lastStatus === "blocked") {
    return "Needs access";
  }
  if (!job.enabled) {
    return "Disabled";
  }
  if (job.state?.stopReason) {
    return "Stopped";
  }
  if (job.state?.runningAtMs) {
    return "Running";
  }
  if (job.state?.lastStatus === "ok" || job.state?.lastRunStatus === "ok") {
    return "OK";
  }
  if (job.state?.lastStatus === "error" || job.state?.lastRunStatus === "error") {
    return "Failed";
  }
  return "Idle";
}

function taskStatusDotDescriptors(job: CronJob, activeRun?: CronQueueStatus["activeRuns"][number]) {
  const dots: Array<{ tone: TaskLogTone; title: string }> = [];
  const add = (tone: TaskLogTone, title: string) => {
    if (!dots.some((dot) => dot.title === title)) {
      dots.push({ tone, title });
    }
  };
  add(taskStatusTone(job), taskStatusTitle(job));
  if (!job.enabled && taskStatusTitle(job) !== "Disabled") {
    add("muted", "Disabled");
  }
  if (job.state?.stopReason && taskStatusTitle(job) !== "Stopped") {
    add("muted", "Stopped");
  }
  if (activeRun) {
    add(
      activeRun.leaseExpired ? "warn" : "info",
      activeRun.leaseExpired
        ? `Expired lease for run ${activeRun.runId}`
        : `Running run ${activeRun.runId}`,
    );
  }
  if (job.state?.lastDeliveryStatus === "not-delivered") {
    add("danger", "Delivery failed");
  }
  return dots.slice(0, 3);
}

function renderTaskStatusDots(job: CronJob, activeRun?: CronQueueStatus["activeRuns"][number]) {
  return html`
    <span class="task-status-dots" aria-label=${taskStatusTitle(job)}>
      ${taskStatusDotDescriptors(job, activeRun).map(
        (dot) => html`
          <span class=${`task-status-dot task-status-dot--${dot.tone}`} title=${dot.title}></span>
        `,
      )}
    </span>
  `;
}

function compactTaskId(id: string): string {
  const lastDash = id.lastIndexOf("-");
  if (id.startsWith("task-") && lastDash > 4 && lastDash < id.length - 1) {
    return `task...${id.slice(lastDash + 1)}`;
  }
  if (id.length <= 12) {
    return id;
  }
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function formatCompactTaskSchedule(job: CronJob): string {
  const schedule = job.schedule;
  if (schedule.kind === "every") {
    return formatDurationHuman(schedule.everyMs);
  }
  if (schedule.kind === "at") {
    const atMs = Date.parse(schedule.at);
    return Number.isFinite(atMs) ? formatRelativeTimestamp(atMs) : schedule.at;
  }
  return schedule.expr;
}

function renderCompactNextWake(nextWakeAtMs?: number | null) {
  if (!nextWakeAtMs) {
    return nothing;
  }
  return html`<span class="chip" title=${new Date(nextWakeAtMs).toLocaleString()}>
    next ${formatRelativeTimestamp(nextWakeAtMs)}
  </span>`;
}

function renderTaskRuntimeConfig(props: CronProps) {
  const hasRuntimeConfig =
    props.configForm !== undefined ||
    props.onConfigPatch ||
    props.onConfigSave ||
    props.onConfigReload;
  if (!hasRuntimeConfig) {
    return nothing;
  }
  const canEdit = Boolean(props.configForm && props.onConfigPatch && props.onConfigRemove);
  const disabled = props.configSaving || !canEdit;
  const cronEnabled = configValueAtPath(props.configForm, ["cron", "enabled"]);
  const enabledValue =
    typeof cronEnabled === "boolean" ? (cronEnabled ? "enabled" : "disabled") : "";
  const maxConcurrentRuns = configStringValue(props.configForm, ["cron", "maxConcurrentRuns"]);
  const sessionRetention = configStringValue(props.configForm, ["cron", "sessionRetention"]);
  const runLogMaxBytes = configStringValue(props.configForm, ["cron", "runLog", "maxBytes"]);
  const runLogKeepLines = configStringValue(props.configForm, ["cron", "runLog", "keepLines"]);
  return html`
    <section class="card task-runtime-card" data-test-id="task-runtime-config">
      <div class="task-runtime-card__head">
        <div>
          <div class="task-runtime-card__title">Runtime & Retention</div>
          <div class="task-runtime-card__sub">
            Global scheduler, worker concurrency, and task-run cleanup policy.
          </div>
        </div>
        <div class="task-runtime-card__actions">
          ${
            props.onConfigReload
              ? html`
                  <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${props.configLoading || props.configSaving}
                    @click=${props.onConfigReload}
                  >
                    ${props.configLoading ? "Loading..." : "Reload"}
                  </button>
                `
              : nothing
          }
          ${
            props.onConfigSave
              ? html`
                  <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${props.configSaving || !props.configDirty}
                    @click=${props.onConfigSave}
                  >
                    ${props.configSaving ? "Saving..." : "Save runtime"}
                  </button>
                `
              : nothing
          }
        </div>
      </div>
      ${
        props.configForm
          ? html`
              <div class="task-runtime-card__grid">
                <label class="field">
                  <span>Scheduler</span>
                  <select
                    aria-label="Task scheduler"
                    .value=${enabledValue}
                    ?disabled=${disabled}
                    @change=${(event: Event) => {
                      const next = (event.target as HTMLSelectElement).value;
                      if (next === "enabled") {
                        props.onConfigPatch?.(["cron", "enabled"], true);
                      } else if (next === "disabled") {
                        props.onConfigPatch?.(["cron", "enabled"], false);
                      } else {
                        props.onConfigRemove?.(["cron", "enabled"]);
                      }
                    }}
                  >
                    <option value="">Default</option>
                    <option value="enabled">Enabled</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
                <label class="field">
                  <span>Max concurrent runs</span>
                  <input
                    aria-label="Max concurrent task runs"
                    type="number"
                    min="1"
                    step="1"
                    .value=${maxConcurrentRuns}
                    placeholder="default"
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchCronIntegerOrRemove(
                        props,
                        ["cron", "maxConcurrentRuns"],
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
                <label class="field">
                  <span>Run session retention</span>
                  <input
                    aria-label="Task run session retention"
                    .value=${sessionRetention}
                    placeholder="24h"
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchCronRetentionOrRemove(
                        props,
                        ["cron", "sessionRetention"],
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
                <label class="field">
                  <span>Run log max bytes</span>
                  <input
                    aria-label="Task run log max bytes"
                    .value=${runLogMaxBytes}
                    placeholder="2000000"
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchCronStringOrRemove(
                        props,
                        ["cron", "runLog", "maxBytes"],
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
                <label class="field">
                  <span>Run log keep lines</span>
                  <input
                    aria-label="Task run log keep lines"
                    type="number"
                    min="1"
                    step="1"
                    .value=${runLogKeepLines}
                    placeholder="2000"
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchCronIntegerOrRemove(
                        props,
                        ["cron", "runLog", "keepLines"],
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
              </div>
            `
          : html`
              <div class="muted">Load config to edit task runtime settings.</div>
            `
      }
    </section>
  `;
}

function formatTaskStopReason(reason: string): string {
  if (reason === "onSuccess") {
    return "stopped after success";
  }
  if (reason.startsWith("maxSuccessfulRuns:")) {
    return `stopped after ${reason.slice("maxSuccessfulRuns:".length)} successful runs`;
  }
  if (reason.startsWith("maxTotalRuns:")) {
    return `stopped after ${reason.slice("maxTotalRuns:".length)} total runs`;
  }
  if (reason.startsWith("outputIncludes:")) {
    return `stopped by output marker ${reason.slice("outputIncludes:".length)}`;
  }
  if (reason.startsWith("needsAccess:")) {
    return "blocked until access is fixed";
  }
  if (reason.startsWith("needsSources:")) {
    return formatTaskSourceStopLabel(reason.slice("needsSources:".length));
  }
  return reason;
}

function formatTaskSourceStopLabel(code: string): string {
  switch (code) {
    case "source_access_missing":
      return "source access missing";
    case "needs_user_source":
      return "needs trusted source";
    case "conflicting_sources":
      return "conflicting sources need review";
    case "repair_limit_reached":
      return "repair limit reached";
    case "insufficient_sources":
      return "insufficient sources";
    default:
      return "needs source review";
  }
}

function formatTaskRunLog(job: CronJob): TaskLogEntry[] {
  const state = job.state;
  if (!state) {
    return [];
  }
  const details: TaskLogEntry[] = [];
  if (state.needsAccess?.reason) {
    details.push({ tone: "warn", label: "Blocked", detail: state.needsAccess.reason });
  } else if (state.runningAtMs) {
    details.push({ tone: "info", label: "Running now" });
  } else if (state.lastRunStatus || state.lastStatus) {
    const status = state.lastRunStatus ?? state.lastStatus;
    const label =
      status === "ok"
        ? "Last run ok"
        : status === "blocked"
          ? "Last run blocked"
          : status === "skipped"
            ? "Last run skipped"
            : "Last run failed";
    details.push({
      tone:
        status === "ok" ? "ok" : status === "blocked" || status === "skipped" ? "warn" : "danger",
      label,
      detail: state.lastError,
    });
  }
  if (state.lastDeliveryStatus === "not-delivered") {
    details.push({
      tone: "danger",
      label: "Delivery failed",
      detail: state.lastDeliveryError,
    });
  } else if (state.lastDeliveryStatus === "delivered") {
    details.push({ tone: "ok", label: "Delivery sent" });
  }
  if (state.lastRunResultSource === "direct-tool") {
    details.push({
      tone: "ok",
      label: "Direct tool result",
      detail: state.lastRunResultAdapter
        ? `${state.lastRunResultAdapter} - no model used`
        : "no model used",
    });
  } else if (state.lastRunResultSource === "direct-text") {
    details.push({
      tone: "muted",
      label: "Direct task result",
      detail: "no model used",
    });
  } else if (state.lastRunResultSource === "model") {
    details.push({
      tone: "info",
      label: "Model result",
      detail: state.lastRunModelSource,
    });
  }
  if (state.lastEvaluatorDecision) {
    details.push({
      tone: state.lastEvaluatorDecision.stopCode
        ? "warn"
        : state.lastEvaluatorDecision.action === "none"
          ? "muted"
          : "info",
      label: state.lastEvaluatorDecision.stopCode
        ? `Evaluator ${formatTaskSourceStopLabel(state.lastEvaluatorDecision.stopCode)}`
        : `Evaluator ${state.lastEvaluatorDecision.action}`,
      detail: state.lastEvaluatorDecision.reason,
    });
  }
  if (state.lastGraphRepairStop) {
    details.push({
      tone: "warn",
      label: `Repair stopped: ${formatTaskSourceStopLabel(state.lastGraphRepairStop.code)}`,
      detail: state.lastGraphRepairStop.reason,
    });
  }
  if (state.pendingEscalation) {
    details.push({
      tone: "info",
      label: "Escalation queued",
      detail: state.pendingEscalation.reason,
    });
  }
  if (state.adaptiveRouting?.lastDecision) {
    const adaptive = state.adaptiveRouting.lastDecision;
    details.push({
      tone: "info",
      label: `Adaptive next: ${taskAdaptiveRouteLabel(adaptive.route)}`,
      detail: `${adaptive.reason} · ${adaptive.sampleSize} sample${
        adaptive.sampleSize === 1 ? "" : "s"
      }`,
    });
  }
  if (state.lastRunSessionKey) {
    details.push({ tone: "info", label: "Latest run transcript is ready" });
  }
  if (state.stopReason) {
    details.push({ tone: "muted", label: formatTaskStopReason(state.stopReason) });
  }
  return details.slice(0, 5);
}

function renderTaskRunLog(entries: TaskLogEntry[]) {
  if (entries.length === 0) {
    return nothing;
  }
  return html`
    <div class="task-run-log">
      ${entries.map(
        (entry) => html`
          <div class="task-run-log-entry">
            <span class=${`task-run-log-dot task-run-log-dot--${entry.tone}`}></span>
            <span>
              <span class="task-run-log-label">${entry.label}</span>
              ${entry.detail ? html`<span class="task-run-log-detail">${entry.detail}</span>` : nothing}
            </span>
          </div>
        `,
      )}
    </div>
  `;
}

function taskSortMs(job: CronJob): number {
  return job.updatedAtMs ?? job.state?.lastRunAtMs ?? job.createdAtMs ?? 0;
}

function taskPromptPreview(job: CronJob): string {
  if (job.payload.kind === "systemEvent") {
    return job.payload.text;
  }
  return job.payload.message;
}

function taskDeliveryLabel(job: CronJob): string {
  const delivery = job.delivery;
  if (!delivery) {
    return "no delivery";
  }
  if (delivery.mode === "none") {
    return "internal only";
  }
  if (delivery.mode === "webhook") {
    return delivery.to ? `webhook -> ${delivery.to}` : "webhook";
  }
  return `${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""}`;
}

function renderTaskAccessCallout(params: {
  block?: TaskAccessBlock;
  basePath: string;
  onActionClick?: (event: Event) => void;
}) {
  const block = params.block;
  if (!block) {
    return nothing;
  }
  const setupTarget = setupTargetForAccess(block);
  return html`
    <div class="callout warn" style="margin-top: 8px;">
      <div>Access required before this task can resume.</div>
      ${block.setupCommand ? html`<span class="mono">${block.setupCommand}</span>` : nothing}
      ${
        setupTarget
          ? html`
              <a
                class="btn btn--sm"
                href=${`${pathForTab(setupTarget.tab, params.basePath)}${
                  setupTarget.hash ? `#${setupTarget.hash}` : ""
                }`}
                @click=${params.onActionClick}
              >
                ${setupTarget.label}
              </a>
            `
          : nothing
      }
    </div>
  `;
}

function sourceSetupPathForTask(job: CronJob): Tab {
  const sourceNodeId =
    job.state?.lastGraphRepairStop?.sourceNodeId ??
    job.state?.lastGraphRepair?.replacesNodeId ??
    job.state?.lastGraphRepair?.nodeId ??
    "";
  if (sourceNodeId.includes("gateway")) {
    return "providers";
  }
  if (sourceNodeId.includes("wallet")) {
    return "wallet";
  }
  return "services";
}

function renderTaskRepairControls(job: CronJob, props: CronProps) {
  const stop = job.state?.lastGraphRepairStop;
  const sourceNodeId = stop?.sourceNodeId ?? job.state?.lastGraphRepair?.replacesNodeId;
  const needsSourceRecovery = Boolean(stop || job.state?.stopReason?.startsWith("needsSources:"));
  if (!needsSourceRecovery && !job.state?.needsAccess) {
    return nothing;
  }
  const setupPath = sourceSetupPathForTask(job);
  const configureSource = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    await props.onRepair?.(job, "configure_source");
    props.onNavigate?.(setupPath);
  };
  const addTrustedSource = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const root = (event.currentTarget as HTMLElement).closest(".task-repair-controls");
    const input = root?.querySelector<HTMLInputElement>("[data-task-trusted-source]");
    const source = input?.value.trim() ?? "";
    if (!source) {
      input?.focus();
      return;
    }
    void props.onRepair?.(job, "add_trusted_source", { source });
  };
  return html`
    <div class="cron-job-field cron-job-field--wide task-repair-controls">
      <div class="cron-job-detail-label">Source recovery</div>
      ${renderTaskRepairRecommendation(job)}
      <div class="task-repair-note">
        ${
          stop
            ? html`<span>${formatTaskSourceStopLabel(stop.code)}</span><span>${stop.reason}</span>`
            : html`
                <span>Task needs source or access recovery before the next run.</span>
              `
        }
      </div>
      <div class="task-repair-source-row">
        <input
          class="task-repair-source-input"
          data-task-trusted-source
          placeholder="Paste trusted source URL or note"
          @click=${(event: Event) => event.stopPropagation()}
        />
        <button
          type="button"
          class="button-secondary"
          ?disabled=${props.busy}
          @click=${addTrustedSource}
        >
          Add trusted source
        </button>
      </div>
      <div class="task-repair-actions">
        ${
          props.onNavigate
            ? html`
                <button
                  type="button"
                  class="button-secondary"
                  ?disabled=${props.busy || !props.onRepair}
                  @click=${configureSource}
                >
                  Configure source
                </button>
              `
            : html`
                <a
                  class="button-secondary"
                  href=${pathForTab(setupPath, props.basePath)}
                  @click=${() => void props.onRepair?.(job, "configure_source")}
                >
                  Configure source
                </a>
              `
        }
        <button
          type="button"
          class="button-secondary"
          ?disabled=${props.busy || !props.onRepair}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            void props.onRepair?.(job, "retry_replacement");
          }}
        >
          Retry replacement
        </button>
        <button
          type="button"
          class="button-secondary"
          ?disabled=${props.busy || !props.onRepair || !sourceNodeId}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            void props.onRepair?.(job, "stop_source_path", { sourceNodeId });
          }}
        >
          Stop source path
        </button>
      </div>
    </div>
  `;
}

function sourceStatusLabel(source: CronTaskTrustedSource) {
  if (source.active === false) {
    return "disabled";
  }
  if (source.lastError) {
    return "needs review";
  }
  return "active";
}

function sourceStatusClass(source: CronTaskTrustedSource) {
  if (source.active === false) {
    return "chip-warn";
  }
  if (source.lastError || source.lastQualityBand === "unavailable") {
    return "chip-warn";
  }
  if (source.lastQualityBand === "high" || source.lastQualityBand === "medium") {
    return "chip-ok";
  }
  return "";
}

function sourceQualityLabel(source: CronTaskTrustedSource) {
  const band = source.lastQualityBand;
  const score =
    typeof source.lastQualityScore === "number" && Number.isFinite(source.lastQualityScore)
      ? source.lastQualityScore.toFixed(2)
      : "";
  if (band && score) {
    return `${band} ${score}`;
  }
  return band ?? (score || "unknown");
}

function sourceRoleForJob(
  job: CronJob,
  source: CronTaskTrustedSource,
): CronTaskWorkflowGraphNode | undefined {
  return job.executionPolicy?.planner?.graph?.nodes?.find(
    (node) =>
      node.trustedSourceId === source.id ||
      (node.sourceUrl && node.sourceUrl === source.source) ||
      (node.sourceText && node.sourceText === source.source),
  );
}

function sourceRoleLabel(node: CronTaskWorkflowGraphNode | undefined) {
  if (!node?.sourceRole) {
    return "task source";
  }
  return node.optional ? `${node.sourceRole} optional` : node.sourceRole;
}

function sourceLastUsedLabel(source: CronTaskTrustedSource) {
  const ts = source.lastRunAtMs ?? source.lastUsedAtMs ?? source.updatedAtMs ?? source.createdAtMs;
  return ts ? formatRelativeTimestamp(ts) : "never";
}

function taskCoordinationLabel(job: CronJob) {
  const coordination = job.executionPolicy?.coordination;
  if (!coordination?.mode || coordination.mode === "none") {
    return "None";
  }
  const agents = coordination.agents?.length ? coordination.agents.join(", ") : "planner-selected";
  const maxAgents =
    typeof coordination.maxAgents === "number" && Number.isFinite(coordination.maxAgents)
      ? ` · max ${coordination.maxAgents}`
      : "";
  const approval =
    coordination.requireApproval === false ? " · approval optional" : " · approval required";
  return `${coordination.mode} · ${agents}${maxAgents}${approval}`;
}

function taskCoordinationNeedsApproval(job: CronJob) {
  const coordination = job.executionPolicy?.coordination;
  return Boolean(
    coordination?.mode &&
    coordination.mode !== "none" &&
    coordination.requireApproval !== false &&
    !job.state?.coordinationApprovedAtMs,
  );
}

function taskHasRunnableCoordination(job: CronJob) {
  const coordination = job.executionPolicy?.coordination;
  return Boolean(
    coordination?.mode &&
    coordination.mode !== "none" &&
    (coordination.agents ?? []).some((agent) => agent.trim()),
  );
}

function taskCoordinationAgentsLabel(job: CronJob) {
  const agents = job.executionPolicy?.coordination?.agents?.filter(Boolean) ?? [];
  return agents.length ? agents.join(", ") : "planner-selected Agents";
}

function renderTaskCoordinationRetry(
  job: CronJob,
  props: Pick<CronProps, "busy" | "onAskAgentEvidence">,
) {
  if (!taskHasRunnableCoordination(job)) {
    return nothing;
  }
  return html`
    <div class="cron-job-field cron-job-field--wide task-repair-controls">
      <div class="cron-job-detail-label">Agent evidence</div>
      <div class="task-repair-note">
        <span>Run this task again and ask ${taskCoordinationAgentsLabel(job)} for task-room evidence.</span>
      </div>
      <div class="task-repair-actions">
        <button
          type="button"
          class="button-secondary"
          ?disabled=${props.busy || !props.onAskAgentEvidence}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            void props.onAskAgentEvidence?.(job);
          }}
        >
          Retry with Agent evidence
        </button>
      </div>
    </div>
  `;
}

function renderTaskCoordinationApproval(job: CronJob, props: CronProps) {
  if (!taskCoordinationNeedsApproval(job)) {
    return nothing;
  }
  return html`
    <div class="cron-job-field cron-job-field--wide task-repair-controls">
      <div class="cron-job-detail-label">Coordination approval</div>
      <div class="task-repair-note">
        <span>
          This task is approval-gated before it can consult ${taskCoordinationAgentsLabel(job)}.
        </span>
      </div>
      <div class="task-repair-actions">
        <button
          type="button"
          class="button-secondary"
          ?disabled=${props.busy || !props.onApproveCoordination}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            void props.onApproveCoordination?.(job);
          }}
        >
          Approve coordination & run
        </button>
      </div>
    </div>
  `;
}

type TaskCoordinationEvidenceView = NonNullable<
  NonNullable<CronJob["state"]>["lastCoordinationEvidence"]
>[number];

function coordinationEvidenceFromUnknown(value: unknown): TaskCoordinationEvidenceView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is TaskCoordinationEvidenceView => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as { agentId?: unknown; status?: unknown; mode?: unknown };
    return (
      typeof candidate.agentId === "string" &&
      typeof candidate.status === "string" &&
      typeof candidate.mode === "string"
    );
  });
}

function coordinationEvidenceForRunDetail(detail: CronTaskRunDetail) {
  const evidence: TaskCoordinationEvidenceView[] = [];
  for (const step of detail.stepDetails ?? []) {
    evidence.push(
      ...coordinationEvidenceFromUnknown(
        (step.checkpoint as { coordinationEvidence?: unknown } | undefined)?.coordinationEvidence,
      ),
    );
  }
  evidence.push(...(detail.job?.state?.lastCoordinationEvidence ?? []));
  const seen = new Set<string>();
  return evidence.filter((entry) => {
    const key = [
      entry.agentId,
      entry.status,
      entry.childSessionKey ?? "",
      entry.runId ?? "",
      entry.summary ?? "",
      entry.error ?? "",
    ].join("\u0000");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function renderTaskTrustedSources(job: CronJob, props: CronProps) {
  const sources = job.executionPolicy?.trustedSources ?? [];
  if (sources.length === 0) {
    return nothing;
  }
  return html`
    <div class="cron-job-field cron-job-field--wide task-source-controls">
      <div class="cron-job-detail-label">Trusted sources</div>
      <div class="task-source-list">
        ${sources.map((source) => {
          const node = sourceRoleForJob(job, source);
          const toggleLabel = source.active === false ? "Enable source" : "Disable source";
          return html`
            <div class="task-source-row">
              <div class="task-source-main">
                <div class="task-source-title-line">
                  <strong>${source.label ?? source.source}</strong>
                  <span class=${`chip ${sourceStatusClass(source)}`}>
                    ${sourceStatusLabel(source)}
                  </span>
                  <span class="chip">${sourceRoleLabel(node)}</span>
                </div>
                <div class="task-source-meta">
                  <span class="mono">${source.id}</span>
                  <span>${source.kind}</span>
                  <span>quality ${sourceQualityLabel(source)}</span>
                  <span>used ${source.useCount ?? 0}</span>
                  <span>ok ${source.successCount ?? 0}</span>
                  <span>fail ${source.failureCount ?? 0}</span>
                  <span>last ${sourceLastUsedLabel(source)}</span>
                </div>
                ${
                  source.lastError
                    ? html`<div class="task-source-error">${source.lastError}</div>`
                    : nothing
                }
              </div>
              <div
                class="task-source-actions"
                @click=${(event: Event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                ${renderTaskIconButton({
                  label: toggleLabel,
                  icon: source.active === false ? "play" : "pause",
                  disabled: props.busy || !props.onSourceToggle,
                  onClick: (event) => {
                    event.stopPropagation();
                    void props.onSourceToggle?.(source, source.active === false);
                  },
                })}
                ${renderTaskIconButton({
                  label: "Forget source",
                  icon: "x",
                  danger: true,
                  disabled: props.busy || !props.onSourceRemove,
                  onClick: (event) => {
                    event.stopPropagation();
                    void props.onSourceRemove?.(source);
                  },
                })}
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderTaskIconButton(params: {
  label: string;
  icon: keyof typeof icons;
  danger?: boolean;
  disabled?: boolean;
  onClick: (event: Event) => void;
}) {
  return html`
    <button
      class=${`cron-task-icon-button ${params.danger ? "cron-task-icon-button--danger" : ""}`}
      type="button"
      title=${params.label}
      aria-label=${params.label}
      ?disabled=${params.disabled}
      @click=${params.onClick}
    >
      ${icons[params.icon]}
    </button>
  `;
}

function renderSuggestionList(id: string, options: string[]) {
  const clean = Array.from(new Set(options.map((option) => option.trim()).filter(Boolean)));
  if (clean.length === 0) {
    return nothing;
  }
  return html`<datalist id=${id}>
    ${clean.map((value) => html`<option value=${value}></option> `)}
  </datalist>`;
}

type BlockingField = {
  key: CronFieldKey;
  label: string;
  message: string;
  inputId: string;
};

function errorIdForField(key: CronFieldKey) {
  return `cron-error-${key}`;
}

function inputIdForField(key: CronFieldKey) {
  if (key === "name") {
    return "cron-name";
  }
  if (key === "scheduleAt") {
    return "cron-schedule-at";
  }
  if (key === "everyAmount") {
    return "cron-every-amount";
  }
  if (key === "cronExpr") {
    return "cron-cron-expr";
  }
  if (key === "staggerAmount") {
    return "cron-stagger-amount";
  }
  if (key === "payloadText") {
    return "cron-payload-text";
  }
  if (key === "payloadModel") {
    return "cron-payload-model";
  }
  if (key === "payloadThinking") {
    return "cron-payload-thinking";
  }
  if (key === "timeoutSeconds") {
    return "cron-timeout-seconds";
  }
  if (key === "failureAlertAfter") {
    return "cron-failure-alert-after";
  }
  if (key === "failureAlertCooldownSeconds") {
    return "cron-failure-alert-cooldown-seconds";
  }
  return "cron-delivery-to";
}

function fieldLabelForKey(
  key: CronFieldKey,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
) {
  if (key === "payloadText") {
    return form.payloadKind === "systemEvent"
      ? t("cron.form.mainTimelineMessage")
      : t("cron.form.assistantTaskPrompt");
  }
  if (key === "deliveryTo") {
    return deliveryMode === "webhook" ? t("cron.form.webhookUrl") : t("cron.form.to");
  }
  const labels: Record<CronFieldKey, string> = {
    name: t("cron.form.fieldName"),
    scheduleAt: t("cron.form.runAt"),
    everyAmount: t("cron.form.every"),
    cronExpr: t("cron.form.expression"),
    staggerAmount: t("cron.form.staggerWindow"),
    payloadText: t("cron.form.assistantTaskPrompt"),
    payloadModel: t("cron.form.model"),
    payloadThinking: t("cron.form.thinking"),
    timeoutSeconds: t("cron.form.timeoutSeconds"),
    deliveryTo: t("cron.form.to"),
    failureAlertAfter: "Failure alert after",
    failureAlertCooldownSeconds: "Failure alert cooldown",
  };
  return labels[key];
}

function collectBlockingFields(
  errors: CronFieldErrors,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
): BlockingField[] {
  const orderedKeys: CronFieldKey[] = [
    "name",
    "scheduleAt",
    "everyAmount",
    "cronExpr",
    "staggerAmount",
    "payloadText",
    "payloadModel",
    "payloadThinking",
    "timeoutSeconds",
    "deliveryTo",
    "failureAlertAfter",
    "failureAlertCooldownSeconds",
  ];
  const fields: BlockingField[] = [];
  for (const key of orderedKeys) {
    const message = errors[key];
    if (!message) {
      continue;
    }
    fields.push({
      key,
      label: fieldLabelForKey(key, form, deliveryMode),
      message,
      inputId: inputIdForField(key),
    });
  }
  return fields;
}

function focusFormField(id: string) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) {
    return;
  }
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  el.focus();
}

function renderFieldLabel(text: string, required = false) {
  return html`<span>
    ${text}
    ${
      required
        ? html`
          <span class="cron-required-marker" aria-hidden="true">*</span>
          <span class="cron-required-sr">${t("cron.form.requiredSr")}</span>
        `
        : nothing
    }
  </span>`;
}

function runDetailField(label: string, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return nothing;
  }
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  return html`
    <div class="cron-run-detail-field">
      <div class="cron-job-detail-label">${label}</div>
      <div class="cron-job-detail-value ${text.includes(":") ? "mono" : ""}">${text}</div>
    </div>
  `;
}

type CronRunStepDetail = CronTaskRunDetail["stepDetails"][number];
type AppliedGraphRepair = CronTaskGraphRepairPlan & {
  applied?: boolean;
  applyReason?: string;
};

function graphRepairsForRun(detail: CronTaskRunDetail): AppliedGraphRepair[] {
  const state = detail.job?.state;
  if (!state) {
    return [];
  }
  const lastRunId = state.lastRunCheckpoint?.runId;
  if (lastRunId && lastRunId !== detail.runId) {
    return [];
  }
  if (state.lastGraphRepairs?.length) {
    return state.lastGraphRepairs;
  }
  return state.lastGraphRepair ? [state.lastGraphRepair] : [];
}

function graphRepairTitle(repair: AppliedGraphRepair) {
  if (repair.action === "replace_source") {
    return `Replace ${repair.replacesNodeId ?? "source"}`;
  }
  return `Add ${repair.nodeId}`;
}

function graphRepairStatus(repair: AppliedGraphRepair) {
  if (repair.applied === true) {
    return "applied";
  }
  if (repair.applied === false) {
    return "not applied";
  }
  return "planned";
}

function renderGraphRepairDetail(repair: AppliedGraphRepair) {
  return html`
    <div class="cron-run-repair">
      <div class="cron-run-repair__head">
        <strong>${graphRepairTitle(repair)}</strong>
        <span class="chip">${graphRepairStatus(repair)}</span>
      </div>
      <div class="cron-run-step__meta">
        ${renderRunStepMeta("Tool", repair.toolName)}
        ${renderRunStepMeta("Repair node", repair.nodeId)}
        ${
          repair.action === "replace_source"
            ? renderRunStepMeta("Replaced source", repair.replacesNodeId)
            : nothing
        }
      </div>
      <div class="cron-run-step__note">${repair.applyReason ?? repair.reason}</div>
    </div>
  `;
}

function recommendedRepairForJob(job: CronJob): { label: string; reason: string } | null {
  const needsAccess = job.state?.needsAccess;
  if (needsAccess) {
    return {
      label: needsAccess.service === "agent_models" ? "Open Agent > Models" : "Configure source",
      reason: needsAccess.reason,
    };
  }
  const stop = job.state?.lastGraphRepairStop;
  if (!stop) {
    return null;
  }
  if (stop.code === "source_access_missing") {
    return { label: "Configure source", reason: stop.reason };
  }
  if (stop.code === "repair_limit_reached") {
    return {
      label: "Add trusted source",
      reason: "Automatic source repair hit its limit.",
    };
  }
  if (stop.sourceRole === "enrichment") {
    return {
      label: "Stop source path",
      reason: "Optional source evidence is weak or unavailable.",
    };
  }
  return { label: "Add trusted source", reason: stop.reason };
}

function renderTaskRepairRecommendation(job: CronJob) {
  const recommendation = recommendedRepairForJob(job);
  if (!recommendation) {
    return nothing;
  }
  return html`
    <div class="task-repair-recommendation">
      <strong>Recommended: ${recommendation.label}</strong>
      <span>${recommendation.reason}</span>
    </div>
  `;
}

function renderTrustedSourceQuality(detail: CronTaskRunDetail) {
  const sources = detail.logEntry?.policy?.sourceQuality?.sources ?? [];
  const trusted = sources.filter((source) => source.trustedSourceId);
  if (!trusted.length) {
    return nothing;
  }
  const savedSources = new Map(
    (detail.job?.executionPolicy?.trustedSources ?? []).map((source) => [source.id, source]),
  );
  return html`
    <div class="cron-job-field cron-job-field--wide">
      <div class="cron-job-detail-label">Trusted sources</div>
      <div class="cron-run-repairs">
        ${trusted.map((source) => {
          const saved = source.trustedSourceId
            ? savedSources.get(source.trustedSourceId)
            : undefined;
          return html`
            <div class="cron-run-repair">
              <div class="cron-run-repair__head">
                <strong>${source.trustedSourceId}</strong>
                <span class="chip">${source.status ?? "unknown"}</span>
              </div>
              <div class="cron-run-step__meta">
                ${renderRunStepMeta("Node", source.id)}
                ${renderRunStepMeta(
                  "Score",
                  typeof source.score === "number" ? source.score.toFixed(2) : undefined,
                )}
                ${renderRunStepMeta("Role", source.role)}
                ${renderRunStepMeta("Quality", saved?.lastQualityBand)}
                ${renderRunStepMeta("Successes", saved?.successCount)}
                ${renderRunStepMeta("Failures", saved?.failureCount)}
              </div>
              ${saved?.source ? html`<div class="cron-run-step__note">${saved.source}</div>` : nothing}
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderRunDetailRepairRecommendations(params: {
  detail: CronTaskRunDetail;
  basePath?: string;
  busy?: boolean;
  loading?: boolean;
  onRepair?: CronRepairHandler;
  onNavigate?: (tab: Tab) => void;
}) {
  const recommendations = params.detail.recommendedRepairActions ?? [];
  const job = params.detail.job;
  if (!job || recommendations.length === 0) {
    return nothing;
  }
  const disabled = params.busy || params.loading || !params.onRepair;
  const configureSource = async (recommendation: { setupPath?: string }) => {
    const setupTab = setupTabForRepair(job, recommendation.setupPath);
    await params.onRepair?.(job, "configure_source");
    params.onNavigate?.(setupTab);
  };
  const focusTrustedSourceInput = (event: Event) => {
    const modal = (event.currentTarget as HTMLElement).closest(".cron-run-modal");
    modal?.querySelector<HTMLInputElement>("[data-run-trusted-source]")?.focus();
  };
  return html`
    <div class="cron-job-field cron-job-field--wide">
      <div class="cron-job-detail-label">Recommended next action</div>
      <div class="cron-run-repairs">
        ${recommendations.map(
          (recommendation) => html`
          <div
            class=${`cron-run-repair ${
              recommendation.priority === "primary" ? "cron-run-repair--primary" : ""
            }`}
          >
            <div class="cron-run-repair__head">
              <strong>${recommendation.label}</strong>
              <span class="chip">${recommendation.priority}</span>
            </div>
            <div class="cron-run-step__note">${recommendation.reason}</div>
            <div class="task-repair-actions">
              ${
                recommendation.action === "configure_source"
                  ? params.onNavigate
                    ? html`
                        <button
                          type="button"
                          class="button-secondary"
                          ?disabled=${disabled}
                          @click=${() => configureSource(recommendation)}
                        >
                          Configure source
                        </button>
                      `
                    : html`
                        <a
                          class="button-secondary"
                          href=${pathForTab(
                            setupTabForRepair(job, recommendation.setupPath),
                            params.basePath ?? "",
                          )}
                          @click=${() => void params.onRepair?.(job, "configure_source")}
                        >
                          Configure source
                        </a>
                      `
                  : recommendation.action === "add_trusted_source"
                    ? html`
                        <button
                          type="button"
                          class="button-secondary"
                          @click=${focusTrustedSourceInput}
                        >
                          Add trusted source below
                        </button>
                      `
                    : recommendation.action === "retry_replacement"
                      ? html`
                          <button
                            type="button"
                            class="button-secondary"
                            ?disabled=${disabled}
                            @click=${() => void params.onRepair?.(job, "retry_replacement")}
                          >
                            Retry with replacement
                          </button>
                        `
                      : html`
                          <button
                            type="button"
                            class="button-secondary"
                            ?disabled=${disabled || !recommendation.sourceNodeId}
                            @click=${() => {
                              if (!recommendation.sourceNodeId) {
                                return;
                              }
                              void params.onRepair?.(job, "stop_source_path", {
                                sourceNodeId: recommendation.sourceNodeId,
                              });
                            }}
                          >
                            Stop source path
                          </button>
                        `
              }
            </div>
          </div>
        `,
        )}
      </div>
    </div>
  `;
}

function runDetailNeedsSourceRecovery(detail: CronTaskRunDetail) {
  const job = detail.job;
  if (!job) {
    return false;
  }
  return Boolean(
    job.state?.needsAccess ||
    job.state?.lastGraphRepairStop ||
    job.state?.stopReason?.startsWith("needsSources:") ||
    job.state?.stopReason?.startsWith("needsAccess:") ||
    graphRepairsForRun(detail).length,
  );
}

function runDetailSourceNodeId(detail: CronTaskRunDetail): string | undefined {
  const job = detail.job;
  return (
    job?.state?.lastGraphRepairStop?.sourceNodeId ??
    job?.state?.lastGraphRepair?.replacesNodeId ??
    job?.state?.lastGraphRepair?.nodeId ??
    graphRepairsForRun(detail).find((repair) => repair.replacesNodeId)?.replacesNodeId ??
    graphRepairsForRun(detail).find((repair) => repair.nodeId)?.nodeId
  );
}

function renderRunDetailRepairControls(params: {
  detail: CronTaskRunDetail;
  basePath?: string;
  busy?: boolean;
  loading?: boolean;
  onRepair?: CronRepairHandler;
  onNavigate?: (tab: Tab) => void;
}) {
  const { detail } = params;
  const job = detail.job;
  if (!job || !runDetailNeedsSourceRecovery(detail)) {
    return nothing;
  }
  const sourceNodeId = runDetailSourceNodeId(detail);
  const setupPath = setupTabForRepair(job);
  const disabled = params.busy || params.loading || !params.onRepair;
  const configureSource = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    await params.onRepair?.(job, "configure_source");
    params.onNavigate?.(setupPath);
  };
  const addTrustedSource = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const root = (event.currentTarget as HTMLElement).closest(".cron-run-repair-controls");
    const input = root?.querySelector<HTMLInputElement>("[data-run-trusted-source]");
    const source = input?.value.trim() ?? "";
    if (!source) {
      input?.focus();
      return;
    }
    void params.onRepair?.(job, "add_trusted_source", { source });
  };
  return html`
    <div class="cron-job-field cron-job-field--wide cron-run-repair-controls">
      <div class="cron-job-detail-label">Repair actions</div>
      <div class="task-repair-note">
        <span>Use these actions when a run is blocked by missing access or weak source evidence.</span>
      </div>
      <div class="task-repair-source-row">
        <input
          class="task-repair-source-input"
          data-run-trusted-source
          placeholder="Paste trusted source URL or note"
          @click=${(event: Event) => event.stopPropagation()}
        />
        <button
          type="button"
          class="button-secondary"
          ?disabled=${disabled}
          @click=${addTrustedSource}
        >
          Add trusted source
        </button>
      </div>
      <div class="task-repair-actions">
        ${
          params.onNavigate
            ? html`
                <button
                  type="button"
                  class="button-secondary"
                  ?disabled=${disabled}
                  @click=${configureSource}
                >
                  Configure source
                </button>
              `
            : html`
                <a
                  class="button-secondary"
                  href=${pathForTab(setupPath, params.basePath ?? "")}
                  @click=${() => void params.onRepair?.(job, "configure_source")}
                >
                  Configure source
                </a>
              `
        }
        <button
          type="button"
          class="button-secondary"
          ?disabled=${disabled}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            void params.onRepair?.(job, "retry_replacement");
          }}
        >
          Retry with replacement
        </button>
        <button
          type="button"
          class="button-secondary"
          ?disabled=${disabled || !sourceNodeId}
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            void params.onRepair?.(job, "stop_source_path", { sourceNodeId });
          }}
        >
          Stop source path
        </button>
      </div>
    </div>
  `;
}

function renderRunDetailCoordination(params: {
  detail: CronTaskRunDetail;
  busy?: boolean;
  onApproveCoordination?: (job: CronJob) => void | Promise<void>;
  onAskAgentEvidence?: (job: CronJob) => void | Promise<void>;
}) {
  const job = params.detail.job;
  const evidence = coordinationEvidenceForRunDetail(params.detail);
  if (!job && evidence.length === 0) {
    return nothing;
  }
  const needsApproval = job ? taskCoordinationNeedsApproval(job) : false;
  if (!needsApproval && evidence.length === 0) {
    return nothing;
  }
  return html`
    <div class="cron-job-field cron-job-field--wide">
      <div class="cron-job-detail-label">Task-room evidence</div>
      ${
        evidence.length
          ? html`
              <div class="cron-run-steps">
                ${evidence.map(
                  (entry) => html`
                    <div class="cron-run-step">
                      <div class="cron-run-step__head">
                        <strong>${entry.agentId}</strong>
                        <span class="chip">${entry.status}</span>
                        <span class="chip">${entry.mode}</span>
                      </div>
                      <div class="cron-run-step__note">
                        ${entry.summary ?? entry.outputText ?? entry.error ?? "No summary recorded."}
                      </div>
                      <div class="cron-run-step__meta">
                        ${
                          entry.childSessionKey
                            ? renderRunStepMeta("Session", entry.childSessionKey)
                            : nothing
                        }
                        ${entry.runId ? renderRunStepMeta("Run", entry.runId) : nothing}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`
              <div class="task-repair-note"><span>No coordination evidence recorded yet.</span></div>
            `
      }
      ${
        needsApproval && job
          ? html`
              <div class="task-repair-note">
                <span>
                  Approval is required before this run can consult
                  ${taskCoordinationAgentsLabel(job)}.
                </span>
              </div>
              <div class="task-repair-actions">
                <button
                  type="button"
                  class="button-secondary"
                  ?disabled=${params.busy || !params.onApproveCoordination}
                  @click=${(event: Event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void params.onApproveCoordination?.(job);
                  }}
                >
                  Approve coordination & run
                </button>
              </div>
            `
          : nothing
      }
      ${
        job && taskHasRunnableCoordination(job)
          ? html`
              <div class="task-repair-actions">
                <button
                  type="button"
                  class="button-secondary"
                  ?disabled=${params.busy || !params.onAskAgentEvidence}
                  @click=${(event: Event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void params.onAskAgentEvidence?.(job);
                  }}
                >
                  Retry with Agent evidence
                </button>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function previewList(values: string[], empty = "none") {
  if (!values.length) {
    return empty;
  }
  const visible = values.slice(0, 4);
  return `${visible.join(", ")}${values.length > visible.length ? `, +${values.length - visible.length}` : ""}`;
}

function renderGraphRepairReplay(detail: CronTaskRunDetail) {
  const replay = detail.repairReplay;
  if (!replay) {
    return nothing;
  }
  return html`
    <div class="cron-job-field cron-job-field--wide">
      <div class="cron-job-detail-label">Repair replay</div>
      <div class="cron-run-repair">
        <div class="cron-run-repair__head">
          <strong>Graph revision ${replay.graphRevision}</strong>
          <span class="chip">attempt ${replay.repairAttempt}/${replay.maxRepairAttempts}</span>
        </div>
        <div class="cron-run-step__meta">
          ${renderRunStepMeta("From revision", replay.parentRevision)}
          ${renderRunStepMeta("Repair revision", replay.repairRevision)}
          ${renderRunStepMeta("Parent run", replay.parentRunId)}
        </div>
        <div class="cron-run-step__note">
          Reused ${replay.reusedNodeIds.length} checkpoint${
            replay.reusedNodeIds.length === 1 ? "" : "s"
          }:
          ${previewList(replay.reusedNodeIds)}
        </div>
        <div class="cron-run-step__note">
          Invalidated ${replay.invalidatedNodeIds.length} node${
            replay.invalidatedNodeIds.length === 1 ? "" : "s"
          }:
          ${previewList(replay.invalidatedNodeIds)}
        </div>
        <div class="cron-run-step__note">Reran: ${previewList(replay.requeuedNodeIds)}</div>
        <div class="cron-run-step__note">${replay.reason}</div>
      </div>
    </div>
  `;
}

function formatRunStepDuration(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 100) / 10}s`;
  }
  return `${Math.round(ms / 1000 / 60)}m`;
}

function runStepTone(status: CronRunStepDetail["status"]): TaskLogTone {
  if (status === "ok") {
    return "ok";
  }
  if (status === "running" || status === "queued") {
    return "info";
  }
  if (status === "skipped" || status === "blocked" || status === "recovered") {
    return "warn";
  }
  if (status === "error" || status === "canceled") {
    return "danger";
  }
  return "muted";
}

function formatRunStepLease(step?: CronRunStepDetail) {
  if (!step?.leaseExpiresAtMs) {
    return undefined;
  }
  return `${step.leaseExpired ? "expired" : "expires"} ${formatRelativeTimestamp(
    step.leaseExpiresAtMs,
  )}`;
}

function formatRunStepRetry(step: CronRunStepDetail) {
  const policy = step.retryPolicy;
  if (!policy) {
    return undefined;
  }
  const nextRetry = step.nextRetryAtMs
    ? ` · next ${formatRelativeTimestamp(step.nextRetryAtMs)}`
    : "";
  return `${policy.retryOn} · ${policy.retryDelayMs}ms · ${policy.backoffMultiplier}x${nextRetry}`;
}

function formatRunStepResume(step: CronRunStepDetail) {
  const resume = step.resume;
  if (!resume) {
    return undefined;
  }
  const keys = resume.checkpointKeys.length ? ` · ${resume.checkpointKeys.join(", ")}` : "";
  return `${resume.resumable ? "resumable" : "not resumable"}${keys}`;
}

function renderRunStepMeta(label: string, value: unknown) {
  if (value === undefined || value === null || value === "") {
    return nothing;
  }
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  return html`
    <div class="cron-run-step__meta-item">
      <span>${label}</span>
      <strong class=${text.includes(":") ? "mono" : ""}>${text}</strong>
    </div>
  `;
}

function renderRunStepDetail(params: {
  step: CronRunStepDetail;
  detail: CronTaskRunDetail;
  busy?: boolean;
  loading?: boolean;
  onQueueControl?: (action: "cancel" | "retry" | "clear-stale", runId: string) => void;
}) {
  const { step, detail } = params;
  const tone = runStepTone(step.status);
  const checkpoint =
    step.checkpoint && Object.keys(step.checkpoint).length
      ? JSON.stringify(step.checkpoint, null, 2)
      : "";
  const availableControl = step.control.available ? step.control : null;
  return html`
    <div class="cron-run-step" data-tone=${tone}>
      <div class="cron-run-step__head">
        <div class="cron-run-step__title">
          <span class=${`task-run-log-dot task-run-log-dot--${tone}`}></span>
          <span>${step.id}</span>
        </div>
        <span class="chip">${step.status} · attempt ${step.attempt}/${step.maxAttempts}</span>
      </div>
      <div class="cron-run-step__meta">
        ${renderRunStepMeta("Created", formatRelativeTimestamp(step.createdAtMs))}
        ${renderRunStepMeta("Started", step.startedAtMs ? formatRelativeTimestamp(step.startedAtMs) : undefined)}
        ${renderRunStepMeta("Completed", step.completedAtMs ? formatRelativeTimestamp(step.completedAtMs) : undefined)}
        ${renderRunStepMeta("Duration", step.durationMs !== undefined ? formatRunStepDuration(step.durationMs) : undefined)}
        ${renderRunStepMeta("Lease owner", step.leaseOwner)}
        ${renderRunStepMeta("Lease", formatRunStepLease(step))}
        ${renderRunStepMeta("Retry policy", formatRunStepRetry(step))}
        ${renderRunStepMeta(
          "Next retry",
          step.nextRetryAtMs ? formatRelativeTimestamp(step.nextRetryAtMs) : undefined,
        )}
        ${renderRunStepMeta("Resume", formatRunStepResume(step))}
      </div>
      ${
        step.resume?.reason
          ? html`
              <div class="cron-run-step__note">${step.resume.reason}</div>
            `
          : nothing
      }
      ${
        step.error
          ? html`
              <div class="cron-run-step__note danger">${step.error}</div>
            `
          : nothing
      }
      ${
        checkpoint
          ? html`
              <pre class="cron-run-step__checkpoint">${checkpoint}</pre>
            `
          : nothing
      }
      <div class="cron-run-step__control">
        <div>
          <strong>${step.control.label}</strong>
          <span>${step.control.reason}</span>
        </div>
        ${
          availableControl
            ? html`
                <button
                  class="btn btn--sm ${availableControl.action === "cancel" ? "danger" : ""}"
                  type="button"
                  ?disabled=${params.busy || params.loading}
                  @click=${() => params.onQueueControl?.(availableControl.action, detail.runId)}
                >
                  ${availableControl.label}
                </button>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

export function renderCronRunDetailModal(params: {
  detail: CronTaskRunDetail | null;
  loading: boolean;
  error: string | null;
  basePath?: string;
  busy?: boolean;
  onClose: () => void;
  onOpenTranscript?: (sessionKey: string) => void;
  onQueueControl?: (action: "cancel" | "retry" | "clear-stale", runId: string) => void;
  onRepair?: CronRepairHandler;
  onApproveCoordination?: (job: CronJob) => void | Promise<void>;
  onAskAgentEvidence?: (job: CronJob) => void | Promise<void>;
  onNavigate?: (tab: Tab) => void;
}) {
  if (!params.detail && !params.loading && !params.error) {
    return nothing;
  }
  const detail = params.detail;
  const execution = detail?.execution;
  const activeStep = detail?.stepDetails.find((step) => step.status === "running");
  const stepDetails: CronRunStepDetail[] = detail?.stepDetails?.length
    ? detail.stepDetails
    : (detail?.queueRun?.steps ?? []).map((step) => ({
        ...step,
        durationMs:
          typeof step.startedAtMs === "number" && typeof step.completedAtMs === "number"
            ? Math.max(0, step.completedAtMs - step.startedAtMs)
            : undefined,
        leaseExpired: false,
        control: {
          available: false as const,
          label: "No step action",
          reason: "No queue action is available for this step.",
        },
      }));
  return html`
    <style>
      .cron-run-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.54);
      }
      .cron-run-modal {
        width: min(720px, 100%);
        max-height: min(780px, calc(100vh - 48px));
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--panel);
        box-shadow: var(--shadow-lg);
      }
      .cron-run-modal__head,
      .cron-run-modal__foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--border);
      }
      .cron-run-modal__foot {
        border-top: 1px solid var(--border);
        border-bottom: 0;
        justify-content: flex-end;
        flex-wrap: wrap;
      }
      .cron-run-modal__body {
        display: grid;
        gap: 14px;
        padding: 18px;
      }
      .cron-run-detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .cron-run-detail-field {
        min-width: 0;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface);
      }
      .cron-run-steps {
        display: grid;
        gap: 10px;
      }
      .cron-run-step {
        display: grid;
        gap: 10px;
        min-width: 0;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface);
      }
      .cron-run-step[data-tone="warn"] {
        border-color: color-mix(in srgb, var(--warning) 42%, var(--border));
      }
      .cron-run-step[data-tone="danger"] {
        border-color: color-mix(in srgb, var(--danger) 46%, var(--border));
      }
      .cron-run-step__head,
      .cron-run-step__control {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
      }
      .cron-run-step__title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        font-weight: 800;
      }
      .cron-run-step__meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        gap: 8px;
      }
      .cron-run-step__meta-item {
        min-width: 0;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-xs);
        background: color-mix(in srgb, var(--surface) 78%, transparent);
      }
      .cron-run-step__meta-item span,
      .cron-run-step__control span {
        display: block;
        color: var(--muted);
        font-size: 0.78rem;
      }
      .cron-run-step__meta-item strong {
        display: block;
        margin-top: 2px;
        overflow-wrap: anywhere;
        font-size: 0.86rem;
      }
      .cron-run-step__note {
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-xs);
        overflow-wrap: anywhere;
      }
      .cron-run-step__note.danger {
        border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
        color: var(--danger);
      }
      .cron-run-step__checkpoint {
        max-height: 140px;
        overflow: auto;
        margin: 0;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-xs);
        background: var(--panel);
        color: var(--text);
        white-space: pre-wrap;
      }
      .cron-run-step__control {
        align-items: flex-start;
        padding-top: 2px;
      }
      .cron-run-repairs {
        display: grid;
        gap: 10px;
      }
      .cron-run-repair {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface);
      }
      .cron-run-repair--primary {
        border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
      }
      .cron-run-repair__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
      }
      .cron-run-repair__head strong {
        min-width: 0;
        overflow-wrap: anywhere;
      }
    </style>
    <div class="cron-run-modal-backdrop" role="dialog" aria-modal="true" @click=${params.onClose}>
      <section class="cron-run-modal" @click=${(event: Event) => event.stopPropagation()}>
        <header class="cron-run-modal__head">
          <div>
            <div class="section-title">${detail?.jobName ?? "Task run"}</div>
            <div class="muted mono">${detail?.runId ?? "Loading run..."}</div>
          </div>
          <button class="icon-btn" type="button" aria-label="Close run detail" @click=${params.onClose}>
            ${icons.x}
          </button>
        </header>
        <div class="cron-run-modal__body">
          ${
            params.loading
              ? html`
                  <div class="muted">Loading run detail...</div>
                `
              : params.error
                ? html`<div class="cron-error">${params.error}</div>`
                : detail
                  ? html`
                      <div class="cron-run-detail-grid">
                        ${runDetailField("Status", detail.status)}
                        ${runDetailField("Task ID", detail.jobId)}
                        ${runDetailField("Agent", detail.agentId)}
                        ${runDetailField("Session", detail.sessionKey)}
                        ${runDetailField("Trigger", detail.trigger)}
                        ${runDetailField("Active step", activeStep?.id)}
                        ${runDetailField("Lease owner", activeStep?.leaseOwner)}
                        ${runDetailField("Lease expiry", formatRunStepLease(activeStep))}
                        ${runDetailField("Delivery", execution?.deliveryStatus)}
                        ${runDetailField(
                          "Execution",
                          execution?.adapter
                            ? `${execution.source ?? "task"} · ${execution.adapter}`
                            : (execution?.source ??
                                detail.logEntry?.policy?.effectiveExecutionMode),
                        )}
                        ${runDetailField(
                          "Model",
                          execution?.modelUsed === false ? "No model" : execution?.model,
                        )}
                        ${runDetailField("Model source", execution?.modelSource)}
                        ${runDetailField("Duration", detail.logEntry?.durationMs ? `${detail.logEntry.durationMs}ms` : undefined)}
                        ${runDetailField("Tokens", execution?.usage?.total_tokens)}
                      </div>
                      ${
                        detail.logEntry?.policy?.planner
                          ? html`
                              <div class="cron-job-field cron-job-field--wide">
                                <div class="cron-job-detail-label">Planner</div>
                                <div class="cron-job-detail-value">
                                  ${detail.logEntry.policy.planner.strategy} ·
                                  ${detail.logEntry.policy.planner.rationale}
                                </div>
                              </div>
                            `
                          : nothing
                      }
                      ${
                        detail.logEntry?.policy?.evaluator
                          ? html`
                              <div class="cron-job-field cron-job-field--wide">
                                <div class="cron-job-detail-label">Evaluator</div>
                                <div class="cron-job-detail-value">
                                  ${detail.logEntry.policy.evaluator.action} ·
                                  ${detail.logEntry.policy.evaluator.reason}
                                </div>
                              </div>
                            `
                          : nothing
                      }
                      ${
                        execution?.summary || execution?.error || detail.error
                          ? html`
                              <div class="cron-job-field cron-job-field--wide">
                                <div class="cron-job-detail-label">
                                  ${execution?.error || detail.error ? "Error" : "Summary"}
                                </div>
                                <div class="cron-job-detail-value">
                                  ${execution?.error ?? detail.error ?? execution?.summary}
                                </div>
                              </div>
                            `
                          : nothing
                      }
                      ${
                        graphRepairsForRun(detail).length
                          ? html`
                              <div class="cron-job-field cron-job-field--wide">
                                <div class="cron-job-detail-label">Source repair</div>
                                <div class="cron-run-repairs">
                                  ${graphRepairsForRun(detail).map(renderGraphRepairDetail)}
                                </div>
                              </div>
                            `
                          : nothing
                      }
                      ${renderRunDetailRepairRecommendations({
                        detail,
                        basePath: params.basePath,
                        busy: params.busy,
                        loading: params.loading,
                        onRepair: params.onRepair,
                        onNavigate: params.onNavigate,
                      })}
                      ${renderRunDetailRepairControls({
                        detail,
                        basePath: params.basePath,
                        busy: params.busy,
                        loading: params.loading,
                        onRepair: params.onRepair,
                        onNavigate: params.onNavigate,
                      })}
                      ${renderRunDetailCoordination({
                        detail,
                        busy: params.busy,
                        onApproveCoordination: params.onApproveCoordination,
                        onAskAgentEvidence: params.onAskAgentEvidence,
                      })}
                      ${renderTrustedSourceQuality(detail)}
                      ${renderGraphRepairReplay(detail)}
                      ${
                        stepDetails.length
                          ? html`
                              <div class="cron-job-field cron-job-field--wide">
                                <div class="cron-job-detail-label">Queue steps</div>
                                <div class="cron-run-steps">
                                  ${stepDetails.map((step) =>
                                    renderRunStepDetail({
                                      step,
                                      detail,
                                      busy: params.busy,
                                      loading: params.loading,
                                      onQueueControl: params.onQueueControl,
                                    }),
                                  )}
                                </div>
                              </div>
                            `
                          : nothing
                      }
                    `
                  : nothing
          }
        </div>
        <footer class="cron-run-modal__foot">
          ${
            detail?.controls.canCancel
              ? html`<button
                  class="btn btn--sm danger"
                  type="button"
                  ?disabled=${params.busy || params.loading}
                  @click=${() => params.onQueueControl?.("cancel", detail.runId)}
                >
                  Cancel run
                </button>`
              : nothing
          }
          ${
            detail?.controls.canRetry
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${params.busy || params.loading}
                  @click=${() => params.onQueueControl?.("retry", detail.runId)}
                >
                  Retry run
                </button>`
              : nothing
          }
          ${
            detail?.controls.canClearStaleLease
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${params.busy || params.loading}
                  @click=${() => params.onQueueControl?.("clear-stale", detail.runId)}
                >
                  Clear stale lease
                </button>`
              : nothing
          }
          ${
            detail?.sessionKey && params.onOpenTranscript
              ? html`<button class="btn btn--sm" type="button" @click=${() => params.onOpenTranscript?.(detail.sessionKey!)}>Open transcript</button>`
              : nothing
          }
          <button class="btn btn--sm" type="button" @click=${params.onClose}>Close</button>
        </footer>
      </section>
    </div>
  `;
}

export function renderCron(props: CronProps) {
  const hasActiveJobsFilters =
    props.jobsQuery.trim().length > 0 ||
    props.jobsEnabledFilter !== "all" ||
    props.jobsScheduleKindFilter !== "all" ||
    props.jobsLastStatusFilter !== "all" ||
    props.jobsAdaptiveRouteFilter !== "all" ||
    props.jobsSortBy !== "updatedAtMs" ||
    props.jobsSortDir !== "desc";
  const visibleJobs = getVisibleCronJobs({
    cronJobs: props.jobs,
    cronJobsQuery: props.jobsQuery,
    cronJobsEnabledFilter: props.jobsEnabledFilter,
    cronJobsScheduleKindFilter: props.jobsScheduleKindFilter,
    cronJobsLastStatusFilter: props.jobsLastStatusFilter,
    cronJobsAdaptiveRouteFilter: props.jobsAdaptiveRouteFilter,
  });
  // Legacy inline authoring markup is not rendered; create/edit now opens the shared task modal.
  const isEditing = Boolean(props.editingJobId);
  const isAgentTurn = props.form.payloadKind === "agentTurn";
  const isCronSchedule = props.form.scheduleKind === "cron";
  const channelOptions = buildChannelOptions(props);
  const agentOptions = buildAgentOptions(props);
  const supportsAnnounce =
    props.form.sessionTarget !== "main" && props.form.payloadKind === "agentTurn";
  const selectedDeliveryMode =
    props.form.deliveryMode === "announce" && !supportsAnnounce ? "none" : props.form.deliveryMode;
  const blockingFields = collectBlockingFields(props.fieldErrors, props.form, selectedDeliveryMode);
  const blockedByValidation = !props.busy && blockingFields.length > 0;
  const submitDisabledReason =
    blockedByValidation && !props.canSubmit
      ? blockingFields.length === 1
        ? t("cron.form.fixFields", { count: String(blockingFields.length) })
        : t("cron.form.fixFieldsPlural", { count: String(blockingFields.length) })
      : "";
  const authoringOpen = isEditing || blockedByValidation;
  const renderLegacyInlineForm = props.editingJobId === "__legacy-inline-form__";
  return html`
    <style>
      .cron-page-shell {
        display: grid;
        gap: 16px;
      }
      .cron-page-shell > .card {
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--panel);
      }
      .cron-workspace {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
      }
      .cron-workspace-main {
        display: grid;
        gap: 16px;
      }
      @media (max-width: 1120px) {
        .cron-workspace {
          grid-template-columns: 1fr;
        }
      }
      .cron-workspace-form {
        order: -1;
        position: static;
      }
      .task-runtime-card {
        display: grid;
        gap: 14px;
        padding: 16px;
      }
      .task-runtime-card__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .task-runtime-card__title {
        font-weight: 700;
      }
      .task-runtime-card__sub {
        color: var(--muted);
        font-size: 0.92rem;
        margin-top: 4px;
      }
      .task-runtime-card__actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }
      .task-runtime-card__grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 10px;
      }
      @media (max-width: 720px) {
        .task-runtime-card__head {
          display: grid;
        }
        .task-runtime-card__actions {
          justify-content: flex-start;
        }
      }
      .cron-coordination-picker {
        border: 1px solid var(--border);
        border-radius: 10px;
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      .cron-coordination-picker__agents {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .cron-coordination-picker__agent {
        border-radius: 999px;
      }
    </style>

    <section class="cron-page-shell">
    <section class="cron-workspace">
      <div class="cron-workspace-main">
        ${renderTaskRuntimeConfig(props)}
        <section class="card">
          <div class="cron-task-toolbar">
            <div class="cron-task-toolbar__primary">
              <button class="btn btn--sm primary" type="button" @click=${props.onCreate}>
                Create task
              </button>
              <button
                class="task-toolbar-icon-button"
                type="button"
                title="Refresh tasks"
                aria-label="Refresh tasks"
                ?disabled=${props.loading}
                @click=${props.onRefresh}
              >
                ${icons.refresh}
              </button>
              <span class="chip">
                ${props.jobsTotal || props.jobs.length} task${(props.jobsTotal || props.jobs.length) === 1 ? "" : "s"}
              </span>
              ${renderCompactNextWake(props.status?.nextWakeAtMs)}
              ${renderTaskWorkerCounters({
                queue: props.status?.queue,
              })}
            </div>
          </div>
          ${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}
          <div class="cron-task-filters" style="margin-top: 12px;">
            <label class="field cron-filter-search">
              <input
                aria-label=${t("cron.jobs.searchJobs")}
                .value=${props.jobsQuery}
                placeholder=${t("cron.jobs.searchPlaceholder")}
                @input=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsQuery: (e.target as HTMLInputElement).value,
                  })}
              />
            </label>
            <label class="field">
              <select
                aria-label="Task status"
                .value=${props.jobsEnabledFilter}
                @change=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsEnabledFilter: (e.target as HTMLSelectElement)
                      .value as CronJobsEnabledFilter,
                  })}
              >
                <option value="all">${t("cron.jobs.all")}</option>
                <option value="enabled">${t("common.enabled")}</option>
                <option value="disabled">${t("common.disabled")}</option>
              </select>
            </label>
            <label class="field">
              <select
                aria-label="Task date sort"
                .value=${props.jobsSortDir}
                @change=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsSortBy: "updatedAtMs",
                    cronJobsSortDir: (e.target as HTMLSelectElement).value as CronSortDir,
                  })}
              >
                <option value="desc">Newest first</option>
                <option value="asc">Oldest first</option>
              </select>
            </label>
            <label class="field">
              <select
                aria-label="Adaptive next route"
                .value=${props.jobsAdaptiveRouteFilter}
                @change=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsAdaptiveRouteFilter: (e.target as HTMLSelectElement)
                      .value as CronJobsAdaptiveRouteFilter,
                  })}
              >
                ${TASK_ADAPTIVE_ROUTE_OPTIONS.map(
                  (option) =>
                    html`<option value=${option.value} ?selected=${option.value === props.jobsAdaptiveRouteFilter}>
                      ${option.label}
                    </option>`,
                )}
              </select>
            </label>
            <div class="field task-filter-reset">
              <button
                class="task-toolbar-icon-button"
                data-test-id="cron-jobs-filters-reset"
                type="button"
                title=${t("cron.jobs.reset")}
                aria-label=${t("cron.jobs.reset")}
                ?disabled=${!hasActiveJobsFilters}
                @click=${props.onJobsFiltersReset}
              >
                ${icons.rotateCcw}
              </button>
            </div>
          </div>
          ${
            visibleJobs.length === 0
              ? html` <div class="muted" style="margin-top: 12px">${t("cron.jobs.noMatching")}</div> `
              : html`
                <div class="list" style="margin-top: 12px;">
                  ${repeat(
                    visibleJobs,
                    (job) => job.id,
                    (job) => renderJob(job, props),
                  )}
                </div>
              `
          }
          ${
            props.jobsHasMore
              ? html`
                <div class="row" style="margin-top: 12px">
                  <button
                    class="btn"
                    ?disabled=${props.loading || props.jobsLoadingMore}
                    @click=${props.onLoadMoreJobs}
                  >
                    ${props.jobsLoadingMore ? t("cron.jobs.loading") : t("cron.jobs.loadMore")}
                  </button>
                </div>
              `
              : nothing
          }
        </section>

      </div>

      ${
        renderLegacyInlineForm
          ? html`<details class="card cron-workspace-form" ?open=${authoringOpen}>
        <summary class="cron-workspace-form__summary">
          <div>
            <div class="card-title">${isEditing ? t("cron.form.editJob") : t("cron.form.newJob")}</div>
            <div class="card-sub">
              ${isEditing ? t("cron.form.updateSubtitle") : t("cron.form.createSubtitle")}
            </div>
          </div>
          <span class="cron-workspace-form__summary-action">
            ${isEditing ? t("cron.form.saveChanges") : t("cron.form.addJob")}
          </span>
        </summary>
        <div class="cron-form">
          <div class="cron-required-legend">
            <span class="cron-required-marker" aria-hidden="true">*</span> ${t(
              "cron.form.required",
            )}
          </div>
          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cron.form.basics")}</div>
            <div class="cron-form-section__sub">${t("cron.form.basicsSub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${renderFieldLabel(t("cron.form.fieldName"), true)}
                <input
                  id="cron-name"
                  .value=${props.form.name}
                  placeholder=${t("cron.form.namePlaceholder")}
                  aria-invalid=${props.fieldErrors.name ? "true" : "false"}
                  aria-describedby=${ifDefined(
                    props.fieldErrors.name ? errorIdForField("name") : undefined,
                  )}
                  @input=${(e: Event) =>
                    props.onFormChange({ name: (e.target as HTMLInputElement).value })}
                />
                ${renderFieldError(props.fieldErrors.name, errorIdForField("name"))}
              </label>
              <label class="field">
                <span>${t("cron.form.description")}</span>
                <input
                  .value=${props.form.description}
                  placeholder=${t("cron.form.descriptionPlaceholder")}
                  @input=${(e: Event) =>
                    props.onFormChange({ description: (e.target as HTMLInputElement).value })}
                />
              </label>
              <label class="field">
                ${renderFieldLabel(t("cron.form.agentId"))}
                <select
                  id="cron-agent-id"
                  data-test-id="cron-agent-select"
                  .value=${normalizeAgentId(props.form.agentId)}
                  ?disabled=${props.form.clearAgent}
                  @change=${(e: Event) =>
                    props.onFormChange({ agentId: (e.target as HTMLSelectElement).value })}
                >
                  <option value="">Assistant</option>
                  ${agentOptions.map(
                    (agent) => html`
                      <option value=${agent.id} ?selected=${agent.id === normalizeAgentId(props.form.agentId)}>
                        ${formatAgentLabel(agent)}
                      </option>
                    `,
                  )}
                </select>
                <div class="cron-help">${t("cron.form.agentHelp")}</div>
              </label>
              <label class="field checkbox cron-checkbox cron-checkbox-inline">
                <input
                  type="checkbox"
                  .checked=${props.form.enabled}
                  @change=${(e: Event) =>
                    props.onFormChange({ enabled: (e.target as HTMLInputElement).checked })}
                />
                <span class="field-checkbox__label">${t("cron.summary.enabled")}</span>
              </label>
            </div>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cron.form.schedule")}</div>
            <div class="cron-form-section__sub">${t("cron.form.scheduleSub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field cron-span-2">
                ${renderFieldLabel(t("cron.form.schedule"))}
                <select
                  id="cron-schedule-kind"
                  .value=${props.form.scheduleKind}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      scheduleKind: (e.target as HTMLSelectElement)
                        .value as CronFormState["scheduleKind"],
                    })}
                >
                  <option value="every">${t("cron.form.every")}</option>
                  <option value="at">${t("cron.form.at")}</option>
                  <option value="cron">${t("cron.form.cronOption")}</option>
                </select>
              </label>
            </div>
            ${renderScheduleFields(props)}
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cron.form.execution")}</div>
            <div class="cron-form-section__sub">${t("cron.form.executionSub")}</div>
            <div class="cron-preset-row" aria-label="Task policy presets">
              <span class="cron-preset-row__label">Presets</span>
              ${TASK_POLICY_PRESET_OPTIONS.map(
                (preset) => html`
                  <button
                    class="btn btn--xs btn--ghost"
                    type="button"
                    @click=${() =>
                      props.onFormChange(buildTaskPolicyPresetPatch(preset.id, props.form))}
                  >
                    ${preset.label}
                  </button>
                `,
              )}
            </div>
            <div class="form-grid cron-form-grid">
              <label class="field">
                ${renderFieldLabel(t("cron.form.session"))}
                <select
                  id="cron-session-target"
                  .value=${props.form.sessionTarget}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      sessionTarget: (e.target as HTMLSelectElement)
                        .value as CronFormState["sessionTarget"],
                    })}
                >
                  <option value="main">${t("cron.form.main")}</option>
                  <option value="isolated">${t("cron.form.isolated")}</option>
                </select>
                <div class="cron-help">${t("cron.form.sessionHelp")}</div>
              </label>
              <label class="field">
                ${renderFieldLabel(t("cron.form.wakeMode"))}
                <select
                  id="cron-wake-mode"
                  .value=${props.form.wakeMode}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      wakeMode: (e.target as HTMLSelectElement).value as CronFormState["wakeMode"],
                    })}
                >
                  <option value="now">${t("cron.form.now")}</option>
                  <option value="next-heartbeat">${t("cron.form.nextHeartbeat")}</option>
                </select>
                <div class="cron-help">${t("cron.form.wakeModeHelp")}</div>
              </label>
              <label class="field ${isAgentTurn ? "" : "cron-span-2"}">
                ${renderFieldLabel(t("cron.form.payloadKind"))}
                <select
                  id="cron-payload-kind"
                  .value=${props.form.payloadKind}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      payloadKind: (e.target as HTMLSelectElement)
                        .value as CronFormState["payloadKind"],
                    })}
                >
                  <option value="systemEvent">${t("cron.form.systemEvent")}</option>
                  <option value="agentTurn">${t("cron.form.agentTurn")}</option>
                </select>
                <div class="cron-help">
                  ${
                    props.form.payloadKind === "systemEvent"
                      ? t("cron.form.systemEventHelp")
                      : t("cron.form.agentTurnHelp")
                  }
                </div>
              </label>
              ${
                isAgentTurn
                  ? html`
                    <label class="field">
                      ${renderFieldLabel(t("cron.form.timeoutSeconds"))}
                      <input
                        id="cron-timeout-seconds"
                        .value=${props.form.timeoutSeconds}
                        placeholder=${t("cron.form.timeoutPlaceholder")}
                        aria-invalid=${props.fieldErrors.timeoutSeconds ? "true" : "false"}
                        aria-describedby=${ifDefined(
                          props.fieldErrors.timeoutSeconds
                            ? errorIdForField("timeoutSeconds")
                            : undefined,
                        )}
                        @input=${(e: Event) =>
                          props.onFormChange({
                            timeoutSeconds: (e.target as HTMLInputElement).value,
                          })}
                      />
                      <div class="cron-help">${t("cron.form.timeoutHelp")}</div>
                      ${renderFieldError(
                        props.fieldErrors.timeoutSeconds,
                        errorIdForField("timeoutSeconds"),
                      )}
                    </label>
                  `
                  : nothing
              }
            </div>
            <label class="field cron-span-2">
              ${renderFieldLabel(
                props.form.payloadKind === "systemEvent"
                  ? t("cron.form.mainTimelineMessage")
                  : t("cron.form.assistantTaskPrompt"),
                true,
              )}
              <textarea
                id="cron-payload-text"
                .value=${props.form.payloadText}
                aria-invalid=${props.fieldErrors.payloadText ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.payloadText ? errorIdForField("payloadText") : undefined,
                )}
                @input=${(e: Event) =>
                  props.onFormChange({
                    payloadText: (e.target as HTMLTextAreaElement).value,
                  })}
                rows="4"
              ></textarea>
              ${renderFieldError(props.fieldErrors.payloadText, errorIdForField("payloadText"))}
            </label>
            <div class="form-grid cron-form-grid cron-span-2">
              <label class="field">
                ${renderFieldLabel("Objective")}
                <input
                  .value=${props.form.taskObjective}
                  @input=${(e: Event) =>
                    props.onFormChange({
                      taskObjective: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="What outcome should this task drive?"
                />
                <div class="cron-help">Stored with the task for planner and run review.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Success")}
                <input
                  .value=${props.form.taskSuccessCriteria}
                  @input=${(e: Event) =>
                    props.onFormChange({
                      taskSuccessCriteria: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="How should the task know it is done?"
                />
                <div class="cron-help">Use this as the task's evaluation target.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Execution mode")}
                <select
                  .value=${props.form.executionMode}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      executionMode: (e.target as HTMLSelectElement)
                        .value as CronFormState["executionMode"],
                    })}
                >
                  <option value="auto">Auto</option>
                  <option value="agent-turn">Agent turn</option>
                  <option value="skill-only">Skill-only</option>
                  <option value="no-model">No model</option>
                </select>
                <div class="cron-help">
                  Auto can use a model. No model delivers or records the task without inference.
                </div>
              </label>
              <label class="field">
                ${renderFieldLabel("Memory scope")}
                <select
                  .value=${props.form.memoryScope}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      memoryScope: (e.target as HTMLSelectElement)
                        .value as CronFormState["memoryScope"],
                    })}
                >
                  <option value="none">None</option>
                  <option value="session-summary">Session summary</option>
                  <option value="pinned">Pinned</option>
                  <option value="search">Search</option>
                  <option value="agent">Agent</option>
                </select>
                <div class="cron-help">Controls how much context the task should use.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Skill scope")}
                <select
                  .value=${props.form.skillScope}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      skillScope: (e.target as HTMLSelectElement)
                        .value as CronFormState["skillScope"],
                    })}
                >
                  <option value="agent-default">Inherited from Agent</option>
                  <option value="selected">Narrow selected skills</option>
                  <option value="none">None</option>
                </select>
                <div class="cron-help">Use the Agent skills set, narrow it for this task, or turn skills off.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Narrow selected skills")}
                <input
                  .value=${props.form.allowedSkills}
                  ?disabled=${props.form.skillScope !== "selected"}
                  @input=${(e: Event) =>
                    props.onFormChange({ allowedSkills: (e.target as HTMLInputElement).value })}
                  placeholder="wallet, search, docs"
                />
                <div class="cron-help">Comma-separated skill IDs for selected-skill tasks.</div>
              </label>
              ${
                props.form.executionMode === "skill-only"
                  ? html`
                    <label class="field">
                      ${renderFieldLabel("Skill tool")}
                      <input
                        .value=${props.form.skillToolName}
                        @input=${(e: Event) =>
                          props.onFormChange({
                            skillToolName: (e.target as HTMLInputElement).value,
                          })}
                        placeholder="wallet"
                      />
                      <div class="cron-help">
                        Exact tool name to run without model inference.
                      </div>
                    </label>
                    <label class="field">
                      ${renderFieldLabel("Skill input")}
                      <textarea
                        .value=${props.form.skillToolInputJson}
                        @input=${(e: Event) =>
                          props.onFormChange({
                            skillToolInputJson: (e.target as HTMLTextAreaElement).value,
                          })}
                        rows="3"
                        placeholder='{"action":"balance"}'
                      ></textarea>
                      <div class="cron-help">JSON object passed directly to the tool.</div>
                    </label>
                  `
                  : nothing
              }
              <label class="field">
                ${renderFieldLabel("Agent model role")}
                <select
                  .value=${props.form.modelRole}
                  ?disabled=${props.form.executionMode === "no-model"}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      modelRole: (e.target as HTMLSelectElement)
                        .value as CronFormState["modelRole"],
                    })}
                >
                  <option value="">Automatic / Agent default</option>
                  <option value="cheapCheck">Cheap/check</option>
                  <option value="strong">Strong</option>
                  <option value="escalation">Escalation</option>
                  <option value="coding">Coding</option>
                  <option value="summarizer">Summarizer</option>
                </select>
                <div class="cron-help">Uses the selected Agent's configured role model.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Exact task model")}
                <input
                  .value=${props.form.policyModel}
                  list="cron-model-suggestions"
                  ?disabled=${props.form.executionMode === "no-model"}
                  @input=${(e: Event) =>
                    props.onFormChange({ policyModel: (e.target as HTMLInputElement).value })}
                  placeholder="provider/model"
                />
              </label>
              <label class="field">
                ${renderFieldLabel("Escalation model")}
                <input
                  .value=${props.form.escalationModel}
                  list="cron-model-suggestions"
                  ?disabled=${props.form.executionMode === "no-model"}
                  @input=${(e: Event) =>
                    props.onFormChange({ escalationModel: (e.target as HTMLInputElement).value })}
                  placeholder="provider/model"
                />
                <div class="cron-help">Stronger model used when the evaluator sees a signal.</div>
              </label>
              <div class="field cron-span-2 cron-coordination-picker">
                <div class="row" style="justify-content: space-between; gap: 10px;">
                  <div>
                    ${renderFieldLabel("Ask Agents")}
                    <div class="cron-help">
                      Let selected local Agents review the task and write task-room evidence before validation.
                    </div>
                  </div>
                  <select
                    .value=${props.form.coordinationMode}
                    @change=${(e: Event) =>
                      props.onFormChange({
                        coordinationMode: (e.target as HTMLSelectElement)
                          .value as CronFormState["coordinationMode"],
                      })}
                  >
                    <option value="none">Off</option>
                    <option value="consult">Consult</option>
                    <option value="parallel">Parallel</option>
                  </select>
                </div>
                <div class="cron-coordination-picker__agents">
                  ${agentOptions.map((agent) => {
                    const selected = csvList(props.form.coordinationAgents).includes(agent.id);
                    return html`
                      <button
                        class="btn btn--xs ${selected ? "primary" : "btn--ghost"} cron-coordination-picker__agent"
                        type="button"
                        ?disabled=${props.form.coordinationMode === "none"}
                        aria-pressed=${selected ? "true" : "false"}
                        @click=${() => toggleCoordinationAgent(props, agent.id)}
                      >
                        ${formatAgentLabel(agent)}
                      </button>
                    `;
                  })}
                </div>
                <div class="form-grid cron-form-grid">
                  <label class="field">
                    ${renderFieldLabel("Custom Agent ids")}
                    <input
                      .value=${props.form.coordinationAgents}
                      ?disabled=${props.form.coordinationMode === "none"}
                      @input=${(e: Event) =>
                        props.onFormChange({
                          coordinationAgents: (e.target as HTMLInputElement).value,
                        })}
                      placeholder="research, support"
                    />
                  </label>
                  <label class="field">
                    ${renderFieldLabel("Max Agents")}
                    <input
                      .value=${props.form.coordinationMaxAgents}
                      ?disabled=${props.form.coordinationMode === "none"}
                      inputmode="decimal"
                      @input=${(e: Event) =>
                        props.onFormChange({
                          coordinationMaxAgents: (e.target as HTMLInputElement).value,
                        })}
                      placeholder="2"
                    />
                  </label>
                  <label class="field">
                    ${renderFieldLabel("Approval")}
                    <select
                      .value=${props.form.coordinationRequireApproval ? "true" : "false"}
                      ?disabled=${props.form.coordinationMode === "none"}
                      @change=${(e: Event) =>
                        props.onFormChange({
                          coordinationRequireApproval:
                            (e.target as HTMLSelectElement).value === "true",
                        })}
                    >
                      <option value="true">Required</option>
                      <option value="false">Optional</option>
                    </select>
                  </label>
                </div>
              </div>
              <label class="field">
                ${renderFieldLabel("Escalation cue")}
                <select
                  .value=${props.form.evaluatorEscalateOnSignal ? "true" : "false"}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      evaluatorEscalateOnSignal: (e.target as HTMLSelectElement).value === "true",
                    })}
                >
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
                <div class="cron-help">Cheap checks can request one stronger follow-up.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Cue text")}
                <input
                  .value=${props.form.evaluatorSignalIncludes}
                  ?disabled=${!props.form.evaluatorEscalateOnSignal}
                  @input=${(e: Event) =>
                    props.onFormChange({
                      evaluatorSignalIncludes: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="Needs deeper analysis: yes"
                />
                <div class="cron-help">Comma-separated plain-language cues that trigger escalation.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Max escalations")}
                <input
                  .value=${props.form.evaluatorMaxEscalations}
                  ?disabled=${!props.form.evaluatorEscalateOnSignal}
                  inputmode="decimal"
                  @input=${(e: Event) =>
                    props.onFormChange({
                      evaluatorMaxEscalations: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="1"
                />
              </label>
              <label class="field">
                ${renderFieldLabel("Auto repair retry")}
                <select
                  .value=${props.form.repairAutoRetryReplacement ? "true" : "false"}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      repairAutoRetryReplacement: (e.target as HTMLSelectElement).value === "true",
                    })}
                >
                  <option value="true">Enabled</option>
                  <option value="false">Manual only</option>
                </select>
                <div class="cron-help">Safe repaired graphs can retry without another click.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Auto stop optional sources")}
                <select
                  .value=${props.form.repairAutoStopOptionalSources ? "true" : "false"}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      repairAutoStopOptionalSources:
                        (e.target as HTMLSelectElement).value === "true",
                    })}
                >
                  <option value="false">Manual</option>
                  <option value="true">Enabled</option>
                </select>
              </label>
              <label class="field">
                ${renderFieldLabel("Max auto repairs/run")}
                <input
                  .value=${props.form.repairMaxAutoRepairsPerRun}
                  inputmode="decimal"
                  @input=${(e: Event) =>
                    props.onFormChange({
                      repairMaxAutoRepairsPerRun: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="1"
                />
              </label>
              <label class="field">
                ${renderFieldLabel("Primary source approval")}
                <select
                  .value=${props.form.repairRequireApprovalForPrimarySource ? "true" : "false"}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      repairRequireApprovalForPrimarySource:
                        (e.target as HTMLSelectElement).value === "true",
                    })}
                >
                  <option value="true">Required</option>
                  <option value="false">Allow deterministic repair</option>
                </select>
              </label>
              <label class="field">
                ${renderFieldLabel("Max tokens/run")}
                <input
                  .value=${props.form.budgetMaxTokensPerRun}
                  inputmode="decimal"
                  @input=${(e: Event) =>
                    props.onFormChange({
                      budgetMaxTokensPerRun: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="10000"
                />
              </label>
              <label class="field">
                ${renderFieldLabel("Max cost/run")}
                <input
                  .value=${props.form.budgetMaxCostUsdPerRun}
                  inputmode="decimal"
                  @input=${(e: Event) =>
                    props.onFormChange({
                      budgetMaxCostUsdPerRun: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="0.05"
                />
              </label>
              <label class="field">
                ${renderFieldLabel("Max runs/hour")}
                <input
                  .value=${props.form.budgetMaxRunsPerHour}
                  inputmode="decimal"
                  @input=${(e: Event) =>
                    props.onFormChange({
                      budgetMaxRunsPerHour: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="12"
                />
              </label>
              <label class="field">
                ${renderFieldLabel("Stop on success")}
                <select
                  .value=${props.form.stopOnSuccess ? "true" : "false"}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      stopOnSuccess: (e.target as HTMLSelectElement).value === "true",
                    })}
                >
                  <option value="false">No</option>
                  <option value="true">Yes</option>
                </select>
                <div class="cron-help">Disable this task after a successful run.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Stop text")}
                <input
                  .value=${props.form.stopTextIncludes}
                  @input=${(e: Event) =>
                    props.onFormChange({
                      stopTextIncludes: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="done, complete"
                />
                <div class="cron-help">Disable when output includes one of these markers.</div>
              </label>
              <label class="field">
                ${renderFieldLabel("Max successes")}
                <input
                  .value=${props.form.stopMaxSuccessfulRuns}
                  inputmode="decimal"
                  @input=${(e: Event) =>
                    props.onFormChange({
                      stopMaxSuccessfulRuns: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="1"
                />
              </label>
              <label class="field">
                ${renderFieldLabel("Max total runs")}
                <input
                  .value=${props.form.stopMaxTotalRuns}
                  inputmode="decimal"
                  @input=${(e: Event) =>
                    props.onFormChange({
                      stopMaxTotalRuns: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="10"
                />
              </label>
            </div>
          </section>

          <section class="cron-form-section">
            <div class="cron-form-section__title">${t("cron.form.deliverySection")}</div>
            <div class="cron-form-section__sub">${t("cron.form.deliverySub")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field ${selectedDeliveryMode === "none" ? "cron-span-2" : ""}">
                ${renderFieldLabel(t("cron.form.resultDelivery"))}
                <select
                  id="cron-delivery-mode"
                  .value=${selectedDeliveryMode}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      deliveryMode: (e.target as HTMLSelectElement)
                        .value as CronFormState["deliveryMode"],
                    })}
                >
                  ${
                    supportsAnnounce
                      ? html` <option value="announce">${t("cron.form.announceDefault")}</option> `
                      : nothing
                  }
                  <option value="webhook">${t("cron.form.webhookPost")}</option>
                  <option value="none">${t("cron.form.noneInternal")}</option>
                </select>
                <div class="cron-help">${t("cron.form.deliveryHelp")}</div>
              </label>
              ${
                selectedDeliveryMode !== "none"
                  ? html`
                    <label class="field ${selectedDeliveryMode === "webhook" ? "cron-span-2" : ""}">
                      ${renderFieldLabel(
                        selectedDeliveryMode === "webhook"
                          ? t("cron.form.webhookUrl")
                          : t("cron.form.channel"),
                        selectedDeliveryMode === "webhook",
                      )}
                      ${
                        selectedDeliveryMode === "webhook"
                          ? html`
                            <input
                              id="cron-delivery-to"
                              .value=${props.form.deliveryTo}
                              list="cron-delivery-to-suggestions"
                              aria-invalid=${props.fieldErrors.deliveryTo ? "true" : "false"}
                              aria-describedby=${ifDefined(
                                props.fieldErrors.deliveryTo
                                  ? errorIdForField("deliveryTo")
                                  : undefined,
                              )}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  deliveryTo: (e.target as HTMLInputElement).value,
                                })}
                              placeholder=${t("cron.form.webhookPlaceholder")}
                            />
                          `
                          : html`
                            <select
                              id="cron-delivery-channel"
                              .value=${props.form.deliveryChannel || "last"}
                              @change=${(e: Event) =>
                                props.onFormChange({
                                  deliveryChannel: (e.target as HTMLSelectElement).value,
                                })}
                            >
                              ${channelOptions.map(
                                (channel) =>
                                  html`<option value=${channel}>
                                    ${resolveChannelLabel(props, channel)}
                                  </option>`,
                              )}
                            </select>
                          `
                      }
                      ${
                        selectedDeliveryMode === "announce"
                          ? html` <div class="cron-help">${t("cron.form.channelHelp")}</div> `
                          : html` <div class="cron-help">${t("cron.form.webhookHelp")}</div> `
                      }
                    </label>
                    ${
                      selectedDeliveryMode === "announce"
                        ? html`
                          <label class="field cron-span-2">
                            ${renderFieldLabel(t("cron.form.to"))}
                            <input
                              id="cron-delivery-to"
                              .value=${props.form.deliveryTo}
                              list="cron-delivery-to-suggestions"
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  deliveryTo: (e.target as HTMLInputElement).value,
                                })}
                              placeholder=${t("cron.form.toPlaceholder")}
                            />
                            <div class="cron-help">${t("cron.form.toHelp")}</div>
                          </label>
                        `
                        : nothing
                    }
                    ${
                      selectedDeliveryMode === "webhook"
                        ? renderFieldError(
                            props.fieldErrors.deliveryTo,
                            errorIdForField("deliveryTo"),
                          )
                        : nothing
                    }
                  `
                  : nothing
              }
            </div>
          </section>

          <details class="cron-advanced">
            <summary class="cron-advanced__summary">${t("cron.form.advanced")}</summary>
            <div class="cron-help">${t("cron.form.advancedHelp")}</div>
            <div class="form-grid cron-form-grid">
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${props.form.deleteAfterRun}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      deleteAfterRun: (e.target as HTMLInputElement).checked,
                    })}
                />
                <span class="field-checkbox__label">${t("cron.form.deleteAfterRun")}</span>
                <div class="cron-help">${t("cron.form.deleteAfterRunHelp")}</div>
              </label>
              <label class="field checkbox cron-checkbox">
                <input
                  type="checkbox"
                  .checked=${props.form.clearAgent}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      clearAgent: (e.target as HTMLInputElement).checked,
                    })}
                />
                <span class="field-checkbox__label">${t("cron.form.clearAgentOverride")}</span>
                <div class="cron-help">${t("cron.form.clearAgentHelp")}</div>
              </label>
              <label class="field cron-span-2">
                ${renderFieldLabel("Session key")}
                <input
                  id="cron-session-key"
                  .value=${props.form.sessionKey}
                  @input=${(e: Event) =>
                    props.onFormChange({
                      sessionKey: (e.target as HTMLInputElement).value,
                    })}
                  placeholder="agent:main:main"
                />
                <div class="cron-help">Optional routing key for task delivery and wake routing.</div>
              </label>
              ${
                isCronSchedule
                  ? html`
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${props.form.scheduleExact}
                        @change=${(e: Event) =>
                          props.onFormChange({
                            scheduleExact: (e.target as HTMLInputElement).checked,
                          })}
                      />
                      <span class="field-checkbox__label">${t("cron.form.exactTiming")}</span>
                      <div class="cron-help">${t("cron.form.exactTimingHelp")}</div>
                    </label>
                    <div class="cron-stagger-group cron-span-2">
                      <label class="field">
                        ${renderFieldLabel(t("cron.form.staggerWindow"))}
                        <input
                          id="cron-stagger-amount"
                          .value=${props.form.staggerAmount}
                          ?disabled=${props.form.scheduleExact}
                          aria-invalid=${props.fieldErrors.staggerAmount ? "true" : "false"}
                          aria-describedby=${ifDefined(
                            props.fieldErrors.staggerAmount
                              ? errorIdForField("staggerAmount")
                              : undefined,
                          )}
                          @input=${(e: Event) =>
                            props.onFormChange({
                              staggerAmount: (e.target as HTMLInputElement).value,
                            })}
                          placeholder=${t("cron.form.staggerPlaceholder")}
                        />
                        ${renderFieldError(
                          props.fieldErrors.staggerAmount,
                          errorIdForField("staggerAmount"),
                        )}
                      </label>
                      <label class="field">
                        <span>${t("cron.form.staggerUnit")}</span>
                        <select
                          .value=${props.form.staggerUnit}
                          ?disabled=${props.form.scheduleExact}
                          @change=${(e: Event) =>
                            props.onFormChange({
                              staggerUnit: (e.target as HTMLSelectElement)
                                .value as CronFormState["staggerUnit"],
                            })}
                        >
                          <option value="seconds">${t("cron.form.seconds")}</option>
                          <option value="minutes">${t("cron.form.minutes")}</option>
                        </select>
                      </label>
                    </div>
                  `
                  : nothing
              }
              ${
                isAgentTurn
                  ? html`
                    <label class="field cron-span-2">
                      ${renderFieldLabel("Account ID")}
                      <input
                        id="cron-delivery-account-id"
                        .value=${props.form.deliveryAccountId}
                        list="cron-delivery-account-suggestions"
                        ?disabled=${selectedDeliveryMode !== "announce"}
                        @input=${(e: Event) =>
                          props.onFormChange({
                            deliveryAccountId: (e.target as HTMLInputElement).value,
                          })}
                        placeholder="default"
                      />
                      <div class="cron-help">
                        Optional channel account ID for multi-account setups.
                      </div>
                    </label>
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${props.form.payloadLightContext}
                        @change=${(e: Event) =>
                          props.onFormChange({
                            payloadLightContext: (e.target as HTMLInputElement).checked,
                          })}
                      />
                      <span class="field-checkbox__label">Light context</span>
                      <div class="cron-help">
                        Use lightweight bootstrap context for this Agent task.
                      </div>
                    </label>
                    <label class="field">
                      ${renderFieldLabel(t("cron.form.model"))}
                      <input
                        id="cron-payload-model"
                        .value=${props.form.payloadModel}
                        list="cron-model-suggestions"
                        @input=${(e: Event) =>
                          props.onFormChange({
                            payloadModel: (e.target as HTMLInputElement).value,
                          })}
                        placeholder=${t("cron.form.modelPlaceholder")}
                      />
                      <div class="cron-help">${t("cron.form.modelHelp")}</div>
                    </label>
                    <label class="field">
                      ${renderFieldLabel(t("cron.form.thinking"))}
                      <input
                        id="cron-payload-thinking"
                        .value=${props.form.payloadThinking}
                        list="cron-thinking-suggestions"
                        @input=${(e: Event) =>
                          props.onFormChange({
                            payloadThinking: (e.target as HTMLInputElement).value,
                          })}
                        placeholder=${t("cron.form.thinkingPlaceholder")}
                      />
                      <div class="cron-help">${t("cron.form.thinkingHelp")}</div>
                    </label>
                  `
                  : nothing
              }
              ${
                isAgentTurn
                  ? html`
                    <label class="field cron-span-2">
                      ${renderFieldLabel("Failure alerts")}
                      <select
                        .value=${props.form.failureAlertMode}
                        @change=${(e: Event) =>
                          props.onFormChange({
                            failureAlertMode: (e.target as HTMLSelectElement)
                              .value as CronFormState["failureAlertMode"],
                          })}
                      >
                        <option value="inherit">Inherit global setting</option>
                        <option value="disabled">Disable for this task</option>
                        <option value="custom">Custom per-task settings</option>
                      </select>
                      <div class="cron-help">
                        Control when this task sends repeated-failure alerts.
                      </div>
                    </label>
                    ${
                      props.form.failureAlertMode === "custom"
                        ? html`
                          <label class="field">
                            ${renderFieldLabel("Alert after")}
                            <input
                              id="cron-failure-alert-after"
                              .value=${props.form.failureAlertAfter}
                              aria-invalid=${props.fieldErrors.failureAlertAfter ? "true" : "false"}
                              aria-describedby=${ifDefined(
                                props.fieldErrors.failureAlertAfter
                                  ? errorIdForField("failureAlertAfter")
                                  : undefined,
                              )}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  failureAlertAfter: (e.target as HTMLInputElement).value,
                                })}
                              placeholder="2"
                            />
                            <div class="cron-help">Consecutive errors before alerting.</div>
                            ${renderFieldError(
                              props.fieldErrors.failureAlertAfter,
                              errorIdForField("failureAlertAfter"),
                            )}
                          </label>
                          <label class="field">
                            ${renderFieldLabel("Cooldown (seconds)")}
                            <input
                              id="cron-failure-alert-cooldown-seconds"
                              .value=${props.form.failureAlertCooldownSeconds}
                              aria-invalid=${
                                props.fieldErrors.failureAlertCooldownSeconds ? "true" : "false"
                              }
                              aria-describedby=${ifDefined(
                                props.fieldErrors.failureAlertCooldownSeconds
                                  ? errorIdForField("failureAlertCooldownSeconds")
                                  : undefined,
                              )}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  failureAlertCooldownSeconds: (e.target as HTMLInputElement).value,
                                })}
                              placeholder="3600"
                            />
                            <div class="cron-help">Minimum seconds between alerts.</div>
                            ${renderFieldError(
                              props.fieldErrors.failureAlertCooldownSeconds,
                              errorIdForField("failureAlertCooldownSeconds"),
                            )}
                          </label>
                          <label class="field">
                            ${renderFieldLabel("Alert channel")}
                            <select
                              .value=${props.form.failureAlertChannel || "last"}
                              @change=${(e: Event) =>
                                props.onFormChange({
                                  failureAlertChannel: (e.target as HTMLSelectElement).value,
                                })}
                            >
                              ${channelOptions.map(
                                (channel) =>
                                  html`<option value=${channel}>
                                    ${resolveChannelLabel(props, channel)}
                                  </option>`,
                              )}
                            </select>
                          </label>
                          <label class="field">
                            ${renderFieldLabel("Alert to")}
                            <input
                              .value=${props.form.failureAlertTo}
                              list="cron-delivery-to-suggestions"
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  failureAlertTo: (e.target as HTMLInputElement).value,
                                })}
                              placeholder="+1555... or chat id"
                            />
                            <div class="cron-help">
                              Optional recipient override for failure alerts.
                            </div>
                          </label>
                          <label class="field">
                            ${renderFieldLabel("Alert mode")}
                            <select
                              .value=${props.form.failureAlertDeliveryMode || "announce"}
                              @change=${(e: Event) =>
                                props.onFormChange({
                                  failureAlertDeliveryMode: (e.target as HTMLSelectElement)
                                    .value as CronFormState["failureAlertDeliveryMode"],
                                })}
                            >
                              <option value="announce">Announce (via channel)</option>
                              <option value="webhook">Webhook (HTTP POST)</option>
                            </select>
                          </label>
                          <label class="field">
                            ${renderFieldLabel("Alert account ID")}
                            <input
                              .value=${props.form.failureAlertAccountId}
                              @input=${(e: Event) =>
                                props.onFormChange({
                                  failureAlertAccountId: (e.target as HTMLInputElement).value,
                                })}
                              placeholder="Account ID for multi-account setups"
                            />
                          </label>
                        `
                        : nothing
                    }
                  `
                  : nothing
              }
              ${
                selectedDeliveryMode !== "none"
                  ? html`
                    <label class="field checkbox cron-checkbox cron-span-2">
                      <input
                        type="checkbox"
                        .checked=${props.form.deliveryBestEffort}
                        @change=${(e: Event) =>
                          props.onFormChange({
                            deliveryBestEffort: (e.target as HTMLInputElement).checked,
                          })}
                      />
                      <span class="field-checkbox__label"
                        >${t("cron.form.bestEffortDelivery")}</span
                      >
                      <div class="cron-help">${t("cron.form.bestEffortHelp")}</div>
                    </label>
                  `
                  : nothing
              }
            </div>
          </details>
        </div>
        ${
          blockedByValidation
            ? html`
              <div class="cron-form-status" role="status" aria-live="polite">
                <div class="cron-form-status__title">${t("cron.form.cantAddYet")}</div>
                <div class="cron-help">${t("cron.form.fillRequired")}</div>
                <ul class="cron-form-status__list">
                  ${blockingFields.map(
                    (field) => html`
                      <li>
                        <button
                          type="button"
                          class="cron-form-status__link"
                          @click=${() => focusFormField(field.inputId)}
                        >
                          ${field.label}: ${t(field.message)}
                        </button>
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `
            : nothing
        }
        <div class="row cron-form-actions">
          <button
            class="btn primary"
            ?disabled=${props.busy || !props.canSubmit}
            @click=${props.onAdd}
          >
            ${
              props.busy
                ? t("cron.form.saving")
                : isEditing
                  ? t("cron.form.saveChanges")
                  : t("cron.form.addJob")
            }
          </button>
          ${
            submitDisabledReason
              ? html`<div class="cron-submit-reason" aria-live="polite">${submitDisabledReason}</div>`
              : nothing
          }
          ${
            isEditing
              ? html`
                <button class="btn" ?disabled=${props.busy} @click=${props.onCancelEdit}>
                  ${t("cron.form.cancel")}
                </button>
              `
              : nothing
          }
        </div>
      </details>`
          : nothing
      }
    </section>

    ${renderSuggestionList("cron-model-suggestions", props.modelSuggestions)}
    ${renderSuggestionList("cron-thinking-suggestions", props.thinkingSuggestions)}
    ${renderSuggestionList("cron-tz-suggestions", props.timezoneSuggestions)}
    ${renderSuggestionList("cron-delivery-to-suggestions", props.deliveryToSuggestions)}
    ${renderSuggestionList("cron-delivery-account-suggestions", props.accountSuggestions)}
    </section>
  `;
}

function renderScheduleFields(props: CronProps) {
  const form = props.form;
  if (form.scheduleKind === "at") {
    return html`
      <label class="field cron-span-2" style="margin-top: 12px;">
        ${renderFieldLabel(t("cron.form.runAt"), true)}
        <input
          id="cron-schedule-at"
          type="datetime-local"
          .value=${form.scheduleAt}
          aria-invalid=${props.fieldErrors.scheduleAt ? "true" : "false"}
          aria-describedby=${ifDefined(
            props.fieldErrors.scheduleAt ? errorIdForField("scheduleAt") : undefined,
          )}
          @input=${(e: Event) =>
            props.onFormChange({
              scheduleAt: (e.target as HTMLInputElement).value,
            })}
        />
        ${renderFieldError(props.fieldErrors.scheduleAt, errorIdForField("scheduleAt"))}
      </label>
    `;
  }
  if (form.scheduleKind === "every") {
    return html`
      <div class="form-grid cron-form-grid" style="margin-top: 12px;">
        <label class="field">
          ${renderFieldLabel(t("cron.form.every"), true)}
          <input
            id="cron-every-amount"
            .value=${form.everyAmount}
            aria-invalid=${props.fieldErrors.everyAmount ? "true" : "false"}
            aria-describedby=${ifDefined(
              props.fieldErrors.everyAmount ? errorIdForField("everyAmount") : undefined,
            )}
            @input=${(e: Event) =>
              props.onFormChange({
                everyAmount: (e.target as HTMLInputElement).value,
              })}
            placeholder=${t("cron.form.everyAmountPlaceholder")}
          />
          ${renderFieldError(props.fieldErrors.everyAmount, errorIdForField("everyAmount"))}
        </label>
        <label class="field">
          <span>${t("cron.form.unit")}</span>
          <select
            .value=${form.everyUnit}
            @change=${(e: Event) =>
              props.onFormChange({
                everyUnit: (e.target as HTMLSelectElement).value as CronFormState["everyUnit"],
              })}
          >
            <option value="minutes">${t("cron.form.minutes")}</option>
            <option value="hours">${t("cron.form.hours")}</option>
            <option value="days">${t("cron.form.days")}</option>
          </select>
        </label>
      </div>
    `;
  }
  return html`
    <div class="form-grid cron-form-grid" style="margin-top: 12px;">
      <label class="field">
        ${renderFieldLabel(t("cron.form.expression"), true)}
        <input
          id="cron-cron-expr"
          .value=${form.cronExpr}
          aria-invalid=${props.fieldErrors.cronExpr ? "true" : "false"}
          aria-describedby=${ifDefined(
            props.fieldErrors.cronExpr ? errorIdForField("cronExpr") : undefined,
          )}
          @input=${(e: Event) =>
            props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
          placeholder=${t("cron.form.expressionPlaceholder")}
        />
        ${renderFieldError(props.fieldErrors.cronExpr, errorIdForField("cronExpr"))}
      </label>
      <label class="field">
        <span>${t("cron.form.timezoneOptional")}</span>
        <input
          .value=${form.cronTz}
          list="cron-tz-suggestions"
          @input=${(e: Event) =>
            props.onFormChange({ cronTz: (e.target as HTMLInputElement).value })}
          placeholder=${t("cron.form.timezonePlaceholder")}
        />
        <div class="cron-help">${t("cron.form.timezoneHelp")}</div>
      </label>
      <div class="cron-help cron-span-2">${t("cron.form.jitterHelp")}</div>
    </div>
  `;
}

function renderFieldError(message?: string, id?: string) {
  if (!message) {
    return nothing;
  }
  return html`<div id=${ifDefined(id)} class="cron-help cron-error">${t(message)}</div>`;
}

function renderJob(job: CronJob, props: CronProps) {
  const itemClass = "list-item list-item-clickable cron-job";
  const openSessionKey = job.state?.lastRunSessionKey ?? job.sessionKey ?? "";
  const openSessionLabel = job.state?.lastRunSessionKey ? "Open latest run" : "Open chat";
  const runDetails = formatTaskRunLog(job);
  const activeRun = taskActiveQueueRun(props.status?.queue, job.id);
  const failedRun = taskFailedQueueRun(props.status?.queue, job.id);
  const latestRunId = taskLatestRunId(props.status?.queue, job);
  return html`
    <details class=${itemClass}>
      <summary class="cron-job-summary">
        <div class="list-main">
          <div class="cron-job-title-row">
            ${renderTaskStatusDots(job, activeRun)}
            <span class="list-title">${job.name}</span>
            <span class="mono cron-job-id" title=${job.id}>${compactTaskId(job.id)}</span>
            <span class="chip" title=${job.schedule.kind}>${formatCompactTaskSchedule(job)}</span>
          </div>
        </div>
        <div
          class="cron-job-actions"
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          ${renderTaskIconButton({
            label: "Edit task",
            icon: "edit",
            disabled: props.busy,
            onClick: (event) => {
              event.stopPropagation();
              props.onEdit(job);
            },
          })}
          ${renderTaskIconButton({
            label: "Run now",
            icon: "zap",
            disabled: props.busy,
            onClick: (event) => {
              event.stopPropagation();
              props.onRun(job, "force");
            },
          })}
          ${
            activeRun
              ? renderTaskIconButton({
                  label: "Cancel active run",
                  icon: "stop",
                  danger: true,
                  disabled: props.busy || !props.onQueueControl,
                  onClick: (event) => {
                    event.stopPropagation();
                    props.onQueueControl?.("cancel", activeRun.runId);
                  },
                })
              : nothing
          }
          ${
            activeRun?.leaseExpired
              ? renderTaskIconButton({
                  label: "Clear stale lease",
                  icon: "wrench",
                  disabled: props.busy || !props.onQueueControl,
                  onClick: (event) => {
                    event.stopPropagation();
                    props.onQueueControl?.("clear-stale", activeRun.runId);
                  },
                })
              : nothing
          }
          ${
            !activeRun && failedRun
              ? renderTaskIconButton({
                  label: "Retry failed run",
                  icon: "play",
                  disabled: props.busy || !props.onQueueControl,
                  onClick: (event) => {
                    event.stopPropagation();
                    props.onQueueControl?.("retry", failedRun.runId);
                  },
                })
              : nothing
          }
          ${
            taskCoordinationNeedsApproval(job)
              ? renderTaskIconButton({
                  label: "Approve coordination & run",
                  icon: "check",
                  disabled: props.busy || !props.onApproveCoordination,
                  onClick: (event) => {
                    event.stopPropagation();
                    void props.onApproveCoordination?.(job);
                  },
                })
              : nothing
          }
          ${
            latestRunId && props.onRunDetail
              ? renderTaskIconButton({
                  label: "Open latest run",
                  icon: "externalLink",
                  disabled: props.busy,
                  onClick: (event) => {
                    event.stopPropagation();
                    props.onRunDetail?.(latestRunId);
                  },
                })
              : openSessionKey && props.onNavigateToChat
                ? renderTaskIconButton({
                    label: openSessionLabel,
                    icon: "externalLink",
                    disabled: props.busy,
                    onClick: (event) => {
                      event.stopPropagation();
                      props.onNavigateToChat?.(openSessionKey);
                    },
                  })
                : nothing
          }
          ${renderTaskIconButton({
            label: job.enabled ? "Pause task" : "Resume task",
            icon: job.enabled ? "pause" : "play",
            disabled: props.busy,
            onClick: (event) => {
              event.stopPropagation();
              props.onToggle(job, !job.enabled);
            },
          })}
          ${renderTaskIconButton({
            label: "Delete task",
            icon: "x",
            danger: true,
            disabled: props.busy,
            onClick: (event) => {
              event.stopPropagation();
              props.onRemove(job);
            },
          })}
        </div>
      </summary>
      <div class="cron-job-body">
        <div class="cron-job-grid">
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Task ID</div>
            <div class="cron-job-detail-value mono">${job.id}</div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Agent</div>
            <div class="cron-job-detail-value">${formatAgentForId(props, job.agentId)}</div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Created</div>
            <div class="cron-job-detail-value">
              ${formatRelativeTimestamp(job.createdAtMs ?? taskSortMs(job))}
            </div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">State</div>
            <div class="cron-job-detail-value">${formatCronState(job)}</div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Delivery</div>
            <div class="cron-job-detail-value">${taskDeliveryLabel(job)}</div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Session</div>
            <div class="cron-job-detail-value mono">
              ${job.sessionKey ?? `${job.sessionTarget} / ${job.wakeMode}`}
            </div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Runtime</div>
            <div class="cron-job-detail-value">${formatCronPayload(job)}</div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Execution</div>
            <div class="cron-job-detail-value">
              ${job.executionPolicy?.executionMode ?? job.sessionTarget}
            </div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Model</div>
            <div class="cron-job-detail-value mono">
              ${job.executionPolicy?.modelPolicy?.model ?? "Agent default"}
            </div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Coordination</div>
            <div class="cron-job-detail-value">${taskCoordinationLabel(job)}</div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Adaptive next</div>
            <div class="cron-job-detail-value">
              ${
                taskAdaptiveDecision(job)
                  ? html`
                      ${taskAdaptiveRouteLabel(taskAdaptiveDecision(job)?.route)}
                      <span class="muted">
                        · ${taskAdaptiveDecision(job)?.sampleSize ?? 0} sample${
                          taskAdaptiveDecision(job)?.sampleSize === 1 ? "" : "s"
                        }
                      </span>
                    `
                  : "not learned yet"
              }
            </div>
          </div>
          <div class="cron-job-field">
            <div class="cron-job-detail-label">Updated</div>
            <div class="cron-job-detail-value">${formatRelativeTimestamp(taskSortMs(job))}</div>
          </div>
        </div>
        <div class="cron-job-field cron-job-field--wide">
          <div class="cron-job-detail-label">Prompt</div>
          <div class="cron-job-detail-value">${taskPromptPreview(job)}</div>
        </div>
        ${
          runDetails.length > 0
            ? html`
                <div class="cron-job-field cron-job-field--wide">
                  <div class="cron-job-detail-label">Activity log</div>
                  ${renderTaskRunLog(runDetails)}
                </div>
              `
            : nothing
        }
        ${renderTaskRepairControls(job, props)}
        ${renderTaskCoordinationApproval(job, props)}
        ${renderTaskCoordinationRetry(job, props)}
        ${renderTaskTrustedSources(job, props)}
        ${renderTaskAccessCallout({
          block: job.state?.needsAccess,
          basePath: props.basePath,
          onActionClick: (event) => event.stopPropagation(),
        })}
      </div>
    </details>
  `;
}
