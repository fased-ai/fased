import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { pathForTab } from "../navigation.ts";
import {
  formatCronPayload,
  formatCronSchedule,
  formatCronState,
  formatNextRun,
  formatSessionTokens,
} from "../presenter.ts";
import { normalizeAgentId, parseAgentSessionKey } from "../session-key.ts";
import type { CronJob, GatewaySessionRow, SessionsListResult } from "../types.ts";

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  search: string;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  agentId?: string | null;
  title?: string;
  subtitle?: string;
  showFilters?: boolean | "auto";
  filterControls?: "full" | "search";
  showLiveStatus?: boolean;
  showStorePath?: boolean;
  emptyText?: string;
  connected?: boolean;
  currentSessionKey?: string | null;
  sessionsSubscriptionActive?: boolean;
  sessionsLastEventAt?: number | null;
  sessionMessagesSubscriptionActive?: boolean;
  subscribedSessionMessageKey?: string | null;
  sessionMessageLastEventAt?: number | null;
  onFiltersChange: (next: {
    search: string;
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
      sendPolicy?: "allow" | "deny" | null;
    },
  ) => void;
  onDelete: (key: string) => void;
  onBranchCheckpoint: (key: string, checkpointId: string) => void;
  onRestoreCheckpoint: (key: string, checkpointId: string) => void;
  taskJobs?: CronJob[];
  taskLoading?: boolean;
  configForm?: Record<string, unknown> | null;
  configLoading?: boolean;
  configSaving?: boolean;
  configDirty?: boolean;
  onConfigPatch?: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove?: (path: Array<string | number>) => void;
  onConfigSave?: () => void;
  onConfigReload?: () => void;
  onTaskEdit?: (job: CronJob) => void;
  onTaskRun?: (job: CronJob) => void;
  onTaskOpenRun?: (sessionKey: string) => void;
  onTaskActivityOpen?: (sessionKey: string) => void;
  onTaskToggle?: (job: CronJob, enabled: boolean) => void;
  onTaskCancel?: (job: CronJob) => void;
};

