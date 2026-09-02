import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  TASK_TEMPLATE_PRESET_OPTIONS,
  type CronJobsAdaptiveRouteFilter,
  type CronRepairAction,
  type TaskTemplatePreset,
} from "../controllers/cron.ts";
import { closeDialogOnBackdropClick, openDialogSafely } from "../dialog.ts";
import { formatDurationHuman, formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import type { Tab } from "../navigation.ts";
import { formatCronPayload, formatCronState } from "../presenter.ts";
import { taskLedgerAnchorId } from "../task-ledger-source-route.ts";
import type {
  AgentFileEntry,
  AgentsFilesListResult,
  AgentsListResult,
  ChannelsStatusSnapshot,
  ConfigUiHints,
  CronJob,
  CronStatus,
  CronTaskAdaptiveRoute,
  CronTaskTrustedSource,
  CronTaskWorkflowGraphNode,
  SavedTaskWorkflowDefinition,
  SavedTaskWorkflowDefinitionsResult,
  StandingOrderDraft,
  StandingOrderRecord,
  StandingOrdersResult,
  TaskFlowListResult,
  TaskFlowRecord,
  TaskListResult,
  TaskRecord,
  TaskWorkflowDraft,
  TaskWorkflowGraphDraft,
  TaskWorkflowGraphEdge,
  TaskWorkflowGraphEdgeEvent,
  TaskWorkflowGraphNode,
  TaskWorkflowGraphNodeType,
  TaskWorkflowTemplate,
  TaskWorkflowTemplatesResult,
  WebhookTrigger,
  WebhookTriggersResult,
} from "../types.ts";
import { formatBytes, type AgentContext } from "./agents-utils.ts";
import { renderChannels } from "./channels.ts";
import type { ChannelsProps } from "./channels.types.ts";
import { renderTaskWorkflowGraphBuilder } from "./task-workflow-graph-builder.ts";

type TaskAccessBlock = NonNullable<NonNullable<CronJob["state"]>["needsAccess"]>;
type CronQueueStatus = NonNullable<CronStatus["queue"]>;

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

function taskLatestRunId(queue: CronQueueStatus | undefined, job: CronJob): string | undefined {
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
    return { tab: "wallet", label: "Open Wallet Policies", hash: "wallet-access" };
  }
  if (setupPath === "/wallet" || service === "wallet") {
    return { tab: "wallet", label: "Open Wallet" };
  }
  if (setupPath === "/channels" || service === "channel_delivery") {
    return { tab: "channels", label: "Open Channels" };
  }
  if (setupPath === "/skills#skill-library" || setupPath === "/skills" || service === "skills") {
    return { tab: "skills", label: "Open Skill Library" };
  }
  if (setupPath === "/agents#agent-access" || service === "agent_skills") {
    return { tab: "agents", label: "Open Agent Skills" };
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
    const labels: Record<string, string> = {
      "service-firecrawl": "Open Firecrawl setup",
      "service-github": "Open GitHub setup",
      "service-google-workspace": "Open Google Workspace setup",
      "service-media-browser": "Open Media/browser setup",
      "service-plugin-services": "Open Plugin services",
      "service-web-search": "Open Web/search setup",
    };
    if (hash && labels[hash]) {
      return { tab: "services", label: labels[hash] };
    }
    if (service === "web_search") {
      return { tab: "services", label: "Open Web/search setup" };
    }
    if (service === "github") {
      return { tab: "services", label: "Open GitHub setup" };
    }
    if (service === "google_workspace") {
      return { tab: "services", label: "Open Google Workspace setup" };
    }
    if (service === "firecrawl") {
      return { tab: "services", label: "Open Firecrawl setup" };
    }
    if (service === "media_browser") {
      return { tab: "services", label: "Open Media/browser setup" };
    }
    if (service === "plugin_services") {
      return { tab: "services", label: "Open Plugin services" };
    }
    return { tab: "services", label: "Open Services" };
  }
  return null;
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

type TaskLogTone = "ok" | "warn" | "danger" | "info" | "muted";

type TaskLogEntry = {
  tone: TaskLogTone;
  label: string;
  detail?: string;
};

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

function sourceSetupTabForTask(job: CronJob): Tab {
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

function recommendedRepairForAgentTask(job: CronJob): { label: string; reason: string } | null {
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

function renderAgentTaskRepairControls(params: {
  job: CronJob;
  onRepair?: (
    job: CronJob,
    action: CronRepairAction,
    opts?: { source?: string; sourceNodeId?: string },
  ) => void | Promise<void>;
  onNavigate?: (tab: Tab) => void;
}) {
  const { job } = params;
  const stop = job.state?.lastGraphRepairStop;
  const sourceNodeId = stop?.sourceNodeId ?? job.state?.lastGraphRepair?.replacesNodeId;
  const needsSourceRecovery = Boolean(stop || job.state?.stopReason?.startsWith("needsSources:"));
  if (!needsSourceRecovery && !job.state?.needsAccess) {
    return nothing;
  }
  const recommendation = recommendedRepairForAgentTask(job);
  const setupTab = sourceSetupTabForTask(job);
  const configureSource = async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    await params.onRepair?.(job, "configure_source");
    params.onNavigate?.(setupTab);
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
    void params.onRepair?.(job, "add_trusted_source", { source });
  };
  return html`
    <div class="agent-task-field agent-task-field--wide task-repair-controls">
      <div class="agent-task-field-label">Source recovery</div>
      ${
        recommendation
          ? html`
              <div class="task-repair-recommendation">
                <strong>Recommended: ${recommendation.label}</strong>
                <span>${recommendation.reason}</span>
              </div>
            `
          : nothing
      }
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
        <button type="button" class="button-secondary" @click=${addTrustedSource}>
          Add trusted source
        </button>
      </div>
      <div class="task-repair-actions">
        <button
          type="button"
          class="button-secondary"
          ?disabled=${!params.onRepair}
          @click=${configureSource}
        >
          Configure source
        </button>
        <button
          type="button"
          class="button-secondary"
          ?disabled=${!params.onRepair}
          @click=${() => void params.onRepair?.(job, "retry_replacement")}
        >
          Retry replacement
        </button>
        <button
          type="button"
          class="button-secondary"
          ?disabled=${!params.onRepair || !sourceNodeId}
          @click=${() => void params.onRepair?.(job, "stop_source_path", { sourceNodeId })}
        >
          Stop source path
        </button>
      </div>
    </div>
  `;
}

function agentTaskSourceStatusLabel(source: CronTaskTrustedSource) {
  if (source.active === false) {
    return "disabled";
  }
  if (source.lastError) {
    return "needs review";
  }
  return "active";
}

function agentTaskSourceStatusClass(source: CronTaskTrustedSource) {
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

function agentTaskSourceQualityLabel(source: CronTaskTrustedSource) {
  const score =
    typeof source.lastQualityScore === "number" && Number.isFinite(source.lastQualityScore)
      ? source.lastQualityScore.toFixed(2)
      : "";
  if (source.lastQualityBand && score) {
    return `${source.lastQualityBand} ${score}`;
  }
  return source.lastQualityBand ?? (score || "unknown");
}

function agentTaskSourceRoleNode(
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

function agentTaskSourceRoleLabel(node: CronTaskWorkflowGraphNode | undefined) {
  if (!node?.sourceRole) {
    return "task source";
  }
  return node.optional ? `${node.sourceRole} optional` : node.sourceRole;
}

function agentTaskSourceLastUsedLabel(source: CronTaskTrustedSource) {
  const ts = source.lastRunAtMs ?? source.lastUsedAtMs ?? source.updatedAtMs ?? source.createdAtMs;
  return ts ? formatRelativeTimestamp(ts) : "never";
}

function renderAgentTaskTrustedSources(params: {
  job: CronJob;
  onSourceToggle?: (source: CronTaskTrustedSource, active: boolean) => void | Promise<void>;
  onSourceRemove?: (source: CronTaskTrustedSource) => void | Promise<void>;
}) {
  const sources = params.job.executionPolicy?.trustedSources ?? [];
  if (sources.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-task-field agent-task-field--wide task-source-controls">
      <div class="agent-task-field-label">Trusted sources</div>
      <div class="task-source-list">
        ${sources.map((source) => {
          const node = agentTaskSourceRoleNode(params.job, source);
          return html`
            <div class="task-source-row">
              <div class="task-source-main">
                <div class="task-source-title-line">
                  <strong>${source.label ?? source.source}</strong>
                  <span class=${`chip ${agentTaskSourceStatusClass(source)}`}>
                    ${agentTaskSourceStatusLabel(source)}
                  </span>
                  <span class="chip">${agentTaskSourceRoleLabel(node)}</span>
                </div>
                <div class="task-source-meta">
                  <span class="mono">${source.id}</span>
                  <span>${source.kind}</span>
                  <span>quality ${agentTaskSourceQualityLabel(source)}</span>
                  <span>used ${source.useCount ?? 0}</span>
                  <span>ok ${source.successCount ?? 0}</span>
                  <span>fail ${source.failureCount ?? 0}</span>
                  <span>last ${agentTaskSourceLastUsedLabel(source)}</span>
                </div>
                ${
                  source.lastError
                    ? html`<div class="task-source-error">${source.lastError}</div>`
                    : nothing
                }
              </div>
              <div class="task-source-actions">
                ${renderTaskIconButton({
                  label: source.active === false ? "Enable source" : "Disable source",
                  icon: source.active === false ? "play" : "pause",
                  disabled: !params.onSourceToggle,
                  onClick: () => void params.onSourceToggle?.(source, source.active === false),
                })}
                ${renderTaskIconButton({
                  label: "Forget source",
                  icon: "x",
                  danger: true,
                  disabled: !params.onSourceRemove,
                  onClick: () => void params.onSourceRemove?.(source),
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
  onClick: () => void;
}) {
  return html`
    <button
      class=${`agent-task-icon-button ${params.danger ? "agent-task-icon-button--danger" : ""}`}
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

function renderWebhookTriggerPanel(params: {
  agentId: string;
  triggersState: NonNullable<Parameters<typeof renderAgentCron>[0]["webhookTriggers"]>;
  workflowDefinitions?: SavedTaskWorkflowDefinitionsResult | null;
  activityTasks?: TaskRecord[];
  onCreate?: (agentId: string) => void;
  onEdit?: (trigger: WebhookTrigger) => void;
  onPatch?: (
    patch: Partial<import("../controllers/webhook-triggers.ts").WebhookTriggerDraft>,
  ) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onRemove?: (trigger: WebhookTrigger) => void;
  onToggle?: (trigger: WebhookTrigger, enabled: boolean) => void;
  onTest?: (trigger: WebhookTrigger) => void;
}) {
  const result = params.triggersState.result;
  const triggers = (result?.triggers ?? []).filter((trigger) => trigger.agentId === params.agentId);
  const draft = params.triggersState.draft;
  const workflowDefinitions = (params.workflowDefinitions?.definitions ?? []).filter(
    (definition) => definition.agentId === params.agentId,
  );
  const workflowDefinitionById = new Map(
    workflowDefinitions.map((definition) => [definition.id, definition]),
  );
  const basePath = result?.basePath ?? "/hooks";
  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:18789";
  const copyEndpoint = async (trigger: WebhookTrigger) => {
    const url = `${origin}${trigger.urlPath}`;
    await navigator.clipboard?.writeText(url).catch(() => {});
  };
  const patchString =
    (key: keyof import("../controllers/webhook-triggers.ts").WebhookTriggerDraft) =>
    (event: Event) => {
      params.onPatch?.({ [key]: (event.target as HTMLInputElement | HTMLTextAreaElement).value });
    };
  const editor = draft
    ? html`
        <div class="agent-task-modal-backdrop" @click=${() => params.onCancel?.()}>
          <div class="agent-task-modal-panel" @click=${(event: Event) => event.stopPropagation()}>
            <div class="agent-task-modal-head">
              <div>
                <div class="agent-task-modal-title">
                  ${icons.link} ${draft.id ? "Edit webhook trigger" : "Create webhook trigger"}
                </div>
                <div class="muted">
                  Saved Trigger definition for this Agent. Each POST records run history and starts
                  the selected target.
                </div>
              </div>
              <button
                class="agent-task-icon-button"
                type="button"
                aria-label="Close trigger editor"
                @click=${() => params.onCancel?.()}
              >
                ${icons.x}
              </button>
            </div>
            <div class="webhook-trigger-editor">
              <label class="field">
                <span>Name</span>
                <input .value=${draft.name} @input=${patchString("name")} />
                <small class="muted">Shown in Agent &gt; Tasks as the saved Trigger definition.</small>
              </label>
              <label class="field">
                <span>Path</span>
                <input .value=${draft.path} @input=${patchString("path")} />
                <small class="muted">Endpoint path under ${basePath}; path only, no token here.</small>
              </label>
              <label class="field">
                <span>Run target</span>
                <select
                  .value=${draft.action}
                  @change=${(event: Event) =>
                    params.onPatch?.({
                      action: (event.target as HTMLSelectElement).value as
                        | "agent"
                        | "wake"
                        | "workflow",
                    })}
                >
                  <option value="agent">Agent prompt</option>
                  <option value="workflow">Workflow / graph</option>
                  <option value="wake">Heartbeat wake</option>
                </select>
                <small class="muted">A POST runs this target and writes linked run history.</small>
              </label>
              ${
                draft.action === "workflow"
                  ? html`
                      <label class="field webhook-trigger-field--wide">
                        <span>Workflow target</span>
                        <select
                          .value=${draft.workflowDefinitionId ?? ""}
                          @change=${(event: Event) =>
                            params.onPatch?.({
                              workflowDefinitionId: (event.target as HTMLSelectElement).value,
                            })}
                        >
                          <option value="">Select saved workflow</option>
                          ${workflowDefinitions.map(
                            (definition) => html`
                              <option value=${definition.id}>
                                ${definition.name} (${definition.mode})
                              </option>
                            `,
                          )}
                        </select>
                        <small class="muted">
                          The Trigger starts this saved workflow; workflow run history stays linked.
                        </small>
                      </label>
                    `
                  : html`
                      <label class="field">
                        <span>Run timing</span>
                        <select
                          .value=${draft.wakeMode ?? "now"}
                          @change=${(event: Event) =>
                            params.onPatch?.({
                              wakeMode: (event.target as HTMLSelectElement).value as
                                | "now"
                                | "next-heartbeat",
                            })}
                        >
                          <option value="now">Run now</option>
                          <option value="next-heartbeat">Next heartbeat</option>
                        </select>
                        <small class="muted">
                          Run immediately or wait for the Agent heartbeat loop.
                        </small>
                      </label>
                      <label class="field">
                        <span>Delivery</span>
                        <select
                          .value=${draft.deliver ? "deliver" : "none"}
                          @change=${(event: Event) =>
                            params.onPatch?.({
                              deliver: (event.target as HTMLSelectElement).value === "deliver",
                            })}
                        >
                          <option value="none">Internal only</option>
                          <option value="deliver">Deliver reply</option>
                        </select>
                        <small class="muted">
                          Internal still records history; Deliver also sends the Agent reply.
                        </small>
                      </label>
                      <label class="field webhook-trigger-field--wide">
                        <span>${
                          draft.action === "wake" ? "Wake text template" : "Agent prompt template"
                        }</span>
                        <textarea
                          rows="5"
                          .value=${
                            draft.action === "wake"
                              ? (draft.textTemplate ?? "")
                              : (draft.messageTemplate ?? "")
                          }
                          @input=${(event: Event) =>
                            params.onPatch?.(
                              draft.action === "wake"
                                ? { textTemplate: (event.target as HTMLTextAreaElement).value }
                                : { messageTemplate: (event.target as HTMLTextAreaElement).value },
                            )}
                        ></textarea>
                        <small class="muted">
                          Supports {{payload}}, {{headers}}, {{path}}, and {{now}}.
                        </small>
                      </label>
                      <label class="field">
                        <span>Reply channel</span>
                        <input .value=${draft.channel ?? "last"} @input=${patchString("channel")} />
                        <small class="muted">Used only when delivery is enabled.</small>
                      </label>
                      <label class="field">
                        <span>Reply target</span>
                        <input .value=${draft.to ?? ""} @input=${patchString("to")} />
                        <small class="muted">Optional channel target, such as a room or user id.</small>
                      </label>
                      <label class="field">
                        <span>Timeout</span>
                        <input
                          type="number"
                          min="1"
                          .value=${draft.timeoutSeconds == null ? "" : String(draft.timeoutSeconds)}
                          @input=${(event: Event) => {
                            const value = Number((event.target as HTMLInputElement).value);
                            params.onPatch?.({
                              timeoutSeconds:
                                Number.isFinite(value) && value > 0 ? value : undefined,
                            });
                          }}
                        />
                        <small class="muted">Optional Agent turn timeout in seconds.</small>
                      </label>
                    `
              }
              <label class="field">
                <span>Notify</span>
                <select
                  .value=${draft.notifyPolicy ?? "done_only"}
                  @change=${(event: Event) =>
                    params.onPatch?.({
                      notifyPolicy: (event.target as HTMLSelectElement).value as
                        | "silent"
                        | "done_only"
                        | "state_changes",
                    })}
                >
                  <option value="silent">Silent</option>
                  <option value="done_only">Done only</option>
                  <option value="state_changes">State changes</option>
                </select>
                <small class="muted">Controls run-history notifications, not whether history exists.</small>
              </label>
              <div class="webhook-trigger-editor-actions">
                <button
                  class="btn btn--sm primary"
                  type="button"
                  ?disabled=${
                    params.triggersState.busy ||
                    (draft.action === "workflow" && !draft.workflowDefinitionId)
                  }
                  @click=${() => params.onSave?.()}
                >
                  Save trigger
                </button>
                <button class="btn btn--sm" type="button" @click=${() => params.onCancel?.()}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      `
    : nothing;
  const hasPanelBody =
    (params.triggersState.loading && !result) ||
    Boolean(params.triggersState.error || params.triggersState.message || result?.token) ||
    triggers.length > 0;
  if (!hasPanelBody) {
    return html`${editor}`;
  }
  return html`
    ${editor}
    <div class="webhook-trigger-panel webhook-trigger-panel--flat">
      <div class="webhook-trigger-body">
        ${
          params.triggersState.error
            ? html`<div class="callout danger">${params.triggersState.error}</div>`
            : nothing
        }
        ${
          params.triggersState.message
            ? html`<div class="callout ok">${params.triggersState.message}</div>`
            : nothing
        }
        ${
          result?.token
            ? html`
                <div class="callout warn">
                  New hook token, shown once:
                  <code>${result.token}</code>
                </div>
              `
            : nothing
        }
        <div class="webhook-trigger-list">
          ${
            params.triggersState.loading && triggers.length === 0
              ? html`
                  <div class="muted">Loading webhook triggers...</div>
                `
              : triggers.map((trigger) => {
                  const latest = latestTaskForDefinition(
                    params.activityTasks ?? [],
                    "trigger",
                    trigger.id,
                  );
                  const workflowTarget = trigger.workflowDefinitionId
                    ? workflowDefinitionById.get(trigger.workflowDefinitionId)
                    : null;
                  const targetLabel =
                    trigger.action === "workflow"
                      ? `workflow · ${workflowTarget?.name ?? trigger.workflowDefinitionId ?? "missing target"}`
                      : `${trigger.action} · ${trigger.urlPath}`;
                  return html`
                      <div
                        id=${taskLedgerAnchorId("webhook-trigger", trigger.id || trigger.name)}
                        class="webhook-trigger-row"
                      >
                        <span
                          class=${`task-status-dot task-status-dot--${trigger.enabled ? "ok" : "muted"}`}
                          title=${trigger.enabled ? "Enabled" : "Disabled"}
                        ></span>
                        <div class="webhook-trigger-main">
                          <strong>${trigger.name}</strong>
                          <span class="muted">${targetLabel}</span>
                          <span class="muted">${trigger.urlPath}</span>
                          <span class="muted">
                            notify ${trigger.notifyPolicy.replace("_", " ")}
                            · ${taskDefinitionLatestLabel(latest)}
                          </span>
                        </div>
                        <div class="agent-task-actions">
                          ${renderTaskIconButton({
                            label: "Copy endpoint",
                            icon: "copy",
                            onClick: () => void copyEndpoint(trigger),
                          })}
                          ${renderTaskIconButton({
                            label: "Test trigger",
                            icon: "zap",
                            disabled: params.triggersState.busy,
                            onClick: () => params.onTest?.(trigger),
                          })}
                          ${renderTaskIconButton({
                            label: "Edit trigger",
                            icon: "edit",
                            onClick: () => params.onEdit?.(trigger),
                          })}
                          ${renderTaskIconButton({
                            label: trigger.enabled ? "Disable trigger" : "Enable trigger",
                            icon: trigger.enabled ? "pause" : "play",
                            disabled: params.triggersState.busy,
                            onClick: () => params.onToggle?.(trigger, !trigger.enabled),
                          })}
                          ${renderTaskIconButton({
                            label: "Delete trigger",
                            icon: "trash",
                            danger: true,
                            disabled: params.triggersState.busy,
                            onClick: () => params.onRemove?.(trigger),
                          })}
                        </div>
                      </div>
                    `;
                })
          }
        </div>
      </div>
    </div>
  `;
}

const WORKFLOW_TEMPLATE_SOURCE_TAGS = new Set([
  "wallet",
  "marketplace",
  "mining",
  "services",
  "channels",
  "media",
]);

function workflowTemplateSourceTag(template: TaskWorkflowTemplate) {
  return (
    template.tags.find((tag) => WORKFLOW_TEMPLATE_SOURCE_TAGS.has(tag)) ??
    template.tags[0] ??
    "workflow"
  );
}

function workflowTemplateSourceLabel(tag: string) {
  if (tag === "channels") {
    return "channel";
  }
  if (tag === "services") {
    return "service";
  }
  return tag;
}

function openWorkflowTemplateLibrary(event: Event) {
  const root = (event.currentTarget as HTMLElement).closest(".agent-task-toolbar");
  const dialog = root?.querySelector<HTMLDialogElement>(
    '[data-workflow-template-library-dialog="true"]',
  );
  openDialogSafely(dialog);
}

function renderWorkflowTemplateLibraryDialog(params: {
  agentId: string;
  templates: TaskWorkflowTemplate[];
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  onUseTemplate?: (agentId: string, template: TaskWorkflowTemplate) => void;
  onUseTaskTemplate?: (agentId: string, template: TaskTemplatePreset) => void;
}) {
  const taskTemplates = TASK_TEMPLATE_PRESET_OPTIONS;
  return html`
    <dialog
      class="workflow-template-preview-dialog"
      data-workflow-template-library-dialog="true"
      @click=${closeDialogOnBackdropClick}
    >
      <div class="workflow-template-preview-panel" @click=${(event: Event) => event.stopPropagation()}>
        <div class="workflow-template-preview-head">
          <div>
            <div class="workflow-template-preview-title">Templates</div>
            <div class="muted">
              Pick a Task or Workflow starter for this Agent. Templates do not grant wallet,
              mining, marketplace, channel, service, or tool authority.
            </div>
          </div>
          <button
            class="agent-task-icon-button"
            type="button"
            title="Close templates"
            aria-label="Close templates"
            @click=${(event: Event) => (event.currentTarget as HTMLElement).closest("dialog")?.close()}
          >
            ${icons.x}
          </button>
        </div>
        <div class="workflow-template-library-list">
          ${taskTemplates.map((template) => {
            const closeAndUse = (event: Event) => {
              (event.currentTarget as HTMLElement).closest("dialog")?.close();
              params.onUseTaskTemplate?.(params.agentId, template.id);
            };
            return html`
              <div class="webhook-trigger-row workflow-template-row">
                <span class="task-status-dot task-status-dot--info"></span>
                <span class="webhook-trigger-main">
                  <strong>
                    ${template.label}
                    <span class="workflow-template-source-badge workflow-template-source-badge--mining">
                      Task
                    </span>
                  </strong>
                  <span class="muted">${template.description}</span>
                </span>
                <span class="workflow-template-actions">
                  <button
                    class="btn btn--sm primary"
                    type="button"
                    ?disabled=${params.disabled}
                    aria-label=${`Use ${template.label}`}
                    @click=${closeAndUse}
                  >
                    ${icons.play} Use
                  </button>
                </span>
              </div>
            `;
          })}
          ${
            params.error
              ? html`<div class="callout danger">${params.error}</div>`
              : params.loading
                ? html`
                    <div class="muted">Loading workflow templates...</div>
                  `
                : params.templates.map((template) => {
                    const unitCount = template.graph?.nodes.length ?? template.steps.length;
                    const unitLabel = template.graph ? "node" : "step";
                    const sourceTag = workflowTemplateSourceTag(template);
                    const closeAndUse = (event: Event) => {
                      (event.currentTarget as HTMLElement).closest("dialog")?.close();
                      params.onUseTemplate?.(params.agentId, template);
                    };
                    return html`
                      <div class="webhook-trigger-row workflow-template-row">
                        <span class="task-status-dot task-status-dot--info"></span>
                        <span class="webhook-trigger-main">
                          <strong>
                            ${template.name}
                            <span class=${`workflow-template-source-badge workflow-template-source-badge--${sourceTag}`}>
                              ${workflowTemplateSourceLabel(sourceTag)}
                            </span>
                          </strong>
                          <span class="muted">${template.description}</span>
                          <span class="muted">
                            ${unitCount} ${unitLabel}${unitCount === 1 ? "" : "s"}
                            ${template.tags.length ? html` · ${template.tags.join(", ")}` : nothing}
                          </span>
                        </span>
                        <span class="workflow-template-actions">
                          <button
                            class="btn btn--sm primary"
                            type="button"
                            ?disabled=${params.disabled}
                            aria-label=${`Use ${template.name}`}
                            @click=${closeAndUse}
                          >
                            ${icons.play} Use
                          </button>
                        </span>
                      </div>
                    `;
                  })
          }
        </div>
      </div>
    </dialog>
  `;
}

function renderWorkflowPanel(params: {
  agentId: string;
  state: {
    draft: TaskWorkflowDraft | null;
    graphDraft: TaskWorkflowGraphDraft | null;
    busy: boolean;
    error: string | null;
    message: string | null;
    definitions: SavedTaskWorkflowDefinitionsResult | null;
    definitionsLoading: boolean;
    definitionsBusy: boolean;
    definitionsError: string | null;
    templates?: TaskWorkflowTemplatesResult | null;
    templatesLoading?: boolean;
    templatesError?: string | null;
    runs: TaskFlowListResult | null;
    runsLoading: boolean;
    runsBusy: boolean;
    runsError: string | null;
  };
  onCreate?: (agentId: string) => void;
  onGraphCreate?: (agentId: string) => void;
  onUseTemplate?: (agentId: string, template: TaskWorkflowTemplate) => void;
  onPatch?: (patch: Partial<TaskWorkflowDraft>) => void;
  onGraphPatch?: (patch: Partial<TaskWorkflowGraphDraft>) => void;
  onGraphAddNode?: (type: TaskWorkflowGraphNodeType) => void;
  onGraphUpdateNode?: (nodeId: string, patch: Partial<TaskWorkflowGraphNode>) => void;
  onGraphRemoveNode?: (nodeId: string) => void;
  onGraphMoveNode?: (nodeId: string, x: number, y: number) => void;
  onGraphAddEdge?: (from: string, to: string, on?: TaskWorkflowGraphEdgeEvent) => void;
  onGraphUpdateEdge?: (edgeId: string, patch: Partial<TaskWorkflowGraphEdge>) => void;
  onGraphRemoveEdge?: (edgeId: string) => void;
  onGraphAutoLayout?: () => void;
  onGraphImportJson?: () => void;
  onGraphExportJson?: () => void;
  onPreview?: (agentId: string) => void;
  onGraphPreview?: (agentId: string) => void;
  onSave?: (agentId: string) => void;
  onGraphSave?: (agentId: string) => void;
  onRun?: (agentId: string) => void;
  onGraphRun?: (agentId: string) => void;
  onEditDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onEditGraphDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onRunDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onRemoveDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onOpenRunGraph?: (flow: TaskFlowRecord) => void;
  onCancelRun?: (flow: TaskFlowRecord) => void;
  onOpenSource?: (task: TaskRecord) => void;
  onCancel?: () => void;
  modeFilter?: "all" | "workflow" | "graph";
}) {
  const draft = params.state.draft;
  const modeFilter = params.modeFilter ?? "all";
  const allDefinitions = params.state.definitions?.definitions ?? [];
  const definitions = allDefinitions.filter((definition) => {
    if (modeFilter === "graph") {
      return definition.mode === "graph";
    }
    if (modeFilter === "workflow") {
      return definition.mode !== "graph";
    }
    return true;
  });
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const allRuns = params.state.runs?.flows ?? [];
  const runs = allRuns.filter((flow) => {
    if (modeFilter === "all") {
      return true;
    }
    const flowMode =
      flowMetadataString(flow, "definitionKind") ||
      (flow.definitionId &&
        allDefinitions.find((definition) => definition.id === flow.definitionId)?.mode);
    if (flowMode === modeFilter) {
      return true;
    }
    return Boolean(flow.definitionId && definitionIds.has(flow.definitionId));
  });
  const latestRunForDefinition = (definitionId: string) =>
    runs
      .filter((flow) => flow.definitionId === definitionId)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  const blockedRunCount =
    params.state.runs?.summary.blocked ?? runs.filter((flow) => flow.status === "blocked").length;
  const definitionsBusy = params.state.definitionsBusy || params.state.busy;
  const runsBusy = params.state.runsBusy || params.state.busy;
  const isTerminalFlow = (status: TaskFlowRecord["status"]) =>
    ["succeeded", "failed", "timed_out", "cancelled", "lost", "skipped", "blocked"].includes(
      status,
    );
  const flowTone = (
    status: TaskFlowRecord["status"],
  ): "ok" | "warn" | "danger" | "info" | "muted" => {
    if (status === "succeeded") {
      return "ok";
    }
    if (status === "queued" || status === "running" || status === "waiting") {
      return "info";
    }
    if (
      status === "blocked" ||
      status === "failed" ||
      status === "timed_out" ||
      status === "lost"
    ) {
      return "danger";
    }
    if (status === "cancelled" || status === "skipped") {
      return "warn";
    }
    return "muted";
  };
  const editor =
    params.state.graphDraft || draft
      ? html`
          <div class="agent-task-modal-backdrop" @click=${() => params.onCancel?.()}>
            <div
              class="agent-task-modal-panel agent-task-modal-panel--wide"
              @click=${(event: Event) => event.stopPropagation()}
            >
              <div class="agent-task-modal-head">
                <div>
                  <div class="agent-task-modal-title">
                    ${params.state.graphDraft ? icons.link : icons.listChecks}
                    ${
                      params.state.graphDraft
                        ? params.state.graphDraft.id
                          ? "Edit graph workflow"
                          : "Create graph workflow"
                        : draft?.id
                          ? "Edit workflow"
                          : "Create workflow"
                    }
                  </div>
                  <div class="muted">
                    ${
                      params.state.graphDraft
                        ? "Saved Graph Workflow definition for this Agent. Running it creates run history; graph approval nodes pause until approved or rejected."
                        : "Saved Workflow definition for this Agent. Running it creates run history; approval steps pause until approved."
                    }
                  </div>
                </div>
                <button
                  class="agent-task-icon-button"
                  type="button"
                  aria-label="Close workflow editor"
                  @click=${() => params.onCancel?.()}
                >
                  ${icons.x}
                </button>
              </div>
              ${
                params.state.graphDraft
                  ? renderTaskWorkflowGraphBuilder({
                      agentId: params.agentId,
                      draft: params.state.graphDraft,
                      busy: params.state.busy,
                      definitionsBusy,
                      onPatch: params.onGraphPatch,
                      onAddNode: params.onGraphAddNode,
                      onUpdateNode: params.onGraphUpdateNode,
                      onRemoveNode: params.onGraphRemoveNode,
                      onMoveNode: params.onGraphMoveNode,
                      onAddEdge: params.onGraphAddEdge,
                      onUpdateEdge: params.onGraphUpdateEdge,
                      onRemoveEdge: params.onGraphRemoveEdge,
                      onAutoLayout: params.onGraphAutoLayout,
                      onImportJson: params.onGraphImportJson,
                      onExportJson: params.onGraphExportJson,
                      onPreview: params.onGraphPreview,
                      onSave: params.onGraphSave,
                      onRun: params.onGraphRun,
                      onCancel: params.onCancel,
                    })
                  : draft
                    ? html`
                        <div class="webhook-trigger-editor">
                          <label class="field">
                            <span>Name</span>
                            <input
                              .value=${draft.name}
                              @input=${(event: Event) =>
                                params.onPatch?.({
                                  name: (event.target as HTMLInputElement).value,
                                })}
                            />
                            <small class="muted">
                              Shown in Agent &gt; Tasks as the saved Workflow definition.
                            </small>
                          </label>
                          <label class="field">
                            <span>Notify</span>
                            <select
                              .value=${draft.notifyPolicy}
                              @change=${(event: Event) =>
                                params.onPatch?.({
                                  notifyPolicy: (event.target as HTMLSelectElement)
                                    .value as TaskWorkflowDraft["notifyPolicy"],
                                })}
                            >
                              <option value="silent">Silent</option>
                              <option value="done_only">Done only</option>
                              <option value="state_changes">State changes</option>
                            </select>
                            <small class="muted">
                              Controls run-history notifications, not whether history exists.
                            </small>
                          </label>
                          <label class="field webhook-trigger-field--wide">
                            <span>Task</span>
                            <input
                              .value=${draft.task}
                              @input=${(event: Event) =>
                                params.onPatch?.({
                                  task: (event.target as HTMLInputElement).value,
                                })}
                            />
                            <small class="muted">
                              Run title/instruction stored with each workflow run.
                            </small>
                          </label>
                          <label class="field webhook-trigger-field--wide">
                            <span>Steps</span>
                            <textarea
                              rows="6"
                              .value=${draft.stepsText}
                              @input=${(event: Event) =>
                                params.onPatch?.({
                                  stepsText: (event.target as HTMLTextAreaElement).value,
                                })}
                            ></textarea>
                            <small class="muted">
                              One step per line. Supported prefixes: note:, checkpoint:, wait
                              5m:, approval:, handoff:.
                            </small>
                          </label>
                          <div class="muted webhook-trigger-field--wide">
                            Preview validates the steps. Run creates one workflow run now. Save
                            stores the definition without running it. Approval steps pause as
                            blocked until approved.
                          </div>
                          <div class="webhook-trigger-editor-actions">
                            <button
                              class="btn btn--sm"
                              type="button"
                              ?disabled=${params.state.busy}
                              @click=${() => params.onPreview?.(params.agentId)}
                            >
                              Preview
                            </button>
                            <button
                              class="btn btn--sm primary"
                              type="button"
                              ?disabled=${params.state.busy}
                              @click=${() => params.onRun?.(params.agentId)}
                            >
                              Run workflow
                            </button>
                            <button
                              class="btn btn--sm"
                              type="button"
                              ?disabled=${definitionsBusy}
                              @click=${() => params.onSave?.(params.agentId)}
                            >
                              ${draft.id ? "Save changes" : "Save workflow"}
                            </button>
                            <button
                              class="btn btn--sm"
                              type="button"
                              @click=${() => params.onCancel?.()}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      `
                    : nothing
              }
            </div>
          </div>
        `
      : nothing;
  const hasWorkflowBody =
    Boolean(
      params.state.error ||
      params.state.definitionsError ||
      params.state.runsError ||
      params.state.templatesError ||
      params.state.message,
    ) ||
    params.state.runsLoading ||
    params.state.definitionsLoading ||
    runs.length > 0 ||
    definitions.length > 0;
  if (!hasWorkflowBody) {
    return html`${editor}`;
  }
  return html`
    ${editor}
    <div class="webhook-trigger-panel webhook-trigger-panel--flat">
      <div class="webhook-trigger-body">
        ${params.state.error ? html`<div class="callout danger">${params.state.error}</div>` : nothing}
        ${
          params.state.definitionsError
            ? html`<div class="callout danger">${params.state.definitionsError}</div>`
            : nothing
        }
        ${
          params.state.runsError
            ? html`<div class="callout danger">${params.state.runsError}</div>`
            : nothing
        }
        ${
          params.state.templatesError
            ? html`<div class="callout danger">${params.state.templatesError}</div>`
            : nothing
        }
        ${params.state.message ? html`<div class="callout ok">${params.state.message}</div>` : nothing}
        ${
          params.state.runsLoading || runs.length > 0
            ? html`<div class="webhook-trigger-list">
                <div class="agent-task-section-title">
                  <span>Workflow runs</span>
                  <span class="chip">${params.state.runs?.summary.total ?? runs.length} total</span>
                  <span class="chip">${params.state.runs?.summary.active ?? 0} active</span>
                  ${
                    blockedRunCount
                      ? html`<span class="chip">${blockedRunCount} needs review</span>`
                      : nothing
                  }
                </div>
          ${
            params.state.runsLoading
              ? html`
                  <div class="muted">Loading workflow runs...</div>
                `
              : runs.map((flow) => {
                  const graphDefinition = flow.definitionId
                    ? definitions.find(
                        (definition) =>
                          definition.id === flow.definitionId &&
                          definition.mode === "graph" &&
                          Boolean(definition.graph),
                      )
                    : undefined;
                  const sourceTask = sourceTaskFromWorkflowFlow(flow);
                  const flowTask = taskFromWorkflowFlow(flow);
                  const flowTaskLabel =
                    flow.status === "blocked" ? "Open blocked task" : "Open run task";
                  return html`
                        <details class="agent-task-row">
                          <summary>
                            <div class="agent-task-summary">
                              <div class="agent-task-title-line">
                                <span class=${`task-status-dot task-status-dot--${flowTone(flow.status)}`}></span>
                                <span class="agent-task-title">${flow.goal}</span>
                                <span class="agent-task-id mono" title=${flow.flowId}>${compactTaskId(flow.flowId)}</span>
                                <span class="chip agent-task-status">${flow.status.replace("_", " ")}</span>
                                ${
                                  flow.status === "blocked"
                                    ? html`
                                        <span class="chip agent-task-view-only">Needs review</span>
                                      `
                                    : nothing
                                }
                                ${
                                  sourceTask
                                    ? html`
                                        <span class="chip agent-task-view-only">Source task</span>
                                      `
                                    : nothing
                                }
                              </div>
                              <div class="agent-task-meta-line">
                                <span class="muted">
                                  ${flow.currentStep ? html`${flow.currentStep}` : "workflow run"}
                                  ${flow.blockedSummary ? html` · ${flow.blockedSummary}` : nothing}
                                  ${flow.updatedAt ? html` · ${formatRelativeTimestamp(flow.updatedAt)}` : nothing}
                                </span>
                              </div>
                            </div>
                            <div
                              class="agent-task-actions"
                              @click=${(event: Event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                            >
                              ${
                                graphDefinition
                                  ? renderTaskIconButton({
                                      label: "Open workflow graph",
                                      icon: "fileText",
                                      disabled: runsBusy,
                                      onClick: () => params.onOpenRunGraph?.(flow),
                                    })
                                  : nothing
                              }
                              ${
                                sourceTask
                                  ? renderTaskIconButton({
                                      label: "Open source task",
                                      icon: "externalLink",
                                      disabled: runsBusy || !params.onOpenSource,
                                      onClick: () => params.onOpenSource?.(sourceTask),
                                    })
                                  : nothing
                              }
                              ${
                                flowTask
                                  ? renderTaskIconButton({
                                      label: flowTaskLabel,
                                      icon: "messageSquare",
                                      disabled: runsBusy || !params.onOpenSource,
                                      onClick: () => params.onOpenSource?.(flowTask),
                                    })
                                  : nothing
                              }
                              ${
                                !isTerminalFlow(flow.status)
                                  ? renderTaskIconButton({
                                      label: "Cancel workflow run",
                                      icon: "stop",
                                      danger: true,
                                      disabled: runsBusy,
                                      onClick: () => params.onCancelRun?.(flow),
                                    })
                                  : nothing
                              }
                            </div>
                          </summary>
                          <div class="agent-task-detail-grid">
                            ${renderTaskLedgerField({ label: "Flow", value: flow.flowId, mono: true })}
                            ${renderTaskLedgerField({
                              label: "Definition",
                              value: flow.definitionId ?? "not saved",
                              mono: Boolean(flow.definitionId),
                            })}
                            ${renderTaskLedgerField({
                              label: "Tasks",
                              value: `${flow.taskIds.length} linked`,
                            })}
                            ${
                              flowTask
                                ? renderTaskLedgerField({
                                    label:
                                      flow.status === "blocked" ? "Blocked task" : "Current task",
                                    value: `${taskLedgerSourceLabel(flowTask.source)} · ${flowTask.task} · ${flowTask.taskId}`,
                                    wide: true,
                                  })
                                : nothing
                            }
                            ${
                              sourceTask
                                ? renderTaskLedgerField({
                                    label: "Source task",
                                    value: `${taskLedgerSourceLabel(sourceTask.source)} · ${sourceTask.task} · ${sourceTask.taskId}`,
                                    wide: true,
                                  })
                                : nothing
                            }
                            ${renderTaskLedgerField({
                              label: "Notify",
                              value: flow.notifyPolicy.replace("_", " "),
                            })}
                            ${renderTaskLedgerField({
                              label: "Created",
                              value: formatRelativeTimestamp(flow.createdAt),
                            })}
                            ${renderTaskLedgerField({
                              label: "Updated",
                              value: formatRelativeTimestamp(flow.updatedAt),
                            })}
                          </div>
                          ${renderTaskLedgerSourceActions({
                            agentId: params.agentId,
                            task: sourceTask ?? {
                              taskId: flow.flowId,
                              source: "CLI",
                              runtime: "cli",
                              task: flow.goal,
                              status: "succeeded",
                              deliveryStatus: "not_applicable",
                              notifyPolicy: "silent",
                              createdAt: flow.createdAt,
                              updatedAt: flow.updatedAt,
                            },
                            sourceTask,
                            sourceOpenLabel: "",
                            workflowReviewLabel: "",
                            busy: runsBusy,
                            onOpenSource: params.onOpenSource,
                          })}
                        </details>
                      `;
                })
          }
        </div>`
            : nothing
        }
        ${
          params.state.definitionsLoading || definitions.length > 0
            ? html`<div class="webhook-trigger-list">
                <div class="agent-task-section-title">
                  <span>Workflows</span>
                  <span class="chip">${definitions.length} saved</span>
                </div>
          ${
            params.state.definitionsLoading
              ? html`
                  <div class="muted">Loading saved workflows...</div>
                `
              : definitions.map((definition) => {
                  const approvals = definition.steps.filter(
                    (step) => step.type === "approval",
                  ).length;
                  const graphNodeCount = definition.graph?.nodes.length ?? 0;
                  const graphEdgeCount = definition.graph?.edges.length ?? 0;
                  const latestRun = latestRunForDefinition(definition.id);
                  return html`
                      <div class="webhook-trigger-row">
                        <span class="task-status-dot task-status-dot--info"></span>
                        <div class="webhook-trigger-main">
                          <strong>${definition.name}</strong>
                          <span class="muted">${definition.task}</span>
                          <span class="muted">
                            ${
                              definition.mode === "graph"
                                ? html`${graphNodeCount} nodes · ${graphEdgeCount} edges`
                                : html`${definition.steps.length} step${
                                    definition.steps.length === 1 ? "" : "s"
                                  }`
                            }
                            ${
                              definition.mode !== "graph" && approvals
                                ? html` · ${approvals} approval${approvals === 1 ? "" : "s"}`
                                : nothing
                            }
                            · notify ${definition.notifyPolicy.replace("_", " ")}
                            · ${
                              latestRun
                                ? html`latest ${latestRun.status.replace("_", " ")} ${formatRelativeTimestamp(latestRun.updatedAt)}`
                                : "no runs yet"
                            }
                          </span>
                        </div>
                        <div class="agent-task-actions">
                          ${
                            latestRun
                              ? renderTaskIconButton({
                                  label: "Open latest workflow run",
                                  icon: "messageSquare",
                                  disabled: runsBusy,
                                  onClick: () => params.onOpenRunGraph?.(latestRun),
                                })
                              : nothing
                          }
                          ${renderTaskIconButton({
                            label: "Run workflow",
                            icon: "play",
                            disabled: definitionsBusy,
                            onClick: () => params.onRunDefinition?.(definition),
                          })}
                          ${renderTaskIconButton({
                            label: "Edit workflow",
                            icon: "edit",
                            disabled: definitionsBusy,
                            onClick: () =>
                              definition.mode === "graph"
                                ? params.onEditGraphDefinition?.(definition)
                                : params.onEditDefinition?.(definition),
                          })}
                          ${renderTaskIconButton({
                            label: "Delete workflow",
                            icon: "trash",
                            danger: true,
                            disabled: definitionsBusy,
                            onClick: () => params.onRemoveDefinition?.(definition),
                          })}
                        </div>
                      </div>
                    `;
                })
          }
        </div>`
            : nothing
        }
      </div>
    </div>
  `;
}

function renderStandingOrdersPanel(params: {
  agentId: string;
  state: {
    result: StandingOrdersResult | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    message: string | null;
    draft: StandingOrderDraft | null;
  };
  onCreate?: (agentId: string) => void;
  onEdit?: (order: StandingOrderRecord) => void;
  onPatch?: (patch: Partial<StandingOrderDraft>) => void;
  onSave?: (agentId: string) => void;
  onRemove?: (order: StandingOrderRecord) => void;
  onPropose?: (order: StandingOrderRecord) => void;
  onCancel?: () => void;
  query?: string;
  typeFilter?: TaskActivityTypeFilter;
}) {
  const allOrders = params.state.result?.orders ?? [];
  const normalizedQuery = (params.query ?? "").trim().toLowerCase();
  const activeTypeFilter = params.typeFilter ?? "all";
  const orders =
    activeTypeFilter !== "all" && activeTypeFilter !== "program"
      ? []
      : allOrders.filter((order) => {
          if (!normalizedQuery) {
            return true;
          }
          return [
            order.id,
            order.name,
            order.instructions,
            order.triggerHint,
            order.proposalKind,
            order.status,
          ]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(normalizedQuery));
        });
  const draft = params.state.draft;
  const kindLabel = (kind: StandingOrderRecord["proposalKind"]) =>
    kind === "workflow" ? "Workflow proposal" : "Task proposal";
  const statusTone = (status: StandingOrderRecord["status"]) =>
    status === "enabled" ? "ok" : "muted";
  const shouldRenderPanel =
    Boolean(draft) || Boolean(params.state.error) || params.state.loading || orders.length > 0;
  if (!shouldRenderPanel) {
    return nothing;
  }
  return html`
    ${
      draft
        ? html`
            <div class="agent-task-modal-backdrop" @click=${() => params.onCancel?.()}>
              <div
                class="agent-task-modal-panel"
                @click=${(event: Event) => event.stopPropagation()}
              >
                <div class="agent-task-modal-head">
                  <div>
                    <div class="agent-task-modal-title">
                      ${icons.listChecks} ${draft.id ? "Edit program" : "Create program"}
                    </div>
                    <div class="muted">
                      Programs propose Tasks or Workflows. They never grant tools, wallets,
                      mining, marketplace, or service authority.
                    </div>
                  </div>
                  <button
                    class="agent-task-icon-button"
                    type="button"
                    aria-label="Close program editor"
                    @click=${() => params.onCancel?.()}
                  >
                    ${icons.x}
                  </button>
                </div>
                <div class="webhook-trigger-editor">
                  <label class="field">
                    <span>Name</span>
                    <input
                      .value=${draft.name}
                      @input=${(event: Event) =>
                        params.onPatch?.({ name: (event.target as HTMLInputElement).value })}
                    />
                    <small class="muted">
                      Shown in Agent &gt; Tasks as the saved Program definition.
                    </small>
                  </label>
                  <label class="field">
                    <span>Status</span>
                    <select
                      .value=${draft.status}
                      @change=${(event: Event) =>
                        params.onPatch?.({
                          status: (event.target as HTMLSelectElement)
                            .value as StandingOrderDraft["status"],
                        })}
                    >
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                    <small class="muted">
                      Disabled Programs stay saved but cannot propose new work.
                    </small>
                  </label>
                  <label class="field">
                    <span>Proposal</span>
                    <select
                      .value=${draft.proposalKind}
                      @change=${(event: Event) =>
                        params.onPatch?.({
                          proposalKind: (event.target as HTMLSelectElement)
                            .value as StandingOrderDraft["proposalKind"],
                        })}
                    >
                      <option value="task">Task</option>
                      <option value="workflow">Workflow</option>
                    </select>
                    <small class="muted">
                      Proposal type only. The proposal still waits for operator review.
                    </small>
                  </label>
                  <label class="field">
                    <span>Trigger hint</span>
                    <input
                      .value=${draft.triggerHint}
                      placeholder="When should this propose work?"
                      @input=${(event: Event) =>
                        params.onPatch?.({
                          triggerHint: (event.target as HTMLInputElement).value,
                        })}
                    />
                    <small class="muted">
                      Human hint such as weekdays 08:00 or when orders change; not a schedule.
                    </small>
                  </label>
                  <label class="field webhook-trigger-field--wide">
                    <span>Instructions</span>
                    <textarea
                      rows="5"
                      .value=${draft.instructions}
                      @input=${(event: Event) =>
                        params.onPatch?.({
                          instructions: (event.target as HTMLTextAreaElement).value,
                        })}
                    ></textarea>
                    <small class="muted">
                      Standing instruction used to create a blocked proposal record. It does not
                      run automatically.
                    </small>
                  </label>
                  <div class="muted webhook-trigger-field--wide">
                    Save stores the Program for this Agent. Propose work creates one blocked
                    run-history proposal for review; it does not create or run a Task by itself.
                  </div>
                  <div class="webhook-trigger-editor-actions">
                    <button
                      class="btn btn--sm primary"
                      type="button"
                      ?disabled=${params.state.busy}
                      @click=${() => params.onSave?.(params.agentId)}
                    >
                      ${draft.id ? "Save changes" : "Save program"}
                    </button>
                    <button class="btn btn--sm" type="button" @click=${() => params.onCancel?.()}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `
        : nothing
    }
    ${
      params.state.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${params.state.error}</div>`
        : nothing
    }
    ${
      params.state.loading
        ? html`
            <div class="muted" style="margin-top: 12px">Loading programs...</div>
          `
        : orders.length === 0
          ? nothing
          : html`
              <div class="agent-task-list">
                ${repeat(
                  orders,
                  (order) => order.id,
                  (order) => html`
                    <div class="webhook-trigger-row">
                      <span class=${`task-status-dot task-status-dot--${statusTone(order.status)}`}></span>
                      <div class="webhook-trigger-main">
                        <strong>${order.name}</strong>
                        <span class="muted">
                          ${kindLabel(order.proposalKind)}
                          ${order.triggerHint ? ` · ${order.triggerHint}` : ""}
                          ${
                            order.lastProposedAt
                              ? ` · proposed ${formatRelativeTimestamp(order.lastProposedAt)}`
                              : ""
                          }
                        </span>
                      </div>
                      <div class="agent-task-actions">
                        ${renderTaskIconButton({
                          label: "Propose work",
                          icon: "play",
                          disabled: params.state.busy || order.status !== "enabled",
                          onClick: () => params.onPropose?.(order),
                        })}
                        ${renderTaskIconButton({
                          label: "Edit program",
                          icon: "edit",
                          disabled: params.state.busy,
                          onClick: () => params.onEdit?.(order),
                        })}
                        ${renderTaskIconButton({
                          label: "Delete program",
                          icon: "x",
                          danger: true,
                          disabled: params.state.busy,
                          onClick: () => params.onRemove?.(order),
                        })}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
    }
  `;
}

function toChannelsProps(params: Parameters<typeof renderAgentChannels>[0]): ChannelsProps {
  const noop = () => undefined;
  return {
    connected: params.connected,
    loading: params.loading,
    snapshot: params.snapshot,
    agentsList: params.agentsList,
    lastError: params.error,
    notice: null,
    lastSuccessAt: params.lastSuccess,
    channelRuntimeBusy: params.channelRuntimeBusy,
    channelQrLogin: {},
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: params.configSchema,
    configSchemaLoading: params.configSchemaLoading,
    configForm: params.configForm,
    configUiHints: params.configUiHints,
    configSaving: params.configSaving,
    configFormDirty: params.configDirty,
    activeView: params.activeView ?? "accounts",
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    onViewChange: params.onViewChange ?? noop,
    onRefresh: () => params.onRefresh(),
    onChannelEnable: params.onChannelEnable,
    onChannelStart: params.onChannelStart,
    onChannelStop: params.onChannelStop,
    onChannelInstall: noop,
    onChannelLogout: params.onChannelLogout,
    onChannelQrStart: noop,
    onChannelQrWait: noop,
    onWhatsAppStart: noop,
    onWhatsAppWait: noop,
    onWhatsAppLogout: noop,
    onConfigPatch: params.onConfigPatch,
    onConfigRemove: params.onConfigRemove,
    onConfigSave: params.onConfigSave,
    onConfigReload: params.onConfigReload,
    onNostrProfileEdit: noop,
    onNostrProfileCancel: noop,
    onNostrProfileFieldChange: noop,
    onNostrProfileSave: noop,
    onNostrProfileImport: noop,
    onNostrProfileToggleAdvanced: noop,
  };
}

export function renderAgentChannels(params: {
  context: AgentContext;
  configForm: Record<string, unknown> | null;
  configSchema: unknown;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  snapshot: ChannelsStatusSnapshot | null;
  connected: boolean;
  loading: boolean;
  error: string | null;
  lastSuccess: number | null;
  channelRuntimeBusy: Record<string, boolean>;
  agentId: string;
  agentsList: AgentsListResult | null;
  configSaving: boolean;
  configDirty: boolean;
  activeView?: import("./channels.types.ts").ChannelsView;
  onViewChange?: (view: import("./channels.types.ts").ChannelsView) => void;
  onRefresh: () => void;
  onChannelEnable: (channelId: string) => void;
  onChannelStart: (channelId: string, accountId?: string) => void;
  onChannelStop: (channelId: string, accountId?: string) => void;
  onChannelLogout: (channelId: string, accountId?: string) => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onConfigSave: () => void;
  onConfigReload: () => void;
  onOpenChannels: () => void;
}) {
  const channelProps = toChannelsProps(params);
  return renderChannels(channelProps, { embedded: true, showDebug: false });
}

function taskLedgerTone(status: TaskRecord["status"]): "ok" | "warn" | "danger" | "info" | "muted" {
  if (status === "succeeded") {
    return "ok";
  }
  if (status === "queued" || status === "running") {
    return "info";
  }
  if (status === "failed" || status === "timed_out" || status === "lost" || status === "blocked") {
    return "danger";
  }
  if (status === "cancelled" || status === "skipped") {
    return "warn";
  }
  return "muted";
}

function isTaskLedgerTerminal(task: TaskRecord): boolean {
  return task.status !== "queued" && task.status !== "running";
}

function taskHasBlockedWorkflowApproval(task: TaskRecord): boolean {
  return (
    task.taskKind === "workflow" &&
    task.status === "blocked" &&
    Boolean(task.steps?.some((step) => step.status === "blocked"))
  );
}

function canApproveTaskLedgerWorkflow(task: TaskRecord): boolean {
  return taskHasBlockedWorkflowApproval(task) && !isTaskLedgerViewOnlySource(task);
}

function canRejectTaskLedgerWorkflow(task: TaskRecord): boolean {
  return (
    canApproveTaskLedgerWorkflow(task) &&
    task.metadata?.workflowGraphVersion === 2 &&
    Boolean(task.metadata?.blockedNodeId)
  );
}

type TaskLedgerSourceFilter = TaskRecord["source"] | "all";
type TaskActivityTypeFilter =
  | "all"
  | "task"
  | "trigger"
  | "workflow"
  | "graph"
  | "program"
  | "history";
type TaskLedgerStatusFilter = "all" | "active" | "terminal" | TaskRecord["status"];

const TASK_LEDGER_SOURCE_LABELS: Record<TaskRecord["source"], string> = {
  cron: "Tasks",
  webhook: "Webhooks",
  subagent: "ACP",
  channel: "Channels",
  CLI: "CLI",
  media: "Media",
  wallet: "Wallet",
  marketplace: "Marketplace",
  mining: "Mining",
};
const TASK_LEDGER_SOURCE_KEYS = new Set(Object.keys(TASK_LEDGER_SOURCE_LABELS));
const AGENT_TASK_WORKBENCH_HELP =
  "Tasks is the Agent workbench. Saved tasks, triggers, workflows, and graph workflows describe what can run. Run history is available from the Run history filter and Logs.";
const WEBHOOK_TRIGGER_HELP =
  "Webhook triggers belong to the selected Agent. A trigger can run an Agent prompt, a saved workflow/graph, or a heartbeat wake. Run history belongs in Logs.";

function renderAgentTaskHelp(text: string, label = "Task help") {
  return html`
    <span
      class="agent-task-help"
      role="img"
      tabindex="0"
      aria-label=${label}
      title=${text}
      data-tooltip=${text}
      @click=${(event: Event) => event.stopPropagation()}
    >
      ${icons.info}
    </span>
  `;
}

function taskLedgerSourceLabel(source: TaskRecord["source"]): string {
  return TASK_LEDGER_SOURCE_LABELS[source] ?? source;
}

function formatTaskLedgerSource(task: TaskRecord): string {
  const source = taskLedgerSourceLabel(task.source);
  return task.runtime === task.source ? source : `${source} · ${task.runtime}`;
}

function taskMetadataString(task: TaskRecord, key: string): string {
  const value = task.metadata?.[key];
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function taskRecordValueString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function taskMetadataRecord(task: TaskRecord, key: string): Record<string, unknown> | null {
  const value = task.metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourceTaskFromWorkflowTask(task: TaskRecord): TaskRecord | null {
  const sourceTask = taskMetadataRecord(task, "sourceTask");
  const taskId = sourceTask
    ? taskRecordValueString(sourceTask, "taskId")
    : taskMetadataString(task, "sourceTaskId");
  const source = sourceTask
    ? taskRecordValueString(sourceTask, "source")
    : taskMetadataString(task, "sourceTaskSource");
  if (!taskId || !TASK_LEDGER_SOURCE_KEYS.has(source)) {
    return null;
  }
  const runtime =
    (sourceTask
      ? taskRecordValueString(sourceTask, "runtime")
      : taskMetadataString(task, "sourceTaskRuntime")) || (source === "CLI" ? "cli" : source);
  const rawMetadata = sourceTask?.metadata;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const runId = sourceTask
    ? taskRecordValueString(sourceTask, "runId")
    : taskMetadataString(task, "sourceTaskRunId");
  const taskKind = sourceTask
    ? taskRecordValueString(sourceTask, "taskKind")
    : taskMetadataString(task, "sourceTaskKind");
  const sourceId = sourceTask ? taskRecordValueString(sourceTask, "sourceId") : "";
  const rootTaskId = sourceTask ? taskRecordValueString(sourceTask, "rootTaskId") : "";
  const parentTaskId = sourceTask ? taskRecordValueString(sourceTask, "parentTaskId") : "";
  const correlationId = sourceTask ? taskRecordValueString(sourceTask, "correlationId") : "";
  const definitionId = sourceTask ? taskRecordValueString(sourceTask, "definitionId") : "";
  const definitionKind = sourceTask ? taskRecordValueString(sourceTask, "definitionKind") : "";
  const workflowRunId = sourceTask ? taskRecordValueString(sourceTask, "workflowRunId") : "";
  const workflowNodeId = sourceTask ? taskRecordValueString(sourceTask, "workflowNodeId") : "";
  const agentId = sourceTask ? taskRecordValueString(sourceTask, "agentId") : (task.agentId ?? "");
  const sessionKey = sourceTask ? taskRecordValueString(sourceTask, "sessionKey") : "";
  const requesterSessionKey = sourceTask
    ? taskRecordValueString(sourceTask, "requesterSessionKey")
    : "";
  const channel = sourceTask ? taskRecordValueString(sourceTask, "channel") : "";
  return {
    taskId,
    ...(runId ? { runId } : {}),
    source: source as TaskRecord["source"],
    runtime: runtime as TaskRecord["runtime"],
    ...(taskKind ? { taskKind } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(rootTaskId ? { rootTaskId } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(definitionId ? { definitionId } : {}),
    ...(definitionKind ? { definitionKind: definitionKind as TaskRecord["definitionKind"] } : {}),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(workflowNodeId ? { workflowNodeId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(requesterSessionKey ? { requesterSessionKey } : {}),
    ...(channel ? { channel } : {}),
    task: (sourceTask ? taskRecordValueString(sourceTask, "task") : "") || "Source task",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    metadata,
  };
}

function flowMetadataString(flow: TaskFlowRecord, key: string): string {
  const value = flow.metadata?.[key];
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function flowMetadataRecord(flow: TaskFlowRecord, key: string): Record<string, unknown> | null {
  const value = flow.metadata?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourceTaskFromWorkflowFlow(flow: TaskFlowRecord): TaskRecord | null {
  const sourceTask = flowMetadataRecord(flow, "sourceTask");
  const taskId = sourceTask
    ? taskRecordValueString(sourceTask, "taskId")
    : flowMetadataString(flow, "sourceTaskId");
  const source = sourceTask
    ? taskRecordValueString(sourceTask, "source")
    : flowMetadataString(flow, "sourceTaskSource");
  if (!taskId || !TASK_LEDGER_SOURCE_KEYS.has(source)) {
    return null;
  }
  const runtime =
    (sourceTask
      ? taskRecordValueString(sourceTask, "runtime")
      : flowMetadataString(flow, "sourceTaskRuntime")) || (source === "CLI" ? "cli" : source);
  const rawMetadata = sourceTask?.metadata;
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};
  const runId = sourceTask
    ? taskRecordValueString(sourceTask, "runId")
    : flowMetadataString(flow, "sourceTaskRunId");
  const taskKind = sourceTask
    ? taskRecordValueString(sourceTask, "taskKind")
    : flowMetadataString(flow, "sourceTaskKind");
  const sourceId = sourceTask ? taskRecordValueString(sourceTask, "sourceId") : "";
  const rootTaskId = sourceTask ? taskRecordValueString(sourceTask, "rootTaskId") : "";
  const parentTaskId = sourceTask ? taskRecordValueString(sourceTask, "parentTaskId") : "";
  const correlationId = sourceTask ? taskRecordValueString(sourceTask, "correlationId") : "";
  const definitionId = sourceTask ? taskRecordValueString(sourceTask, "definitionId") : "";
  const definitionKind = sourceTask ? taskRecordValueString(sourceTask, "definitionKind") : "";
  const workflowRunId = sourceTask ? taskRecordValueString(sourceTask, "workflowRunId") : "";
  const workflowNodeId = sourceTask ? taskRecordValueString(sourceTask, "workflowNodeId") : "";
  const agentId = sourceTask ? taskRecordValueString(sourceTask, "agentId") : (flow.agentId ?? "");
  const sessionKey = sourceTask ? taskRecordValueString(sourceTask, "sessionKey") : "";
  const requesterSessionKey = sourceTask
    ? taskRecordValueString(sourceTask, "requesterSessionKey")
    : "";
  const channel = sourceTask ? taskRecordValueString(sourceTask, "channel") : "";
  return {
    taskId,
    ...(runId ? { runId } : {}),
    source: source as TaskRecord["source"],
    runtime: runtime as TaskRecord["runtime"],
    ...(taskKind ? { taskKind } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(rootTaskId ? { rootTaskId } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(definitionId ? { definitionId } : {}),
    ...(definitionKind ? { definitionKind: definitionKind as TaskRecord["definitionKind"] } : {}),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(workflowNodeId ? { workflowNodeId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(requesterSessionKey ? { requesterSessionKey } : {}),
    ...(channel ? { channel } : {}),
    task: (sourceTask ? taskRecordValueString(sourceTask, "task") : "") || "Source task",
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    metadata,
  };
}

function taskFromWorkflowFlow(flow: TaskFlowRecord): TaskRecord | null {
  const taskId = flow.blockedTaskId ?? flow.currentTaskId ?? flow.taskIds.at(-1);
  if (!taskId) {
    return null;
  }
  const source = flowMetadataString(flow, "source");
  const runtime = flowMetadataString(flow, "runtime");
  const taskKind = flowMetadataString(flow, "taskKind") || "workflow";
  const status = flow.status === "waiting" ? "running" : flow.status;
  return {
    taskId,
    source: TASK_LEDGER_SOURCE_KEYS.has(source) ? (source as TaskRecord["source"]) : "CLI",
    runtime: (runtime || "cli") as TaskRecord["runtime"],
    ...(taskKind ? { taskKind } : {}),
    ...(flowMetadataString(flow, "rootTaskId")
      ? { rootTaskId: flowMetadataString(flow, "rootTaskId") }
      : {}),
    ...(flowMetadataString(flow, "parentTaskId")
      ? { parentTaskId: flowMetadataString(flow, "parentTaskId") }
      : {}),
    ...(flowMetadataString(flow, "correlationId")
      ? { correlationId: flowMetadataString(flow, "correlationId") }
      : {}),
    ...(flow.definitionId ? { definitionId: flow.definitionId } : {}),
    ...(flowMetadataString(flow, "definitionKind")
      ? {
          definitionKind: flowMetadataString(
            flow,
            "definitionKind",
          ) as TaskRecord["definitionKind"],
        }
      : {}),
    ...(flowMetadataString(flow, "workflowRunId")
      ? { workflowRunId: flowMetadataString(flow, "workflowRunId") }
      : {}),
    ...(flowMetadataString(flow, "workflowNodeId")
      ? { workflowNodeId: flowMetadataString(flow, "workflowNodeId") }
      : {}),
    task: flow.currentStep ? `${flow.goal}: ${flow.currentStep}` : flow.goal,
    status: status,
    deliveryStatus: "not_applicable",
    notifyPolicy: flow.notifyPolicy,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    metadata: {
      workflowFlowId: flow.flowId,
      ...(flow.definitionId ? { workflowDefinitionId: flow.definitionId } : {}),
    },
  };
}

function taskLedgerKindLabel(task: TaskRecord): string {
  if (task.taskKind === "acp-spawn" || task.runtime === "acp" || task.source === "subagent") {
    return "ACP spawn";
  }
  if (task.source === "webhook") {
    return "Webhook trigger";
  }
  if (task.taskKind === "workflow") {
    return "Workflow";
  }
  if (task.source === "channel") {
    return "Channel task";
  }
  if (task.source === "media") {
    return "Media generation";
  }
  if (task.source === "wallet") {
    return task.taskKind === "wallet_approval" ? "Wallet approval" : "Wallet task";
  }
  if (task.source === "marketplace") {
    if (task.taskKind === "marketplace_request") {
      return "Marketplace request";
    }
    if (task.taskKind === "marketplace_order") {
      return "Marketplace order";
    }
    return "Marketplace task";
  }
  if (task.source === "mining") {
    if (task.taskKind === "mining_readiness") {
      return "Mining readiness";
    }
    if (task.taskKind === "mining_control") {
      return "Mining control";
    }
    if (task.taskKind === "mining_capital") {
      return "Mining capital";
    }
    if (task.taskKind === "mining_cycle") {
      return "Mining cycle";
    }
    if (task.taskKind === "mining_claim") {
      return "Mining claim";
    }
    if (task.taskKind === "mining_recovery") {
      return "Mining recovery";
    }
    return "Mining task";
  }
  if (task.source === "cron") {
    return "Scheduled task";
  }
  if (task.source === "CLI") {
    return "CLI task";
  }
  return task.taskKind?.trim() || formatTaskLedgerSource(task);
}

function formatTaskLedgerDetail(task: TaskRecord): string {
  const terminal =
    task.terminalSummary?.trim() || task.error?.trim() || task.delivery?.error?.trim();
  if (isTaskLedgerTerminal(task)) {
    return terminal || task.progressSummary?.trim() || "";
  }
  return task.progressSummary?.trim() || terminal || "";
}

function compactTaskLedgerMeta(task: TaskRecord): string {
  const parts = [
    taskLedgerKindLabel(task),
    task.provider && task.model ? `${task.provider}/${task.model}` : (task.model ?? task.provider),
    task.deliveryStatus !== "not_applicable" ? task.deliveryStatus.replace("_", " ") : "",
    task.notifyPolicy !== "silent" ? `notify ${task.notifyPolicy.replace("_", " ")}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function taskLedgerSessionKey(task: TaskRecord): string {
  return (
    task.sessionKey?.trim() ||
    taskMetadataString(task, "childSessionKey") ||
    task.requesterSessionKey?.trim() ||
    ""
  );
}

function formatTaskLedgerDelivery(task: TaskRecord): string {
  const parts = [
    task.deliveryStatus.replace("_", " "),
    task.delivery?.channel,
    task.delivery?.target,
    task.delivery?.messageId ? `message ${task.delivery.messageId}` : "",
    task.delivery?.deliveredAt ? `at ${formatRelativeTimestamp(task.delivery.deliveredAt)}` : "",
    task.delivery?.error ? `error ${task.delivery.error}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatTaskUsage(task: TaskRecord): string {
  const usage = task.usage;
  if (!usage) {
    return "not recorded";
  }
  const parts = [
    usage.totalTokens != null ? `${usage.totalTokens} total` : "",
    usage.inputTokens != null ? `${usage.inputTokens} in` : "",
    usage.outputTokens != null ? `${usage.outputTokens} out` : "",
    usage.cacheReadTokens != null ? `${usage.cacheReadTokens} cache read` : "",
    usage.cacheWriteTokens != null ? `${usage.cacheWriteTokens} cache write` : "",
    usage.costUsd != null
      ? `$${usage.costUsd.toFixed(usage.costUsd >= 1 ? 2 : 4)}`
      : usage.unpriced
        ? "unpriced"
        : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "not recorded";
}

function formatTaskTimeline(task: TaskRecord): string {
  const parts = [
    `created ${formatRelativeTimestamp(task.createdAt)}`,
    task.startedAt ? `started ${formatRelativeTimestamp(task.startedAt)}` : "",
    task.endedAt ? `ended ${formatRelativeTimestamp(task.endedAt)}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function taskMetadataList(task: TaskRecord, key: string): string[] {
  const value = task.metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string" && entry.trim()) {
        return entry.trim();
      }
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return String(entry);
      }
      return "";
    })
    .filter(Boolean);
}

function taskMetadataRecordList(task: TaskRecord, key: string): Array<Record<string, unknown>> {
  const value = task.metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function taskCoordinationEvidence(task: TaskRecord): Array<Record<string, unknown>> {
  return taskMetadataRecordList(task, "coordinationEvidence").filter(
    (entry) => typeof entry.agentId === "string" && typeof entry.status === "string",
  );
}

function coordinationEvidenceString(entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatCoordinationEvidenceSummary(evidence: Array<Record<string, unknown>>): string {
  if (evidence.length === 0) {
    return "";
  }
  const statuses = new Map<string, number>();
  for (const entry of evidence) {
    const status = coordinationEvidenceString(entry, "status") || "unknown";
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
  return [
    `${evidence.length} helper Agent run${evidence.length === 1 ? "" : "s"}`,
    ...Array.from(statuses.entries()).map(([status, count]) => `${count} ${status}`),
  ].join(" · ");
}

function coordinationEvidenceTone(status: string): "ok" | "warn" | "danger" | "info" | "muted" {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "succeeded" || normalized === "success") {
    return "ok";
  }
  if (normalized === "running" || normalized === "queued" || normalized === "pending") {
    return "info";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "blocked") {
    return "danger";
  }
  if (normalized === "cancelled" || normalized === "skipped") {
    return "warn";
  }
  return "muted";
}

function renderTaskCoordinationChainRows(task: TaskRecord) {
  const evidence = taskCoordinationEvidence(task);
  if (evidence.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-task-helper-chain" aria-label="Coordination helper Agent runs">
      ${evidence.map((entry) => {
        const agentId = coordinationEvidenceString(entry, "agentId");
        const status = coordinationEvidenceString(entry, "status") || "recorded";
        const mode = coordinationEvidenceString(entry, "mode") || "helper";
        const childSessionKey = coordinationEvidenceString(entry, "childSessionKey");
        const runId = coordinationEvidenceString(entry, "runId");
        const summary = coordinationEvidenceString(entry, "summary");
        const error = coordinationEvidenceString(entry, "error");
        return html`
          <div class="agent-task-helper-row">
            <span class="agent-task-helper-row__rail"></span>
            <span class=${`task-status-dot task-status-dot--${coordinationEvidenceTone(status)}`}></span>
            <div class="agent-task-helper-row__main">
              <strong>Helper Agent · ${agentId}</strong>
              <span class="muted">
                ${[status, mode, summary || error].filter(Boolean).join(" · ")}
              </span>
            </div>
            ${
              childSessionKey || runId
                ? html`
                    <span class="mono muted" title=${[childSessionKey, runId].filter(Boolean).join(" · ")}>
                      ${compactTaskId(childSessionKey || runId)}
                    </span>
                  `
                : nothing
            }
          </div>
        `;
      })}
    </div>
  `;
}

function renderTaskCoordinationEvidence(task: TaskRecord) {
  const evidence = taskCoordinationEvidence(task);
  if (evidence.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-task-field agent-task-field--wide agent-task-coordination-evidence">
      <div class="agent-task-field-label">Coordination evidence</div>
      <div class="agent-task-coordination-list">
        ${evidence.map((entry) => {
          const agentId = coordinationEvidenceString(entry, "agentId");
          const status = coordinationEvidenceString(entry, "status");
          const mode = coordinationEvidenceString(entry, "mode");
          const childSessionKey = coordinationEvidenceString(entry, "childSessionKey");
          const runId = coordinationEvidenceString(entry, "runId");
          const summary = coordinationEvidenceString(entry, "summary");
          const error = coordinationEvidenceString(entry, "error");
          return html`
            <div class="agent-task-coordination-row">
              <span class=${`task-status-dot task-status-dot--${coordinationEvidenceTone(status)}`}></span>
              <strong>${agentId}</strong>
              <span>${[status, mode].filter(Boolean).join(" · ")}</span>
              ${
                childSessionKey || runId
                  ? html`
                      <span class="mono muted" title=${[childSessionKey, runId].filter(Boolean).join(" · ")}>
                        ${compactTaskId(childSessionKey || runId)}
                      </span>
                    `
                  : nothing
              }
              ${summary || error ? html`<span class="muted">${summary || error}</span>` : nothing}
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function taskMetadataCompactObject(task: TaskRecord, key: string): string {
  const value = task.metadata?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const parts = Object.entries(value)
    .filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
    .map(([entryKey, entry]) => `${entryKey} ${String(entry)}`);
  return parts.join(" · ");
}

function taskMetadataBoolLabel(task: TaskRecord, key: string): string {
  const value = task.metadata?.[key];
  return typeof value === "boolean" ? (value ? "yes" : "no") : taskMetadataString(task, key);
}

function formatTaskRecordChecks(
  checks: Array<Record<string, unknown>>,
  opts: { statusKey?: string; okKey?: string } = {},
): string {
  if (checks.length === 0) {
    return "";
  }
  const statusKey = opts.statusKey ?? "status";
  const okKey = opts.okKey ?? "ok";
  const failed = checks.filter(
    (check) => check[statusKey] === "fail" || check[okKey] === false,
  ).length;
  const passed = checks.filter(
    (check) => check[statusKey] === "pass" || check[okKey] === true,
  ).length;
  const firstProblem = checks.find(
    (check) => check[statusKey] === "fail" || check[okKey] === false,
  );
  const problemDetail =
    typeof firstProblem?.detail === "string" && firstProblem.detail.trim()
      ? firstProblem.detail.trim()
      : typeof firstProblem?.remediation === "string" && firstProblem.remediation.trim()
        ? firstProblem.remediation.trim()
        : "";
  return [
    `${checks.length} check${checks.length === 1 ? "" : "s"}`,
    passed ? `${passed} passed` : "",
    failed ? `${failed} failed` : "",
    problemDetail,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatTaskActionSupport(task: TaskRecord, jobs: CronJob[] = []): string {
  const actions = [];
  const sourceOpenLabel = taskLedgerSourceOpenLabel(task, jobs);
  const workflowReviewLabel = taskLedgerWorkflowReviewLabel(task);
  if (sourceOpenLabel) {
    actions.push(sourceOpenLabel.replace(/^Open /, "open "));
  }
  if (workflowReviewLabel) {
    actions.push(workflowReviewLabel.replace(/^Review /, "review "));
  }
  if (canCancelTaskLedgerTask(task, jobs)) {
    actions.push("cancel");
  }
  if (canApproveTaskLedgerWorkflow(task)) {
    actions.push("approve/resume");
  }
  if (canRejectTaskLedgerWorkflow(task)) {
    actions.push("reject");
  }
  if (canRetryTaskLedgerTask(task, jobs)) {
    actions.push(task.source === "webhook" ? "replay" : "retry");
  }
  if (canNotifyTaskLedgerTask(task)) {
    actions.push(`notify ${task.notifyPolicy.replace("_", " ")}`);
  }
  return actions.length ? actions.join(" · ") : "view only";
}

function isTaskLedgerViewOnlySource(task: TaskRecord): boolean {
  return task.source === "wallet" || task.source === "marketplace" || task.source === "mining";
}

function taskCronDefinitionId(task: TaskRecord): string {
  if (task.source !== "cron") {
    return "";
  }
  return task.definitionId?.trim() || task.sourceId?.trim() || "";
}

function taskCronDefinitionAvailable(task: TaskRecord, jobs: CronJob[]): boolean {
  const definitionId = taskCronDefinitionId(task);
  return Boolean(definitionId && jobs.some((job) => job.id === definitionId));
}

function taskLedgerSourceOwnedChipLabel(task: TaskRecord): string {
  if (task.source === "wallet") {
    return "Wallet controls";
  }
  if (task.source === "marketplace") {
    return "Marketplace controls";
  }
  if (task.source === "mining") {
    return "Mining controls";
  }
  return "Source controls";
}

function taskLedgerSourceOwnershipNote(task: TaskRecord): string {
  if (task.source === "cron") {
    return "Scheduled task definitions control future runs. History rows are run records; retry/cancel applies only when the original task definition still exists.";
  }
  if (task.source === "wallet") {
    return "Wallet signing, passkey approval, rejection, and broadcast stay in Wallets.";
  }
  if (task.source === "marketplace") {
    return "Marketplace settlement, delivery, receipts, and dispute controls stay in Marketplace.";
  }
  if (task.source === "mining") {
    return "Mining start/stop, capital, cycle, commit/reveal, claim, and recovery controls stay in Mining.";
  }
  return "";
}

function canCancelTaskLedgerTask(task: TaskRecord, jobs: CronJob[] = []): boolean {
  if (task.source === "cron") {
    return (
      Boolean(task.runId) &&
      taskCronDefinitionAvailable(task, jobs) &&
      (task.status === "queued" || task.status === "running")
    );
  }
  return (
    (task.status === "queued" || task.status === "running") && !isTaskLedgerViewOnlySource(task)
  );
}

function canRetryTaskLedgerTask(task: TaskRecord, jobs: CronJob[] = []): boolean {
  if (task.source === "cron") {
    return (
      Boolean(task.runId) &&
      taskCronDefinitionAvailable(task, jobs) &&
      ["failed", "timed_out", "lost", "blocked", "cancelled"].includes(task.status)
    );
  }
  return (
    !isTaskLedgerViewOnlySource(task) &&
    task.taskKind === "workflow" &&
    ["failed", "timed_out", "lost", "blocked", "cancelled"].includes(task.status)
  );
}

function canNotifyTaskLedgerTask(task: TaskRecord): boolean {
  return task.source !== "cron" && !isTaskLedgerViewOnlySource(task);
}

function taskLedgerSourceControlNote(task: TaskRecord, jobs: CronJob[] = []): string {
  if (task.source === "wallet") {
    return "Review, passkey approval, reject, and broadcast stay in Wallets. Use Open Wallets for control; this row is run history.";
  }
  if (task.source === "marketplace") {
    return "Offer, payment, delivery, receipt, and dispute controls stay in Marketplace. Use Open Marketplace for control; this row is run history.";
  }
  if (task.source === "mining") {
    return "Start/stop, capital, commit/reveal, claim, and recovery controls stay in Mining.";
  }
  if (task.source === "channel") {
    return "Channel delivery state is updated by the dispatcher. Open the task session to inspect context; retry is available only for recorded workflows.";
  }
  if (task.source === "media") {
    return "Media artifacts are listed here. Open the media session for context; approval, hold, retry, and delivery stay with the media surface.";
  }
  if (task.source === "webhook") {
    return "Webhook payload and trigger state stay in webhook triggers. Failed workflow records can be replayed safely from Logs.";
  }
  if (task.source === "cron") {
    if (!taskCronDefinitionId(task)) {
      return "This scheduled-task run is missing its definition id, so it is history only.";
    }
    if (!taskCronDefinitionAvailable(task, jobs)) {
      return "This scheduled-task definition no longer exists. This row is history only.";
    }
  }
  return "";
}

function taskLedgerWorkflowReviewLabel(task: TaskRecord): string {
  void task;
  return "";
}

function taskLedgerSourceOpenLabel(task: TaskRecord, jobs: CronJob[] = []): string {
  if (task.source === "cron") {
    return taskCronDefinitionAvailable(task, jobs) ? "Open scheduled task" : "";
  }
  if (task.source === "wallet") {
    return taskMetadataString(task, "approvalId") || task.taskKind === "wallet_approval"
      ? "Open wallet approval"
      : "Open Wallets";
  }
  if (task.source === "marketplace") {
    if (taskMetadataString(task, "orderId") || task.taskKind === "marketplace_order") {
      return "Open marketplace order";
    }
    if (taskMetadataString(task, "requestId") || task.taskKind === "marketplace_request") {
      return "Open marketplace request";
    }
    if (taskMetadataString(task, "offerId")) {
      return "Open marketplace offer";
    }
    return "Open Marketplace";
  }
  if (task.source === "mining") {
    if (
      taskMetadataString(task, "cycleId") ||
      taskMetadataString(task, "currentCycleId") ||
      taskMetadataString(task, "epochId") ||
      task.taskKind === "mining_cycle"
    ) {
      return "Open mining cycle";
    }
    if (taskMetadataString(task, "action") || task.taskKind?.startsWith("mining_")) {
      return "Open mining action";
    }
    return "Open Mining";
  }
  if (task.source === "channel") {
    return taskMetadataString(task, "messageId") || taskMetadataString(task, "threadId")
      ? "Open channel message"
      : "Open Agent Channels";
  }
  if (task.source === "media") {
    return taskLedgerSessionKey(task) ? "Open media session" : "Open media task";
  }
  if (task.source === "webhook") {
    return taskMetadataString(task, "triggerId") || task.sourceId
      ? "Open webhook trigger"
      : "Open webhook triggers";
  }
  if (task.source === "subagent") {
    return taskLedgerSessionKey(task) ? "Open ACP session" : "Open ACP tasks";
  }
  if (task.source === "CLI") {
    return task.taskKind === "workflow" ? "Open workflow graph" : "Open CLI task";
  }
  return "";
}

function taskLedgerCancelLabel(task: TaskRecord): string {
  if (task.taskKind === "workflow") {
    return "Cancel workflow";
  }
  return "Cancel task";
}

function taskLedgerRetryLabel(task: TaskRecord): string {
  if (task.source === "webhook") {
    return "Replay webhook workflow";
  }
  if (task.source === "channel") {
    return "Retry channel workflow";
  }
  if (task.source === "media") {
    return "Retry media workflow";
  }
  if (task.source === "cron") {
    return "Retry scheduled task";
  }
  if (task.taskKind === "workflow") {
    return "Retry workflow";
  }
  return "Retry task";
}

function taskLedgerNotifyLabel(task: TaskRecord): string {
  if (task.source === "channel") {
    return "Notify channel state changes";
  }
  if (task.source === "media") {
    return "Notify media state changes";
  }
  if (task.source === "webhook") {
    return "Notify webhook state changes";
  }
  return "Notify on state changes";
}

function renderTaskLedgerSourceActions(params: {
  agentId: string;
  task: TaskRecord;
  sourceTask: TaskRecord | null;
  sourceOpenLabel: string;
  workflowReviewLabel: string;
  busy: boolean;
  onOpenSource?: (task: TaskRecord) => void;
  onWorkflowReview?: (agentId: string, task: TaskRecord) => void;
}) {
  if (!params.sourceOpenLabel && !params.workflowReviewLabel && !params.sourceTask) {
    return nothing;
  }
  return html`
    <div class="agent-task-source-actions">
      <div class="agent-task-source-actions__title">Source actions</div>
      <div class="agent-task-source-actions__buttons">
        ${
          params.sourceOpenLabel
            ? html`
                <button
                  class="btn btn--sm"
                  type="button"
                  title=${params.sourceOpenLabel}
                  aria-label=${params.sourceOpenLabel}
                  ?disabled=${params.busy || !params.onOpenSource}
                  @click=${() => params.onOpenSource?.(params.task)}
                >
                  ${icons.externalLink} <span>Open source</span>
                </button>
              `
            : nothing
        }
        ${
          params.workflowReviewLabel
            ? html`
                <button
                  class="btn btn--sm"
                  type="button"
                  title=${params.workflowReviewLabel}
                  aria-label=${params.workflowReviewLabel}
                  ?disabled=${params.busy || !params.onWorkflowReview}
                  @click=${() => params.onWorkflowReview?.(params.agentId, params.task)}
                >
                  ${icons.fileText} <span>Review workflow</span>
                </button>
              `
            : nothing
        }
        ${
          params.sourceTask
            ? html`
                <button
                  class="btn btn--sm"
                  type="button"
                  title="Open source task"
                  aria-label="Open source task"
                  ?disabled=${params.busy || !params.onOpenSource}
                  @click=${() => params.onOpenSource?.(params.sourceTask!)}
                >
                  ${icons.externalLink} <span>Open source task</span>
                </button>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

function taskActivityType(task: TaskRecord): Exclude<TaskActivityTypeFilter, "all" | "history"> {
  const definitionKind = task.definitionKind?.toLowerCase();
  const taskKind = (task.taskKind ?? "").toLowerCase();
  const graphVersion = task.metadata?.workflowGraphVersion;
  if (
    taskKind === "standing-order-proposal" ||
    definitionKind === "program" ||
    typeof task.metadata?.standingOrderId === "string"
  ) {
    return "program";
  }
  if (definitionKind === "graph" || graphVersion === 2 || graphVersion === "2") {
    return "graph";
  }
  if (definitionKind === "workflow" || taskKind.includes("workflow")) {
    return "workflow";
  }
  if (definitionKind === "trigger" || task.source === "webhook") {
    return "trigger";
  }
  return "task";
}

function taskLedgerSearchHaystack(task: TaskRecord): string[] {
  return [
    task.taskId,
    task.task,
    task.taskKind,
    task.status,
    task.source,
    task.sourceId,
    task.runId,
    task.sessionKey,
    task.requesterSessionKey,
    task.provider,
    task.model,
    task.channel,
    task.error,
    task.correlationId,
    task.definitionId,
    task.definitionKind,
    task.workflowRunId,
    task.workflowNodeId,
    JSON.stringify(task.metadata ?? {}),
  ].filter((value): value is string => Boolean(value));
}

function taskLedgerMatchesSearch(task: TaskRecord, query: string) {
  if (!query) {
    return true;
  }
  return taskLedgerSearchHaystack(task).some((value) => value.toLowerCase().includes(query));
}

function taskLedgerMatchesStatus(task: TaskRecord, statusFilter: TaskLedgerStatusFilter) {
  if (statusFilter === "all") {
    return true;
  }
  if (statusFilter === "active") {
    return task.status === "queued" || task.status === "running";
  }
  if (statusFilter === "terminal") {
    return task.status !== "queued" && task.status !== "running";
  }
  return task.status === statusFilter;
}

function filterTaskLedgerTasks(
  tasks: TaskRecord[],
  sourceFilter: TaskLedgerSourceFilter,
  typeFilter: TaskActivityTypeFilter = "all",
  statusFilter: TaskLedgerStatusFilter = "all",
  query = "",
) {
  const normalizedQuery = query.trim().toLowerCase();
  return tasks.filter((task) => {
    if (sourceFilter !== "all" && task.source !== sourceFilter) {
      return false;
    }
    if (typeFilter !== "all" && typeFilter !== "history" && taskActivityType(task) !== typeFilter) {
      return false;
    }
    return (
      taskLedgerMatchesStatus(task, statusFilter) && taskLedgerMatchesSearch(task, normalizedQuery)
    );
  });
}

type TaskLedgerChainGroup = {
  key: string;
  tasks: TaskRecord[];
  latest: TaskRecord;
  createdAt: number;
  activeCount: number;
};

function taskLedgerChainKey(task: TaskRecord): string {
  return task.correlationId ?? task.rootTaskId ?? task.parentTaskId ?? task.taskId;
}

function taskUpdatedMs(task: TaskRecord): number {
  return task.updatedAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function taskCreatedMs(task: TaskRecord): number {
  return task.createdAt ?? task.startedAt ?? taskUpdatedMs(task);
}

function groupTaskLedgerTasks(tasks: TaskRecord[]): TaskLedgerChainGroup[] {
  const groups = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const key = taskLedgerChainKey(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return Array.from(groups.entries())
    .map(([key, entries]) => {
      const sorted = entries.toSorted((a, b) => a.createdAt - b.createdAt);
      const latest = sorted.toSorted((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a))[0] ?? sorted[0];
      return {
        key,
        tasks: sorted,
        latest,
        createdAt: taskCreatedMs(sorted[0] ?? latest),
        activeCount: sorted.filter((task) => task.status === "queued" || task.status === "running")
          .length,
      };
    })
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

function taskLedgerChainLabel(group: TaskLedgerChainGroup): string {
  const labels = group.tasks.map(taskLedgerKindLabel);
  const compact = labels.filter((label, index) => labels.indexOf(label) === index).slice(0, 5);
  const suffix = labels.length > compact.length ? ` +${labels.length - compact.length}` : "";
  return `${compact.join(" -> ")}${suffix}`;
}

function taskLedgerChainStatusLabel(group: TaskLedgerChainGroup): string {
  if (group.activeCount) {
    return `${group.activeCount} active`;
  }
  return group.latest.status.replace("_", " ");
}

function latestTaskForDefinition(
  tasks: TaskRecord[],
  kind: TaskRecord["definitionKind"],
  definitionId: string,
): TaskRecord | undefined {
  return tasks
    .filter((task) => {
      if (task.definitionKind === kind && task.definitionId === definitionId) {
        return true;
      }
      if (kind === "trigger") {
        return task.source === "webhook" && taskMetadataString(task, "triggerId") === definitionId;
      }
      if (kind === "task") {
        return (
          task.source === "cron" &&
          (task.sourceId === definitionId || task.definitionId === definitionId)
        );
      }
      return false;
    })
    .toSorted((a, b) => taskUpdatedMs(b) - taskUpdatedMs(a))[0];
}

function taskDefinitionLatestLabel(task: TaskRecord | undefined): string {
  if (!task) {
    return "no runs yet";
  }
  return `latest ${task.status.replace("_", " ")} · ${formatRelativeTimestamp(taskUpdatedMs(task))}`;
}

function taskLedgerExtraFields(
  task: TaskRecord,
  jobs: CronJob[] = [],
): Array<{ label: string; value: string; mono?: boolean; wide?: boolean }> {
  const fields: Array<{ label: string; value: string; mono?: boolean; wide?: boolean }> = [];
  const traceRootTaskId = task.rootTaskId ?? taskMetadataString(task, "rootTaskId");
  const traceParentTaskId = task.parentTaskId ?? taskMetadataString(task, "parentTaskId");
  const traceCorrelationId = task.correlationId ?? taskMetadataString(task, "correlationId");
  const traceDefinitionId =
    task.definitionId ??
    taskMetadataString(task, "definitionId") ??
    taskMetadataString(task, "workflowDefinitionId");
  const traceDefinitionKind =
    task.definitionKind ??
    taskMetadataString(task, "definitionKind") ??
    (taskMetadataString(task, "workflowMode") === "graph" ? "graph" : "");
  const traceWorkflowRunId = task.workflowRunId ?? taskMetadataString(task, "workflowRunId");
  const traceWorkflowNodeId =
    task.workflowNodeId ??
    taskMetadataString(task, "workflowNodeId") ??
    taskMetadataString(task, "blockedNodeId");
  const trigger = taskMetadataString(task, "triggerId") || task.sourceId;
  const hookJobId = taskMetadataString(task, "hookJobId");
  const hookName = taskMetadataString(task, "hookName");
  const path = taskMetadataString(task, "path");
  const action = taskMetadataString(task, "action");
  const wakeMode = taskMetadataString(task, "wakeMode");
  const resultSource = taskMetadataString(task, "resultSource");
  const mode = taskMetadataString(task, "mode");
  const childSession = taskMetadataString(task, "childSessionKey");
  const requester = task.requesterSessionKey?.trim();
  const messageId = taskMetadataString(task, "messageId");
  const threadId = taskMetadataString(task, "threadId");
  const accountId = taskMetadataString(task, "accountId");
  const to = taskMetadataString(task, "to");
  const providerHint = taskMetadataString(task, "providerHint");
  const dispatchRoute = taskMetadataString(task, "dispatchRoute");
  const replyCounts = taskMetadataCompactObject(task, "replyCounts");
  const approvalId = taskMetadataString(task, "approvalId");
  const approvalStatus = taskMetadataString(task, "approvalStatus");
  const actionKind = taskMetadataString(task, "actionKind");
  const chain = taskMetadataString(task, "chain");
  const providerId = taskMetadataString(task, "providerId");
  const walletId = taskMetadataString(task, "walletId");
  const walletName = taskMetadataString(task, "walletName");
  const walletRole = taskMetadataString(task, "walletRole");
  const amountDisplay =
    taskMetadataString(task, "amountDisplay") || taskMetadataString(task, "amount");
  const token = taskMetadataString(task, "token") || taskMetadataString(task, "mint");
  const relatedTaskId = taskMetadataString(task, "relatedTaskId");
  const txHash = taskMetadataString(task, "txHash");
  const requestedBy = taskMetadataString(task, "requestedBy");
  const approvedBy = taskMetadataString(task, "approvedBy");
  const rejectedBy = taskMetadataString(task, "rejectedBy");
  const expiresAt = taskMetadataString(task, "expiresAt");
  const decisionAt = taskMetadataString(task, "decisionAt");
  const simulationDecision = taskMetadataString(task, "simulationDecision");
  const simulationOk = taskMetadataBoolLabel(task, "simulationOk");
  const simulationChecks = taskMetadataRecordList(task, "simulationChecks");
  const orderId = taskMetadataString(task, "orderId");
  const offerId = taskMetadataString(task, "offerId");
  const requestId = taskMetadataString(task, "requestId");
  const marketplaceSource = taskMetadataString(task, "source");
  const requestStatus = taskMetadataString(task, "requestStatus");
  const orderStatus = taskMetadataString(task, "orderStatus");
  const serviceKind = taskMetadataString(task, "serviceKind");
  const visibility = taskMetadataString(task, "visibility");
  const enabled = taskMetadataBoolLabel(task, "enabled");
  const buyerHandle = taskMetadataString(task, "buyerHandle");
  const sellerHandle = taskMetadataString(task, "sellerHandle");
  const sellerEndpoint = taskMetadataString(task, "sellerEndpoint");
  const sellerSyncStatus = taskMetadataString(task, "sellerSyncStatus");
  const paymentStatus = taskMetadataString(task, "paymentStatus");
  const settlementMode = taskMetadataString(task, "settlementMode");
  const settlementStatus = taskMetadataString(task, "settlementStatus");
  const escrowStatus = taskMetadataString(task, "escrowStatus");
  const deliveryStatus = taskMetadataString(task, "deliveryStatus");
  const deliveryTargetKind = taskMetadataString(task, "deliveryTargetKind");
  const invoiceId = taskMetadataString(task, "invoiceId");
  const receiptId = taskMetadataString(task, "receiptId");
  const receiptStatus = taskMetadataString(task, "receiptStatus");
  const resultRef = taskMetadataString(task, "resultRef");
  const artifactRef = taskMetadataString(task, "artifactRef");
  const txRef = taskMetadataString(task, "txRef");
  const currency = taskMetadataString(task, "currency");
  const amount = taskMetadataString(task, "amount");
  const disputeCaseId = taskMetadataString(task, "disputeCaseId");
  const miningMethod = taskMetadataString(task, "method");
  const miningAction = taskMetadataString(task, "action");
  const miningCycleId =
    taskMetadataString(task, "cycleId") || taskMetadataString(task, "currentCycleId");
  const miningEpochId =
    taskMetadataString(task, "epochId") || taskMetadataString(task, "currentEpochId");
  const miningMicroRoundId =
    taskMetadataString(task, "microRoundId") || taskMetadataString(task, "currentMicroRoundId");
  const activeCommitLamports = taskMetadataString(task, "activeCommitLamports");
  const capitalFunded = taskMetadataString(task, "currentCapitalFundedLamports");
  const capitalFree = taskMetadataString(task, "currentCapitalFreeLamports");
  const capitalLocked = taskMetadataString(task, "currentCapitalLockedLamports");
  const capitalPendingCycleCount = taskMetadataString(task, "currentCapitalPendingCycleCount");
  const capitalAddress = taskMetadataString(task, "currentCapitalAddress");
  const running = taskMetadataString(task, "running");
  const drainOnly = taskMetadataString(task, "drainOnly");
  const enabledWanted = taskMetadataString(task, "enabledWanted");
  const started = taskMetadataBoolLabel(task, "started");
  const stopped = taskMetadataBoolLabel(task, "stopped");
  const bootstrapReason = taskMetadataString(task, "bootstrapReason");
  const nextActionDetail = taskMetadataString(task, "nextActionDetail");
  const blockedReason = taskMetadataString(task, "blockedReason");
  const lastAction = taskMetadataString(task, "lastAction");
  const lastActionTxHash = taskMetadataString(task, "lastActionTxHash");
  const strategyMode = taskMetadataString(task, "strategyMode");
  const strategyExecution = taskMetadataString(task, "strategyExecution");
  const strategyPreset = taskMetadataString(task, "strategyPreset");
  const pageIndex = taskMetadataString(task, "pageIndex");
  const chunkIndex = taskMetadataString(task, "chunkIndex");
  const lamports = taskMetadataString(task, "lamports");
  const readinessChecks = taskMetadataRecordList(task, "readinessChecks");
  const mediaCount = taskMetadataString(task, "mediaCount");
  const mediaIds = taskMetadataList(task, "mediaIds");
  const mediaSizes = taskMetadataList(task, "mediaSizes");
  const mediaArtifactKind = taskMetadataString(task, "artifactKind");
  const mediaPaths = taskMetadataList(task, "mediaPaths");
  const mediaContentTypes = taskMetadataList(task, "mediaContentTypes");
  const sourceControl = taskLedgerSourceControlNote(task, jobs);
  const coordinationEvidence = taskCoordinationEvidence(task);

  if (traceCorrelationId || traceRootTaskId || traceParentTaskId) {
    fields.push({
      label: "Trace",
      value: [
        traceCorrelationId ? `correlation ${traceCorrelationId}` : "",
        traceRootTaskId && traceRootTaskId !== task.taskId ? `root ${traceRootTaskId}` : "",
        traceParentTaskId ? `parent ${traceParentTaskId}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      mono: true,
      wide: true,
    });
  }
  if (traceDefinitionId || traceDefinitionKind) {
    fields.push({
      label: "Definition",
      value: [
        traceDefinitionKind ? `kind ${traceDefinitionKind}` : "",
        traceDefinitionId ? `id ${traceDefinitionId}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      mono: true,
    });
  }
  if (traceWorkflowRunId || traceWorkflowNodeId) {
    fields.push({
      label: "Workflow trace",
      value: [
        traceWorkflowRunId ? `run ${traceWorkflowRunId}` : "",
        traceWorkflowNodeId ? `node ${traceWorkflowNodeId}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      mono: true,
    });
  }
  if (coordinationEvidence.length > 0) {
    fields.push({
      label: "Coordination",
      value: formatCoordinationEvidenceSummary(coordinationEvidence),
      wide: true,
    });
  }

  if (task.source === "channel") {
    if (dispatchRoute) {
      fields.push({ label: "Dispatch route", value: dispatchRoute });
    }
    if (replyCounts) {
      fields.push({ label: "Reply counts", value: replyCounts });
    }
  }
  if (task.source === "media") {
    if (mediaArtifactKind) {
      fields.push({ label: "Media kind", value: mediaArtifactKind });
    }
    if (mediaCount) {
      fields.push({ label: "Media count", value: mediaCount });
    }
    if (mediaIds.length > 0) {
      fields.push({ label: "Media ids", value: mediaIds.join(", "), mono: true });
    }
    if (mediaSizes.length > 0) {
      fields.push({ label: "Media sizes", value: mediaSizes.join(", ") });
    }
  }
  if (task.source === "marketplace") {
    if (marketplaceSource || serviceKind) {
      fields.push({
        label: "Marketplace",
        value: [
          marketplaceSource ? `source ${marketplaceSource}` : "",
          serviceKind ? `service ${serviceKind}` : "",
          visibility ? `visibility ${visibility}` : "",
          enabled ? `enabled ${enabled}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (orderStatus || requestStatus) {
      fields.push({
        label: "State",
        value: [
          orderStatus ? `order ${orderStatus}` : "",
          requestStatus ? `request ${requestStatus}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (orderId) {
      fields.push({ label: "Order", value: orderId, mono: true });
    }
    if (requestId) {
      fields.push({ label: "Request", value: requestId, mono: true });
    }
    if (offerId) {
      fields.push({ label: "Offer", value: offerId, mono: true });
    }
    if (buyerHandle || sellerHandle) {
      fields.push({
        label: "Parties",
        value: [
          buyerHandle ? `buyer ${buyerHandle}` : "",
          sellerHandle ? `seller ${sellerHandle}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (sellerEndpoint || sellerSyncStatus) {
      fields.push({
        label: "Seller sync",
        value: [
          sellerEndpoint ? `endpoint ${sellerEndpoint}` : "",
          sellerSyncStatus ? `status ${sellerSyncStatus}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        mono: Boolean(sellerEndpoint),
      });
    }
    if (paymentStatus || settlementStatus || escrowStatus) {
      fields.push({
        label: "Payment",
        value: [
          paymentStatus,
          settlementMode ? `mode ${settlementMode}` : "",
          settlementStatus ? `settlement ${settlementStatus}` : "",
          escrowStatus ? `escrow ${escrowStatus}` : "",
          currency || amount ? `${amount} ${currency}`.trim() : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (deliveryStatus || deliveryTargetKind) {
      fields.push({
        label: "Marketplace delivery",
        value: [
          deliveryStatus ? deliveryStatus.replace("_", " ") : "",
          deliveryTargetKind ? `target ${deliveryTargetKind}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (invoiceId || receiptId || receiptStatus || txRef) {
      fields.push({
        label: "Receipt",
        value: [
          invoiceId ? `invoice ${invoiceId}` : "",
          receiptId ? `receipt ${receiptId}` : "",
          receiptStatus ? `status ${receiptStatus}` : "",
          txRef ? `tx ${txRef}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        mono: true,
      });
    }
    if (resultRef) {
      fields.push({ label: "Result", value: resultRef, mono: true });
    }
    if (disputeCaseId) {
      fields.push({ label: "Dispute", value: disputeCaseId, mono: true });
    }
    if (artifactRef) {
      fields.push({ label: "Artifact", value: artifactRef, mono: true });
    }
    if (expiresAt && task.taskKind === "marketplace_request") {
      fields.push({ label: "Expires", value: expiresAt });
    }
  }
  if (task.source === "mining") {
    if (miningAction) {
      fields.push({ label: "Mining action", value: miningAction, mono: true });
    }
    if (miningMethod) {
      fields.push({ label: "Mining method", value: miningMethod, mono: true });
    }
    if (miningCycleId || miningEpochId || miningMicroRoundId) {
      fields.push({
        label: "Cycle",
        value: [
          miningCycleId ? `cycle ${miningCycleId}` : "",
          miningEpochId ? `epoch ${miningEpochId}` : "",
          miningMicroRoundId ? `round ${miningMicroRoundId}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (running || drainOnly || enabledWanted) {
      fields.push({
        label: "Runtime",
        value: [
          running ? `running ${running}` : "",
          drainOnly ? `drain ${drainOnly}` : "",
          enabledWanted ? `enabled ${enabledWanted}` : "",
          started ? `started ${started}` : "",
          stopped ? `stopped ${stopped}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (activeCommitLamports) {
      fields.push({ label: "Commit", value: `${activeCommitLamports} lamports` });
    }
    if (capitalFunded || capitalFree || capitalLocked) {
      fields.push({
        label: "Capital",
        value: [
          capitalFunded ? `funded ${capitalFunded}` : "",
          capitalFree ? `free ${capitalFree}` : "",
          capitalLocked ? `locked ${capitalLocked}` : "",
          capitalPendingCycleCount ? `pending cycles ${capitalPendingCycleCount}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (capitalAddress) {
      fields.push({ label: "Capital address", value: capitalAddress, mono: true });
    }
    if (strategyMode || strategyExecution || strategyPreset) {
      fields.push({
        label: "Strategy",
        value: [strategyMode, strategyExecution, strategyPreset].filter(Boolean).join(" · "),
      });
    }
    if (lastAction || lastActionTxHash) {
      fields.push({
        label: "Last action",
        value: [lastAction, lastActionTxHash ? `tx ${lastActionTxHash}` : ""]
          .filter(Boolean)
          .join(" · "),
        mono: Boolean(lastActionTxHash),
      });
    }
    if (pageIndex || chunkIndex || lamports) {
      fields.push({
        label: "Request params",
        value: [
          pageIndex ? `page ${pageIndex}` : "",
          chunkIndex ? `chunk ${chunkIndex}` : "",
          lamports ? `${lamports} lamports` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (readinessChecks.length > 0) {
      fields.push({ label: "Readiness", value: formatTaskRecordChecks(readinessChecks) });
    }
    if (blockedReason || nextActionDetail || bootstrapReason) {
      fields.push({
        label: "Mining detail",
        value: blockedReason || nextActionDetail || bootstrapReason,
      });
    }
  }
  if (approvalId && task.source === "wallet") {
    fields.push({ label: "Approval", value: approvalId, mono: true });
  }
  if (task.source === "wallet") {
    if (approvalStatus || actionKind || chain || providerId) {
      fields.push({
        label: "Wallet action",
        value: [
          approvalStatus ? `status ${approvalStatus}` : "",
          actionKind ? `action ${actionKind}` : "",
          chain ? `chain ${chain}` : "",
          providerId ? `provider ${providerId}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (requestedBy || approvedBy || rejectedBy) {
      fields.push({
        label: "Actors",
        value: [
          requestedBy ? `requested ${requestedBy}` : "",
          approvedBy ? `approved ${approvedBy}` : "",
          rejectedBy ? `rejected ${rejectedBy}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (expiresAt || decisionAt) {
      fields.push({
        label: "Approval time",
        value: [expiresAt ? `expires ${expiresAt}` : "", decisionAt ? `decision ${decisionAt}` : ""]
          .filter(Boolean)
          .join(" · "),
      });
    }
    if (simulationDecision || simulationOk) {
      fields.push({
        label: "Policy simulation",
        value: [
          simulationDecision ? `decision ${simulationDecision}` : "",
          simulationOk ? `ok ${simulationOk}` : "",
          formatTaskRecordChecks(simulationChecks),
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
  }
  if (walletId) {
    fields.push({
      label: "Wallet",
      value: [walletName || walletId, walletRole ? `role ${walletRole}` : ""]
        .filter(Boolean)
        .join(" · "),
      mono: true,
    });
  }
  if (amountDisplay || token) {
    fields.push({ label: "Spend", value: [amountDisplay, token].filter(Boolean).join(" ") });
  }
  if (relatedTaskId) {
    fields.push({ label: "Related task", value: relatedTaskId, mono: true });
  }
  if (txHash) {
    fields.push({ label: "Tx", value: txHash, mono: true });
  }
  if (trigger && task.source === "webhook") {
    fields.push({ label: "Trigger", value: trigger, mono: true });
  }
  if (hookJobId) {
    fields.push({ label: "Hook job", value: hookJobId, mono: true });
  }
  if (hookName) {
    fields.push({ label: "Hook", value: hookName });
  }
  if (path) {
    fields.push({ label: "Path", value: path, mono: true });
  }
  if (action) {
    fields.push({ label: "Action", value: action });
  }
  if (wakeMode) {
    fields.push({ label: "Wake", value: wakeMode.replace("-", " ") });
  }
  if (resultSource) {
    fields.push({ label: "Result", value: resultSource });
  }
  if (mode) {
    fields.push({ label: "Mode", value: mode });
  }
  if (childSession) {
    fields.push({ label: "Child session", value: childSession, mono: true });
  }
  if (requester && requester !== childSession && requester !== task.sessionKey) {
    fields.push({ label: "Requester", value: requester, mono: true });
  }
  if (task.channel) {
    fields.push({ label: "Channel", value: task.channel });
  }
  if (to) {
    fields.push({ label: "Target", value: to, mono: true });
  }
  if (messageId) {
    fields.push({ label: "Message", value: messageId, mono: true });
  }
  if (threadId) {
    fields.push({ label: "Thread", value: threadId, mono: true });
  }
  if (accountId) {
    fields.push({ label: "Account", value: accountId, mono: true });
  }
  if (providerHint && providerHint !== "auto") {
    fields.push({ label: "Provider hint", value: providerHint });
  }
  if (mediaPaths.length > 0) {
    fields.push({ label: "Artifacts", value: `${mediaPaths.length} output(s)` });
    fields.push({ label: "Artifact paths", value: mediaPaths.join("\n"), mono: true });
  }
  if (mediaContentTypes.length > 0) {
    fields.push({ label: "Artifact types", value: mediaContentTypes.join(", ") });
  }
  if (task.sourceId && task.source !== "webhook" && task.sourceId !== task.runId) {
    fields.push({ label: "Source id", value: task.sourceId, mono: true });
  }
  if (sourceControl) {
    fields.push({ label: "Source controls", value: sourceControl, wide: true });
  }
  fields.push({ label: "Actions", value: formatTaskActionSupport(task, jobs) });
  return fields;
}

type TaskLedgerStep = NonNullable<TaskRecord["steps"]>[number];

function formatTaskWorkflowStepDetail(step: TaskLedgerStep): string {
  const parts = [
    step.status,
    step.attempt != null && step.maxAttempts != null
      ? `attempt ${step.attempt}/${step.maxAttempts}`
      : "",
    step.startedAt ? `started ${formatRelativeTimestamp(step.startedAt)}` : "",
    step.endedAt ? `ended ${formatRelativeTimestamp(step.endedAt)}` : "",
    step.updatedAt && !step.endedAt ? `updated ${formatRelativeTimestamp(step.updatedAt)}` : "",
    step.error?.trim() ?? "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function taskWorkflowStepLabel(step: TaskLedgerStep): string {
  return step.label?.trim() || step.id;
}

function taskWorkflowRunState(task: TaskRecord): string {
  const blockedStep = task.steps?.find((step) => step.status === "blocked");
  if (taskHasBlockedWorkflowApproval(task)) {
    return "Waiting for approval";
  }
  if (blockedStep) {
    return `Blocked at ${taskWorkflowStepLabel(blockedStep)}`;
  }
  const failedStep = task.steps?.find((step) => step.status === "failed" || step.status === "lost");
  if (failedStep) {
    return `Failed at ${taskWorkflowStepLabel(failedStep)}`;
  }
  const runningStep = task.steps?.find((step) => step.status === "running");
  if (runningStep) {
    return `Running ${taskWorkflowStepLabel(runningStep)}`;
  }
  const queuedStep = task.steps?.find((step) => step.status === "queued");
  if (queuedStep && task.status !== "succeeded") {
    return `Queued ${taskWorkflowStepLabel(queuedStep)}`;
  }
  if (task.status === "succeeded") {
    return "Workflow completed";
  }
  if (task.status === "failed" || task.status === "timed_out" || task.status === "lost") {
    return "Workflow failed";
  }
  return `${task.status.replace("_", " ")} workflow`;
}

function renderTaskWorkflowTimeline(task: TaskRecord) {
  const steps = task.steps ?? [];
  if (steps.length === 0) {
    return nothing;
  }
  const title = task.taskKind === "workflow" ? "Workflow run" : "Run steps";
  const blockedApproval = taskHasBlockedWorkflowApproval(task);
  return html`
    <div class="agent-task-field agent-task-field--wide agent-task-workflow">
      <div class="agent-task-workflow-head">
        <div>
          <div class="agent-task-field-label">${title}</div>
          <div class="agent-task-workflow-state">
            <span class=${`task-status-dot task-status-dot--${taskLedgerTone(task.status)}`}></span>
            <strong>${taskWorkflowRunState(task)}</strong>
          </div>
        </div>
        <span class="chip">${steps.length} step${steps.length === 1 ? "" : "s"}</span>
      </div>
      <div class="agent-task-workflow-meta">
        <span>${formatTaskLedgerSource(task)}</span>
        <span>${formatTaskLedgerDelivery(task)}</span>
        <span>${formatTaskTimeline(task)}</span>
      </div>
      ${
        blockedApproval
          ? html`
              <div class="callout warn agent-task-workflow-approval">
                Waiting for approval. Use Approve and continue to resume this same workflow task.
              </div>
            `
          : nothing
      }
      <div class="agent-task-workflow-steps">
        ${steps.map(
          (step, index) => html`
            <div class=${`agent-task-workflow-step agent-task-workflow-step--${step.status}`}>
              <div class="agent-task-workflow-step-index">${index + 1}</div>
              <span class=${`task-status-dot task-status-dot--${taskLedgerTone(step.status)}`}></span>
              <div class="agent-task-workflow-step-main">
                <div class="agent-task-workflow-step-title">${taskWorkflowStepLabel(step)}</div>
                <div class="agent-task-workflow-step-detail">
                  ${formatTaskWorkflowStepDetail(step)}
                </div>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function renderTaskLedgerField(field: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return html`
    <div class=${`agent-task-field ${field.wide ? "agent-task-field--wide" : ""}`}>
      <div class="agent-task-field-label">${field.label}</div>
      <div class=${`agent-task-field-value ${field.mono ? "mono" : ""}`}>${field.value}</div>
    </div>
  `;
}

function renderTaskWorkFilter(params: {
  typeFilter: TaskActivityTypeFilter;
  loading: boolean;
  scheduledCount: number;
  triggerCount: number;
  workflowCount: number;
  graphCount: number;
  programCount: number;
  historyCount: number | null;
  onTypeFilterChange?: (type: TaskActivityTypeFilter) => void;
}) {
  const definitionTotal =
    params.scheduledCount +
    params.triggerCount +
    params.workflowCount +
    params.graphCount +
    params.programCount;
  const optionLabel = (label: string, count: number | null) =>
    count == null ? label : `${label} (${count})`;
  return html`
    <label class="field task-source-filter-field">
      <select
        aria-label="Work type"
        .value=${params.typeFilter}
        @change=${(event: Event) => {
          params.onTypeFilterChange?.(
            (event.target as HTMLSelectElement).value as TaskActivityTypeFilter,
          );
        }}
      >
        <option value="all" data-testid="task-work-filter-all">
          ${optionLabel("All", definitionTotal)}
        </option>
        <option value="task" data-testid="task-work-filter-tasks">
          ${optionLabel("Tasks", params.scheduledCount)}
        </option>
        <option value="trigger" data-testid="task-work-filter-triggers">
          ${optionLabel("Triggers", params.triggerCount)}
        </option>
        <option value="workflow" data-testid="task-work-filter-workflows">
          ${optionLabel("Workflows", params.workflowCount)}
        </option>
        <option value="graph" data-testid="task-work-filter-graphs">
          ${optionLabel("Graphs", params.graphCount)}
        </option>
        <option value="program" data-testid="task-work-filter-programs">
          ${optionLabel("Programs", params.programCount)}
        </option>
        <option value="history" data-testid="task-work-filter-history">
          ${optionLabel("Run history", params.historyCount)}
        </option>
      </select>
    </label>
  `;
}

function renderTaskSourceFilter(params: {
  result: TaskListResult | null;
  sourceFilter: TaskLedgerSourceFilter;
  loading: boolean;
  onSourceFilterChange?: (source: TaskLedgerSourceFilter) => void;
}) {
  const sourceCounts = params.result?.summary.bySource ?? {};
  const optionLabel = (label: string, count: number) => `${label} (${count})`;
  return html`
    <label class="field task-source-filter-field">
      <select
        aria-label="History source"
        .value=${params.sourceFilter}
        @change=${(event: Event) =>
          params.onSourceFilterChange?.(
            (event.target as HTMLSelectElement).value as TaskLedgerSourceFilter,
          )}
      >
        <option value="all" data-testid="task-work-filter-source-all">
          ${optionLabel("All sources", params.result?.summary.total ?? 0)}
        </option>
        ${(Object.keys(TASK_LEDGER_SOURCE_LABELS) as TaskRecord["source"][]).map(
          (source) => html`
            <option value=${source} data-testid=${`task-work-filter-source-${source}`}>
              ${optionLabel(TASK_LEDGER_SOURCE_LABELS[source], sourceCounts[source] ?? 0)}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

function renderTaskStatusFilter(params: {
  result: TaskListResult | null;
  statusFilter: TaskLedgerStatusFilter;
  loading: boolean;
  onStatusFilterChange?: (status: TaskLedgerStatusFilter) => void;
}) {
  const byStatus = params.result?.summary.byStatus ?? {};
  const active = (byStatus.queued ?? 0) + (byStatus.running ?? 0);
  const terminal = Math.max(0, (params.result?.summary.total ?? 0) - active);
  const optionLabel = (label: string, count: number) => `${label} (${count})`;
  return html`
    <label class="field task-source-filter-field">
      <select
        aria-label="History status"
        .value=${params.statusFilter}
        @change=${(event: Event) =>
          params.onStatusFilterChange?.(
            (event.target as HTMLSelectElement).value as TaskLedgerStatusFilter,
          )}
      >
        <option value="all">${optionLabel("All status", params.result?.summary.total ?? 0)}</option>
        <option value="active">${optionLabel("Active", active)}</option>
        <option value="terminal">${optionLabel("Terminal", terminal)}</option>
        <option value="queued">${optionLabel("Queued", byStatus.queued ?? 0)}</option>
        <option value="running">${optionLabel("Running", byStatus.running ?? 0)}</option>
        <option value="blocked">${optionLabel("Blocked", byStatus.blocked ?? 0)}</option>
        <option value="failed">${optionLabel("Failed", byStatus.failed ?? 0)}</option>
        <option value="succeeded">${optionLabel("Succeeded", byStatus.succeeded ?? 0)}</option>
        <option value="timed_out">${optionLabel("Timed out", byStatus.timed_out ?? 0)}</option>
        <option value="cancelled">${optionLabel("Cancelled", byStatus.cancelled ?? 0)}</option>
        <option value="lost">${optionLabel("Lost", byStatus.lost ?? 0)}</option>
        <option value="skipped">${optionLabel("Skipped", byStatus.skipped ?? 0)}</option>
      </select>
    </label>
  `;
}

function renderTaskLedger(params: {
  agentId: string;
  jobs: CronJob[];
  result: TaskListResult | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  sourceFilter?: TaskLedgerSourceFilter;
  typeFilter?: TaskActivityTypeFilter;
  statusFilter?: TaskLedgerStatusFilter;
  searchQuery?: string;
  details?: Record<string, TaskRecord>;
  detailLoading?: Record<string, boolean>;
  detailErrors?: Record<string, string>;
  onDetailOpen?: (taskId: string) => void;
  onControl?: (
    action: "approve" | "reject" | "cancel" | "retry" | "notify",
    taskId: string,
  ) => void;
  onOpenSession?: (sessionKey: string) => void;
  onOpenSource?: (task: TaskRecord) => void;
  onWorkflowReview?: (agentId: string, task: TaskRecord) => void;
  onPageChange?: (offset: number) => void;
}) {
  const sourceFilter = params.sourceFilter ?? "all";
  const typeFilter = params.typeFilter ?? "all";
  const statusFilter = params.statusFilter ?? "all";
  const allTasks = params.result?.tasks ?? [];
  const tasks = filterTaskLedgerTasks(
    allTasks,
    sourceFilter,
    typeFilter,
    statusFilter,
    params.searchQuery ?? "",
  );
  const offset = params.result?.offset ?? 0;
  const limit = params.result?.limit ?? Math.max(allTasks.length, 1);
  const total = params.result?.total ?? allTasks.length;
  const nextOffset = params.result?.nextOffset ?? null;
  const hasPreviousPage = offset > 0;
  const hasNextPage = nextOffset !== null;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(total, offset + allTasks.length);
  const taskGroups = groupTaskLedgerTasks(tasks);
  const emptyMessage =
    allTasks.length === 0
      ? params.loading
        ? "Loading run history..."
        : "No run history recorded for this Agent yet."
      : `No ${sourceFilter === "all" ? "" : taskLedgerSourceLabel(sourceFilter)} run history matches this filter.`;
  return html`
    <div class="agent-task-ledger agent-task-ledger--flat">
      <div class="agent-task-ledger-body">
        ${
          total > 0
            ? html`
                <div class="agent-task-ledger-pager">
                  <span>${pageStart}-${pageEnd} of ${total}</span>
                  <span class="agent-task-ledger-pager-actions">
                    <button
                      type="button"
                      class="btn btn--xs btn--ghost"
                      ?disabled=${!hasPreviousPage || params.loading}
                      @click=${() => params.onPageChange?.(Math.max(0, offset - limit))}
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      class="btn btn--xs btn--ghost"
                      ?disabled=${!hasNextPage || params.loading}
                      @click=${() => {
                        if (nextOffset !== null) {
                          params.onPageChange?.(nextOffset);
                        }
                      }}
                    >
                      Next
                    </button>
                  </span>
                </div>
              `
            : nothing
        }
        ${
          params.error
            ? html`<div class="callout danger">${params.error}</div>`
            : tasks.length === 0
              ? html`
                    <div class="agent-task-ledger-empty" aria-live="polite">
                      ${emptyMessage}
                    </div>
                  `
              : html`
                    <div class="agent-task-list" aria-busy=${params.loading ? "true" : "false"}>
                      ${repeat(
                        taskGroups,
                        (group) => group.key,
                        (group) => html`
                        <div class=${`agent-task-chain ${group.tasks.length > 1 ? "agent-task-chain--linked" : ""}`}>
                          ${
                            group.tasks.length > 1
                              ? html`
                                  <div class="agent-task-chain-head">
                                    <span class="agent-task-chain-title">
                                      <span class=${`task-status-dot task-status-dot--${taskLedgerTone(group.latest.status)}`}></span>
                                      <strong title=${taskLedgerChainLabel(group)}>
                                        ${taskLedgerChainLabel(group)}
                                      </strong>
                                    </span>
                                    <span class="agent-task-chain-meta">
                                      <span class="chip">${group.tasks.length} linked</span>
                                      <span class="chip">${taskLedgerChainStatusLabel(group)}</span>
                                      <span class="chip mono" title=${group.key}>
                                        ${compactTaskId(group.key)}
                                      </span>
                                    </span>
                                  </div>
                                `
                              : nothing
                          }
                          <div class="agent-task-chain-items">
                            ${repeat(
                              group.tasks,
                              (task) => task.taskId,
                              (task) => {
                                const detailTask = params.details?.[task.taskId] ?? task;
                                const detailLoading = params.detailLoading?.[task.taskId] === true;
                                const detailError = params.detailErrors?.[task.taskId] ?? "";
                                const detail = formatTaskLedgerDetail(detailTask);
                                const sessionKey = taskLedgerSessionKey(detailTask);
                                const extraFields = taskLedgerExtraFields(detailTask, params.jobs);
                                const coordinationEvidence = taskCoordinationEvidence(detailTask);
                                const sourceTask = sourceTaskFromWorkflowTask(detailTask);
                                const workflowReviewLabel =
                                  taskLedgerWorkflowReviewLabel(detailTask);
                                const sourceOpenLabel = taskLedgerSourceOpenLabel(
                                  detailTask,
                                  params.jobs,
                                );
                                const sourceControl = taskLedgerSourceControlNote(
                                  detailTask,
                                  params.jobs,
                                );
                                return html`
                                <details
                                  id=${taskLedgerAnchorId("task-ledger", detailTask.taskId)}
                                  class="agent-task-row"
                                  @toggle=${(event: Event) => {
                                    const row = event.currentTarget as HTMLDetailsElement;
                                    if (row.open) {
                                      params.onDetailOpen?.(task.taskId);
                                    }
                                  }}
                                >
                            <summary>
                              <div class="agent-task-summary">
                                <div class="agent-task-title-line">
                                  <span class=${`task-status-dot task-status-dot--${taskLedgerTone(detailTask.status)}`}></span>
                                  <span class="agent-task-title">${detailTask.task}</span>
                                  <span class="agent-task-id mono" title=${detailTask.taskId}>${compactTaskId(detailTask.taskId)}</span>
                                  <span class="chip agent-task-status">${detailTask.status.replace("_", " ")}</span>
                                  ${
                                    coordinationEvidence.length > 0
                                      ? html`
                                          <span
                                            class="chip"
                                            title=${formatCoordinationEvidenceSummary(coordinationEvidence)}
                                          >
                                            ${coordinationEvidence.length} helper${coordinationEvidence.length === 1 ? "" : "s"}
                                          </span>
                                        `
                                      : nothing
                                  }
                                  ${
                                    isTaskLedgerViewOnlySource(detailTask)
                                      ? html`
                                          <span class="chip agent-task-view-only" title=${sourceControl}>
                                            ${taskLedgerSourceOwnedChipLabel(detailTask)}
                                          </span>
                                        `
                                      : nothing
                                  }
                                </div>
                                <div class="agent-task-meta-line">
                                  <span class="muted">${compactTaskLedgerMeta(detailTask)}</span>
                                  ${detailTask.updatedAt ? html`<span class="muted">· ${formatRelativeTimestamp(detailTask.updatedAt)}</span>` : nothing}
                                </div>
                              </div>
                              <div
                                class="agent-task-actions"
                                @click=${(event: Event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                }}
                              >
                                ${
                                  sourceOpenLabel
                                    ? renderTaskIconButton({
                                        label: sourceOpenLabel,
                                        icon: "externalLink",
                                        disabled: params.busy || !params.onOpenSource,
                                        onClick: () => params.onOpenSource?.(detailTask),
                                      })
                                    : nothing
                                }
                                ${
                                  canCancelTaskLedgerTask(detailTask, params.jobs)
                                    ? renderTaskIconButton({
                                        label: taskLedgerCancelLabel(detailTask),
                                        icon: "stop",
                                        danger: true,
                                        disabled: params.busy,
                                        onClick: () =>
                                          params.onControl?.("cancel", detailTask.taskId),
                                      })
                                    : nothing
                                }
                                ${
                                  canApproveTaskLedgerWorkflow(detailTask)
                                    ? renderTaskIconButton({
                                        label: "Approve/resume workflow",
                                        icon: "check",
                                        disabled: params.busy,
                                        onClick: () =>
                                          params.onControl?.("approve", detailTask.taskId),
                                      })
                                    : nothing
                                }
                                ${
                                  canRejectTaskLedgerWorkflow(detailTask)
                                    ? renderTaskIconButton({
                                        label: "Reject workflow",
                                        icon: "x",
                                        danger: true,
                                        disabled: params.busy,
                                        onClick: () =>
                                          params.onControl?.("reject", detailTask.taskId),
                                      })
                                    : nothing
                                }
                                ${
                                  canRetryTaskLedgerTask(detailTask, params.jobs)
                                    ? renderTaskIconButton({
                                        label: taskLedgerRetryLabel(detailTask),
                                        icon: "play",
                                        disabled: params.busy,
                                        onClick: () =>
                                          params.onControl?.("retry", detailTask.taskId),
                                      })
                                    : nothing
                                }
                                ${
                                  workflowReviewLabel
                                    ? renderTaskIconButton({
                                        label: workflowReviewLabel,
                                        icon: "fileText",
                                        disabled: params.busy || !params.onWorkflowReview,
                                        onClick: () =>
                                          params.onWorkflowReview?.(params.agentId, detailTask),
                                      })
                                    : nothing
                                }
                                ${
                                  sourceTask
                                    ? renderTaskIconButton({
                                        label: "Open source task",
                                        icon: "externalLink",
                                        disabled: params.busy || !params.onOpenSource,
                                        onClick: () => params.onOpenSource?.(sourceTask),
                                      })
                                    : nothing
                                }
                                ${
                                  sessionKey
                                    ? renderTaskIconButton({
                                        label: "Open task session",
                                        icon: "messageSquare",
                                        disabled: params.busy || !params.onOpenSession,
                                        onClick: () => params.onOpenSession?.(sessionKey),
                                      })
                                    : nothing
                                }
                                ${
                                  canNotifyTaskLedgerTask(detailTask)
                                    ? renderTaskIconButton({
                                        label: taskLedgerNotifyLabel(detailTask),
                                        icon: "bell",
                                        disabled: params.busy,
                                        onClick: () =>
                                          params.onControl?.("notify", detailTask.taskId),
                                      })
                                    : nothing
                                }
                              </div>
                            </summary>
                            <div class="agent-task-body">
                              ${
                                taskLedgerSourceOwnershipNote(detailTask)
                                  ? html`
                                      <div class="agent-task-source-note">
                                        ${taskLedgerSourceOwnershipNote(detailTask)}
                                      </div>
                                    `
                                  : nothing
                              }
                              <div class="agent-task-grid">
                                ${renderTaskLedgerField({ label: "Kind", value: taskLedgerKindLabel(detailTask) })}
                                ${renderTaskLedgerField({ label: "Source", value: formatTaskLedgerSource(detailTask) })}
                                ${renderTaskLedgerField({ label: "Delivery", value: formatTaskLedgerDelivery(detailTask) })}
                                ${renderTaskLedgerField({
                                  label: "Session",
                                  value: sessionKey || "none",
                                  mono: true,
                                })}
                                ${renderTaskLedgerField({
                                  label: "Model",
                                  value:
                                    detailTask.provider && detailTask.model
                                      ? `${detailTask.provider}/${detailTask.model}`
                                      : (detailTask.model ?? detailTask.provider ?? "not recorded"),
                                  mono: true,
                                })}
                                ${renderTaskLedgerField({ label: "Usage", value: formatTaskUsage(detailTask) })}
                                ${renderTaskLedgerField({
                                  label: "Skills",
                                  value: detailTask.loadedSkills?.length
                                    ? detailTask.loadedSkills.join(", ")
                                    : (detailTask.skillScope ?? "not recorded"),
                                })}
                                ${renderTaskLedgerField({
                                  label: "Tools",
                                  value: detailTask.loadedTools?.length
                                    ? detailTask.loadedTools.join(", ")
                                    : detailTask.toolCount != null
                                      ? `${detailTask.toolCount} tools`
                                      : "not recorded",
                                })}
                                ${renderTaskLedgerField({
                                  label: "Memory",
                                  value: detailTask.memoryScope ?? "not recorded",
                                })}
                                ${renderTaskLedgerField({
                                  label: "Timeline",
                                  value: formatTaskTimeline(detailTask),
                                })}
                                ${renderTaskLedgerField({
                                  label: "Run",
                                  value:
                                    detailTask.runId ?? detailTask.sourceId ?? detailTask.taskId,
                                  mono: true,
                                })}
                                ${
                                  sourceTask
                                    ? renderTaskLedgerField({
                                        label: "Source task",
                                        value: `${taskLedgerSourceLabel(sourceTask.source)} · ${sourceTask.task} · ${sourceTask.taskId}`,
                                        wide: true,
                                      })
                                    : nothing
                                }
                                ${extraFields.map((field) => renderTaskLedgerField(field))}
                              </div>
                              ${renderTaskLedgerSourceActions({
                                agentId: params.agentId,
                                task: detailTask,
                                sourceTask,
                                sourceOpenLabel,
                                workflowReviewLabel,
                                busy: params.busy,
                                onOpenSource: params.onOpenSource,
                                onWorkflowReview: params.onWorkflowReview,
                              })}
                              ${
                                detailLoading
                                  ? html`
                                      <div class="muted">Loading full task detail...</div>
                                    `
                                  : nothing
                              }
                              ${
                                detailError
                                  ? html`<div class="callout danger">${detailError}</div>`
                                  : nothing
                              }
                              ${
                                detail
                                  ? html`
                                      <div class="agent-task-field agent-task-field--wide">
                                        <div class="agent-task-field-label">Detail</div>
                                        <div class="agent-task-field-value">${detail}</div>
                                      </div>
                                    `
                                  : nothing
                              }
                              ${renderTaskCoordinationEvidence(detailTask)}
                              ${
                                detailTask.steps?.length
                                  ? renderTaskWorkflowTimeline(detailTask)
                                  : nothing
                              }
                            </div>
                          </details>
                          ${renderTaskCoordinationChainRows(detailTask)}
                        `;
                              },
                            )}
                          </div>
                        </div>
                      `,
                      )}
                    </div>
                  `
        }
      </div>
    </div>
  `;
}

export function renderAgentCron(params: {
  context: AgentContext;
  agentId: string;
  jobs: CronJob[];
  status: CronStatus | null;
  webhookTriggers?: {
    result: WebhookTriggersResult | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    message: string | null;
    draft: import("../controllers/webhook-triggers.ts").WebhookTriggerDraft | null;
  };
  taskLedger?: {
    result: TaskListResult | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    sourceFilter?: TaskLedgerSourceFilter;
    typeFilter?: TaskActivityTypeFilter;
    statusFilter?: TaskLedgerStatusFilter;
    details?: Record<string, TaskRecord>;
    detailLoading?: Record<string, boolean>;
    detailErrors?: Record<string, string>;
  };
  taskWorkflow?: {
    draft: TaskWorkflowDraft | null;
    graphDraft: TaskWorkflowGraphDraft | null;
    busy: boolean;
    error: string | null;
    message: string | null;
    definitions: SavedTaskWorkflowDefinitionsResult | null;
    definitionsLoading: boolean;
    definitionsBusy: boolean;
    definitionsError: string | null;
    templates?: TaskWorkflowTemplatesResult | null;
    templatesLoading?: boolean;
    templatesError?: string | null;
    runs: TaskFlowListResult | null;
    runsLoading: boolean;
    runsBusy: boolean;
    runsError: string | null;
  };
  taskStandingOrders?: {
    result: StandingOrdersResult | null;
    loading: boolean;
    busy: boolean;
    error: string | null;
    message: string | null;
    draft: StandingOrderDraft | null;
  };
  loading: boolean;
  error: string | null;
  taskFilters?: {
    query: string;
    status: "all" | "enabled" | "disabled" | "needs-access";
    adaptiveRoute: CronJobsAdaptiveRouteFilter;
    sortDir: "desc" | "asc";
  };
  onRefresh: () => void;
  onEdit: (job: CronJob) => void;
  onRunNow: (jobId: string) => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRepair?: (
    job: CronJob,
    action: CronRepairAction,
    opts?: { source?: string; sourceNodeId?: string },
  ) => void | Promise<void>;
  onApproveCoordination?: (job: CronJob) => void | Promise<void>;
  onAskAgentEvidence?: (job: CronJob) => void | Promise<void>;
  onSourceToggle?: (source: CronTaskTrustedSource, active: boolean) => void | Promise<void>;
  onSourceRemove?: (source: CronTaskTrustedSource) => void | Promise<void>;
  onQueueControl?: (action: "cancel" | "retry" | "clear-stale", runId: string) => void;
  onTaskLedgerRefresh?: () => void;
  onTaskLedgerSourceFilterChange?: (source: TaskLedgerSourceFilter) => void;
  onTaskLedgerTypeFilterChange?: (type: TaskActivityTypeFilter) => void;
  onTaskLedgerStatusFilterChange?: (status: TaskLedgerStatusFilter) => void;
  onTaskLedgerPageChange?: (offset: number) => void;
  onTaskLedgerDetailOpen?: (taskId: string) => void;
  onTaskLedgerControl?: (
    action: "approve" | "reject" | "cancel" | "retry" | "notify",
    taskId: string,
  ) => void;
  onTaskLedgerOpenSource?: (task: TaskRecord) => void;
  onTaskLedgerWorkflowReview?: (agentId: string, task: TaskRecord) => void;
  onTaskWorkflowCreate?: (agentId: string) => void;
  onTaskWorkflowGraphCreate?: (agentId: string) => void;
  onTaskWorkflowUseTemplate?: (agentId: string, template: TaskWorkflowTemplate) => void;
  onTaskTemplateUse?: (agentId: string, template: TaskTemplatePreset) => void;
  onTaskWorkflowPatch?: (patch: Partial<TaskWorkflowDraft>) => void;
  onTaskWorkflowGraphPatch?: (patch: Partial<TaskWorkflowGraphDraft>) => void;
  onTaskWorkflowGraphAddNode?: (type: TaskWorkflowGraphNodeType) => void;
  onTaskWorkflowGraphUpdateNode?: (nodeId: string, patch: Partial<TaskWorkflowGraphNode>) => void;
  onTaskWorkflowGraphRemoveNode?: (nodeId: string) => void;
  onTaskWorkflowGraphMoveNode?: (nodeId: string, x: number, y: number) => void;
  onTaskWorkflowGraphAddEdge?: (from: string, to: string, on?: TaskWorkflowGraphEdgeEvent) => void;
  onTaskWorkflowGraphUpdateEdge?: (edgeId: string, patch: Partial<TaskWorkflowGraphEdge>) => void;
  onTaskWorkflowGraphRemoveEdge?: (edgeId: string) => void;
  onTaskWorkflowGraphAutoLayout?: () => void;
  onTaskWorkflowGraphImportJson?: () => void;
  onTaskWorkflowGraphExportJson?: () => void;
  onTaskWorkflowPreview?: (agentId: string) => void;
  onTaskWorkflowGraphPreview?: (agentId: string) => void;
  onTaskWorkflowSave?: (agentId: string) => void;
  onTaskWorkflowGraphSave?: (agentId: string) => void;
  onTaskWorkflowRun?: (agentId: string) => void;
  onTaskWorkflowGraphRun?: (agentId: string) => void;
  onTaskWorkflowEditDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onTaskWorkflowEditGraphDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onTaskWorkflowRunDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onTaskWorkflowRemoveDefinition?: (definition: SavedTaskWorkflowDefinition) => void;
  onTaskWorkflowOpenRunGraph?: (flow: TaskFlowRecord) => void;
  onTaskWorkflowCancelRun?: (flow: TaskFlowRecord) => void;
  onTaskWorkflowCancel?: () => void;
  onTaskStandingOrderCreate?: (agentId: string) => void;
  onTaskStandingOrderEdit?: (order: StandingOrderRecord) => void;
  onTaskStandingOrderPatch?: (patch: Partial<StandingOrderDraft>) => void;
  onTaskStandingOrderSave?: (agentId: string) => void;
  onTaskStandingOrderRemove?: (order: StandingOrderRecord) => void;
  onTaskStandingOrderPropose?: (order: StandingOrderRecord) => void;
  onTaskStandingOrderCancel?: () => void;
  onRunDetail?: (runId: string) => void;
  onRemove: (job: CronJob) => void;
  onCreate: (agentId: string) => void;
  onWebhookTriggerCreate?: (agentId: string) => void;
  onWebhookTriggerEdit?: (trigger: WebhookTrigger) => void;
  onWebhookTriggerPatch?: (
    patch: Partial<import("../controllers/webhook-triggers.ts").WebhookTriggerDraft>,
  ) => void;
  onWebhookTriggerSave?: () => void;
  onWebhookTriggerCancel?: () => void;
  onWebhookTriggerRemove?: (trigger: WebhookTrigger) => void;
  onWebhookTriggerToggle?: (trigger: WebhookTrigger, enabled: boolean) => void;
  onWebhookTriggerTest?: (trigger: WebhookTrigger) => void;
  onOpenSession?: (sessionKey: string) => void;
  onTaskFiltersChange?: (
    patch: Partial<{
      query: string;
      status: "all" | "enabled" | "disabled" | "needs-access";
      adaptiveRoute: CronJobsAdaptiveRouteFilter;
      sortDir: "desc" | "asc";
    }>,
  ) => void;
  onSelectPanel?: (panel: "sessions" | "channels" | "cron") => void;
  onNavigate?: (tab: Tab) => void;
}) {
  const allAgentJobs = params.jobs.filter((job) => job.agentId === params.agentId);
  const taskFilters = params.taskFilters ?? {
    query: "",
    status: "all" as const,
    adaptiveRoute: "all" as const,
    sortDir: "desc" as const,
  };
  const hasDefinitionFilters =
    taskFilters.status !== "all" ||
    taskFilters.adaptiveRoute !== "all" ||
    taskFilters.sortDir !== "desc";
  const query = taskFilters.query.trim().toLowerCase();
  const jobs = allAgentJobs
    .filter((job) => {
      if (taskFilters.status === "enabled" && !job.enabled) {
        return false;
      }
      if (taskFilters.status === "disabled" && job.enabled) {
        return false;
      }
      if (taskFilters.status === "needs-access" && !job.state?.needsAccess) {
        return false;
      }
      if (
        taskFilters.adaptiveRoute !== "all" &&
        job.state?.adaptiveRouting?.lastDecision?.route !== taskFilters.adaptiveRoute
      ) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [
        job.name,
        job.id,
        job.description,
        taskPromptPreview(job),
        job.sessionKey,
        taskDeliveryLabel(job),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    })
    .toSorted((a, b) =>
      taskFilters.sortDir === "asc" ? taskSortMs(a) - taskSortMs(b) : taskSortMs(b) - taskSortMs(a),
    );
  const triggerCount =
    params.webhookTriggers?.result?.triggers.filter((trigger) => trigger.agentId === params.agentId)
      .length ?? 0;
  const graphDefinitionCount =
    params.taskWorkflow?.definitions?.definitions.filter(
      (definition) => definition.agentId === params.agentId && definition.mode === "graph",
    ).length ?? 0;
  const workflowDefinitionCount =
    params.taskWorkflow?.definitions?.definitions.filter(
      (definition) => definition.agentId === params.agentId && definition.mode !== "graph",
    ).length ?? 0;
  const programCount =
    params.taskStandingOrders?.result?.orders.filter((order) => order.agentId === params.agentId)
      .length ?? 0;
  const workflowTemplates = params.taskWorkflow?.templates?.templates ?? [];
  const ledgerTasks = params.taskLedger?.result?.tasks ?? [];
  const ledgerTotal = params.taskLedger?.result?.summary.total ?? null;
  const activeTypeFilter = params.taskLedger?.typeFilter ?? "all";
  const showRunHistory = activeTypeFilter === "history";
  const definitionTotal =
    allAgentJobs.length +
    triggerCount +
    workflowDefinitionCount +
    graphDefinitionCount +
    programCount;
  const showScheduledDefinitions =
    (activeTypeFilter === "all" || activeTypeFilter === "task") &&
    (allAgentJobs.length > 0 || hasDefinitionFilters || Boolean(params.error));
  const showWebhookTriggers =
    Boolean(params.webhookTriggers) &&
    (triggerCount > 0 ||
      Boolean(params.webhookTriggers?.draft) ||
      Boolean(params.webhookTriggers?.error) ||
      Boolean(params.webhookTriggers?.loading)) &&
    (activeTypeFilter === "all" || activeTypeFilter === "trigger");
  const showWorkflowDefinitions =
    Boolean(params.taskWorkflow) &&
    (workflowDefinitionCount > 0 ||
      graphDefinitionCount > 0 ||
      Boolean(params.taskWorkflow?.draft) ||
      Boolean(params.taskWorkflow?.graphDraft) ||
      Boolean(params.taskWorkflow?.error) ||
      Boolean(params.taskWorkflow?.definitionsError) ||
      Boolean(params.taskWorkflow?.definitionsLoading)) &&
    (activeTypeFilter === "all" || activeTypeFilter === "workflow" || activeTypeFilter === "graph");
  const showPrograms =
    Boolean(params.taskStandingOrders) &&
    (programCount > 0 ||
      Boolean(params.taskStandingOrders?.draft) ||
      Boolean(params.taskStandingOrders?.error) ||
      Boolean(params.taskStandingOrders?.loading)) &&
    (activeTypeFilter === "all" || activeTypeFilter === "program");
  const hasVisibleDefinitions =
    showScheduledDefinitions || showWebhookTriggers || showWorkflowDefinitions || showPrograms;
  return html`
    <style>
      .agent-task-list {
        display: grid;
        gap: 8px;
        margin-top: 12px;
      }
      .agent-task-chain {
        display: grid;
        gap: 8px;
      }
      .agent-task-chain--linked {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px;
      }
      .agent-task-chain-head {
        align-items: center;
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        font-size: 12px;
        gap: 6px 8px;
        justify-content: space-between;
        padding: 0 2px;
      }
      .agent-task-chain-title {
        align-items: center;
        display: inline-flex;
        flex: 1 1 260px;
        gap: 7px;
        min-width: 0;
      }
      .agent-task-chain-title strong {
        color: var(--text);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-task-chain-meta {
        align-items: center;
        display: inline-flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .agent-task-chain-items {
        display: grid;
        gap: 7px;
      }
      .agent-task-coordination-list {
        display: grid;
        gap: 6px;
      }
      .agent-task-coordination-row {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px 8px;
        min-width: 0;
      }
      .agent-task-coordination-row strong {
        color: var(--text);
      }
      .agent-task-helper-chain {
        display: grid;
        gap: 6px;
        margin-left: 18px;
      }
      .agent-task-helper-row {
        align-items: center;
        background: color-mix(in srgb, var(--bg-elevated) 52%, transparent);
        border: 1px solid var(--border);
        border-radius: 9px;
        display: grid;
        gap: 8px;
        grid-template-columns: 10px auto minmax(0, 1fr) auto;
        min-height: 38px;
        padding: 7px 10px;
      }
      .agent-task-helper-row__rail {
        border-bottom: 1px solid var(--border-strong);
        border-left: 1px solid var(--border-strong);
        height: 16px;
        width: 10px;
      }
      .agent-task-helper-row__main {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .agent-task-helper-row__main strong,
      .agent-task-helper-row__main span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-task-helper-row__main strong {
        font-size: 12px;
      }
      .agent-task-helper-row__main span {
        font-size: 11px;
      }
      .agent-task-row {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
        overflow: hidden;
      }
      .agent-task-row summary {
        align-items: center;
        cursor: pointer;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 10px;
        list-style: none;
        min-height: 46px;
        padding: 8px 12px;
      }
      .agent-task-row summary::-webkit-details-marker {
        display: none;
      }
      .agent-task-row summary::after {
        color: var(--muted);
        content: "▾";
        font-size: 12px;
        justify-self: end;
        margin-left: 6px;
        transition: transform var(--duration-fast) ease;
      }
      .agent-task-row[open] summary::after {
        transform: rotate(180deg);
      }
      .agent-task-title-line,
      .agent-task-meta-line {
        align-items: center;
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        min-width: 0;
      }
      .agent-task-summary {
        min-width: 0;
      }
      .agent-task-title {
        flex: 0 1 auto;
        font-weight: 650;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .task-status-dot {
        border-radius: 999px;
        flex: 0 0 auto;
        height: 9px;
        width: 9px;
      }
      .task-status-dots {
        align-items: center;
        display: inline-flex;
        flex: 0 0 auto;
        gap: 4px;
        min-width: 9px;
      }
      .task-status-dot--ok,
      .task-run-log-dot--ok {
        background: var(--ok);
      }
      .task-status-dot--warn,
      .task-run-log-dot--warn {
        background: var(--warn);
      }
      .task-status-dot--danger,
      .task-run-log-dot--danger {
        background: var(--danger);
      }
      .task-status-dot--info,
      .task-run-log-dot--info {
        background: var(--accent);
      }
      .task-status-dot--muted,
      .task-run-log-dot--muted {
        background: var(--muted);
      }
      .agent-task-id {
        color: var(--muted);
        flex: 0 2 auto;
        font-size: 12px;
        max-width: 260px;
        min-width: 70px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-task-status {
        flex: 0 0 auto;
      }
      .agent-task-view-only {
        border-color: var(--border-strong);
        color: var(--muted);
        flex: 0 0 auto;
      }
      .agent-task-help,
      .agent-task-ledger-help {
        align-items: center;
        color: var(--muted);
        display: inline-flex;
        flex: 0 0 auto;
        height: 18px;
        justify-content: center;
        position: relative;
        width: 18px;
      }
      .agent-task-help:hover,
      .agent-task-help:focus-visible,
      .agent-task-ledger-help:hover,
      .agent-task-ledger-help:focus-visible {
        color: var(--text);
        outline: none;
      }
      .agent-task-help::after,
      .agent-task-ledger-help::after {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        color: var(--text);
        content: attr(data-tooltip);
        font-size: 12px;
        font-weight: 520;
        left: 0;
        line-height: 1.45;
        opacity: 0;
        padding: 10px 12px;
        pointer-events: none;
        position: absolute;
        top: calc(100% + 8px);
        transform: translateY(-2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease;
        white-space: normal;
        width: min(360px, calc(100vw - 48px));
        z-index: 60;
      }
      .agent-task-help:hover::after,
      .agent-task-help:focus-visible::after,
      .agent-task-ledger-help:hover::after,
      .agent-task-ledger-help:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
      }
      .agent-task-help svg,
      .agent-task-ledger-help svg {
        height: 14px;
        width: 14px;
      }
      .agent-task-ledger-note {
        border-bottom: 1px solid var(--border);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        margin: -2px 0 10px;
        padding: 0 0 10px;
      }
      .agent-task-source-note {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        padding: 8px 10px;
      }
      .agent-task-source-actions {
        border-top: 1px solid var(--border);
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        justify-content: space-between;
        padding-top: 10px;
      }
      .agent-task-source-actions__title {
        color: var(--muted);
        font-size: 12px;
        font-weight: 650;
      }
      .agent-task-source-actions__buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .agent-task-source-actions__buttons .btn {
        align-items: center;
        display: inline-flex;
        gap: 6px;
      }
      .agent-task-source-actions__buttons svg {
        height: 14px;
        width: 14px;
      }
      .agent-task-row > .agent-task-source-actions {
        margin: 0 16px 16px;
      }
      .task-source-filter-field {
        min-width: 150px;
      }
      .agent-task-actions {
        display: flex;
        flex-wrap: nowrap;
        gap: 6px;
        justify-content: flex-end;
      }
      .agent-task-icon-button {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-full);
        color: var(--muted);
        cursor: pointer;
        display: inline-flex;
        height: 30px;
        justify-content: center;
        padding: 0;
        width: 30px;
      }
      .agent-task-icon-button:hover,
      .agent-task-icon-button:focus-visible {
        background: var(--secondary);
        color: var(--text);
        outline: none;
      }
      .agent-task-icon-button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .agent-task-icon-button--danger:hover,
      .agent-task-icon-button--danger:focus-visible {
        color: var(--danger);
      }
      .agent-task-icon-button svg {
        fill: none;
        height: 15px;
        stroke: currentColor;
        width: 15px;
      }
      .agent-task-body {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 12px;
        padding: 14px 16px 16px;
      }
      .agent-task-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .agent-task-field {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px;
        min-width: 0;
      }
      .agent-task-field--wide {
        grid-column: 1 / -1;
      }
      .agent-task-field-label {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .agent-task-field-value {
        margin-top: 4px;
        overflow-wrap: anywhere;
      }
      .task-run-log {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }
      .task-run-log-entry {
        align-items: start;
        background: color-mix(in srgb, var(--bg-elevated) 78%, transparent);
        border: 1px solid var(--border);
        border-radius: 9px;
        display: grid;
        gap: 8px;
        grid-template-columns: auto minmax(0, 1fr);
        padding: 8px 10px;
      }
      .task-run-log-dot {
        border-radius: 999px;
        height: 7px;
        margin-top: 5px;
        width: 7px;
      }
      .task-run-log-label {
        display: block;
        font-size: 13px;
        font-weight: 650;
      }
      .task-run-log-detail {
        color: var(--muted);
        display: block;
        font-size: 12px;
        margin-top: 2px;
        overflow-wrap: anywhere;
      }
      .agent-task-workflow {
        display: grid;
        gap: 10px;
      }
      .agent-task-workflow-head {
        align-items: start;
        display: flex;
        gap: 10px;
        justify-content: space-between;
      }
      .agent-task-workflow-state {
        align-items: center;
        display: flex;
        gap: 8px;
        margin-top: 4px;
        min-width: 0;
      }
      .agent-task-workflow-state strong {
        font-size: 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-task-workflow-meta {
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        font-size: 12px;
        gap: 8px;
      }
      .agent-task-workflow-meta span:not(:last-child)::after {
        content: "·";
        margin-left: 8px;
      }
      .agent-task-workflow-approval {
        margin: 0;
      }
      .agent-task-workflow-steps {
        border-top: 1px solid var(--border);
        display: grid;
      }
      .agent-task-workflow-step {
        align-items: start;
        border-bottom: 1px solid var(--border);
        display: grid;
        gap: 9px;
        grid-template-columns: auto auto minmax(0, 1fr);
        padding: 9px 0;
      }
      .agent-task-workflow-step:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }
      .agent-task-workflow-step-index {
        color: var(--muted);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        line-height: 18px;
        min-width: 18px;
        text-align: right;
      }
      .agent-task-workflow-step .task-status-dot {
        margin-top: 4px;
      }
      .agent-task-workflow-step-main {
        min-width: 0;
      }
      .agent-task-workflow-step-title {
        font-size: 13px;
        font-weight: 650;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .agent-task-workflow-step-detail {
        color: var(--muted);
        font-size: 12px;
        margin-top: 2px;
        overflow-wrap: anywhere;
      }
      .task-repair-controls {
        display: grid;
        gap: 10px;
      }
      .task-repair-note {
        color: var(--muted);
        display: grid;
        gap: 3px;
        font-size: 13px;
      }
      .task-repair-source-row,
      .task-repair-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .task-repair-source-input {
        flex: 1 1 240px;
        min-width: 0;
      }
      .agent-task-toolbar {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: space-between;
      }
      .agent-task-toolbar__primary,
      .agent-task-toolbar__stats {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .agent-task-toolbar__primary {
        min-height: 32px;
      }
      .agent-task-toolbar .btn {
        align-items: center;
        display: inline-flex;
        gap: 6px;
      }
      .agent-task-toolbar .btn svg {
        height: 14px;
        width: 14px;
      }
      .agent-task-modal-backdrop {
        align-items: center;
        background: rgb(0 0 0 / 58%);
        display: flex;
        inset: 0;
        justify-content: center;
        padding: 24px;
        position: fixed;
        z-index: 90;
      }
      .agent-task-modal-panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 24px 80px rgb(0 0 0 / 38%);
        display: grid;
        gap: 14px;
        max-height: min(760px, calc(100vh - 48px));
        max-width: min(840px, calc(100vw - 32px));
        overflow: auto;
        padding: 16px;
        width: 840px;
      }
      .agent-task-modal-panel--wide {
        max-width: min(1240px, calc(100vw - 32px));
        width: 1240px;
      }
      .agent-task-modal-head {
        align-items: flex-start;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }
      .agent-task-modal-title {
        align-items: center;
        display: inline-flex;
        font-size: 16px;
        font-weight: 750;
        gap: 8px;
      }
      .agent-task-modal-title svg {
        height: 16px;
        width: 16px;
      }
      .agent-task-filters {
        background: var(--surface);
        display: grid;
        gap: 10px;
        grid-template-columns:
          minmax(220px, 1fr) minmax(140px, 170px) minmax(130px, 170px)
          minmax(140px, 180px) minmax(120px, 150px);
        margin-top: 12px;
        padding-block: 4px;
        position: sticky;
        top: 0;
        z-index: 3;
      }
      .agent-task-workbench-note {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 9px;
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        font-size: 12px;
        gap: 8px 10px;
        line-height: 1.45;
        margin-top: 12px;
        padding: 9px 11px;
      }
      .agent-task-workbench-note strong {
        color: var(--text);
        font-size: 12px;
      }
      .agent-task-workbench-note span {
        min-width: 0;
      }
      .webhook-trigger-panel,
      .agent-task-ledger {
        border: 1px solid var(--border);
        border-radius: 10px;
        margin-top: 12px;
        overflow: hidden;
      }
      .webhook-trigger-panel--flat,
      .agent-task-ledger--flat {
        overflow: visible;
      }
      .webhook-trigger-panel summary,
      .agent-task-ledger summary,
      .agent-task-ledger-head {
        align-items: center;
        cursor: pointer;
        display: flex;
        gap: 10px;
        justify-content: space-between;
        list-style: none;
        min-height: 44px;
        padding: 8px 12px;
      }
      .agent-task-ledger-head {
        cursor: default;
      }
      .webhook-trigger-panel summary::-webkit-details-marker,
      .agent-task-ledger summary::-webkit-details-marker {
        display: none;
      }
      .webhook-trigger-summary,
      .webhook-trigger-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        min-width: 0;
      }
      .webhook-trigger-summary svg,
      .webhook-trigger-actions svg {
        fill: none;
        height: 15px;
        stroke: currentColor;
        width: 15px;
      }
      .webhook-trigger-body,
      .agent-task-ledger-body {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 12px;
        min-height: 84px;
        padding: 12px;
      }
      .agent-task-ledger-body > .agent-task-list {
        max-height: min(58vh, 760px);
        min-height: 240px;
        overflow: auto;
        padding-right: 2px;
        scrollbar-gutter: stable;
      }
      .agent-task-ledger-pager {
        align-items: center;
        color: var(--muted);
        display: flex;
        font-size: 12px;
        gap: 8px;
        justify-content: space-between;
      }
      .agent-task-ledger-pager-actions {
        align-items: center;
        display: inline-flex;
        gap: 6px;
      }
      .webhook-trigger-panel--flat .webhook-trigger-body,
      .agent-task-ledger--flat .agent-task-ledger-body {
        border-top: 0;
      }
      .agent-task-ledger-empty {
        align-items: center;
        color: var(--muted);
        display: flex;
        min-height: 120px;
        padding: 12px 2px;
      }
      .webhook-trigger-editor {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .webhook-trigger-editor textarea {
        min-height: 110px;
        resize: vertical;
      }
      .webhook-trigger-field--wide {
        grid-column: 1 / -1;
      }
      .webhook-trigger-editor-actions,
      .webhook-trigger-list {
        display: grid;
        gap: 8px;
        grid-column: 1 / -1;
      }
      .webhook-trigger-editor-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
      }
      .agent-task-section-title {
        align-items: center;
        color: var(--muted);
        display: flex;
        font-size: 12px;
        font-weight: 700;
        gap: 8px;
        letter-spacing: 0;
        min-height: 24px;
      }
      .agent-task-section-title--workbench {
        justify-content: space-between;
        margin-top: 12px;
      }
      .agent-task-section-title--workbench > span:last-child:not(:first-child) {
        font-weight: 500;
      }
      .workflow-graph-builder {
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 12px;
        padding: 12px;
      }
      .workflow-graph-fields {
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(160px, 1fr) 150px minmax(220px, 2fr);
      }
      .workflow-graph-field-wide {
        min-width: 0;
      }
      .workflow-graph-toolbar,
      .workflow-graph-layout,
      .workflow-graph-edge-row {
        display: flex;
        gap: 8px;
      }
      .workflow-graph-toolbar {
        align-items: center;
        flex-wrap: wrap;
      }
      .workflow-graph-toolbar-hint {
        color: var(--muted);
        flex: 1 1 220px;
        font-size: 12px;
        min-width: 180px;
      }
      .workflow-graph-action-note {
        align-self: center;
        flex: 1 1 260px;
        font-size: 12px;
        min-width: min(100%, 260px);
      }
      .workflow-graph-run-state {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 10px;
        grid-template-columns: auto minmax(0, 1fr) auto;
        padding: 10px;
      }
      .workflow-graph-run-state-main {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .workflow-graph-run-state-main strong,
      .workflow-graph-run-state-main span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .workflow-graph-run-state-main span {
        color: var(--muted);
        font-size: 12px;
      }
      .workflow-graph-layout {
        align-items: stretch;
      }
      .workflow-graph-canvas {
        background: color-mix(in srgb, var(--surface) 88%, transparent);
        border: 1px solid var(--border);
        border-radius: 8px;
        cursor: grab;
        height: 360px;
        min-width: 420px;
        overflow: auto;
        position: relative;
        resize: vertical;
        width: 100%;
      }
      .workflow-graph-edges {
        height: 2200px;
        left: 0;
        overflow: visible;
        position: absolute;
        top: 0;
        width: 2200px;
      }
      .workflow-graph-edges path {
        fill: none;
        pointer-events: none;
        stroke: var(--border-strong);
        stroke-width: 2;
      }
      .workflow-graph-edges line.workflow-graph-edge-hit {
        cursor: pointer;
        opacity: 0;
        pointer-events: stroke;
        stroke: transparent;
        stroke-width: 18;
      }
      .workflow-graph-edges marker path {
        fill: var(--border-strong);
      }
      .workflow-graph-edges text {
        fill: var(--muted);
        font-size: 11px;
        pointer-events: none;
      }
      .workflow-graph-edges .selected path {
        stroke: var(--text);
        stroke-width: 3;
      }
      .workflow-graph-node {
        align-items: center;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
        display: grid;
        gap: 8px;
        grid-template-columns: 28px minmax(0, 1fr) auto;
        min-height: 72px;
        padding: 8px;
        position: absolute;
        width: 260px;
      }
      .workflow-graph-node.selected {
        border-color: var(--text);
      }
      .workflow-graph-node.has-run-state {
        border-color: var(--border-strong);
      }
      .workflow-graph-node--run-succeeded {
        border-color: color-mix(in srgb, var(--ok) 70%, var(--border));
      }
      .workflow-graph-node--run-running,
      .workflow-graph-node--run-queued {
        border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
      }
      .workflow-graph-node--run-blocked,
      .workflow-graph-node--run-failed,
      .workflow-graph-node--run-lost {
        border-color: color-mix(in srgb, var(--danger) 70%, var(--border));
      }
      .workflow-graph-node--run-cancelled,
      .workflow-graph-node--run-skipped {
        border-color: color-mix(in srgb, var(--warn) 70%, var(--border));
      }
      .workflow-graph-node-drag {
        align-items: center;
        background: transparent;
        border: 0;
        color: var(--muted);
        cursor: grab;
        display: inline-flex;
        height: 28px;
        justify-content: center;
        padding: 0;
        width: 28px;
      }
      .workflow-graph-node-title {
        align-items: center;
        display: grid;
        font-size: 13px;
        font-weight: 700;
        gap: 6px;
        grid-template-columns: auto minmax(0, 1fr);
        min-width: 0;
      }
      .workflow-graph-node-title span:last-child {
        display: -webkit-box;
        line-height: 1.25;
        max-height: 32px;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        white-space: normal;
      }
      .workflow-graph-node-meta {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .workflow-graph-node-meta {
        color: var(--muted);
        font-size: 11px;
      }
      .workflow-graph-node-run-error {
        color: var(--danger);
        font-size: 11px;
        margin-top: 2px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .workflow-graph-connect {
        align-items: center;
        display: inline-flex;
        gap: 5px;
        justify-content: center;
        min-width: 56px;
      }
      .workflow-graph-connect svg {
        height: 13px;
        width: 13px;
      }
      .workflow-graph-connect span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .workflow-graph-side {
        display: grid;
        gap: 12px;
        min-width: 260px;
        width: 300px;
      }
      .workflow-graph-run-timeline {
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      .workflow-graph-run-chip {
        border-color: var(--border);
      }
      .workflow-graph-run-chip--ok {
        border-color: color-mix(in srgb, var(--ok) 55%, var(--border));
      }
      .workflow-graph-run-chip--info {
        border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
      }
      .workflow-graph-run-chip--warn {
        border-color: color-mix(in srgb, var(--warn) 55%, var(--border));
      }
      .workflow-graph-run-chip--danger {
        border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
      }
      .workflow-graph-run-timeline-summary,
      .workflow-graph-run-step {
        align-items: flex-start;
        display: grid;
        gap: 8px;
        grid-template-columns: auto minmax(0, 1fr);
      }
      .workflow-graph-run-timeline-summary {
        grid-template-columns: auto minmax(0, 1fr);
      }
      .workflow-graph-run-timeline-summary strong,
      .workflow-graph-run-timeline-summary span,
      .workflow-graph-run-step-main strong,
      .workflow-graph-run-step-main span,
      .workflow-graph-run-step-main em {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .workflow-graph-run-timeline-summary div,
      .workflow-graph-run-step-main {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .workflow-graph-run-timeline-summary span,
      .workflow-graph-run-step-main span {
        color: var(--muted);
        font-size: 12px;
      }
      .workflow-graph-run-step-list {
        display: grid;
        gap: 6px;
        max-height: 220px;
        overflow: auto;
        padding-right: 2px;
      }
      .workflow-graph-run-step {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        color: var(--text);
        cursor: pointer;
        grid-template-columns: 22px auto minmax(0, 1fr);
        padding: 7px;
        text-align: left;
      }
      .workflow-graph-run-step:hover:not(:disabled),
      .workflow-graph-run-step.is-focus {
        background: var(--surface);
        border-color: var(--border);
      }
      .workflow-graph-run-step:disabled {
        cursor: default;
        opacity: 0.78;
      }
      .workflow-graph-run-step-index {
        color: var(--muted);
        font-size: 11px;
        padding-top: 1px;
      }
      .workflow-graph-run-step-main em {
        color: var(--danger);
        font-size: 11px;
        font-style: normal;
        white-space: normal;
      }
      .workflow-graph-editor-panel,
      .workflow-graph-edge-list {
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      .workflow-graph-edge-row {
        align-items: center;
      }
      .workflow-graph-edge-row select {
        min-width: 0;
        width: 100%;
      }
      .workflow-graph-json {
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      .workflow-graph-json textarea {
        min-height: 220px;
      }
      .workflow-template-row {
        align-items: flex-start;
        position: relative;
      }
      .workflow-template-row .webhook-trigger-main strong,
      .workflow-template-row .webhook-trigger-main span {
        overflow: visible;
        overflow-wrap: anywhere;
        text-overflow: clip;
        white-space: normal;
      }
      .workflow-template-actions {
        align-items: center;
        display: inline-flex;
        flex-wrap: wrap;
        gap: 6px;
        justify-content: flex-end;
      }
      .workflow-template-actions .btn,
      .workflow-template-preview-actions .btn {
        align-items: center;
        display: inline-flex;
        gap: 6px;
      }
      .workflow-template-actions svg,
      .workflow-template-preview-actions svg {
        height: 14px;
        width: 14px;
      }
      .workflow-template-source-badge {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        color: var(--muted);
        display: inline-flex;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0;
        line-height: 1;
        margin-left: 6px;
        min-height: 18px;
        padding: 0 7px;
        text-transform: none;
        vertical-align: middle;
      }
      .workflow-template-source-badge--wallet,
      .workflow-template-source-badge--marketplace,
      .workflow-template-source-badge--mining {
        border-color: color-mix(in srgb, var(--warn) 45%, var(--border));
        color: var(--warn);
      }
      .workflow-template-source-badge--channels,
      .workflow-template-source-badge--media,
      .workflow-template-source-badge--services {
        border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
        color: var(--accent);
      }
      .workflow-template-preview-dialog {
        background: transparent;
        border: 0;
        color: var(--text);
        max-height: min(760px, calc(100vh - 48px));
        max-width: min(860px, calc(100vw - 32px));
        padding: 0;
        width: 860px;
      }
      .workflow-template-preview-dialog::backdrop {
        background: rgb(0 0 0 / 58%);
      }
      .workflow-template-preview-panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 24px 80px rgb(0 0 0 / 38%);
        display: grid;
        gap: 14px;
        max-height: min(760px, calc(100vh - 48px));
        overflow: auto;
        padding: 16px;
      }
      .workflow-template-preview-head,
      .workflow-template-preview-actions {
        align-items: flex-start;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }
      .workflow-template-preview-title {
        font-size: 16px;
        font-weight: 750;
      }
      .workflow-template-preview-badges {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .workflow-template-preview-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      }
      .workflow-template-preview-grid section {
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 8px;
        min-width: 0;
        padding: 12px;
      }
      .workflow-template-preview-grid h4,
      .workflow-template-preview-grid p {
        margin: 0;
      }
      .workflow-template-preview-grid h4 {
        font-size: 12px;
      }
      .workflow-template-preview-grid p {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .workflow-template-preview-list {
        display: grid;
        gap: 6px;
        max-height: 340px;
        overflow: auto;
      }
      .workflow-template-library-list {
        display: grid;
        gap: 8px;
        max-height: min(58vh, 560px);
        overflow: auto;
        padding-right: 2px;
      }
      .workflow-template-preview-step {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 8px;
        display: grid;
        gap: 8px;
        grid-template-columns: 22px auto minmax(0, 1fr);
        min-height: 40px;
        padding: 7px 8px;
      }
      .workflow-template-preview-step > span:last-child {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .workflow-template-preview-step strong,
      .workflow-template-preview-step span span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .workflow-template-preview-step strong {
        font-size: 12px;
      }
      .workflow-template-preview-step span span {
        color: var(--muted);
        font-size: 11px;
      }
      .workflow-template-preview-actions {
        border-top: 1px solid var(--border);
        justify-content: flex-end;
        padding-top: 12px;
      }
      @media (max-width: 980px) {
        .workflow-graph-fields,
        .workflow-graph-layout {
          grid-template-columns: 1fr;
        }
        .workflow-graph-layout {
          display: grid;
        }
        .workflow-graph-side {
          width: auto;
        }
        .workflow-template-preview-grid {
          grid-template-columns: 1fr;
        }
        .workflow-template-actions {
          justify-content: flex-start;
        }
      }
      .webhook-trigger-row {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 9px;
        display: grid;
        gap: 10px;
        grid-template-columns: auto minmax(0, 1fr) auto;
        min-height: 44px;
        padding: 8px 10px;
      }
      .webhook-trigger-main {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      .webhook-trigger-main strong,
      .webhook-trigger-main span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      @container (max-width: 620px) {
        .agent-task-row summary,
        .agent-task-grid,
        .agent-task-filters,
        .webhook-trigger-editor,
        .webhook-trigger-row {
          grid-template-columns: 1fr;
        }
        .agent-task-title-line,
        .agent-task-meta-line {
          flex-wrap: wrap;
        }
        .agent-task-actions {
          justify-content: flex-start;
        }
      }
    </style>
    <section class="card">
      <div class="agent-task-toolbar">
        <div class="agent-task-toolbar__primary">
          <button
            class="btn btn--sm primary"
            type="button"
            data-agent-task-create="true"
            @click=${() => params.onCreate(params.agentId)}
          >
            ${icons.plus} Task
          </button>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${params.webhookTriggers?.busy}
            aria-label="Create webhook trigger"
            title=${WEBHOOK_TRIGGER_HELP}
            data-agent-task-trigger-create="true"
            @click=${() => params.onWebhookTriggerCreate?.(params.agentId)}
          >
            ${icons.plus} Trigger
          </button>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${params.taskWorkflow?.busy}
            aria-label="Create workflow"
            data-agent-task-workflow-create="true"
            @click=${() => params.onTaskWorkflowCreate?.(params.agentId)}
          >
            ${icons.plus} Workflow
          </button>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${params.taskWorkflow?.busy}
            aria-label="Create graph workflow"
            data-agent-task-graph-create="true"
            @click=${() => params.onTaskWorkflowGraphCreate?.(params.agentId)}
          >
            ${icons.plus} Graph
          </button>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${params.taskStandingOrders?.busy}
            aria-label="Create program"
            title="Create an Agent-scoped Program that proposes Tasks or Workflows for review."
            @click=${() => params.onTaskStandingOrderCreate?.(params.agentId)}
          >
            ${icons.plus} Program
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${params.taskWorkflow?.templatesLoading}
            aria-label="Open templates"
            title="Open Task and Workflow templates"
            data-agent-task-template-library="true"
            @click=${openWorkflowTemplateLibrary}
          >
            ${icons.fileText} Templates
          </button>
          ${renderWorkflowTemplateLibraryDialog({
            agentId: params.agentId,
            templates: workflowTemplates,
            loading: params.taskWorkflow?.templatesLoading,
            error: params.taskWorkflow?.templatesError,
            disabled: params.taskWorkflow?.busy,
            onUseTemplate: params.onTaskWorkflowUseTemplate,
            onUseTaskTemplate: params.onTaskTemplateUse,
          })}
          ${renderAgentTaskHelp(AGENT_TASK_WORKBENCH_HELP, "Tasks help")}
          <span class="chip">${allAgentJobs.length} task${allAgentJobs.length === 1 ? "" : "s"}</span>
          <span class="chip">${triggerCount} trigger${triggerCount === 1 ? "" : "s"}</span>
          <span class="chip">${workflowDefinitionCount} workflow${workflowDefinitionCount === 1 ? "" : "s"}</span>
          <span class="chip">${graphDefinitionCount} graph${graphDefinitionCount === 1 ? "" : "s"}</span>
          <span class="chip">${programCount} program${programCount === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="agent-task-filters">
        <label class="field">
          <input
            aria-label=${showRunHistory ? "Search run history" : "Search tasks"}
            .value=${taskFilters.query}
            placeholder=${showRunHistory ? "Search run history" : "Search tasks"}
            @input=${(event: Event) =>
              params.onTaskFiltersChange?.({ query: (event.target as HTMLInputElement).value })}
          />
        </label>
        ${renderTaskWorkFilter({
          typeFilter: activeTypeFilter,
          loading: params.taskLedger?.loading ?? false,
          scheduledCount: allAgentJobs.length,
          triggerCount,
          workflowCount: workflowDefinitionCount,
          graphCount: graphDefinitionCount,
          programCount,
          historyCount: ledgerTotal,
          onTypeFilterChange: params.onTaskLedgerTypeFilterChange,
        })}
        ${
          showRunHistory
            ? html`
                ${renderTaskSourceFilter({
                  result: params.taskLedger?.result ?? null,
                  sourceFilter: params.taskLedger?.sourceFilter ?? "all",
                  loading: params.taskLedger?.loading ?? false,
                  onSourceFilterChange: params.onTaskLedgerSourceFilterChange,
                })}
                ${renderTaskStatusFilter({
                  result: params.taskLedger?.result ?? null,
                  statusFilter: params.taskLedger?.statusFilter ?? "all",
                  loading: params.taskLedger?.loading ?? false,
                  onStatusFilterChange: params.onTaskLedgerStatusFilterChange,
                })}
              `
            : nothing
        }
        <label class="field">
          <select
            aria-label="Task date sort"
            .value=${taskFilters.sortDir}
            @change=${(event: Event) =>
              params.onTaskFiltersChange?.({
                sortDir: (event.target as HTMLSelectElement).value as typeof taskFilters.sortDir,
              })}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
      </div>
      ${
        hasVisibleDefinitions
          ? nothing
          : showRunHistory
            ? nothing
            : html`
              <div class="muted" style="margin-top: 12px">
                ${definitionTotal === 0 ? "No tasks." : "No tasks match this view."}
              </div>
            `
      }
      ${
        showWebhookTriggers && params.webhookTriggers
          ? renderWebhookTriggerPanel({
              agentId: params.agentId,
              triggersState: params.webhookTriggers,
              workflowDefinitions: params.taskWorkflow?.definitions,
              activityTasks: ledgerTasks,
              onCreate: params.onWebhookTriggerCreate,
              onEdit: params.onWebhookTriggerEdit,
              onPatch: params.onWebhookTriggerPatch,
              onSave: params.onWebhookTriggerSave,
              onCancel: params.onWebhookTriggerCancel,
              onRemove: params.onWebhookTriggerRemove,
              onToggle: params.onWebhookTriggerToggle,
              onTest: params.onWebhookTriggerTest,
            })
          : nothing
      }
      ${
        showWorkflowDefinitions && params.taskWorkflow
          ? renderWorkflowPanel({
              agentId: params.agentId,
              state: params.taskWorkflow,
              onCreate: params.onTaskWorkflowCreate,
              onGraphCreate: params.onTaskWorkflowGraphCreate,
              onUseTemplate: params.onTaskWorkflowUseTemplate,
              onPatch: params.onTaskWorkflowPatch,
              onGraphPatch: params.onTaskWorkflowGraphPatch,
              onGraphAddNode: params.onTaskWorkflowGraphAddNode,
              onGraphUpdateNode: params.onTaskWorkflowGraphUpdateNode,
              onGraphRemoveNode: params.onTaskWorkflowGraphRemoveNode,
              onGraphMoveNode: params.onTaskWorkflowGraphMoveNode,
              onGraphAddEdge: params.onTaskWorkflowGraphAddEdge,
              onGraphUpdateEdge: params.onTaskWorkflowGraphUpdateEdge,
              onGraphRemoveEdge: params.onTaskWorkflowGraphRemoveEdge,
              onGraphAutoLayout: params.onTaskWorkflowGraphAutoLayout,
              onGraphImportJson: params.onTaskWorkflowGraphImportJson,
              onGraphExportJson: params.onTaskWorkflowGraphExportJson,
              onPreview: params.onTaskWorkflowPreview,
              onGraphPreview: params.onTaskWorkflowGraphPreview,
              onSave: params.onTaskWorkflowSave,
              onGraphSave: params.onTaskWorkflowGraphSave,
              onRun: params.onTaskWorkflowRun,
              onGraphRun: params.onTaskWorkflowGraphRun,
              onEditDefinition: params.onTaskWorkflowEditDefinition,
              onEditGraphDefinition: params.onTaskWorkflowEditGraphDefinition,
              onRunDefinition: params.onTaskWorkflowRunDefinition,
              onRemoveDefinition: params.onTaskWorkflowRemoveDefinition,
              onOpenRunGraph: params.onTaskWorkflowOpenRunGraph,
              onCancelRun: params.onTaskWorkflowCancelRun,
              onOpenSource: params.onTaskLedgerOpenSource,
              onCancel: params.onTaskWorkflowCancel,
              modeFilter:
                activeTypeFilter === "graph"
                  ? "graph"
                  : activeTypeFilter === "workflow"
                    ? "workflow"
                    : "all",
            })
          : nothing
      }
      ${
        showPrograms && params.taskStandingOrders
          ? renderStandingOrdersPanel({
              agentId: params.agentId,
              state: params.taskStandingOrders,
              onCreate: params.onTaskStandingOrderCreate,
              onEdit: params.onTaskStandingOrderEdit,
              onPatch: params.onTaskStandingOrderPatch,
              onSave: params.onTaskStandingOrderSave,
              onRemove: params.onTaskStandingOrderRemove,
              onPropose: params.onTaskStandingOrderPropose,
              onCancel: params.onTaskStandingOrderCancel,
              query: taskFilters.query,
              typeFilter: activeTypeFilter,
            })
          : nothing
      }
      ${
        showRunHistory && params.taskLedger
          ? renderTaskLedger({
              agentId: params.agentId,
              jobs: allAgentJobs,
              result: params.taskLedger.result,
              loading: params.taskLedger.loading,
              busy: params.taskLedger.busy,
              error: params.taskLedger.error,
              sourceFilter: params.taskLedger.sourceFilter,
              typeFilter: "history",
              statusFilter: params.taskLedger.statusFilter,
              searchQuery: taskFilters.query,
              details: params.taskLedger.details,
              detailLoading: params.taskLedger.detailLoading,
              detailErrors: params.taskLedger.detailErrors,
              onDetailOpen: params.onTaskLedgerDetailOpen,
              onControl: params.onTaskLedgerControl,
              onOpenSession: params.onOpenSession,
              onOpenSource: params.onTaskLedgerOpenSource,
              onWorkflowReview: params.onTaskLedgerWorkflowReview,
              onPageChange: params.onTaskLedgerPageChange,
            })
          : showRunHistory
            ? html`
                <div class="agent-task-ledger-empty">Run history has not loaded yet.</div>
              `
            : nothing
      }
      ${
        showScheduledDefinitions
          ? html`
                  <div class="agent-task-section-title agent-task-section-title--workbench">
                <span>Tasks</span>
                <span class="chip">${jobs.length} shown</span>
              </div>
              ${
                params.error
                  ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
                  : nothing
              }
              ${
                jobs.length === 0
                  ? html`
                      <div class="muted" style="margin-top: 16px">No tasks match this view.</div>
                    `
                  : html`
              <div class="agent-task-list">
                ${repeat(
                  jobs,
                  (job) => job.id,
                  (job) => {
                    const runDetails = formatTaskRunLog(job);
                    const setupTarget = setupTargetForAccess(job.state?.needsAccess);
                    const openSessionKey = job.state?.lastRunSessionKey ?? job.sessionKey ?? "";
                    const openSessionLabel = job.state?.lastRunSessionKey
                      ? "Open latest run"
                      : "Open chat";
                    const activeRun = taskActiveQueueRun(params.status?.queue, job.id);
                    const failedRun = taskFailedQueueRun(params.status?.queue, job.id);
                    const latestRunId = taskLatestRunId(params.status?.queue, job);
                    const latestDefinitionTask = latestTaskForDefinition(
                      ledgerTasks,
                      "task",
                      job.id,
                    );
                    return html`
                    <details id=${taskLedgerAnchorId("scheduled-task", job.id)} class="agent-task-row">
                      <summary>
                        <div class="agent-task-summary">
                          <div class="agent-task-title-line">
                            ${renderTaskStatusDots(job, activeRun)}
                            <span class="agent-task-title">${job.name}</span>
                            <span class="agent-task-id mono" title=${job.id}>${compactTaskId(job.id)}</span>
                            <span class="chip agent-task-status" title=${job.schedule.kind}>
                              ${formatCompactTaskSchedule(job)}
                            </span>
                          </div>
                          <div class="agent-task-meta-line">
                            <span class="muted">
                              ${taskDeliveryLabel(job)}
                              ${job.state?.lastRunAtMs ? html` · last ${formatRelativeTimestamp(job.state.lastRunAtMs)}` : nothing}
                              · ${taskDefinitionLatestLabel(latestDefinitionTask)}
                            </span>
                          </div>
                        </div>
                        <div
                          class="agent-task-actions"
                          @click=${(event: Event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                        >
                          ${renderTaskIconButton({
                            label: "Edit task",
                            icon: "edit",
                            onClick: () => params.onEdit(job),
                          })}
                          ${renderTaskIconButton({
                            label: "Run now",
                            icon: "zap",
                            onClick: () => params.onRunNow(job.id),
                          })}
                          ${
                            activeRun
                              ? renderTaskIconButton({
                                  label: "Cancel active run",
                                  icon: "stop",
                                  danger: true,
                                  disabled: !params.onQueueControl,
                                  onClick: () => params.onQueueControl?.("cancel", activeRun.runId),
                                })
                              : nothing
                          }
                          ${
                            activeRun?.leaseExpired
                              ? renderTaskIconButton({
                                  label: "Clear stale lease",
                                  icon: "wrench",
                                  disabled: !params.onQueueControl,
                                  onClick: () =>
                                    params.onQueueControl?.("clear-stale", activeRun.runId),
                                })
                              : nothing
                          }
                          ${
                            !activeRun && failedRun
                              ? renderTaskIconButton({
                                  label: "Retry failed run",
                                  icon: "play",
                                  disabled: !params.onQueueControl,
                                  onClick: () => params.onQueueControl?.("retry", failedRun.runId),
                                })
                              : nothing
                          }
                          ${
                            taskCoordinationNeedsApproval(job)
                              ? renderTaskIconButton({
                                  label: "Approve coordination & run",
                                  icon: "check",
                                  disabled: !params.onApproveCoordination,
                                  onClick: () => params.onApproveCoordination?.(job),
                                })
                              : nothing
                          }
                          ${
                            taskHasRunnableCoordination(job)
                              ? renderTaskIconButton({
                                  label: "Retry with Agent evidence",
                                  icon: "refresh",
                                  disabled: !params.onAskAgentEvidence,
                                  onClick: () => params.onAskAgentEvidence?.(job),
                                })
                              : nothing
                          }
                          ${
                            latestRunId && params.onRunDetail
                              ? renderTaskIconButton({
                                  label: "Open latest run",
                                  icon: "externalLink",
                                  onClick: () => params.onRunDetail?.(latestRunId),
                                })
                              : openSessionKey && params.onOpenSession
                                ? renderTaskIconButton({
                                    label: openSessionLabel,
                                    icon: "externalLink",
                                    onClick: () => params.onOpenSession?.(openSessionKey),
                                  })
                                : nothing
                          }
                          ${renderTaskIconButton({
                            label: job.enabled ? "Pause task" : "Resume task",
                            icon: job.enabled ? "pause" : "play",
                            onClick: () => params.onToggle(job, !job.enabled),
                          })}
                          ${renderTaskIconButton({
                            label: "Delete task",
                            icon: "x",
                            danger: true,
                            onClick: () => params.onRemove(job),
                          })}
                        </div>
                      </summary>
                      <div class="agent-task-body">
                        <div class="agent-task-grid">
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Task ID</div>
                            <div class="agent-task-field-value mono">${job.id}</div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Created</div>
                            <div class="agent-task-field-value">
                              ${formatRelativeTimestamp(job.createdAtMs ?? taskSortMs(job))}
                            </div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">State</div>
                            <div class="agent-task-field-value">${formatCronState(job)}</div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Delivery</div>
                            <div class="agent-task-field-value">${taskDeliveryLabel(job)}</div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Session</div>
                            <div class="agent-task-field-value mono">${job.sessionKey ?? "none"}</div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Runtime</div>
                            <div class="agent-task-field-value">${formatCronPayload(job)}</div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Execution</div>
                            <div class="agent-task-field-value">
                              ${job.executionPolicy?.executionMode ?? job.sessionTarget}
                            </div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Model</div>
                            <div class="agent-task-field-value mono">
                              ${job.executionPolicy?.modelPolicy?.model ?? "Agent task default"}
                            </div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Coordination</div>
                            <div class="agent-task-field-value">${taskCoordinationLabel(job)}</div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Adaptive next</div>
                            <div class="agent-task-field-value">
                              ${
                                taskAdaptiveDecision(job)
                                  ? html`
                                      ${taskAdaptiveRouteLabel(taskAdaptiveDecision(job)?.route)}
                                      <span class="muted">
                                        · ${taskAdaptiveDecision(job)?.sampleSize ?? 0}
                                        sample${taskAdaptiveDecision(job)?.sampleSize === 1 ? "" : "s"}
                                      </span>
                                    `
                                  : "not learned yet"
                              }
                            </div>
                          </div>
                          <div class="agent-task-field">
                            <div class="agent-task-field-label">Updated</div>
                            <div class="agent-task-field-value">${formatRelativeTimestamp(taskSortMs(job))}</div>
                          </div>
                        </div>
                        <div class="agent-task-field agent-task-field--wide">
                          <div class="agent-task-field-label">Prompt</div>
                          <div class="agent-task-field-value">${taskPromptPreview(job)}</div>
                        </div>
                        ${
                          runDetails.length > 0
                            ? html`
                                <div class="agent-task-field agent-task-field--wide">
                                  <div class="agent-task-field-label">Run log</div>
                                  ${renderTaskRunLog(runDetails)}
                                </div>
                              `
                            : nothing
                        }
                        ${renderAgentTaskRepairControls({
                          job,
                          onRepair: params.onRepair,
                          onNavigate: params.onNavigate,
                        })}
                        ${
                          taskCoordinationNeedsApproval(job)
                            ? html`
                                <div class="agent-task-field agent-task-field--wide">
                                  <div class="agent-task-field-label">Coordination approval</div>
                                  <div class="task-repair-note">
                                    <span>
                                      This task must be approved before it can consult
                                      ${taskCoordinationAgentsLabel(job)}.
                                    </span>
                                  </div>
                                  <div class="task-repair-actions">
                                    <button
                                      type="button"
                                      class="button-secondary"
                                      ?disabled=${!params.onApproveCoordination}
                                      @click=${(event: Event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        void params.onApproveCoordination?.(job);
                                      }}
                                    >
                                      Approve coordination & run
                                    </button>
                                  </div>
                                </div>
                              `
                            : nothing
                        }
                        ${
                          taskHasRunnableCoordination(job)
                            ? html`
                                <div class="agent-task-field agent-task-field--wide">
                                  <div class="agent-task-field-label">Agent evidence</div>
                                  <div class="task-repair-note">
                                    <span>
                                      Run this task again and ask
                                      ${taskCoordinationAgentsLabel(job)} for task-room evidence.
                                    </span>
                                  </div>
                                  <div class="task-repair-actions">
                                    <button
                                      type="button"
                                      class="button-secondary"
                                      ?disabled=${!params.onAskAgentEvidence}
                                      @click=${(event: Event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        void params.onAskAgentEvidence?.(job);
                                      }}
                                    >
                                      Retry with Agent evidence
                                    </button>
                                  </div>
                                </div>
                              `
                            : nothing
                        }
                        ${renderAgentTaskTrustedSources({
                          job,
                          onSourceToggle: params.onSourceToggle,
                          onSourceRemove: params.onSourceRemove,
                        })}
                        ${
                          job.state?.needsAccess
                            ? html`
                                <div class="callout warn">
                                  <div>Access required before this task can resume.</div>
                                  ${
                                    job.state.needsAccess.setupCommand
                                      ? html`<span class="mono">${job.state.needsAccess.setupCommand}</span>`
                                      : nothing
                                  }
                                  ${
                                    setupTarget && params.onNavigate
                                      ? html`
                                          <button
                                            class="btn btn--sm"
                                            type="button"
                                            @click=${() => {
                                              if (
                                                setupTarget.hash &&
                                                typeof window !== "undefined"
                                              ) {
                                                window.location.hash = setupTarget.hash;
                                              }
                                              params.onNavigate?.(setupTarget.tab);
                                            }}
                                          >
                                            ${setupTarget.label}
                                          </button>
                                        `
                                      : nothing
                                  }
                                </div>
                              `
                            : nothing
                        }
                      </div>
                    </details>
                  `;
                  },
                )}
              </div>
            `
              }
            `
          : nothing
      }
    </section>
  `;
}

export function renderAgentFiles(params: {
  agentId: string;
  agentFilesList: AgentsFilesListResult | null;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFileActive: string | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileSaving: boolean;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
}) {
  const list = params.agentFilesList?.agentId === params.agentId ? params.agentFilesList : null;
  const files = list?.files ?? [];
  const active = params.agentFileActive ?? null;
  const activeEntry = active ? (files.find((file) => file.name === active) ?? null) : null;
  const baseContent = active ? (params.agentFileContents[active] ?? "") : "";
  const draft = active ? (params.agentFileDrafts[active] ?? baseContent) : "";
  const isDirty = active ? draft !== baseContent : false;
  const missingCount = files.filter((file) => file.missing).length;
  const dirtyCount = Object.entries(params.agentFileDrafts).filter(
    ([name, value]) => value !== (params.agentFileContents[name] ?? ""),
  ).length;
  const coreFilesHelp =
    "These workspace files are user-owned bootstrap instructions. Fased will not overwrite old AGENTS.md, SOUL.md, or TOOLS.md content automatically after setup. They are loaded into Agent context when present.";

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title" style="align-items: center; display: flex; gap: 8px;">
            <span>Workspace Files</span>
            <span
              class="agent-help"
              role="img"
              tabindex="0"
              title=${coreFilesHelp}
              aria-label="Core files help"
              data-tooltip=${coreFilesHelp}
              data-agent-files-help="true"
            >
              ${icons.info}
            </span>
          </div>
          <div class="card-sub">Injected instructions and memory references for this Agent.</div>
        </div>
        <div class="agent-files-stats" aria-live="polite">
          <span>${list ? `${files.length} files` : params.agentFilesLoading ? "Loading" : "Not loaded"}</span>
          ${list ? html`<span>${missingCount} missing</span>` : nothing}
          ${dirtyCount ? html`<span>${dirtyCount} edited</span>` : nothing}
        </div>
      </div>
      ${
        list
          ? html`<div class="muted mono" style="margin-top: 8px;">Workspace: ${list.workspace}</div>`
          : nothing
      }
      ${
        params.agentFilesError
          ? html`<div class="callout danger" style="margin-top: 12px;">${params.agentFilesError}</div>`
          : nothing
      }
      ${
        !list
          ? html`
              <div class="callout info" style="margin-top: 12px">
                ${
                  params.agentFilesLoading
                    ? "Loading workspace files."
                    : "Workspace files load automatically when the Files tab opens."
                }
              </div>
            `
          : html`
              <div class="agent-files-grid" style="margin-top: 16px;">
                <div class="agent-files-list">
                  ${
                    files.length === 0
                      ? html`
                          <div class="muted">No files found.</div>
                        `
                      : files.map((file) =>
                          renderAgentFileRow(file, active, () => params.onSelectFile(file.name)),
                        )
                  }
                </div>
                <div class="agent-files-editor">
                  ${
                    !activeEntry
                      ? html`
                          <div class="muted">Select a file to edit.</div>
                        `
                      : html`
                          <div class="agent-file-header">
                            <div>
                              <div class="agent-file-title mono">${activeEntry.name}</div>
                              <div class="agent-file-sub mono">${activeEntry.path}</div>
                            </div>
                            <div class="agent-file-actions">
                              <button
                                class="btn btn--sm"
                                ?disabled=${!isDirty}
                                @click=${() => params.onFileReset(activeEntry.name)}
                              >
                                Reset
                              </button>
                              <button
                                class="btn btn--sm primary"
                                ?disabled=${params.agentFileSaving || !isDirty}
                                @click=${() => params.onFileSave(activeEntry.name)}
                              >
                                ${params.agentFileSaving ? "Saving…" : "Save"}
                              </button>
                            </div>
                          </div>
                          ${
                            activeEntry.missing
                              ? html`
                                  <div class="callout info" style="margin-top: 10px">
                                    This file is missing. Saving will create it in the agent workspace.
                                  </div>
                                `
                              : nothing
                          }
                          <label class="field" style="margin-top: 12px;">
                            <span>Content</span>
                            <textarea
                              .value=${draft}
                              @input=${(e: Event) =>
                                params.onFileDraftChange(
                                  activeEntry.name,
                                  (e.target as HTMLTextAreaElement).value,
                                )}
                            ></textarea>
                          </label>
                        `
                  }
                </div>
              </div>
            `
      }
    </section>
  `;
}

function renderAgentFileRow(file: AgentFileEntry, active: string | null, onSelect: () => void) {
  const status = file.missing
    ? "Missing"
    : `${formatBytes(file.size)} · ${formatRelativeTimestamp(file.updatedAtMs ?? null)}`;
  return html`
    <button
      type="button"
      class="agent-file-row ${active === file.name ? "active" : ""}"
      @click=${onSelect}
    >
      <div>
        <div class="agent-file-name mono">${file.name}</div>
        <div class="agent-file-meta">${status}</div>
      </div>
      ${
        file.missing
          ? html`
              <span class="agent-pill warn">missing</span>
            `
          : nothing
      }
    </button>
  `;
}
