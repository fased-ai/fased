import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { formatAgentDisplayName } from "../agent-display.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { extractTextCached } from "../chat/message-extract.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import {
  buildTaskPolicyPresetPatch,
  TASK_POLICY_PRESET_OPTIONS,
  type ChatScheduleDraft,
} from "../controllers/cron.ts";
import { closeDialogOnBackdropClick, openDialogSafely } from "../dialog.ts";
import { icons } from "../icons.ts";
import { detectTextDirection } from "../text-direction.ts";
import type {
  CommandEntry,
  CronJob,
  GatewayAgentRow,
  SessionsListResult,
  SessionsUsageEntry,
} from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import "../components/resizable-divider.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";

export type ChatDeliveryMode = "operator" | "channel" | "follow";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type FallbackIndicatorStatus = {
  phase?: "active" | "cleared";
  selected: string;
  active: string;
  previous?: string;
  reason?: string;
  attempts: string[];
  occurredAt: number;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  showToolCalls: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  fallbackStatus?: FallbackIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  sessionUsage?: SessionsUsageEntry | null;
  sessionUsageLoading?: boolean;
  sessionUsageVisible?: boolean;
  onToggleSessionUsage?: () => void;
  transcriptSearch?: string;
  transcriptSearchIndex?: number;
  onTranscriptSearchChange?: (next: string) => void;
  scheduleTask?: ChatScheduleDraft;
  scheduleTaskBusy?: boolean;
  scheduleDeliveryLabel?: string | null;
  scheduleAgentId?: string;
  scheduleAgentOptions?: GatewayAgentRow[];
  onScheduleTaskOpen?: () => void;
  onScheduleTaskClose?: () => void;
  onScheduleTaskChange?: (patch: Partial<ChatScheduleDraft>) => void;
  onScheduleTaskSubmit?: () => void;
  taskJobs?: CronJob[];
  taskLoading?: boolean;
  onTaskEdit?: (job: CronJob) => void;
  onTaskRun?: (job: CronJob) => void;
  onTaskOpenRun?: (sessionKey: string) => void;
  onTaskToggle?: (job: CronJob, enabled: boolean) => void;
  onTaskCancel?: (job: CronJob) => void;
  deliveryMode?: ChatDeliveryMode;
  onDeliveryModeChange?: (mode: ChatDeliveryMode) => void;
  commandEntries?: CommandEntry[];
  commandHelpersCollapsed?: boolean;
  onToggleCommandHelpers?: () => void;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  composerControls?: TemplateResult | null;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

export type ChatSessionPanelsProps = Pick<
  ChatProps,
  | "sessionKey"
  | "sessions"
  | "sessionUsage"
  | "sessionUsageLoading"
  | "sessionUsageVisible"
  | "onToggleSessionUsage"
  | "messages"
  | "taskJobs"
  | "taskLoading"
  | "onTaskEdit"
  | "onTaskRun"
  | "onTaskOpenRun"
  | "onTaskToggle"
  | "onTaskCancel"
  | "deliveryMode"
  | "onDeliveryModeChange"
>;

export function resetChatViewState(): void {
  // The narrowed first-pass chat view does not retain module-level UI state.
}

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function renderFallbackIndicator(status: FallbackIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <div
      class=${className}
      role="status"
      aria-live="polite"
      title=${details}
    >
      ${icon} ${message}
    </div>
  `;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function addImageFile(file: File, props: ChatProps) {
  if (!props.onAttachmentsChange || !file.type.startsWith("image/")) {
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const dataUrl = reader.result as string;
    const newAttachment: ChatAttachment = {
      id: generateAttachmentId(),
      dataUrl,
      mimeType: file.type,
    };
    const current = props.attachments ?? [];
    props.onAttachmentsChange?.([...current, newAttachment]);
  });
  reader.readAsDataURL(file);
}

function handleFileInput(event: Event, props: ChatProps) {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  for (const file of files) {
    addImageFile(file, props);
  }
  input.value = "";
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    addImageFile(file, props);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

export function buildCommandRouteDraft(route: string, draft: string): string {
  const trimmed = draft.trimStart();
  if (trimmed.startsWith(route)) {
    return trimmed;
  }
  return trimmed ? `${route} ${trimmed}` : `${route} `;
}

type ChatCommandSuggestion = {
  token: string;
  label: string;
  description: string;
  source: string;
};

const CORE_COMMAND_SUGGESTIONS: ChatCommandSuggestion[] = [
  {
    token: "@wallet",
    label: "Wallet",
    description: "Balances, sends, approvals, policy-bound wallet actions.",
    source: "core",
  },
  {
    token: "@trade",
    label: "Wallet actions",
    description: "Policy-gated wallet action review and execution helpers.",
    source: "core",
  },
  {
    token: "@offers",
    label: "Offers",
    description: "Fased Network offers, marketplace, receipts, and work routing.",
    source: "core",
  },
  {
    token: "@mining",
    label: "Mining",
    description: "SAT mining status, readiness, and mining operations.",
    source: "core",
  },
];

const UI_SAFE_SLASH_COMMANDS = new Set([
  "help",
  "model",
  "models",
  "new",
  "reasoning",
  "reset",
  "status",
  "stop",
  "think",
  "usage",
  "whoami",
]);

function isUiSafeSlashCommand(entry: CommandEntry): boolean {
  if (entry.source !== "native") {
    return false;
  }
  const names = [
    entry.name,
    entry.nativeName,
    ...(entry.textAliases ?? []).map((alias) => alias.replace(/^\/+/, "")),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return names.some((name) => UI_SAFE_SLASH_COMMANDS.has(name));
}

function buildCommandSuggestions(
  entries: CommandEntry[] | undefined,
  prefix: "@" | "/",
): ChatCommandSuggestion[] {
  const seen = new Set<string>();
  const suggestions: ChatCommandSuggestion[] = [];
  const add = (suggestion: ChatCommandSuggestion) => {
    const key = suggestion.token.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    suggestions.push(suggestion);
  };

  if (prefix === "@") {
    for (const suggestion of CORE_COMMAND_SUGGESTIONS) {
      add(suggestion);
    }
  }

  for (const entry of entries ?? []) {
    if (prefix === "/" && !isUiSafeSlashCommand(entry)) {
      continue;
    }
    const aliases = entry.textAliases?.filter((alias) => alias.startsWith(prefix)) ?? [];
    const tokens = aliases.length > 0 ? aliases : prefix === "/" ? [`/${entry.name}`] : [];
    for (const token of tokens) {
      add({
        token,
        label: entry.nativeName && entry.nativeName !== entry.name ? entry.nativeName : entry.name,
        description: entry.description,
        source: entry.source,
      });
    }
  }
  return suggestions;
}

type CommandQuery = {
  prefix: "@" | "/";
  token: string;
};

function resolveCommandQuery(draft: string): CommandQuery | null {
  const match = draft.match(/(^|\s)([@/][^\s@/]*)$/);
  const token = match ? match[2].toLowerCase() : null;
  if (!token) {
    return null;
  }
  const prefix = token.startsWith("@") ? "@" : token.startsWith("/") ? "/" : null;
  return prefix ? { prefix, token } : null;
}

function filterCommandSuggestions(
  suggestions: ChatCommandSuggestion[],
  query: CommandQuery,
): ChatCommandSuggestion[] {
  const term = query.token.slice(1).trim().toLowerCase();
  if (!term) {
    return suggestions;
  }
  return suggestions.filter((suggestion) => {
    const haystack = [suggestion.token, suggestion.label, suggestion.description, suggestion.source]
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
}

function selectCommandSuggestion(props: ChatProps, token: string) {
  const next = props.draft.replace(/(^|\s)([@/][^\s@/]*)$/, (_, prefix: string) => {
    return `${prefix}${token} `;
  });
  props.onDraftChange(next === props.draft ? buildCommandRouteDraft(token, props.draft) : next);
}

function renderCommandSuggestions(props: ChatProps) {
  const query = resolveCommandQuery(props.draft);
  if (!query) {
    return nothing;
  }
  const suggestions = filterCommandSuggestions(
    buildCommandSuggestions(props.commandEntries, query.prefix),
    query,
  );
  if (suggestions.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-command-suggestions" role="listbox" aria-label="Command suggestions">
      <div class="chat-command-suggestions__title">Commands</div>
      ${suggestions.map(
        (suggestion) => html`
          <button
            class="chat-command-suggestion"
            type="button"
            role="option"
            @click=${() => selectCommandSuggestion(props, suggestion.token)}
          >
            <span class="chat-command-suggestion__token">${suggestion.token}</span>
            <span class="chat-command-suggestion__body">
              <span class="chat-command-suggestion__label">${suggestion.label}</span>
              <span class="chat-command-suggestion__description">${suggestion.description}</span>
            </span>
            <span class="chat-command-suggestion__source">${suggestion.source}</span>
          </button>
        `,
      )}
    </div>
  `;
}

type DeliveryTarget = {
  channel: string;
  to: string;
  accountId?: string;
};

function resolveDeliveryTarget(props: ChatSessionPanelsProps): DeliveryTarget | null {
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const context = activeSession?.deliveryContext;
  const channel = (context?.channel ?? activeSession?.lastChannel ?? "").trim();
  const to = (context?.to ?? activeSession?.lastTo ?? "").trim();
  const accountId = (context?.accountId ?? activeSession?.lastAccountId ?? "").trim();
  if (!channel || channel === "webchat" || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: accountId || undefined,
  };
}

function formatDeliveryChannel(channel: string): string {
  const normalized = channel.trim();
  if (!normalized) {
    return "Channel";
  }
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatDeliveryTarget(target: DeliveryTarget): string {
  return `${formatDeliveryChannel(target.channel)} -> ${target.to}`;
}

function isInternalUsageModel(
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  const normalized = joinProviderModel(provider, model).toLowerCase();
  return (
    normalized === "fased/gateway-injected" ||
    normalized === "gateway-injected" ||
    normalized.startsWith("fased/")
  );
}

function closeOpenChatMenus(event: Event) {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    "details.chat-model-menu[open], details.chat-session-menu[open], details.chat-transcript-menu[open]",
  )) {
    if (!menu.contains(target)) {
      menu.open = false;
    }
  }
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "$0";
  }
  if (value < 0.01) {
    return "<$0.01";
  }
  return `$${value.toFixed(value >= 10 ? 2 : 4)}`;
}