const THINK_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const BINARY_THINK_LEVELS = ["", "off", "on"] as const;
const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off (explicit)" },
  { value: "on", label: "on" },
  { value: "full", label: "full" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
const SESSION_SEND_POLICY_OPTIONS = [
  ["", "inherit"],
  ["allow", "allow"],
  ["deny", "deny"],
] as const;

function normalizeProviderId(provider?: string | null): string {
  if (!provider) {
    return "";
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  return normalized;
}

function isBinaryThinkingProvider(provider?: string | null): boolean {
  return normalizeProviderId(provider) === "zai";
}

function resolveThinkLevelOptions(provider?: string | null): readonly string[] {
  return isBinaryThinkingProvider(provider) ? BINARY_THINK_LEVELS : THINK_LEVELS;
}

function withCurrentOption(options: readonly string[], current: string): string[] {
  if (!current) {
    return [...options];
  }
  if (options.includes(current)) {
    return [...options];
  }
  return [...options, current];
}

function withCurrentLabeledOption(
  options: readonly { value: string; label: string }[],
  current: string,
): Array<{ value: string; label: string }> {
  if (!current) {
    return [...options];
  }
  if (options.some((option) => option.value === current)) {
    return [...options];
  }
  return [...options, { value: current, label: `${current} (custom)` }];
}

function resolveThinkLevelDisplay(value: string, isBinary: boolean): string {
  if (!isBinary) {
    return value;
  }
  if (!value || value === "off") {
    return value;
  }
  return "on";
}

function resolveThinkLevelPatchValue(value: string, isBinary: boolean): string | null {
  if (!value) {
    return null;
  }
  if (!isBinary) {
    return value;
  }
  if (value === "on") {
    return "low";
  }
  return value;
}

function formatLiveEventAt(value?: number | null): string {
  return value ? formatRelativeTimestamp(value) : "No events yet";
}

function sessionAgentId(row: GatewaySessionRow): string | null {
  const parsed = parseAgentSessionKey(row.key);
  return parsed?.agentId ? normalizeAgentId(parsed.agentId) : null;
}

function formatSessionModel(row: GatewaySessionRow): string {
  const provider = row.modelProvider?.trim() ?? "";
  const model = row.model?.trim() ?? "";
  if (!provider && !model) {
    return "Default model";
  }
  if (!provider || model.startsWith(`${provider}/`)) {
    return model || provider;
  }
  return `${provider}/${model}`;
}

function formatDelivery(row: GatewaySessionRow): string {
  const channel = (
    row.deliveryContext?.channel ??
    row.lastChannel ??
    row.channel ??
    row.origin?.channel ??
    ""
  ).trim();
  const target = (row.deliveryContext?.to ?? row.lastTo ?? row.origin?.to ?? "").trim();
  if (!channel || channel === "webchat") {
    return "Local UI";
  }
  return target ? `${channel} -> ${target}` : channel;
}

function formatSourceLabel(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "Local UI";
  }
  if (normalized === "webchat") {
    return "WebChat";
  }
  return normalized
    .split(/[-_:]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sessionSource(row: GatewaySessionRow): string {
  const parsed = parseAgentSessionKey(row.key);
  const rest = parsed?.rest ?? row.key;
  if (rest.startsWith("subagent:") || row.spawnedBy) {
    return "Subagent";
  }
  if (rest.startsWith("cron:") || row.key.startsWith("cron:")) {
    return "Task";
  }
  const explicitChannel = (
    row.deliveryContext?.channel ??
    row.lastChannel ??
    row.channel ??
    row.origin?.channel ??
    row.surface ??
    ""
  ).trim();
  if (explicitChannel) {
    return formatSourceLabel(explicitChannel);
  }
  if (rest.startsWith("webchat:")) {
    return "WebChat";
  }
  if (rest === "main") {
    return "Main chat";
  }
  return "Local UI";
}

function sessionTitle(row: GatewaySessionRow): string {
  return (
    row.label?.trim() ||
    row.derivedTitle?.trim() ||
    row.displayName?.trim() ||
    row.lastMessagePreview?.trim() ||
    row.key
  );
}

function isProtectedMainSessionKey(key: string): boolean {
  const parsed = parseAgentSessionKey(key);
  return key === "main" || parsed?.rest === "main";
}

function sessionSubtitle(row: GatewaySessionRow): string {
  const parts = [sessionAgentId(row), sessionSource(row), row.kind, formatDelivery(row)].filter(
    Boolean,
  );
  return parts.join(" · ");
}

function tasksForSession(row: GatewaySessionRow, jobs?: CronJob[]): CronJob[] {
  if (!jobs?.length) {
    return [];
  }
  return jobs
    .filter((job) => job.sessionKey === row.key || job.state?.lastRunSessionKey === row.key)
    .toSorted((a, b) => {
      const aNext = a.state?.nextRunAtMs ?? Number.POSITIVE_INFINITY;
      const bNext = b.state?.nextRunAtMs ?? Number.POSITIVE_INFINITY;
      if (aNext !== bNext) {
        return aNext - bNext;
      }
      return (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0);
    });
}

function formatTaskCount(count: number): string {
  if (count === 0) {
    return "0 tasks";
  }
  return `${count} task${count === 1 ? "" : "s"}`;
}

function formatSessionTokenPreview(row: GatewaySessionRow): string {
  const value = formatSessionTokens(row);
  return value === "n/a" ? "n/a tokens" : `${value} tokens`;
}

function formatTaskDelivery(job: CronJob): string {
  const delivery = job.delivery;
  if (!delivery || delivery.mode === "none") {
    return "No delivery";
  }
  if (delivery.mode === "webhook") {
    return delivery.to ? `Webhook -> ${delivery.to}` : "Webhook";
  }
  const channel = delivery.channel ?? "last";
  return delivery.to ? `${channel} -> ${delivery.to}` : channel;
}

function formatCheckpointTokens(
  checkpoint: NonNullable<GatewaySessionRow["compactionCheckpoints"]>[number],
): string {
  const before =
    typeof checkpoint.tokensBefore === "number" && Number.isFinite(checkpoint.tokensBefore)
      ? checkpoint.tokensBefore.toLocaleString()
      : null;
  const after =
    typeof checkpoint.tokensAfter === "number" && Number.isFinite(checkpoint.tokensAfter)
      ? checkpoint.tokensAfter.toLocaleString()
      : null;
  if (before && after) {
    return `${before} -> ${after}`;
  }
  return before ?? after ?? "n/a";
}

function renderLiveStatusPill(params: {
  label: string;
  live: boolean;
  connected: boolean;
  lastEventAt?: number | null;
  detail?: string | null;
}) {
  const status = !params.connected ? "Offline" : params.live ? "Live" : "Waiting";
  const tone = !params.connected ? "offline" : params.live ? "live" : "waiting";
  return html`
    <div class="sessions-live__pill ${tone}">
      <span class="sessions-live__dot"></span>
      <span class="sessions-live__label">${params.label}</span>
      <strong>${status}</strong>
      <span class="sessions-live__time">${formatLiveEventAt(params.lastEventAt)}</span>
      ${
        params.detail
          ? html`<span class="sessions-live__detail mono" title=${params.detail}>
            ${params.detail}
          </span>`
          : nothing
      }
    </div>
  `;
}

export function renderSessions(props: SessionsProps) {
  const agentFilter = props.agentId ? normalizeAgentId(props.agentId) : null;
  const rows = (props.result?.sessions ?? []).filter((row) =>
    agentFilter ? sessionAgentId(row) === agentFilter : true,
  );
  const connected = props.connected ?? true;
  const sessionsLive = connected && Boolean(props.sessionsSubscriptionActive);
  const messagesLive = connected && Boolean(props.sessionMessagesSubscriptionActive);
  const totalRows = props.result?.totalCount ?? props.result?.count ?? rows.length;
  const showFilters = props.showFilters === "auto" ? totalRows > 12 : (props.showFilters ?? true);
  const filterControls = props.filterControls ?? "full";
  const showLiveStatus = props.showLiveStatus ?? true;
  const showStorePath = props.showStorePath ?? true;
  const taskBusy = Boolean(props.taskLoading);
  return html`
    <style>
      .sessions-shell {
        display: grid;
        gap: 16px;
      }
      .sessions-card {
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--card);
        box-shadow: var(--shadow-md);
        padding: 16px;
      }
      .sessions-filters {
        margin-top: 14px;
        display: grid;
        grid-template-columns: minmax(220px, 2fr) repeat(2, minmax(110px, 1fr)) repeat(2, auto);
        gap: 12px;
        align-items: end;
      }
      .sessions-filters--search {
        grid-template-columns: minmax(220px, 420px);
      }
      .sessions-live {
        margin-top: 14px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .sessions-live__pill {
        min-width: 0;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        padding: 10px 12px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 4px 8px;
        align-items: center;
      }
      .sessions-live__dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--muted);
      }
      .sessions-live__pill.live .sessions-live__dot {
        background: var(--success);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent);
      }
      .sessions-live__pill.waiting .sessions-live__dot {
        background: var(--accent-2);
      }
      .sessions-live__pill.offline .sessions-live__dot {
        background: var(--danger);
      }
      .sessions-live__label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
      }
      .sessions-live__pill strong {
        color: var(--text-strong);
        font-size: 12px;
        justify-self: end;
      }
      .sessions-live__time,
      .sessions-live__detail {
        grid-column: 2 / 4;
        min-width: 0;
        color: var(--muted);
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .sessions-list {
        display: grid;
        gap: 8px;
        margin-top: 16px;
      }
      .session-card {
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--secondary);
        overflow: hidden;
      }
      .session-card[open] {
        border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
      }
      .session-card__summary {
        align-items: center;
        cursor: pointer;
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(0, 1fr) auto auto;
        list-style: none;
        padding: 12px 14px;
      }
      .session-card__summary::-webkit-details-marker {
        display: none;
      }
      .session-card__body {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 12px;
        padding: 14px;
      }
      .session-card__head {
        align-items: center;
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr);
      }
      .session-card__key {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .session-card__key a,
      .session-card__key .mono {
        color: var(--text-strong);
        font-size: 15px;
        font-weight: 650;
        word-break: break-word;
        text-decoration: none;
      }
      .session-card__display {
        color: var(--muted);
        font-size: 13px;
      }
      .session-card__preview {
        color: var(--muted);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .session-card__summary-meta {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
        min-width: 0;
      }
      .session-card__summary-meta span {
        color: var(--muted);
        font-size: 12px;
        font-weight: 560;
        white-space: nowrap;
      }
      .session-card__active-run {
        align-items: center;
        color: var(--success) !important;
        display: inline-flex;
        gap: 5px;
      }
      .session-card__active-run::before {
        background: var(--success);
        border-radius: 999px;
        content: "";
        display: inline-block;
        height: 6px;
        width: 6px;
      }
      .session-card__stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }
      .session-card__stat {
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        padding: 10px 12px;
        display: grid;
        gap: 4px;
      }
      .session-card__stat-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
      }
      .session-card__stat-value {
        color: var(--text-strong);
        font-weight: 600;
        line-height: 1.35;
      }
      .session-card__controls {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .session-card__actions {
        display: flex;
        justify-content: flex-end;
      }
      .session-card__tasks {
        border-radius: 14px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
        display: grid;
        gap: 10px;
        padding: 10px 12px;
      }
      .session-card__tasks-head {
        align-items: center;
        display: flex;
        justify-content: space-between;
        gap: 10px;
      }
      .session-card__tasks-title {
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 700;
      }
      .session-card__tasks-sub {
        color: var(--muted);
        font-size: 12px;
        margin-top: 2px;
      }
      .session-card__task-list {
        display: grid;
        gap: 8px;
      }
      .session-card__task {
        align-items: center;
        border-top: 1px solid var(--border);
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(0, 1fr) auto;
        padding-top: 10px;
      }
      .session-card__task-main,
      .session-card__task-meta {
        min-width: 0;
      }
      .session-card__task-title {
        color: var(--text-strong);
        font-weight: 650;
      }
      .session-card__task-sub {
        color: var(--muted);
        font-size: 12px;
        margin-top: 3px;
        overflow-wrap: anywhere;
      }
      .session-card__task-meta {
        display: grid;
        gap: 4px;
        justify-items: end;
        text-align: right;
      }
      .session-card__task-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }
      .session-card__delete {
        align-self: start;
        align-items: center;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        color: var(--text-strong);
        display: inline-grid;
        height: 30px;
        justify-content: center;
        padding: 0;
        width: 30px;
      }
      .session-card__delete:hover,
      .session-card__delete:focus-visible {
        background: var(--bg-elevated);
        border-color: var(--border);
        color: var(--danger);
        outline: none;
      }
      .session-card__delete:disabled {
        cursor: not-allowed;
        color: var(--muted);
        opacity: 0.65;
      }
      .session-card__delete svg {
        height: 15px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8px;
        width: 15px;
      }
      .session-card__checkpoints {
        border-radius: 14px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--bg-elevated) 72%, transparent);
        padding: 10px 12px;
      }
      .session-card__checkpoints summary {
        cursor: pointer;
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 650;
      }
      .session-card__checkpoint-list {
        display: grid;
        gap: 10px;
        margin-top: 10px;
      }
      .session-card__checkpoint {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        border-top: 1px solid var(--border);
        padding-top: 10px;
      }
      .session-card__checkpoint-meta {
        min-width: 0;
        display: grid;
        gap: 3px;
      }
      .session-card__checkpoint-id {
        color: var(--text-strong);
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .session-card__checkpoint-sub {
        color: var(--muted);
        font-size: 12px;
      }
      .session-card__checkpoint-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        flex-wrap: wrap;
      }
      .session-maintenance {
        display: grid;
        gap: 12px;
        margin-top: 14px;
        padding: 14px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--secondary);
      }
      .session-maintenance__head {
        align-items: flex-start;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        justify-content: space-between;
      }
      .session-maintenance__actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .session-maintenance__grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      @media (max-width: 980px) {
        .sessions-filters {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
      .sessions-card {
        padding: 14px;
        }
        .sessions-filters,
        .session-card__controls {
          grid-template-columns: 1fr;
        }
        .session-card__checkpoint {
          grid-template-columns: 1fr;
        }
        .session-card__summary {
          grid-template-columns: minmax(0, 1fr) auto;
        }
        .session-card__summary-meta {
          grid-column: 1 / -1;
          justify-content: flex-start;
        }
        .session-card__task {
          grid-template-columns: 1fr;
        }
        .session-card__task-meta {
          justify-items: stretch;
          text-align: left;
        }
        .session-card__task-actions {
          justify-content: flex-start;
        }
        .session-card__checkpoint-actions {
          justify-content: stretch;
        }
        .session-card__checkpoint-actions .btn {
          flex: 1 1 120px;
        }
      }
    </style>

    <section class="sessions-shell">
      <section class="card sessions-card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${props.title ?? "Sessions"}</div>
          <div class="card-sub">
            ${props.subtitle ?? "Conversations, channel sessions, models, delivery, and transcript controls."}
          </div>
        </div>
      </div>

      ${
        showLiveStatus
          ? html`
              <div class="sessions-live">
                ${renderLiveStatusPill({
                  label: "Session list",
                  live: sessionsLive,
                  connected,
                  lastEventAt: props.sessionsLastEventAt,
                })}
                ${renderLiveStatusPill({
                  label: "Active chat",
                  live: messagesLive,
                  connected,
                  lastEventAt: props.sessionMessageLastEventAt,
                  detail: props.subscribedSessionMessageKey,
                })}
              </div>
            `
          : nothing
      }

      ${
        showFilters
          ? html`<div
              class=${
                filterControls === "search"
                  ? "sessions-filters sessions-filters--search"
                  : "sessions-filters"
              }
            >
        <label class="field">
          <span>Search</span>
          <input
            .value=${props.search}
            placeholder="name, channel, session"
            @input=${(e: Event) =>
              props.onFiltersChange({
                search: (e.target as HTMLInputElement).value,
                activeMinutes: props.activeMinutes,
                limit: props.limit,
                includeGlobal: props.includeGlobal,
                includeUnknown: props.includeUnknown,
              })}
          />
        </label>
        ${
          filterControls === "full"
            ? html`
                <label class="field">
                  <span>Active within (minutes)</span>
                  <input
                    .value=${props.activeMinutes}
                    @input=${(e: Event) =>
                      props.onFiltersChange({
                        search: props.search,
                        activeMinutes: (e.target as HTMLInputElement).value,
                        limit: props.limit,
                        includeGlobal: props.includeGlobal,
                        includeUnknown: props.includeUnknown,
                      })}
                  />
                </label>
                <label class="field">
                  <span>Limit</span>
                  <input
                    .value=${props.limit}
                    @input=${(e: Event) =>
                      props.onFiltersChange({
                        search: props.search,
                        activeMinutes: props.activeMinutes,
                        limit: (e.target as HTMLInputElement).value,
                        includeGlobal: props.includeGlobal,
                        includeUnknown: props.includeUnknown,
                      })}
                  />
                </label>
                <label class="field checkbox">
                  <span>Include global</span>
                  <input
                    type="checkbox"
                    .checked=${props.includeGlobal}
                    @change=${(e: Event) =>
                      props.onFiltersChange({
                        search: props.search,
                        activeMinutes: props.activeMinutes,
                        limit: props.limit,
                        includeGlobal: (e.target as HTMLInputElement).checked,
                        includeUnknown: props.includeUnknown,
                      })}
                  />
                </label>
                <label class="field checkbox">
                  <span>Include unknown</span>
                  <input
                    type="checkbox"
                    .checked=${props.includeUnknown}
                    @change=${(e: Event) =>
                      props.onFiltersChange({
                        search: props.search,
                        activeMinutes: props.activeMinutes,
                        limit: props.limit,
                        includeGlobal: props.includeGlobal,
                        includeUnknown: (e.target as HTMLInputElement).checked,
                      })}
                  />
                </label>
              `
            : nothing
        }
      </div>`
          : nothing
      }

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      ${
        showStorePath
          ? html`
              <div class="muted" style="margin-top: 12px;">
                ${props.result ? `Store: ${props.result.path}` : ""}
              </div>
            `
          : nothing
      }

      <div class="sessions-list">
        ${
          rows.length === 0
            ? html`
                <div class="muted">${props.emptyText ?? "No sessions found."}</div>
              `
            : rows.map((row) =>
                renderRow(
                  row,
                  props.basePath,
                  props.onPatch,
                  props.onDelete,
                  props.onBranchCheckpoint,
                  props.onRestoreCheckpoint,
                  tasksForSession(row, props.taskJobs),
                  props.onTaskEdit,
                  props.onTaskRun,
                  props.onTaskOpenRun,
                  props.onTaskActivityOpen,
                  props.onTaskToggle,
                  props.onTaskCancel,
                  props.loading || taskBusy,
                  props.currentSessionKey,
                ),
              )
        }
      </div>
      ${
        props.result?.hasMore && props.onLoadMore
          ? html`
              <div class="row" style="justify-content: center; margin-top: 12px;">
                <button class="btn" ?disabled=${props.loading} @click=${props.onLoadMore}>
                  ${props.loading ? "Loading..." : "Load more"}
                </button>
              </div>
            `
          : nothing
      }
      </section>
    </section>
  `;
}

function renderRow(
  row: GatewaySessionRow,
  basePath: string,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  onBranchCheckpoint: SessionsProps["onBranchCheckpoint"],
  onRestoreCheckpoint: SessionsProps["onRestoreCheckpoint"],
  tasks: CronJob[],
  onTaskEdit: SessionsProps["onTaskEdit"],
  onTaskRun: SessionsProps["onTaskRun"],
  onTaskOpenRun: SessionsProps["onTaskOpenRun"],
  onTaskActivityOpen: SessionsProps["onTaskActivityOpen"],
  onTaskToggle: SessionsProps["onTaskToggle"],
  onTaskCancel: SessionsProps["onTaskCancel"],
  disabled: boolean,
  currentSessionKey?: string | null,
) {
  const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a";
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = withCurrentOption(resolveThinkLevelOptions(row.modelProvider), thinking);
  const verbose = row.verboseLevel ?? "";
  const verboseLevels = withCurrentLabeledOption(VERBOSE_LEVELS, verbose);
  const reasoning = row.reasoningLevel ?? "";
  const reasoningLevels = withCurrentOption(REASONING_LEVELS, reasoning);
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const checkpoints = row.compactionCheckpoints ?? [];
  const title = sessionTitle(row);
  const preview =
    row.lastMessagePreview?.trim() && row.lastMessagePreview.trim() !== title
      ? row.lastMessagePreview.trim()
      : "";
  const delivery = formatDelivery(row);
  const source = sessionSource(row);
  const protectedMain = isProtectedMainSessionKey(row.key);
  const tokenSummary = formatSessionTokens(row);
  const tokenPreview = formatSessionTokenPreview(row);
  const taskSummary = formatTaskCount(tasks.length);
  const isCurrent = currentSessionKey === row.key;
  const deleteDisabled = disabled || protectedMain || isCurrent;
  const activeRunCount = row.activeRunIds?.length ?? 0;
  const deleteTitle = protectedMain
    ? "Main Agent session cannot be deleted"
    : isCurrent
      ? "Switch away before deleting this session"
      : tasks.length > 0
        ? "Delete session history. Attached tasks stay configured."
        : "Delete session";

  return html`
    <details class="session-card">
      <summary class="session-card__summary">
        <div class="session-card__head">
          <div class="session-card__key">
            <div class="mono">
              ${canLink ? html`<a href=${chatUrl} class="session-link">${title}</a>` : title}
            </div>
            <div class="session-card__display">${sessionSubtitle(row)}</div>
            ${preview && !sessionSubtitle(row) ? html`<div class="session-card__preview">${preview}</div>` : nothing}
          </div>
        </div>
        <div class="session-card__summary-meta" aria-label="Session preview">
          ${
            row.hasActiveRun
              ? html`
                  <span class="session-card__active-run">
                    ${activeRunCount > 1 ? `${activeRunCount} active runs` : "active run"}
                  </span>
                `
              : nothing
          }
          <span title=${updated}>${updated}</span>
          <span>${tokenPreview}</span>
          <span>${taskSummary}</span>
        </div>
        <button
          class="session-card__delete"
          type="button"
          ?disabled=${deleteDisabled}
          title=${deleteTitle}
          aria-label="Delete session"
          @click=${(event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            if (deleteDisabled) {
              return;
            }
            onDelete(row.key);
          }}
        >
          ${icons.trash}
        </button>
      </summary>
      <div class="session-card__body">
      <div class="session-card__stats">
        <div class="session-card__stat">
          <div class="session-card__stat-label">Key</div>
          <div class="session-card__stat-value mono">${row.key}</div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Kind</div>
          <div class="session-card__stat-value">${row.kind}</div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Source</div>
          <div class="session-card__stat-value">${source}</div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Model</div>
          <div class="session-card__stat-value">${formatSessionModel(row)}</div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Skills</div>
          <div
            class="session-card__stat-value"
            title=${row.skills?.names?.join(", ") || "No loaded skill snapshot"}
          >
            ${
              row.skills
                ? `${row.skills.count} loaded${
                    row.skills.skillFilter === undefined
                      ? " · inherited"
                      : row.skills.skillFilter.length === 0
                        ? " · none"
                        : " · narrowed"
                  }`
                : "not recorded"
            }
          </div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Delivery</div>
          <div class="session-card__stat-value">${delivery}</div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Updated</div>
          <div class="session-card__stat-value">${updated}</div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Tokens</div>
          <div class="session-card__stat-value">${tokenSummary}</div>
        </div>
        <div class="session-card__stat">
          <div class="session-card__stat-label">Tasks</div>
          <div class="session-card__stat-value">${taskSummary}</div>
        </div>
      </div>
      ${
        onTaskActivityOpen
          ? html`
              <div class="session-card__actions">
                <button class="btn btn--sm" type="button" @click=${() => onTaskActivityOpen(row.key)}>
                  Task activity
                </button>
              </div>
            `
          : nothing
      }
      <div class="session-card__controls">
        <label class="field">
          <span>Label</span>
        <input
          .value=${row.label ?? ""}
          ?disabled=${disabled}
          placeholder="(optional)"
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            onPatch(row.key, { label: value || null });
          }}
        />
        </label>
        <label class="field">
          <span>Thinking</span>
        <select
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, {
              thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
            });
          }}
        >
          ${thinkLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${thinking === level}>
                ${level || "inherit"}
              </option>`,
          )}
        </select>
        </label>
        <label class="field">
          <span>Verbose</span>
        <select
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { verboseLevel: value || null });
          }}
        >
          ${verboseLevels.map(
            (level) =>
              html`<option value=${level.value} ?selected=${verbose === level.value}>
                ${level.label}
              </option>`,
          )}
        </select>
        </label>
        <label class="field">
          <span>Reasoning</span>
        <select
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, { reasoningLevel: value || null });
          }}
        >
          ${reasoningLevels.map(
            (level) =>
              html`<option value=${level} ?selected=${reasoning === level}>
                ${level || "inherit"}
              </option>`,
          )}
        </select>
        </label>
        <label class="field">
          <span>Send policy</span>
        <select
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const value = (e.target as HTMLSelectElement).value;
            onPatch(row.key, {
              sendPolicy: value === "allow" || value === "deny" ? value : null,
            });
          }}
        >
          ${SESSION_SEND_POLICY_OPTIONS.map(
            ([value, label]) =>
              html`<option value=${value} ?selected=${(row.sendPolicy ?? "") === value}>
                ${label}
              </option>`,
          )}
        </select>
        </label>
      </div>
      <section class="session-card__tasks">
        <div class="session-card__tasks-head">
          <div>
            <div class="session-card__tasks-title">Tasks</div>
            <div class="session-card__tasks-sub">Scheduled work attached to this session.</div>
          </div>
        </div>
        ${
          tasks.length === 0
            ? html`
                <div class="muted">No tasks for this session.</div>
              `
            : html`
                <div class="session-card__task-list">
                  ${tasks.map(
                    (job) => html`
                      <div class="session-card__task">
                        <div class="session-card__task-main">
                          <div class="session-card__task-title">${job.name || job.id}</div>
                          <div class="session-card__task-sub">${formatCronPayload(job)}</div>
                          <div class="chip-row">
                            <span class="chip">${formatCronSchedule(job)}</span>
                            <span class="chip ${job.enabled ? "chip-ok" : "chip-warn"}">
                              ${job.enabled ? "enabled" : "disabled"}
                            </span>
                            ${
                              job.state?.needsAccess
                                ? html`
                                    <span class="chip chip-warn">needs access</span>
                                  `
                                : nothing
                            }
                            <span class="chip">${formatTaskDelivery(job)}</span>
                          </div>
                        </div>
                        <div class="session-card__task-meta">
                          <div class="mono">${formatCronState(job)}</div>
                          <div class="muted">Next: ${formatNextRun(job.state?.nextRunAtMs ?? null)}</div>
                          ${
                            job.state?.lastRunSessionKey
                              ? html`
                                  <div class="muted">Latest run transcript ready</div>
                                `
                              : nothing
                          }
                          <div class="session-card__task-actions">
                            ${
                              onTaskEdit
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${disabled}
                                      @click=${() => onTaskEdit(job)}
                                    >
                                      Edit
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              onTaskRun
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${disabled}
                                      @click=${() => onTaskRun(job)}
                                    >
                                      Run now
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              onTaskOpenRun && job.state?.lastRunSessionKey
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${disabled}
                                      @click=${() =>
                                        onTaskOpenRun(job.state?.lastRunSessionKey ?? "")}
                                    >
                                      Open latest run
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              onTaskToggle
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${disabled}
                                      @click=${() => onTaskToggle(job, !job.enabled)}
                                    >
                                      ${job.enabled ? "Pause" : job.state?.needsAccess ? "Resume task" : "Resume"}
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              onTaskCancel
                                ? html`
                                    <button
                                      class="btn btn--sm"
                                      ?disabled=${disabled}
                                      @click=${() => onTaskCancel(job)}
                                    >
                                      Delete
                                    </button>
                                  `
                                : nothing
                            }
                          </div>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `
        }
      </section>
      ${
        checkpoints.length > 0
          ? html`
              <details class="session-card__checkpoints">
                <summary>
                  ${
                    checkpoints.length === 1
                      ? "1 compaction checkpoint"
                      : `${checkpoints.length} compaction checkpoints`
                  }
                </summary>
                <div class="session-card__checkpoint-list">
                  ${checkpoints.map(
                    (checkpoint) => html`
                      <div class="session-card__checkpoint">
                        <div class="session-card__checkpoint-meta">
                          <div class="session-card__checkpoint-id mono">
                            ${checkpoint.checkpointId}
                          </div>
                          <div class="session-card__checkpoint-sub">
                            ${formatRelativeTimestamp(checkpoint.createdAt)} · ${checkpoint.reason}
                            · tokens ${formatCheckpointTokens(checkpoint)}
                          </div>
                          ${
                            checkpoint.summary
                              ? html`<div class="session-card__checkpoint-sub">
                                  ${checkpoint.summary}
                                </div>`
                              : nothing
                          }
                        </div>
                        <div class="session-card__checkpoint-actions">
                          <button
                            class="btn"
                            ?disabled=${disabled}
                            @click=${() => onBranchCheckpoint(row.key, checkpoint.checkpointId)}
                          >
                            Branch
                          </button>
                          <button
                            class="btn danger"
                            ?disabled=${disabled}
                            @click=${() => onRestoreCheckpoint(row.key, checkpoint.checkpointId)}
                          >
                            Restore
                          </button>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </details>
            `
          : nothing
      }
      </div>
    </details>
  `;
}