function joinProviderModel(
  provider: string | null | undefined,
  model: string | null | undefined,
): string {
  const normalizedProvider = provider?.trim() ?? "";
  const normalizedModel = model?.trim() ?? "";
  if (!normalizedProvider) {
    return normalizedModel;
  }
  if (!normalizedModel) {
    return normalizedProvider;
  }
  if (
    normalizedModel === normalizedProvider ||
    normalizedModel.startsWith(`${normalizedProvider}/`)
  ) {
    return normalizedModel;
  }
  return `${normalizedProvider}/${normalizedModel}`;
}

function resolveTranscriptQuery(props: ChatProps): string {
  return (props.transcriptSearch ?? "").trim().toLowerCase();
}

function messageSearchHaystack(message: unknown): string {
  const normalized = normalizeMessage(message);
  const parts = [normalized.role, normalized.senderLabel, extractTextCached(message)].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return parts.join("\n").toLowerCase();
}

function messageMatchesTranscriptSearch(message: unknown, query: string): boolean {
  if (!query) {
    return true;
  }
  return messageSearchHaystack(message).includes(query);
}

function resolveSessionAgentLabel(props: ChatSessionPanelsProps): string {
  const match = /^agent:([^:]+)/.exec(props.sessionKey);
  const agentId = match?.[1] ?? "";
  const normalized = (agentId || "main").trim();
  return formatAgentDisplayName({ id: normalized });
}

function resolveSessionSourceLabel(props: ChatSessionPanelsProps): string {
  const target = resolveDeliveryTarget(props);
  if (target) {
    return formatDeliveryChannel(target.channel);
  }
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const named =
    activeSession?.displayName?.trim() ||
    activeSession?.label?.trim() ||
    activeSession?.subject?.trim() ||
    activeSession?.room?.trim() ||
    activeSession?.space?.trim();
  if (named) {
    return named;
  }
  const parts = props.sessionKey.split(":").filter(Boolean);
  if (parts[0] === "agent" && parts.length >= 3) {
    const source = parts[2] ?? "main";
    if (source === "main") {
      return "Local chat";
    }
    return formatDeliveryChannel(source);
  }
  return props.sessionKey === "main" ? "Local chat" : props.sessionKey;
}

function resolveSessionModelLabel(props: ChatSessionPanelsProps): string {
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const usageProvider = props.sessionUsage?.modelProvider ?? null;
  const usageModel = props.sessionUsage?.model ?? null;
  const provider =
    activeSession?.modelProvider ?? usageProvider ?? props.sessions?.defaults?.modelProvider;
  const model = activeSession?.model ?? usageModel ?? props.sessions?.defaults?.model;
  return joinProviderModel(provider, model) || "model pending";
}

function resolveSessionSkillsLabel(
  props: ChatSessionPanelsProps,
): { label: string; title: string } | null {
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const skills = activeSession?.skills;
  if (!skills) {
    return null;
  }
  const mode =
    skills.skillFilter === undefined
      ? "Inherited from Agent"
      : skills.skillFilter.length === 0
        ? "No skills"
        : "Narrow selected skills";
  const names = skills.names.length > 0 ? skills.names.join(", ") : "none loaded";
  const more = skills.count > skills.names.length ? ` +${skills.count - skills.names.length}` : "";
  return {
    label: `${skills.count} skills`,
    title: `${mode}: ${names}${more}`,
  };
}

function renderDeliveryModeControl(props: ChatSessionPanelsProps) {
  const target = resolveDeliveryTarget(props);
  if (!target) {
    return html`
      <span class="chat-usage-summary__item" title="Delivery: messages stay in the local Control UI">
        Local
      </span>
    `;
  }
  const channelLabel = formatDeliveryChannel(target.channel);
  const targetLabel = formatDeliveryTarget(target);
  const mode =
    props.deliveryMode === "channel" || props.deliveryMode === "follow"
      ? props.deliveryMode
      : "operator";
  if (!props.onDeliveryModeChange) {
    return html`
      <span class="chat-usage-summary__item" title=${`Delivery: ${targetLabel}`}>
        ${targetLabel}
      </span>
    `;
  }
  return html`
    <span
      class="chat-usage-summary__item chat-usage-summary__item--delivery"
      title=${`Delivery: ${targetLabel}`}
    >
      <span class="chat-delivery-mode__target">${channelLabel}</span>
      <select
        class="chat-delivery-mode__select"
        aria-label="Chat delivery mode"
        title=${`Delivery mode for ${targetLabel}`}
        .value=${mode}
        @change=${(event: Event) =>
          props.onDeliveryModeChange?.(
            (event.target as HTMLSelectElement).value as ChatDeliveryMode,
          )}
      >
        <option value="operator">Local</option>
        <option value="channel">Reply</option>
        <option value="follow">Follow</option>
      </select>
    </span>
  `;
}

function renderSessionUsageSummary(props: ChatSessionPanelsProps) {
  const visible = props.sessionUsageVisible !== false;
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const usage = props.sessionUsage?.usage ?? null;
  const modelRows = (usage?.modelUsage ?? [])
    .filter((entry) => !isInternalUsageModel(entry.provider, entry.model))
    .slice(0, 3);
  const modelUsageTitle =
    modelRows.length > 0
      ? modelRows
          .map((entry) => joinProviderModel(entry.provider, entry.model) || "unknown")
          .join(" / ")
      : "";
  const resolvedModelText = resolveSessionModelLabel(props).replace(
    /^model pending$/,
    "model not set",
  );
  const selectedModelText =
    resolvedModelText === "model not set" && modelUsageTitle ? modelUsageTitle : resolvedModelText;
  const skillsLabel = resolveSessionSkillsLabel(props);
  const tokenCount = usage?.totalTokens ?? activeSession?.totalTokens ?? 0;
  const totalCost = usage?.totalCost ?? 0;
  const messageCount = usage?.messageCounts?.total ?? props.messages.length;
  const contextLimit = activeSession?.contextTokens ?? props.sessions?.defaults?.contextTokens ?? 0;
  const contextUsed =
    activeSession?.totalTokensFresh === false ? 0 : (activeSession?.totalTokens ?? 0);
  const contextPct =
    contextLimit > 0 && contextUsed > 0
      ? `${Math.min(Math.round((contextUsed / contextLimit) * 100), 100)}% ctx`
      : "";
  const toggle = props.onToggleSessionUsage
    ? html`
        <button
          class="chat-usage-summary__toggle"
          type="button"
          title=${visible ? "Hide session stats" : "Show session stats"}
          aria-label=${visible ? "Hide session stats" : "Show session stats"}
          @click=${props.onToggleSessionUsage}
        >
          ${visible ? icons.eyeOff : icons.eye}
        </button>
      `
    : nothing;
  if (!visible) {
    return html`
      <div
        class="chat-usage-summary chat-usage-summary--hidden"
        aria-label="Current chat context and session usage hidden"
      >
        ${toggle}
      </div>
    `;
  }
  return html`
    <div class="chat-usage-summary" aria-label="Current chat context and session usage">
      <span class="chat-usage-summary__item" title=${`Agent: ${resolveSessionAgentLabel(props)}`}>
        ${resolveSessionAgentLabel(props)}
      </span>
      <span class="chat-usage-summary__item" title=${`Session: ${props.sessionKey}`}>
        ${resolveSessionSourceLabel(props)}
      </span>
      <span
        class="chat-usage-summary__item"
        title=${`Selected model: ${selectedModelText}${modelUsageTitle ? ` · usage: ${modelUsageTitle}` : ""}`}
      >
        ${selectedModelText}
      </span>
      ${renderDeliveryModeControl(props)}
      ${
        skillsLabel
          ? html`
              <span class="chat-usage-summary__item" title=${skillsLabel.title}>
                ${skillsLabel.label}
              </span>
            `
          : nothing
      }
      <span class="chat-usage-summary__item" title="Tokens used in this session">
        ${formatCompactNumber(tokenCount)} tokens${props.sessionUsageLoading && !usage ? " syncing" : ""}
      </span>
      ${
        contextPct
          ? html`
              <span
                class="chat-usage-summary__item"
                title=${`Context window: ${formatCompactNumber(contextUsed)} / ${formatCompactNumber(contextLimit)} tokens`}
              >
                ${contextPct}
              </span>
            `
          : nothing
      }
      <span class="chat-usage-summary__item" title="Estimated cost for this session">
        ${formatCost(totalCost)}
      </span>
      <span class="chat-usage-summary__item" title="Messages in this session">
        ${messageCount} messages
      </span>
      ${toggle}
    </div>
  `;
}

function compareSessionTasks(a: CronJob, b: CronJob): number {
  const aNext = a.state?.nextRunAtMs ?? Number.POSITIVE_INFINITY;
  const bNext = b.state?.nextRunAtMs ?? Number.POSITIVE_INFINITY;
  if (aNext !== bNext) {
    return aNext - bNext;
  }
  return (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0);
}

function resolveActiveSessionTasks(props: ChatSessionPanelsProps): CronJob[] {
  const sessionKey = props.sessionKey.trim();
  if (!sessionKey) {
    return [];
  }
  return (props.taskJobs ?? [])
    .filter((job) => job.sessionKey === sessionKey)
    .toSorted(compareSessionTasks);
}

function formatTaskDate(msOrIso: number | string | undefined): string {
  if (msOrIso === undefined) {
    return "";
  }
  const ms = typeof msOrIso === "number" ? msOrIso : Date.parse(msOrIso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

function formatTaskSchedule(job: CronJob): string {
  if (job.schedule.kind === "every") {
    const everyMs = job.schedule.everyMs;
    if (everyMs % 86_400_000 === 0) {
      const days = everyMs / 86_400_000;
      return `Every ${days} day${days === 1 ? "" : "s"}`;
    }
    if (everyMs % 3_600_000 === 0) {
      const hours = everyMs / 3_600_000;
      return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
    }
    if (everyMs % 60_000 === 0) {
      return `Every ${everyMs / 60_000} min`;
    }
    return `Every ${Math.max(1, Math.round(everyMs / 1000))} sec`;
  }
  if (job.schedule.kind === "at") {
    return `At ${formatTaskDate(job.schedule.at) || "scheduled time"}`;
  }
  return `Advanced ${job.schedule.expr}`;
}

function formatTaskStatus(job: CronJob): string {
  if (job.state?.needsAccess) {
    return "Needs access";
  }
  if (!job.enabled) {
    return "Paused";
  }
  if (job.state?.runningAtMs) {
    return "Running";
  }
  if (job.state?.lastStatus === "error") {
    return "Failed";
  }
  if (job.state?.lastStatus === "ok") {
    return "Last run ok";
  }
  if (job.state?.nextRunAtMs) {
    return `Next ${formatTaskDate(job.state.nextRunAtMs) || "scheduled"}`;
  }
  return "Scheduled";
}

function renderChatTaskActions(props: ChatSessionPanelsProps, job: CronJob) {
  return html`
    <div class="chat-session-task__actions">
      ${
        props.onTaskEdit
          ? html`
              <button
                class="chat-session-task__button"
                type="button"
                aria-label=${`Edit task ${job.name}`}
                title="Edit task"
                @click=${() => props.onTaskEdit?.(job)}
              >
                ${icons.edit}
              </button>
            `
          : nothing
      }
      ${
        props.onTaskRun
          ? html`
              <button
                class="chat-session-task__button"
                type="button"
                aria-label=${`Run task ${job.name} now`}
                title="Run now"
                @click=${() => props.onTaskRun?.(job)}
              >
                ${icons.zap}
              </button>
            `
          : nothing
      }
      ${
        props.onTaskOpenRun && job.state?.lastRunSessionKey
          ? html`
              <button
                class="chat-session-task__button"
                type="button"
                aria-label=${`Open latest run for ${job.name}`}
                title="Open latest run"
                @click=${() => props.onTaskOpenRun?.(job.state?.lastRunSessionKey ?? "")}
              >
                ${icons.externalLink}
              </button>
            `
          : nothing
      }
      ${
        props.onTaskToggle
          ? html`
              <button
                class="chat-session-task__button"
                type="button"
                aria-label=${job.enabled ? `Pause task ${job.name}` : `Resume task ${job.name}`}
                title=${job.enabled ? "Pause task" : "Resume task"}
                @click=${() => props.onTaskToggle?.(job, !job.enabled)}
              >
                ${job.enabled ? icons.pause : icons.play}
              </button>
            `
          : nothing
      }
      ${
        props.onTaskCancel
          ? html`
              <button
                class="chat-session-task__button chat-session-task__button--danger"
                type="button"
                aria-label=${`Delete task ${job.name}`}
                title="Delete task"
                @click=${() => props.onTaskCancel?.(job)}
              >
                ${icons.x}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

function renderChatTasksPanel(props: ChatSessionPanelsProps) {
  const tasks = resolveActiveSessionTasks(props);
  return html`
    <details class="chat-topbar-panel chat-topbar-panel--tasks">
      <summary
        class="topbar-icon-link chat-topbar-panel__button"
        title=${tasks.length === 1 ? "1 task for this chat" : `${tasks.length} tasks for this chat`}
        aria-label="Tasks for this chat"
      >
        ${icons.listChecks}
        ${
          tasks.length > 0
            ? html`<span class="chat-topbar-panel__badge">${tasks.length}</span>`
            : nothing
        }
      </summary>
      <div class="chat-topbar-panel__panel chat-topbar-panel__panel--tasks">
        <div class="chat-topbar-panel__title">
          <span>Tasks for this chat</span>
          <span>${props.taskLoading ? "Loading" : tasks.length}</span>
        </div>
        ${
          tasks.length === 0
            ? html`
                <div class="chat-session-tasks__empty">
                  ${props.taskLoading ? "Loading scheduled tasks..." : "No tasks tied to this chat"}
                </div>
              `
            : html`
                <div class="chat-session-tasks__list">
                  ${tasks.slice(0, 6).map(
                    (job) => html`
                      <article class="chat-session-task">
                        <div class="chat-session-task__main">
                          <div class="chat-session-task__name" title=${job.name}>${job.name}</div>
                          <div class="chat-session-task__meta">
                            <span>${formatTaskSchedule(job)}</span>
                            <span>${formatTaskStatus(job)}</span>
                          </div>
                        </div>
                        ${renderChatTaskActions(props, job)}
                      </article>
                    `,
                  )}
                </div>
                ${
                  tasks.length > 6
                    ? html`
                        <div class="chat-session-tasks__more">
                          ${tasks.length - 6} more in Tasks
                        </div>
                      `
                    : nothing
                }
              `
        }
      </div>
    </details>
  `;
}

export function renderChatTopbarPanels(props: ChatSessionPanelsProps) {
  const statsProps: ChatSessionPanelsProps = {
    ...props,
    sessionUsageVisible: true,
    onToggleSessionUsage: undefined,
  };
  return html`
    <div class="chat-topbar-panels">
      ${renderChatTasksPanel(props)}
      <details class="chat-topbar-panel chat-topbar-panel--stats">
        <summary
          class="topbar-icon-link chat-topbar-panel__button"
          title="Chat stats"
          aria-label="Chat stats"
        >
          ${icons.barChart}
        </summary>
        <div class="chat-topbar-panel__panel chat-topbar-panel__panel--stats">
          ${renderSessionUsageSummary(statsProps)}
        </div>
      </details>
    </div>
  `;
}

function renderScheduleTaskDialog(props: ChatProps) {
  const draft = props.scheduleTask;
  if (!draft?.open || !props.onScheduleTaskChange || !props.onScheduleTaskSubmit) {
    return nothing;
  }
  const editing = Boolean(draft.editingJobId);
  const deliveryLabel = props.scheduleDeliveryLabel?.trim() || "";
  const channelDeliveryAvailable = Boolean(deliveryLabel);
  const patch = props.onScheduleTaskChange;
  const agentOptions = props.scheduleAgentOptions ?? [];
  const selectedAgentId = draft.agentId || props.scheduleAgentId || "main";
  return html`
    <dialog
      class="chat-schedule-dialog"
      ${ref(openDialogSafely)}
      @click=${closeDialogOnBackdropClick}
      @close=${props.onScheduleTaskClose}
    >
      <form
        class="chat-schedule-dialog__panel"
        @submit=${(event: Event) => {
          event.preventDefault();
          props.onScheduleTaskSubmit?.();
        }}
      >
        <div class="chat-schedule-dialog__head">
          <div>
            <div class="chat-schedule-dialog__title">${editing ? "Edit task" : "Schedule this"}</div>
            <div class="chat-schedule-dialog__meta">
              Agent ${selectedAgentId} ·
              ${props.sessionKey}
            </div>
          </div>
          <button
            class="btn btn--sm btn--ghost"
            type="button"
            @click=${(event: Event) =>
              (event.currentTarget as HTMLElement).closest("dialog")?.close()}
          >
            Close
          </button>
        </div>

        ${draft.error ? html`<div class="callout danger">${draft.error}</div>` : nothing}

        <label class="field chat-schedule-dialog__field">
          <span>Name</span>
          <input
            data-test-id="chat-task-name"
            .value=${draft.name}
            @input=${(event: Event) => patch({ name: (event.target as HTMLInputElement).value })}
            placeholder="Scheduled chat task"
          />
        </label>

        <label class="field chat-schedule-dialog__field">
          <span>Prompt</span>
          <textarea
            data-test-id="chat-task-prompt"
            .value=${draft.prompt}
            @input=${(event: Event) =>
              patch({ prompt: (event.target as HTMLTextAreaElement).value })}
            placeholder="What should the Agent do when this task runs?"
          ></textarea>
        </label>

        <div class="chat-schedule-dialog__grid">
          ${
            agentOptions.length > 0
              ? html`
                  <label class="field chat-schedule-dialog__field">
                    <span>Agent</span>
                    <select
                      data-test-id="chat-task-agent"
                      .value=${selectedAgentId}
                      @change=${(event: Event) =>
                        patch({ agentId: (event.target as HTMLSelectElement).value })}
                    >
                      ${agentOptions.map(
                        (agent) => html`
                          <option value=${agent.id}>
                            ${formatAgentDisplayName(agent)}${agent.id === "main" ? "" : ` (${agent.id})`}
                          </option>
                        `,
                      )}
                    </select>
                  </label>
                `
              : nothing
          }
          <label class="field chat-schedule-dialog__field">
            <span>Objective</span>
            <input
              data-test-id="chat-task-objective"
              .value=${draft.objective}
              @input=${(event: Event) =>
                patch({ objective: (event.target as HTMLInputElement).value })}
              placeholder="What outcome should this task drive?"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Success</span>
            <input
              data-test-id="chat-task-success"
              .value=${draft.successCriteria}
              @input=${(event: Event) =>
                patch({ successCriteria: (event.target as HTMLInputElement).value })}
              placeholder="How should the task know it is done?"
            />
          </label>
        </div>

        <div class="chat-schedule-dialog__grid">
          <label class="field chat-schedule-dialog__field">
            <span>Schedule</span>
            <select
              data-test-id="chat-task-schedule-kind"
              .value=${draft.kind}
              @change=${(event: Event) =>
                patch({
                  kind: (event.target as HTMLSelectElement).value as ChatScheduleDraft["kind"],
                })}
            >
              <option value="every">Every</option>
              <option value="at">At</option>
              <option value="cron">Advanced</option>
            </select>
          </label>
          ${
            draft.kind === "every"
              ? html`
                <div class="chat-schedule-dialog__inline">
                  <label class="field chat-schedule-dialog__field">
                    <span>Interval</span>
                    <input
                      data-test-id="chat-task-every-amount"
                      inputmode="numeric"
                      .value=${draft.everyAmount}
                      @input=${(event: Event) =>
                        patch({ everyAmount: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label class="field chat-schedule-dialog__field">
                    <span>Unit</span>
                    <select
                      data-test-id="chat-task-every-unit"
                      .value=${draft.everyUnit}
                      @change=${(event: Event) =>
                        patch({
                          everyUnit: (event.target as HTMLSelectElement)
                            .value as ChatScheduleDraft["everyUnit"],
                        })}
                    >
                      <option value="minutes">minutes</option>
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                  </label>
                </div>
              `
              : draft.kind === "at"
                ? html`
                  <label class="field chat-schedule-dialog__field">
                    <span>Run at</span>
                    <input
                      data-test-id="chat-task-at"
                      type="datetime-local"
                      .value=${draft.at}
                      @input=${(event: Event) =>
                        patch({ at: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                `
                : html`
                  <label class="field chat-schedule-dialog__field">
                    <span>Advanced schedule</span>
                    <input
                      data-test-id="chat-task-cron-expr"
                      .value=${draft.cronExpr}
                      @input=${(event: Event) =>
                        patch({ cronExpr: (event.target as HTMLInputElement).value })}
                      placeholder="0 9 * * *"
                    />
                  </label>
                `
          }
        </div>

        <label class="field chat-schedule-dialog__field">
          <span>Delivery</span>
          <select
            data-test-id="chat-task-delivery"
            .value=${channelDeliveryAvailable ? draft.deliveryMode : "local"}
            @change=${(event: Event) =>
              patch({
                deliveryMode: (event.target as HTMLSelectElement)
                  .value as ChatScheduleDraft["deliveryMode"],
              })}
          >
            <option value="local">Local UI session</option>
            ${
              channelDeliveryAvailable
                ? html`<option value="channel">Reply to ${deliveryLabel}</option>`
                : nothing
            }
          </select>
        </label>

        <div class="chat-schedule-dialog__presets" aria-label="Task policy presets">
          <span class="chat-schedule-dialog__presets-label">Presets</span>
          ${TASK_POLICY_PRESET_OPTIONS.map(
            (preset) => html`
              <button
                class="btn btn--xs btn--ghost"
                type="button"
                @click=${() => patch(buildTaskPolicyPresetPatch(preset.id, draft))}
              >
                ${preset.label}
              </button>
            `,
          )}
        </div>

        <div class="chat-schedule-dialog__grid">
          <label class="field chat-schedule-dialog__field">
            <span>Execution</span>
            <select
              data-test-id="chat-task-execution"
              .value=${draft.executionMode}
              @change=${(event: Event) => {
                const executionMode = (event.target as HTMLSelectElement)
                  .value as ChatScheduleDraft["executionMode"];
                patch({
                  executionMode,
                  ...(executionMode === "skill-only" && draft.skillScope === "none"
                    ? { skillScope: "agent-default" as const }
                    : {}),
                });
              }}
            >
              <option value="agent-turn">Agent turn</option>
              <option value="skill-only">Skill-only</option>
              <option value="no-model">No model</option>
              <option value="auto">Auto</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Memory</span>
            <select
              data-test-id="chat-task-memory"
              .value=${draft.memoryScope}
              @change=${(event: Event) =>
                patch({
                  memoryScope: (event.target as HTMLSelectElement)
                    .value as ChatScheduleDraft["memoryScope"],
                })}
            >
              <option value="session-summary">Session summary</option>
              <option value="none">None</option>
              <option value="pinned">Pinned</option>
              <option value="search">Search</option>
              <option value="agent">Agent</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Skills</span>
            <select
              data-test-id="chat-task-skills"
              .value=${draft.skillScope}
              @change=${(event: Event) =>
                patch({
                  skillScope: (event.target as HTMLSelectElement)
                    .value as ChatScheduleDraft["skillScope"],
                })}
            >
              <option value="agent-default">Inherited from Agent</option>
              <option value="selected">Narrow selected skills</option>
              <option value="none">None</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Narrow selected skills</span>
            <input
              data-test-id="chat-task-allowed-skills"
              .value=${draft.allowedSkills}
              ?disabled=${draft.skillScope !== "selected"}
              @input=${(event: Event) =>
                patch({ allowedSkills: (event.target as HTMLInputElement).value })}
              placeholder="wallet, search"
            />
          </label>
          ${
            draft.executionMode === "skill-only"
              ? html`
                <label class="field chat-schedule-dialog__field">
                  <span>Skill tool</span>
                  <input
                    data-test-id="chat-task-skill-tool"
                    .value=${draft.skillToolName}
                    @input=${(event: Event) => {
                      const skillToolName = (event.target as HTMLInputElement).value;
                      patch({
                        skillToolName,
                        ...(skillToolName.trim() &&
                        draft.skillScope === "selected" &&
                        !draft.allowedSkills.trim()
                          ? { allowedSkills: skillToolName.trim() }
                          : {}),
                      });
                    }}
                    placeholder="wallet"
                  />
                </label>
                <label class="field chat-schedule-dialog__field">
                  <span>Skill input</span>
                  <textarea
                    data-test-id="chat-task-skill-input"
                    .value=${draft.skillToolInputJson}
                    @input=${(event: Event) =>
                      patch({ skillToolInputJson: (event.target as HTMLTextAreaElement).value })}
                    rows="3"
                    placeholder='{"action":"balance"}'
                  ></textarea>
                </label>
              `
              : nothing
          }
          <label class="field chat-schedule-dialog__field">
            <span>Cheap/check model</span>
            <input
              data-test-id="chat-task-model"
              .value=${draft.policyModel}
              ?disabled=${draft.executionMode === "no-model"}
              @input=${(event: Event) =>
                patch({ policyModel: (event.target as HTMLInputElement).value })}
              placeholder="provider/model"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Escalation model</span>
            <input
              data-test-id="chat-task-escalation-model"
              .value=${draft.escalationModel}
              ?disabled=${draft.executionMode === "no-model"}
              @input=${(event: Event) =>
                patch({ escalationModel: (event.target as HTMLInputElement).value })}
              placeholder="provider/model"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Escalation cue</span>
            <select
              data-test-id="chat-task-evaluator-enabled"
              .value=${draft.evaluatorEscalateOnSignal ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  evaluatorEscalateOnSignal: (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Cue text</span>
            <input
              data-test-id="chat-task-evaluator-signal"
              .value=${draft.evaluatorSignalIncludes}
              ?disabled=${!draft.evaluatorEscalateOnSignal}
              @input=${(event: Event) =>
                patch({ evaluatorSignalIncludes: (event.target as HTMLInputElement).value })}
              placeholder="Needs deeper analysis: yes"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Max escalations</span>
            <input
              data-test-id="chat-task-max-escalations"
              inputmode="decimal"
              .value=${draft.evaluatorMaxEscalations}
              ?disabled=${!draft.evaluatorEscalateOnSignal}
              @input=${(event: Event) =>
                patch({ evaluatorMaxEscalations: (event.target as HTMLInputElement).value })}
              placeholder="1"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Auto repair retry</span>
            <select
              .value=${draft.repairAutoRetryReplacement ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  repairAutoRetryReplacement: (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="true">Enabled</option>
              <option value="false">Manual only</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Auto stop optional sources</span>
            <select
              .value=${draft.repairAutoStopOptionalSources ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  repairAutoStopOptionalSources:
                    (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="false">Manual</option>
              <option value="true">Enabled</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Max auto repairs/run</span>
            <input
              inputmode="decimal"
              .value=${draft.repairMaxAutoRepairsPerRun}
              @input=${(event: Event) =>
                patch({ repairMaxAutoRepairsPerRun: (event.target as HTMLInputElement).value })}
              placeholder="1"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Primary source approval</span>
            <select
              .value=${draft.repairRequireApprovalForPrimarySource ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  repairRequireApprovalForPrimarySource:
                    (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="true">Required</option>
              <option value="false">Allow deterministic repair</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Max tokens/run</span>
            <input
              data-test-id="chat-task-max-tokens"
              inputmode="decimal"
              .value=${draft.budgetMaxTokensPerRun}
              @input=${(event: Event) =>
                patch({ budgetMaxTokensPerRun: (event.target as HTMLInputElement).value })}
              placeholder="10000"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Max cost/run</span>
            <input
              data-test-id="chat-task-max-cost"
              inputmode="decimal"
              .value=${draft.budgetMaxCostUsdPerRun}
              @input=${(event: Event) =>
                patch({ budgetMaxCostUsdPerRun: (event.target as HTMLInputElement).value })}
              placeholder="0.05"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Max runs/hour</span>
            <input
              data-test-id="chat-task-max-runs-hour"
              inputmode="decimal"
              .value=${draft.budgetMaxRunsPerHour}
              @input=${(event: Event) =>
                patch({ budgetMaxRunsPerHour: (event.target as HTMLInputElement).value })}
              placeholder="12"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Stop on success</span>
            <select
              data-test-id="chat-task-stop-on-success"
              .value=${draft.stopOnSuccess ? "true" : "false"}
              @change=${(event: Event) =>
                patch({
                  stopOnSuccess: (event.target as HTMLSelectElement).value === "true",
                })}
            >
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Stop text</span>
            <input
              data-test-id="chat-task-stop-text"
              .value=${draft.stopTextIncludes}
              @input=${(event: Event) =>
                patch({ stopTextIncludes: (event.target as HTMLInputElement).value })}
              placeholder="done, complete"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Max successes</span>
            <input
              data-test-id="chat-task-max-successes"
              inputmode="decimal"
              .value=${draft.stopMaxSuccessfulRuns}
              @input=${(event: Event) =>
                patch({ stopMaxSuccessfulRuns: (event.target as HTMLInputElement).value })}
              placeholder="1"
            />
          </label>
          <label class="field chat-schedule-dialog__field">
            <span>Max total runs</span>
            <input
              data-test-id="chat-task-max-total-runs"
              inputmode="decimal"
              .value=${draft.stopMaxTotalRuns}
              @input=${(event: Event) =>
                patch({ stopMaxTotalRuns: (event.target as HTMLInputElement).value })}
              placeholder="10"
            />
          </label>
        </div>

        <div class="chat-schedule-dialog__actions">
          <button
            class="btn btn--sm"
            type="button"
            @click=${(event: Event) =>
              (event.currentTarget as HTMLElement).closest("dialog")?.close()}
          >
            Cancel
          </button>
          <button
            class="btn btn--sm primary"
            type="submit"
            data-test-id="chat-task-submit"
            ?disabled=${props.scheduleTaskBusy}
          >
            ${props.scheduleTaskBusy ? "Saving..." : editing ? "Save task" : "Create task"}
          </button>
        </div>
      </form>
    </dialog>
  `;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Add a message or paste more images..."
      : "Message. Type @ for routes or / for commands. Paste images or use attach."
    : "Connect to the gateway to start chatting…";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const thread = html`
    <div
      class="chat-thread"
      role="log"
      aria-live="polite"
      @scroll=${props.onChatScroll}
    >
      ${
        props.loading
          ? html`
              <div class="muted">Loading chat…</div>
            `
          : nothing
      }
      ${repeat(
        buildChatItems(props),
        (item) => item.key,
        (item) => {
          if (item.kind === "divider") {
            return html`
              <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                <span class="chat-divider__line"></span>
                <span class="chat-divider__label">${item.label}</span>
                <span class="chat-divider__line"></span>
              </div>
            `;
          }

          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantIdentity);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantIdentity,
            );
          }

          if (item.kind === "group") {
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning,
              activeSearchMatchIndex: props.transcriptSearchIndex ?? 0,
              assistantName: props.assistantName,
              assistantAvatar: assistantIdentity.avatar,
            });
          }

          return nothing;
        },
      )}
    </div>
  `;

  return html`
    <section class="card chat" @click=${closeOpenChatMenus}>
      ${renderScheduleTaskDialog(props)}
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}

      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${
        props.focusMode
          ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Exit focus mode"
              title="Exit focus mode"
            >
              ${icons.x}
            </button>
          `
          : nothing
      }

      <div
        class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}"
      >
        <div
          class="chat-main"
          style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}"
        >
          ${thread}
        </div>

        ${
          sidebarOpen
            ? html`
              <resizable-divider
                .splitRatio=${splitRatio}
                @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
              ></resizable-divider>
              <div class="chat-sidebar">
                ${renderMarkdownSidebar({
                  content: props.sidebarContent ?? null,
                  error: props.sidebarError ?? null,
                  onClose: props.onCloseSidebar!,
                  onViewRawText: () => {
                    if (!props.sidebarContent || !props.onOpenSidebar) {
                      return;
                    }
                    props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                  },
                })}
              </div>
            `
            : nothing
        }
      </div>

      ${
        props.queue.length
          ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">Queued (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${
                          item.text ||
                          (item.attachments?.length ? `Image (${item.attachments.length})` : "")
                        }
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Remove queued message"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
          : nothing
      }

      ${renderFallbackIndicator(props.fallbackStatus)}
      ${renderCompactionIndicator(props.compactionStatus)}

      ${
        props.showNewMessages
          ? html`
            <button
              class="btn chat-new-messages"
              type="button"
              @click=${props.onScrollToBottom}
            >
              New messages ${icons.arrowDown}
            </button>
          `
          : nothing
      }

      <div class="chat-compose">
        ${renderAttachmentPreview(props)}
        ${renderCommandSuggestions(props)}
        <div class="chat-compose__row" role="group" aria-label="Chat composer">
          <label
            class="chat-compose__icon chat-upload-button ${props.connected ? "" : "disabled"}"
            title="Attach image"
            aria-label="Attach image"
          >
            ${icons.paperclip}
            <input
              class="chat-upload-button__input"
              type="file"
              accept="image/*"
              multiple
              ?disabled=${!props.connected || !props.onAttachmentsChange}
              @change=${(event: Event) => handleFileInput(event, props)}
            />
          </label>
          <label class="field chat-compose__field">
            <span>Message</span>
            <textarea
              ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
              .value=${props.draft}
              dir=${detectTextDirection(props.draft)}
              ?disabled=${!props.connected}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key !== "Enter") {
                  return;
                }
                if (e.isComposing || e.keyCode === 229) {
                  return;
                }
                if (e.shiftKey) {
                  return;
                } // Allow Shift+Enter for line breaks
                if (!props.connected) {
                  return;
                }
                e.preventDefault();
                if (canCompose) {
                  props.onSend();
                }
              }}
              @input=${(e: Event) => {
                const target = e.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                props.onDraftChange(target.value);
              }}
              @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
              placeholder=${composePlaceholder}
            ></textarea>
          </label>
          <div class="chat-compose__actions">
            ${
              props.onScheduleTaskOpen
                ? html`
                    <button
                      class="chat-compose__icon chat-schedule-button"
                      type="button"
                      title="Schedule this prompt"
                      aria-label="Schedule this prompt"
                      ?disabled=${!props.connected}
                      @click=${props.onScheduleTaskOpen}
                    >
                      ${icons.bell}
                    </button>
                  `
                : nothing
            }
            ${props.composerControls ?? nothing}
            ${
              canAbort
                ? html`
                    <button
                      class="chat-compose__icon chat-stop-button"
                      title="Stop response"
                      aria-label="Stop response"
                      ?disabled=${!props.connected}
                      @click=${props.onAbort}
                    >
                      ${icons.stop}
                    </button>
                  `
                : nothing
            }
            <button
              class="chat-compose__send"
              ?disabled=${!props.connected}
              title=${isBusy ? "Queue message" : "Send message"}
              aria-label=${isBusy ? "Queue message" : "Send message"}
              @click=${props.onSend}
            >
              ${icons.send}
            </button>
          </div>
        </div>
      </div>
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const senderLabel = role === "user" ? normalized.senderLabel?.trim() || null : null;
    const timestamp = normalized.timestamp || Date.now();

    if (
      !currentGroup ||
      currentGroup.role !== role ||
      (role === "user" && (currentGroup.senderLabel ?? null) !== senderLabel)
    ) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        senderLabel,
        messages: [
          { message: item.message, key: item.key, searchMatchIndex: item.searchMatchIndex },
        ],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({
        message: item.message,
        key: item.key,
        searchMatchIndex: item.searchMatchIndex,
      });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const transcriptQuery = resolveTranscriptQuery(props);
  let nextSearchMatchIndex = 0;
  const searchMatchIndexForMessage = (message: unknown) => {
    if (!transcriptQuery || !messageMatchesTranscriptSearch(message, transcriptQuery)) {
      return undefined;
    }
    const index = nextSearchMatchIndex;
    nextSearchMatchIndex += 1;
    return index;
  };
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (!transcriptQuery && historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__fased as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compaction",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showToolCalls && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
      searchMatchIndex: searchMatchIndexForMessage(msg),
    });
  }
  if (props.showToolCalls) {
    for (let i = 0; i < tools.length; i++) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
        searchMatchIndex: searchMatchIndexForMessage(tools[i]),
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}
