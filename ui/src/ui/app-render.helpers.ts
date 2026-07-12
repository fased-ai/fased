import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n/index.ts";
import { formatAgentDisplayLabel, formatAgentDisplayName } from "./agent-display.ts";
import { refreshChatAvatar } from "./app-chat.ts";
import { loadProviderModelCatalog, syncUrlWithSessionKey } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { createChatModelOverride } from "./chat-model-ref.ts";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./chat-model-select-state.ts";
import { extractTextCached } from "./chat/message-extract.ts";
import { refreshVisibleToolsEffectiveForCurrentSession } from "./controllers/agents.ts";
import { ChatState, loadChatHistory, loadCurrentChatSessionUsage } from "./controllers/chat.ts";
import {
  deleteSessionAndRefresh,
  loadSessions,
  subscribeActiveSessionMessages,
} from "./controllers/sessions.ts";
import { icons } from "./icons.ts";
import { iconForTab, navTitleForTab, pathForTab, type Tab } from "./navigation.ts";
import { buildAgentMainSessionKey, normalizeAgentId, parseAgentSessionKey } from "./session-key.ts";
import type { ThemeMode } from "./theme.ts";
import {
  listThinkingLevelLabels,
  normalizeThinkLevel,
  resolveThinkingCapabilityForModel,
  resolveThinkingDefaultForModel,
} from "./thinking.ts";
import type { SessionsListResult } from "./types.ts";

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

function countCurrentTranscriptMatches(state: AppViewState): number {
  const query = (state.chatTranscriptSearch ?? "").trim().toLowerCase();
  if (!query) {
    return 0;
  }
  const messages = Array.isArray(state.chatMessages) ? state.chatMessages : [];
  const toolMessages =
    state.settings.chatShowToolCalls && Array.isArray(state.chatToolMessages)
      ? state.chatToolMessages
      : [];
  return [...messages, ...toolMessages].filter((message) =>
    (extractTextCached(message) ?? "").toLowerCase().includes(query),
  ).length;
}

type ChatRenderHost = AppViewState & {
  chatStreamStartedAt: number | null;
  updateComplete: Promise<unknown>;
  resetToolStream: () => void;
  resetChatScroll: () => void;
};

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const currentSessionKey = state.sessionKey?.trim();
  if (currentSessionKey && currentSessionKey !== "main") {
    return currentSessionKey;
  }
  const lastActiveSessionKey = state.settings.lastActiveSessionKey?.trim();
  if (lastActiveSessionKey) {
    return lastActiveSessionKey;
  }
  if (currentSessionKey) {
    return currentSessionKey;
  }
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  const host = state as ChatRenderHost;
  state.sessionKey = sessionKey;
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed?.agentId) {
    state.agentsSelectedId = parsed.agentId;
  }
  state.chatMessage = "";
  state.chatAttachments = [];
  state.chatMessages = [];
  state.chatToolMessages = [];
  state.chatTranscriptSearch = "";
  state.chatTranscriptSearchIndex = 0;
  state.chatStreamSegments = [];
  state.chatThinkingLevel = null;
  state.chatStream = null;
  state.lastError = null;
  state.compactionStatus = null;
  state.fallbackStatus = null;
  state.chatAvatarUrl = null;
  state.chatQueue = [];
  host.chatStreamStartedAt = null;
  state.chatRunId = null;
  host.resetToolStream();
  host.resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

function resolveActiveAgentId(state: AppViewState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  const fromSession = parsed?.agentId?.trim();
  if (fromSession) {
    return fromSession.toLowerCase();
  }
  const selectedAgent = state.agentsSelectedId?.trim();
  if (selectedAgent) {
    return selectedAgent.toLowerCase();
  }
  const defaultAgent = state.agentsList?.defaultId?.trim();
  if (defaultAgent) {
    return defaultAgent.toLowerCase();
  }
  return "main";
}

function createShortChatId(): string {
  const uuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const normalized = uuid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 10);
  return normalized || Date.now().toString(36);
}

function countWebChatSessions(state: AppViewState, agentId: string): number {
  const rows = state.sessionsResult?.sessions ?? [];
  let count = 0;
  for (const row of rows) {
    const parsed = parseAgentSessionKey(row.key);
    if (!parsed || parsed.agentId.toLowerCase() !== agentId.toLowerCase()) {
      continue;
    }
    const rest = parsed.rest.toLowerCase();
    if (rest.startsWith("webchat:direct:")) {
      count += 1;
    }
  }
  return count;
}

function nextLocalChatLabel(
  state: AppViewState,
  agentId: string,
  reservedLabels: ReadonlySet<string> = new Set(),
): string {
  const usedLabels = new Set(
    (state.sessionsResult?.sessions ?? [])
      .map((row) => row.label?.trim())
      .filter((label): label is string => Boolean(label))
      .map((label) => label.toLowerCase()),
  );
  for (const label of reservedLabels) {
    usedLabels.add(label.toLowerCase());
  }
  let index = countWebChatSessions(state, agentId) + 1;
  while (usedLabels.has(`chat ${index}`.toLowerCase())) {
    index += 1;
  }
  return `Chat ${index}`;
}

function buildNewLocalChatSession(state: AppViewState): { key: string; label: string } {
  const agentId = resolveActiveAgentId(state);
  const id = createShortChatId();
  return {
    key: `agent:${agentId}:webchat:direct:${id}`,
    label: nextLocalChatLabel(state, agentId),
  };
}

function isSessionLabelCollision(error: unknown): boolean {
  return /label already in use/i.test(String(error));
}

function isProtectedMainSessionKey(key: string): boolean {
  const parsed = parseAgentSessionKey(key);
  return key === "main" || parsed?.rest === "main";
}

export function renderTab(state: AppViewState, tab: Tab, opts?: { collapsed?: boolean }) {
  const href = pathForTab(tab, state.basePath);
  const isActive = state.tab === tab;
  const collapsed = opts?.collapsed ?? state.settings.navCollapsed;
  const title = navTitleForTab(tab);
  return html`
    <a
      href=${href}
      class="nav-item ${isActive ? "nav-item--active" : ""}"
      data-label=${title}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (tab === "chat") {
          const mainSessionKey = resolveSidebarChatSessionKey(state);
          if (state.sessionKey !== mainSessionKey) {
            resetChatStateForSessionSwitch(state, mainSessionKey);
            void state.loadAssistantIdentity();
            void refreshChatAvatar(state);
          }
        }
        state.setTab(tab);
      }}
      title=${title}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      ${!collapsed ? html`<span class="nav-item__text">${title}</span>` : nothing}
    </a>
  `;
}

function renderCronFilterIcon(hiddenCount: number) {
  return html`
    <span class="chat-cron-filter-icon">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10"></circle>
        <polyline points="12 6 12 12 16 14"></polyline>
      </svg>
      ${
        hiddenCount > 0
          ? html`<span class="chat-cron-filter-icon__badge">${hiddenCount}</span>`
          : nothing
      }
    </span>
  `;
}

export function renderChatSessionSelect(state: AppViewState) {
  const activeAgentId = resolveActiveAgentId(state);
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const activeGroup = sessionGroups.find((group) => group.id === `agent:${activeAgentId}`);
  const query = (state.chatSessionSearch ?? "").trim().toLowerCase();
  const activeOptions = activeGroup?.options ?? [];
  const filteredOptions = query
    ? activeOptions.filter((entry) =>
        [entry.label, entry.scopeLabel, entry.key, activeGroup?.label ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : activeOptions;
  const selectedSessionLabel =
    activeOptions.find((entry) => entry.key === state.sessionKey)?.label ?? state.sessionKey;
  const sessionCount = activeOptions.length;
  const visibleCount = filteredOptions.length;
  const limit = Math.max(10, state.chatSessionListLimit || 30);
  const visibleOptions = filteredOptions.slice(0, limit);
  const hiddenCount = Math.max(0, filteredOptions.length - visibleOptions.length);
  return html`
    <div class="chat-history-picker">
      <div class="chat-history-picker__toolbar">
        ${renderChatAgentSelect(state)}
        <span class="chat-history-picker__count">${visibleCount} / ${sessionCount}</span>
        <button
          class="btn btn--sm btn--icon chat-history-picker__search-toggle"
          type="button"
          title="Search sessions"
          aria-label="Search sessions"
          aria-pressed=${state.chatSessionSearchOpen}
          @click=${() => {
            state.chatSessionSearchOpen = !state.chatSessionSearchOpen;
          }}
        >
          ${icons.search}
        </button>
        <button
          class="btn btn--sm btn--icon chat-history-picker__clear"
          type="button"
          title="Clear session search"
          aria-label="Clear session search"
          ?disabled=${!state.chatSessionSearch}
          @click=${() => {
            state.chatSessionSearch = "";
          }}
        >
          ${icons.x}
        </button>
      </div>
      ${
        state.chatSessionSearchOpen || state.chatSessionSearch
          ? html`
            <div class="chat-history-picker__search-row" role="search">
              <span class="chat-history-picker__search-icon" aria-hidden="true">${icons.search}</span>
              <input
                class="input chat-history-picker__search"
                type="search"
                placeholder="Search this Agent's sessions"
                .value=${state.chatSessionSearch ?? ""}
                @input=${(event: Event) => {
                  state.chatSessionSearch = (event.target as HTMLInputElement).value;
                }}
              />
            </div>
          `
          : nothing
      }
      <div
        class="chat-session-list"
        role="listbox"
        aria-label=${`Sessions for ${activeGroup?.label ?? activeAgentId}`}
        title=${selectedSessionLabel}
      >
        ${
          visibleOptions.length === 0
            ? html`
                <div class="chat-session-list__empty">No sessions for this Agent.</div>
              `
            : repeat(
                visibleOptions,
                (entry) => entry.key,
                (entry) => {
                  const active = entry.key === state.sessionKey;
                  const protectedMain = isProtectedMainSessionKey(entry.key);
                  return html`
                  <div class="chat-session-list__row ${active ? "active" : ""}">
                    <button
                      class="chat-session-list__item"
                      type="button"
                      role="option"
                      aria-selected=${active}
                      title=${entry.key}
                      ?disabled=${!state.connected}
                      @click=${(event: Event) => {
                        if (state.sessionKey !== entry.key) {
                          switchChatSession(state, entry.key);
                        }
                        const details = (event.currentTarget as HTMLElement).closest("details");
                        if (details instanceof HTMLDetailsElement) {
                          details.open = false;
                        }
                      }}
                    >
                      <span class="chat-session-list__label">
                        ${stripAgentPrefixFromSessionLabel(entry.label, activeGroup?.label)}
                      </span>
                      <span class="chat-session-list__time">${formatRelativeSessionTime(entry.updatedAt)}</span>
                    </button>
                    <button
                      class="chat-session-list__delete"
                      type="button"
                      title=${
                        protectedMain
                          ? "Main Agent session cannot be deleted"
                          : active
                            ? "Switch away before deleting this session"
                            : "Delete session"
                      }
                      aria-label="Delete session"
                      ?disabled=${active || protectedMain || !state.connected}
                      @click=${(event: Event) => {
                        event.stopPropagation();
                        if (active || protectedMain || !state.connected) {
                          return;
                        }
                        void deleteSessionAndRefresh(
                          state as unknown as Parameters<typeof deleteSessionAndRefresh>[0],
                          entry.key,
                        );
                      }}
                    >
                      ${icons.trash}
                    </button>
                  </div>
                `;
                },
              )
        }
      </div>
      ${
        hiddenCount > 0
          ? html`
            <button
              class="btn btn--sm chat-session-list__more"
              type="button"
              @click=${() => {
                state.chatSessionListLimit = limit + 30;
              }}
            >
              View ${Math.min(30, hiddenCount)} more
            </button>
          `
          : nothing
      }
    </div>
  `;
}

function renderChatAgentSelect(state: AppViewState) {
  const agents = state.agentsList?.agents ?? [];
  if (agents.length === 0) {
    return nothing;
  }
  const activeAgentId = resolveActiveAgentId(state);
  return html`
    <label class="chat-agent-picker">
      <span class="chat-agent-picker__label">Agent</span>
      <select
        class="chat-agent-picker__select"
        aria-label="Chat Agent"
        title="Choose the Agent for new local chats"
        .value=${activeAgentId}
        @change=${(event: Event) => {
          const next = (event.target as HTMLSelectElement).value;
          switchChatAgent(state, next);
        }}
      >
        ${repeat(
          agents,
          (agent) => agent.id,
          (agent) => {
            const label = resolveAgentDisplayName(agent.id, agent.name, agent.identity?.name);
            return html`<option value=${normalizeAgentId(agent.id)}>${label}</option>`;
          },
        )}
      </select>
    </label>
  `;
}

function stripAgentPrefixFromSessionLabel(label: string, groupLabel?: string): string {
  const trimmed = label.trim();
  const group = groupLabel?.trim();
  if (!group) {
    return trimmed;
  }
  const prefix = `${group} / `;
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function formatRelativeSessionTime(updatedAt: number | null | undefined): string {
  if (!updatedAt || !Number.isFinite(updatedAt)) {
    return "No activity";
  }
  const diffMs = Date.now() - updatedAt;
  if (diffMs < 0) {
    return "Just now";
  }
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diffMs < minute) {
    return "Just now";
  }
  if (diffMs < hour) {
    const count = Math.max(1, Math.round(diffMs / minute));
    return `${count}m ago`;
  }
  if (diffMs < day) {
    const count = Math.max(1, Math.round(diffMs / hour));
    return `${count}h ago`;
  }
  if (diffMs < week) {
    const count = Math.max(1, Math.round(diffMs / day));
    return `${count}d ago`;
  }
  const count = Math.max(1, Math.round(diffMs / week));
  return `${count}w ago`;
}

export function renderChatTranscriptSearch(state: AppViewState) {
  const transcriptQuery = (state.chatTranscriptSearch ?? "").trim();
  const transcriptMatchCount = countCurrentTranscriptMatches(state);
  const rawSearchIndex = Number.isFinite(state.chatTranscriptSearchIndex)
    ? state.chatTranscriptSearchIndex
    : 0;
  const activeIndex =
    transcriptQuery && transcriptMatchCount > 0
      ? Math.min(Math.max(0, rawSearchIndex), transcriptMatchCount - 1)
      : 0;
  const transcriptSummary = transcriptQuery
    ? transcriptMatchCount > 0
      ? `${activeIndex + 1} / ${transcriptMatchCount}`
      : "0 matches"
    : "Current chat";
  return html`
    <details class="chat-transcript-menu">
      <summary
        class="btn btn--sm btn--icon"
        title="Search current chat"
        aria-label="Search current chat"
      >
        ${icons.search}
      </summary>
      <div class="chat-transcript-menu__panel">
        <div class="chat-model-menu__title">Chat search</div>
        <div class="chat-transcript-search" role="search" aria-label="Search current chat">
          <span class="chat-transcript-search__icon" aria-hidden="true">${icons.search}</span>
          <input
            class="input chat-transcript-search__input"
            type="search"
            placeholder="Search this chat"
            .value=${state.chatTranscriptSearch ?? ""}
            @input=${(event: Event) => {
              state.chatTranscriptSearch = (event.target as HTMLInputElement).value;
              state.chatTranscriptSearchIndex = 0;
            }}
          />
          <span class="chat-transcript-search__summary">${transcriptSummary}</span>
          <button
            class="btn btn--sm btn--icon chat-transcript-search__nav"
            type="button"
            title="Previous match"
            aria-label="Previous chat search match"
            ?disabled=${transcriptMatchCount === 0}
            @click=${() => {
              if (transcriptMatchCount <= 0) {
                return;
              }
              state.chatTranscriptSearchIndex =
                (activeIndex - 1 + transcriptMatchCount) % transcriptMatchCount;
            }}
          >
            ${icons.chevronUp}
          </button>
          <button
            class="btn btn--sm btn--icon chat-transcript-search__nav"
            type="button"
            title="Next match"
            aria-label="Next chat search match"
            ?disabled=${transcriptMatchCount === 0}
            @click=${() => {
              if (transcriptMatchCount <= 0) {
                return;
              }
              state.chatTranscriptSearchIndex = (activeIndex + 1) % transcriptMatchCount;
            }}
          >
            ${icons.chevronDown}
          </button>
          <button
            class="btn btn--sm chat-transcript-search__clear"
            type="button"
            ?disabled=${!transcriptQuery}
            @click=${() => {
              state.chatTranscriptSearch = "";
              state.chatTranscriptSearchIndex = 0;
            }}
          >
            Clear
          </button>
        </div>
      </div>
    </details>
  `;
}

export function renderChatComposerControls(state: AppViewState) {
  const trustNotice = renderChatModelTrustNotice(state);
  const thinkingState = resolveChatThinkingSelectState(state);
  return html`
    <details class="chat-model-menu">
      <summary
        class="btn btn--icon chat-model-menu__button"
        title="Choose provider model and capabilities"
        aria-label="Choose provider model and capabilities"
      >
        ${icons.brain}
      </summary>
      <div class="chat-model-menu__panel">
        <div class="chat-model-menu__header">
          <div class="chat-model-menu__title">Model and capabilities</div>
        </div>
        <div class="chat-model-menu__controls">
          <div class="chat-model-menu__control chat-model-menu__control--model">
            <div class="chat-model-menu__label">Provider / model</div>
            ${renderChatModelSelect(state)}
          </div>
          ${
            thinkingState.supported
              ? html`
                <div class="chat-model-menu__control chat-model-menu__control--thinking">
                  <div class="chat-model-menu__label">Capabilities</div>
                  ${renderChatThinkingSelect(state, thinkingState)}
                </div>
              `
              : nothing
          }
        </div>
        ${trustNotice}
      </div>
    </details>
  `;
}

function normalizeProviderKey(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isUsableAuthStatus(status: string | null | undefined) {
  return status === "ok" || status === "static" || status === "expiring";
}

function describeMissingChatModelProvider(state: AppViewState, provider: string) {
  const catalogProvider = state.configModelCatalogStatus?.providers?.find(
    (entry) => normalizeProviderKey(entry.provider) === provider,
  );
  if (!catalogProvider) {
    return "no provider catalog entry loaded yet";
  }
  if ((catalogProvider.totalModels ?? 0) <= 0) {
    return "catalog has no models for this provider";
  }
  if (!catalogProvider.configured) {
    return "provider catalog is available, but this Agent is not configured for it";
  }
  return "catalog is loaded, but not available to the selected Agent yet";
}

function renderChatModelTrustNotice(state: AppViewState) {
  const catalogProviders = new Set(
    (state.chatModelCatalog ?? [])
      .map((entry) => normalizeProviderKey(entry.provider))
      .filter(Boolean),
  );
  if (state.chatModelsLoading && catalogProviders.size === 0) {
    return html`
      <p class="chat-model-menu__note" role="status">Loading usable models for this Agent...</p>
    `;
  }
  const readyMissingProviders = (state.configAuthStatus?.providers ?? [])
    .filter((entry) => isUsableAuthStatus(entry.status))
    .map((entry) => normalizeProviderKey(entry.provider))
    .filter((provider) => provider && !catalogProviders.has(provider));
  if (readyMissingProviders.length > 0) {
    const provider = readyMissingProviders[0];
    const reason = describeMissingChatModelProvider(state, provider);
    const more = readyMissingProviders.length > 1 ? ` +${readyMissingProviders.length - 1}` : "";
    return html`
      <p class="chat-model-menu__note" role="status">
        Signed-in provider missing from Chat: ${provider}${more}. ${reason}. Refresh Providers or
        restart the gateway if auth was just added.
      </p>
    `;
  }
  if (!state.chatModelsLoading && catalogProviders.size === 0) {
    return html`
      <p class="chat-model-menu__note" role="status">
        No usable models loaded for this Agent. Open Providers, then refresh Chat if you just signed in.
      </p>
    `;
  }
  return nothing;
}

export function renderChatControls(state: AppViewState) {
  const hideCron = state.sessionsHideCron ?? true;
  const hiddenCronCount = hideCron
    ? countHiddenCronSessions(state.sessionKey, state.sessionsResult)
    : 0;
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const chatBusy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  return html`
    <div class="chat-controls">
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${chatBusy || !state.connected}
        @click=${() => void createNewLocalChatSession(state)}
        title="New chat"
        aria-label="New chat"
      >
        ${icons.plus}
      </button>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${chatBusy || !state.connected}
        @click=${() => void resetCurrentChatSession(state)}
        title="Reset current chat"
        aria-label="Reset current chat"
      >
        ${icons.rotateCcw}
      </button>
      <details class="chat-session-menu">
        <summary
          class="btn btn--sm btn--icon"
          title="Switch chat session"
          aria-label="Switch chat session"
        >
          ${icons.messageSquare}
        </summary>
        <div class="chat-session-menu__panel">
          <div class="chat-model-menu__title">Sessions</div>
          ${renderChatSessionSelect(state)}
        </div>
      </details>
      <button
        class="btn btn--sm btn--icon ${hideCron ? "active" : ""}"
        @click=${() => {
          state.sessionsHideCron = !hideCron;
        }}
        aria-pressed=${hideCron}
        title=${
          hideCron
            ? hiddenCronCount > 0
              ? t("chat.showCronSessionsHidden", { count: String(hiddenCronCount) })
              : t("chat.showCronSessions")
            : t("chat.hideCronSessions")
        }
      >
        ${renderCronFilterIcon(hiddenCronCount)}
      </button>
      <button
        class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${disableThinkingToggle ? t("chat.onboardingDisabled") : t("chat.thinkingToggle")}
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowToolCalls: !state.settings.chatShowToolCalls,
          });
        }}
        aria-pressed=${showToolCalls}
        title=${disableThinkingToggle ? t("chat.onboardingDisabled") : t("chat.toolCallsToggle")}
      >
        ${toolCallsIcon}
      </button>
      <button
        class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
        ?disabled=${disableFocusToggle}
        @click=${() => {
          if (disableFocusToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        }}
        aria-pressed=${focusActive}
        title=${disableFocusToggle ? t("chat.onboardingDisabled") : t("chat.focusToggle")}
      >
        ${focusIcon}
      </button>
    </div>
  `;
}

async function resetCurrentChatSession(state: AppViewState) {
  if (!state.client || !state.connected || !state.sessionKey.trim()) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const previousDraft = state.chatMessage;
  const currentOverride = resolveChatModelOverrideValue(state);
  state.lastError = null;
  try {
    const result = await state.client.request<{ ok?: boolean; key?: string }>("sessions.reset", {
      key: targetSessionKey,
      reason: "new",
    });
    const nextSessionKey =
      typeof result?.key === "string" && result.key.trim() ? result.key.trim() : targetSessionKey;
    resetChatStateForSessionSwitch(state, nextSessionKey);
    state.chatMessage = previousDraft;
    state.chatSessionUsage = null;
    if (currentOverride) {
      state.chatModelOverrides = {
        ...state.chatModelOverrides,
        [nextSessionKey]: createChatModelOverride(currentOverride),
      };
      await state.client.request("sessions.patch", {
        key: nextSessionKey,
        model: currentOverride,
      });
    }
    await Promise.all([
      loadChatHistory(state as unknown as ChatState),
      loadCurrentChatSessionUsage(state as unknown as ChatState),
      refreshSessionOptions(state),
    ]);
  } catch (err) {
    state.lastError = `Failed to reset current chat: ${String(err)}`;
  }
}

async function createNewLocalChatSession(state: AppViewState) {
  if (!state.client || !state.connected) {
    return;
  }
  const { key } = buildNewLocalChatSession(state);
  const agentId = resolveActiveAgentId(state);
  state.lastError = null;
  try {
    let patched = false;
    const attemptedLabels = new Set<string>();
    for (let attempt = 0; attempt < 4 && !patched; attempt += 1) {
      const label = nextLocalChatLabel(state, agentId, attemptedLabels);
      attemptedLabels.add(label);
      try {
        await state.client.request("sessions.patch", {
          key,
          label,
        });
        patched = true;
      } catch (error) {
        if (!isSessionLabelCollision(error) || attempt === 3) {
          throw error;
        }
        await refreshSessionOptions(state);
      }
    }
    resetChatStateForSessionSwitch(state, key);
    state.chatSessionUsage = null;
    syncUrlWithSessionKey(
      state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
      key,
      true,
    );
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state);
    await Promise.all([
      subscribeActiveSessionMessages(
        state as unknown as Parameters<typeof subscribeActiveSessionMessages>[0],
      ),
      loadChatHistory(state as unknown as ChatState),
      loadCurrentChatSessionUsage(state as unknown as ChatState),
      refreshSessionOptions(state),
      loadProviderModelCatalog(state as unknown as Parameters<typeof loadProviderModelCatalog>[0]),
    ]);
  } catch (err) {
    state.lastError = `Failed to create new chat: ${String(err)}`;
  }
}

/**
 * Mobile-only gear toggle + dropdown for chat controls.
 * Rendered in the topbar so it doesn't consume content-header space.
 * Hidden on desktop via CSS.
 */
export function renderChatMobileToggle(state: AppViewState) {
  const sessionGroups = resolveSessionOptionGroups(state, state.sessionKey, state.sessionsResult);
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  const toolCallsIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;

  return html`
    <div class="chat-mobile-controls-wrapper">
      <button
        class="btn btn--sm btn--icon chat-controls-mobile-toggle"
        @click=${(e: Event) => {
          e.stopPropagation();
          const btn = e.currentTarget as HTMLElement;
          const dropdown = btn.nextElementSibling as HTMLElement;
          if (dropdown) {
            const isOpen = dropdown.classList.toggle("open");
            if (isOpen) {
              const close = () => {
                dropdown.classList.remove("open");
                document.removeEventListener("click", close);
              };
              setTimeout(() => document.addEventListener("click", close, { once: true }), 0);
            }
          }
        }}
        title="Chat settings"
        aria-label="Chat settings"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3"></circle>
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          ></path>
        </svg>
      </button>
      <div
        class="chat-controls-dropdown"
        @click=${(e: Event) => {
          e.stopPropagation();
        }}
      >
        <div class="chat-controls">
          <label class="field chat-controls__session">
            <select
              .value=${state.sessionKey}
              @change=${(e: Event) => {
                const next = (e.target as HTMLSelectElement).value;
                switchChatSession(state, next);
              }}
            >
              ${sessionGroups.map(
                (group) => html`
                  <optgroup label=${group.label}>
                    ${group.options.map(
                      (opt) => html`
                        <option value=${opt.key} title=${opt.title}>${opt.label}</option>
                      `,
                    )}
                  </optgroup>
                `,
              )}
            </select>
          </label>
          ${renderChatThinkingSelect(state)}
          <div class="chat-controls__thinking">
            <button
              class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowThinking: !state.settings.chatShowThinking,
                  });
                }
              }}
              aria-pressed=${showThinking}
              title=${t("chat.thinkingToggle")}
            >
              ${icons.brain}
            </button>
            <button
              class="btn btn--sm btn--icon ${showToolCalls ? "active" : ""}"
              ?disabled=${disableThinkingToggle}
              @click=${() => {
                if (!disableThinkingToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatShowToolCalls: !state.settings.chatShowToolCalls,
                  });
                }
              }}
              aria-pressed=${showToolCalls}
              title=${t("chat.toolCallsToggle")}
            >
              ${toolCallsIcon}
            </button>
            <button
              class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
              ?disabled=${disableFocusToggle}
              @click=${() => {
                if (!disableFocusToggle) {
                  state.applySettings({
                    ...state.settings,
                    chatFocusMode: !state.settings.chatFocusMode,
                  });
                }
              }}
              aria-pressed=${focusActive}
              title=${t("chat.focusToggle")}
            >
              ${focusIcon}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function switchChatSession(state: AppViewState, nextSessionKey: string) {
  resetChatStateForSessionSwitch(state, nextSessionKey);
  void state.loadAssistantIdentity();
  void refreshChatAvatar(state);
  void subscribeActiveSessionMessages(
    state as unknown as Parameters<typeof subscribeActiveSessionMessages>[0],
  );
  syncUrlWithSessionKey(
    state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
    nextSessionKey,
    true,
  );
  void loadChatHistory(state as unknown as ChatState);
  void loadCurrentChatSessionUsage(state as unknown as ChatState);
  void refreshSessionOptions(state);
  void loadProviderModelCatalog(state as unknown as Parameters<typeof loadProviderModelCatalog>[0]);
}

function resolveAgentDisplayName(
  agentIdRaw: string,
  nameRaw?: string | null,
  identityNameRaw?: string | null,
): string {
  const agentId = normalizeAgentId(agentIdRaw);
  return formatAgentDisplayName({
    id: agentId,
    name: nameRaw,
    identity: { name: identityNameRaw },
  });
}

function resolvePreferredChatSessionForAgent(state: AppViewState, agentIdRaw: string): string {
  const agentId = normalizeAgentId(agentIdRaw);
  const rows = state.sessionsResult?.sessions ?? [];
  const agentRows = rows.filter((row) => parseAgentSessionKey(row.key)?.agentId === agentId);
  const localRows = agentRows
    .filter((row) => {
      const rest = parseAgentSessionKey(row.key)?.rest.toLowerCase() ?? "";
      return rest === "main" || rest.startsWith("webchat:direct:");
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const preferred = localRows[0]?.key;
  if (preferred) {
    return preferred;
  }
  const rawMainKey = state.agentsList?.mainKey?.trim() || "main";
  const mainKey = parseAgentSessionKey(rawMainKey)?.rest ?? rawMainKey;
  return buildAgentMainSessionKey({
    agentId,
    mainKey,
  });
}

function switchChatAgent(state: AppViewState, agentIdRaw: string) {
  const agentId = normalizeAgentId(agentIdRaw);
  state.agentsSelectedId = agentId;
  state.chatSessionSearch = "";
  state.chatSessionSearchOpen = false;
  state.chatSessionListLimit = 30;
  const nextSessionKey = resolvePreferredChatSessionForAgent(state, agentId);
  if (state.sessionKey === nextSessionKey) {
    return;
  }
  switchChatSession(state, nextSessionKey);
}

async function refreshSessionOptions(state: AppViewState) {
  await loadSessions(state as unknown as Parameters<typeof loadSessions>[0], {
    activeMinutes: 0,
    limit: 0,
    includeGlobal: true,
    includeUnknown: true,
  });
}

function renderChatModelSelect(state: AppViewState) {
  const { currentOverride, defaultLabel, options } = resolveChatModelSelectState(state);
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const applying =
    state.chatModelPatchInFlight && state.chatModelPatchSessionKey === state.sessionKey;
  const disabled =
    !state.connected ||
    busy ||
    applying ||
    (state.chatModelsLoading && options.length === 0) ||
    !state.client;
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  const allOptions = [{ value: "", label: defaultLabel }, ...options];
  return html`
    <div class="chat-select">
      <label class="field chat-controls__session chat-controls__model chat-select__native-wrap">
        <select
          class="chat-select__native"
          data-chat-model-select="true"
          aria-label="Chat model"
          title=${selectedLabel}
          ?disabled=${disabled}
          @change=${async (e: Event) => {
            const next = (e.target as HTMLSelectElement).value.trim();
            await switchChatModel(state, next);
          }}
        >
          <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
          ${repeat(
            options,
            (entry) => entry.value,
            (entry) =>
              html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
                ${entry.label}
              </option>`,
          )}
        </select>
      </label>
      <details class="chat-select__popover">
        <summary
          class="chat-select__button"
          aria-label="Chat model"
          title=${selectedLabel}
          aria-disabled=${disabled}
          @click=${(event: Event) => {
            if (disabled) {
              event.preventDefault();
            }
          }}
        >
          <span>${selectedLabel}</span>
          ${icons.chevronDown}
        </summary>
        <div class="chat-select__panel" role="listbox" aria-label="Chat model">
          ${repeat(
            allOptions,
            (entry) => entry.value,
            (entry) => html`
              <button
                class="chat-select__option ${entry.value === currentOverride ? "active" : ""}"
                type="button"
                role="option"
                aria-selected=${entry.value === currentOverride}
                title=${entry.label}
                ?disabled=${disabled}
                @click=${async (event: Event) => {
                  await switchChatModel(state, entry.value);
                  const details = (event.currentTarget as HTMLElement).closest("details");
                  if (details instanceof HTMLDetailsElement) {
                    details.open = false;
                  }
                }}
              >
                ${entry.label}
              </button>
            `,
          )}
        </div>
      </details>
      ${
        applying
          ? html`
              <p class="chat-model-menu__note" role="status">Applying model to current session...</p>
            `
          : nothing
      }
    </div>
  `;
}

type ChatThinkingSelectOption = {
  value: string;
  label: string;
};

type ChatThinkingSelectState = {
  supported: boolean;
  currentOverride: string;
  defaultLabel: string;
  options: ChatThinkingSelectOption[];
};

function formatThinkingOptionLabel(value: string, mode?: string) {
  if (mode === "zai-binary" && value === "low") {
    return "On";
  }
  if (mode === "openai-reasoning-effort" && value === "off") {
    return "None";
  }
  return value
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function resolveThinkingTargetModel(state: AppViewState): {
  provider: string | null;
  model: string | null;
} {
  const selectedValue = resolveChatModelOverrideValue(state);
  if (selectedValue) {
    const parsed = parseQualifiedModelValue(selectedValue);
    if (parsed.provider || parsed.model) {
      return {
        provider: parsed.provider ?? null,
        model: parsed.model ?? null,
      };
    }
  }
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  return {
    provider: activeRow?.modelProvider ?? state.sessionsResult?.defaults?.modelProvider ?? null,
    model: activeRow?.model ?? state.sessionsResult?.defaults?.model ?? null,
  };
}

function resolveThinkingCatalogEntry(
  state: AppViewState,
  provider: string | null,
  model: string | null,
) {
  if (!provider || !model) {
    return undefined;
  }
  return (state.chatModelCatalog ?? []).find(
    (entry) =>
      entry.provider.trim().toLowerCase() === provider.trim().toLowerCase() &&
      entry.id.trim().toLowerCase() === model.trim().toLowerCase(),
  );
}

function buildThinkingOptions(
  levels: readonly string[],
  mode?: string,
): ChatThinkingSelectOption[] {
  const seen = new Set<string>();
  const options: ChatThinkingSelectOption[] = [];

  const addOption = (value: string, label?: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({
      value: trimmed,
      label: label ?? formatThinkingOptionLabel(trimmed, mode),
    });
  };

  for (const label of levels) {
    const normalized = normalizeThinkLevel(label) ?? label.trim().toLowerCase();
    addOption(normalized);
  }
  return options;
}

export function resolveChatThinkingSelectState(state: AppViewState): ChatThinkingSelectState {
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
  const persisted = activeRow?.thinkingLevel;
  const currentOverride =
    typeof persisted === "string" && persisted.trim()
      ? (normalizeThinkLevel(persisted) ?? persisted.trim())
      : "";
  const { provider, model } = resolveThinkingTargetModel(state);
  const catalogEntry = resolveThinkingCatalogEntry(state, provider, model);
  const catalog = catalogEntry ? [catalogEntry] : [];
  const thinking =
    provider && model && catalogEntry
      ? resolveThinkingCapabilityForModel({
          provider,
          model,
          catalog,
        })
      : null;
  const defaultLevel =
    provider && model && catalogEntry
      ? resolveThinkingDefaultForModel({
          provider,
          model,
          catalog,
        })
      : "off";
  const options = buildThinkingOptions(
    thinking?.thinkingLevels ?? listThinkingLevelLabels(provider, model),
    thinking?.thinkingMode,
  );
  return {
    supported: thinking !== null,
    currentOverride: options.some((option) => option.value === currentOverride)
      ? currentOverride
      : "",
    defaultLabel: `Default (${defaultLevel})`,
    options,
  };
}

function renderChatThinkingSelect(
  state: AppViewState,
  selectState = resolveChatThinkingSelectState(state),
) {
  const { currentOverride, defaultLabel, options } = selectState;
  if (!selectState.supported) {
    return nothing;
  }
  const busy =
    state.chatLoading || state.chatSending || Boolean(state.chatRunId) || state.chatStream !== null;
  const disabled = !state.connected || busy || !state.client;
  const selectedLabel =
    currentOverride === ""
      ? defaultLabel
      : (options.find((entry) => entry.value === currentOverride)?.label ?? currentOverride);
  const allOptions = [{ value: "", label: defaultLabel }, ...options];
  return html`
    <div class="chat-select">
      <label class="field chat-controls__session chat-controls__thinking-select chat-select__native-wrap">
      <select
        class="chat-select__native"
        data-chat-thinking-select="true"
        aria-label="Chat capabilities"
        title=${selectedLabel}
        ?disabled=${disabled}
        @change=${async (e: Event) => {
          const next = (e.target as HTMLSelectElement).value.trim();
          await switchChatThinkingLevel(state, next);
        }}
      >
        <option value="" ?selected=${currentOverride === ""}>${defaultLabel}</option>
        ${repeat(
          options,
          (entry) => entry.value,
          (entry) =>
            html`<option value=${entry.value} ?selected=${entry.value === currentOverride}>
              ${entry.label}
            </option>`,
        )}
      </select>
      </label>
      <details class="chat-select__popover">
        <summary
          class="chat-select__button"
          aria-label="Chat capabilities"
          title=${selectedLabel}
          aria-disabled=${disabled}
          @click=${(event: Event) => {
            if (disabled) {
              event.preventDefault();
            }
          }}
        >
          <span>${selectedLabel}</span>
          ${icons.chevronDown}
        </summary>
        <div class="chat-select__panel" role="listbox" aria-label="Chat capabilities">
          ${repeat(
            allOptions,
            (entry) => entry.value,
            (entry) => html`
              <button
                class="chat-select__option ${entry.value === currentOverride ? "active" : ""}"
                type="button"
                role="option"
                aria-selected=${entry.value === currentOverride}
                title=${entry.label}
                ?disabled=${disabled}
                @click=${async (event: Event) => {
                  await switchChatThinkingLevel(state, entry.value);
                  const details = (event.currentTarget as HTMLElement).closest("details");
                  if (details instanceof HTMLDetailsElement) {
                    details.open = false;
                  }
                }}
              >
                ${entry.label}
              </button>
            `,
          )}
        </div>
      </details>
    </div>
  `;
}

async function switchChatModel(state: AppViewState, nextModel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const currentOverride = resolveChatModelOverrideValue(state);
  if (currentOverride === nextModel) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const prevOverride = state.chatModelOverrides?.[targetSessionKey];
  state.lastError = null;
  // Write the override cache immediately so the picker stays in sync during the RPC round-trip.
  state.chatModelOverrides = {
    ...state.chatModelOverrides,
    [targetSessionKey]: createChatModelOverride(nextModel),
  };
  const selectedLabel = nextModel || "default model";
  state.chatModelPatchInFlight = true;
  state.chatModelPatchSessionKey = targetSessionKey;
  state.chatModelPatchLabel = selectedLabel;
  patchSessionModelValue(state, targetSessionKey, nextModel);
  let pending: Promise<void> = Promise.resolve();
  pending = (async () => {
    try {
      await state.client!.request("sessions.patch", {
        key: targetSessionKey,
        model: nextModel || null,
      });
      void refreshVisibleToolsEffectiveForCurrentSession(state);
      await refreshSessionOptions(state);
    } catch (err) {
      // Roll back so the picker reflects the actual server model.
      state.chatModelOverrides = {
        ...state.chatModelOverrides,
        [targetSessionKey]: prevOverride ?? null,
      };
      patchSessionModelValue(state, targetSessionKey, currentOverride);
      state.lastError = `Failed to set model: ${String(err)}`;
    } finally {
      if (state.chatModelPatchPending === pending) {
        state.chatModelPatchPending = null;
      }
      if (state.chatModelPatchSessionKey === targetSessionKey) {
        state.chatModelPatchInFlight = false;
        state.chatModelPatchSessionKey = null;
        state.chatModelPatchLabel = null;
      }
    }
  })();
  state.chatModelPatchPending = pending;
  await pending;
}

function parseQualifiedModelValue(value: string): { provider?: string; model?: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return { model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

function patchSessionModelValue(state: AppViewState, sessionKey: string, modelValue: string) {
  const current = state.sessionsResult;
  if (!current) {
    return;
  }
  const parsed = parseQualifiedModelValue(modelValue);
  state.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey
        ? {
            ...row,
            modelProvider: parsed.provider,
            model: parsed.model,
          }
        : row,
    ),
  };
}

function patchSessionThinkingLevel(
  state: AppViewState,
  sessionKey: string,
  thinkingLevel: string | undefined,
) {
  const current = state.sessionsResult;
  if (!current) {
    return;
  }
  state.sessionsResult = {
    ...current,
    sessions: current.sessions.map((row) =>
      row.key === sessionKey
        ? {
            ...row,
            thinkingLevel,
          }
        : row,
    ),
  };
}

async function switchChatThinkingLevel(state: AppViewState, nextThinkingLevel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const targetSessionKey = state.sessionKey;
  const activeRow = state.sessionsResult?.sessions?.find((row) => row.key === targetSessionKey);
  const previousThinkingLevel = activeRow?.thinkingLevel;
  const normalizedNext =
    (normalizeThinkLevel(nextThinkingLevel) ?? nextThinkingLevel.trim()) || undefined;
  const normalizedPrev =
    typeof previousThinkingLevel === "string" && previousThinkingLevel.trim()
      ? (normalizeThinkLevel(previousThinkingLevel) ?? previousThinkingLevel.trim())
      : undefined;
  if ((normalizedPrev ?? "") === (normalizedNext ?? "")) {
    return;
  }
  state.lastError = null;
  patchSessionThinkingLevel(state, targetSessionKey, normalizedNext);
  state.chatThinkingLevel = normalizedNext ?? null;
  try {
    await state.client.request("sessions.patch", {
      key: targetSessionKey,
      thinkingLevel: normalizedNext ?? null,
    });
    await refreshSessionOptions(state);
  } catch (err) {
    patchSessionThinkingLevel(state, targetSessionKey, previousThinkingLevel);
    state.chatThinkingLevel = normalizedPrev ?? null;
    state.lastError = `Failed to set reasoning: ${String(err)}`;
  }
}

/* ── Channel display labels ────────────────────────────── */
const CHANNEL_LABELS: Record<string, string> = {
  bluebubbles: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/** Parsed type / context extracted from a session key. */
export type SessionKeyInfo = {
  /** Prefix for typed sessions (Subagent:/Task:). Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a session key to extract type information and a human-readable
 * fallback display name.  Exported for testing.
 */
export function parseSessionKey(key: string): SessionKeyInfo {
  const normalized = key.toLowerCase();

  // ── Main session ─────────────────────────────────
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Local chat" };
  }

  // ── Subagent ─────────────────────────────────────
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }

  // ── Scheduled task ───────────────────────────────
  if (normalized.startsWith("cron:") || key.includes(":cron:")) {
    return { prefix: "Task:", fallbackName: "Task:" };
  }

  // ── Direct chat  (agent:<x>:<channel>:direct:<id>) ──
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const identifier = directMatch[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }

  // ── Group chat  (agent:<x>:<channel>:group:<id>) ────
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // ── Channel-prefixed legacy keys (e.g. "bluebubbles:g-…") ──
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }

  // ── Unknown — return key as-is ───────────────────
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(
  key: string,
  row?: SessionsListResult["sessions"][number],
): string {
  const label = row?.label?.trim() || "";
  const displayName = row?.displayName?.trim() || "";
  const { prefix, fallbackName } = parseSessionKey(key);

  const applyTypedPrefix = (name: string): string => {
    if (!prefix) {
      return name;
    }
    if (prefix === "Task:" && /^Cron:\s*/i.test(name)) {
      return name.replace(/^Cron:\s*/i, "Task: ");
    }
    const prefixPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*`, "i");
    return prefixPattern.test(name) ? name : `${prefix} ${name}`;
  };

  if (label && label !== key) {
    return applyTypedPrefix(label);
  }
  if (displayName && displayName !== key) {
    return applyTypedPrefix(displayName);
  }
  return fallbackName;
}

export function isCronSessionKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("cron:")) {
    return true;
  }
  if (!normalized.startsWith("agent:")) {
    return false;
  }
  const parts = normalized.split(":").filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  const rest = parts.slice(2).join(":");
  return rest.startsWith("cron:");
}

type SessionOptionEntry = {
  key: string;
  label: string;
  scopeLabel: string;
  title: string;
  updatedAt: number | null | undefined;
};

type SessionOptionGroup = {
  id: string;
  label: string;
  options: SessionOptionEntry[];
};

export function resolveSessionOptionGroups(
  state: AppViewState,
  sessionKey: string,
  sessions: SessionsListResult | null,
): SessionOptionGroup[] {
  const rows = sessions?.sessions ?? [];
  const hideCron = state.sessionsHideCron ?? true;
  const byKey = new Map<string, SessionsListResult["sessions"][number]>();
  for (const row of rows) {
    byKey.set(row.key, row);
  }

  const seenKeys = new Set<string>();
  const groups = new Map<string, SessionOptionGroup>();
  const ensureGroup = (groupId: string, label: string): SessionOptionGroup => {
    const existing = groups.get(groupId);
    if (existing) {
      return existing;
    }
    const created: SessionOptionGroup = {
      id: groupId,
      label,
      options: [],
    };
    groups.set(groupId, created);
    return created;
  };

  const addOption = (key: string) => {
    if (!key || seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    const row = byKey.get(key);
    const parsed = parseAgentSessionKey(key);
    const isLegacyMain = !parsed && key === "main";
    const group = parsed
      ? ensureGroup(
          `agent:${parsed.agentId.toLowerCase()}`,
          resolveAgentGroupLabel(state, parsed.agentId),
        )
      : isLegacyMain
        ? ensureGroup("agent:main", resolveAgentGroupLabel(state, "main"))
        : ensureGroup("other", "Other Sessions");
    const scopeLabel = parsed?.rest?.trim() || (isLegacyMain ? "main" : key);
    const label = resolveSessionScopedOptionLabel(key, row, parsed?.rest);
    group.options.push({
      key,
      label,
      scopeLabel,
      title: key,
      updatedAt: row?.updatedAt,
    });
  };

  for (const row of rows) {
    if (row.key !== sessionKey && (row.kind === "global" || row.kind === "unknown")) {
      continue;
    }
    if (hideCron && row.key !== sessionKey && isCronSessionKey(row.key)) {
      continue;
    }
    addOption(row.key);
  }
  addOption(sessionKey);

  for (const group of groups.values()) {
    const counts = new Map<string, number>();
    for (const option of group.options) {
      counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    }
    for (const option of group.options) {
      if ((counts.get(option.label) ?? 0) > 1 && option.scopeLabel !== option.label) {
        option.label = `${option.label} · ${option.scopeLabel}`;
      }
    }
  }

  const allOptions = Array.from(groups.values()).flatMap((group) =>
    group.options.map((option) => ({ groupLabel: group.label, option })),
  );
  const labels = new Map(allOptions.map(({ option }) => [option, option.label]));
  const countAssignedLabels = () => {
    const counts = new Map<string, number>();
    for (const { option } of allOptions) {
      const label = labels.get(option) ?? option.label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  };
  const labelIncludesScopeLabel = (label: string, scopeLabel: string) => {
    const trimmedScope = scopeLabel.trim();
    if (!trimmedScope) {
      return false;
    }
    return (
      label === trimmedScope ||
      label.endsWith(` · ${trimmedScope}`) ||
      label.endsWith(` / ${trimmedScope}`)
    );
  };

  const globalCounts = countAssignedLabels();
  for (const { groupLabel, option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((globalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    const scopedPrefix = `${groupLabel} / `;
    if (currentLabel.startsWith(scopedPrefix)) {
      continue;
    }
    // Keep the agent visible once the native select collapses to a single chosen label.
    labels.set(option, `${groupLabel} / ${currentLabel}`);
  }

  const scopedCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((scopedCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    if (labelIncludesScopeLabel(currentLabel, option.scopeLabel)) {
      continue;
    }
    labels.set(option, `${currentLabel} · ${option.scopeLabel}`);
  }

  const finalCounts = countAssignedLabels();
  for (const { option } of allOptions) {
    const currentLabel = labels.get(option) ?? option.label;
    if ((finalCounts.get(currentLabel) ?? 0) <= 1) {
      continue;
    }
    // Fall back to the full key only when every friendlier disambiguator still collides.
    labels.set(option, `${currentLabel} · ${option.key}`);
  }

  for (const { option } of allOptions) {
    option.label = labels.get(option) ?? option.label;
  }

  return Array.from(groups.values());
}

/** Count sessions with a cron: key that would be hidden when hideCron=true. */
function countHiddenCronSessions(sessionKey: string, sessions: SessionsListResult | null): number {
  if (!sessions?.sessions) {
    return 0;
  }
  return sessions.sessions.filter((row) => isCronSessionKey(row.key) && row.key !== sessionKey)
    .length;
}

function resolveAgentGroupLabel(state: AppViewState, agentIdRaw: string): string {
  const normalized = agentIdRaw.trim().toLowerCase();
  const agent = (state.agentsList?.agents ?? []).find(
    (entry) => entry.id.trim().toLowerCase() === normalized,
  );
  return formatAgentDisplayLabel({
    id: agentIdRaw,
    name: agent?.name,
    identity: agent?.identity,
  });
}

function resolveSessionScopedOptionLabel(
  key: string,
  row?: SessionsListResult["sessions"][number],
  rest?: string,
) {
  const base = rest?.trim() || key;
  if (!row) {
    return base;
  }

  const label = row.label?.trim() || "";
  const displayName = row.displayName?.trim() || "";
  if ((label && label !== key) || (displayName && displayName !== key)) {
    return resolveSessionDisplayName(key, row);
  }

  if (parseSessionKey(key).prefix) {
    return base;
  }
  const resolved = resolveSessionDisplayName(key, row);
  return resolved && resolved !== key ? resolved : base;
}

type ThemeModeOption = { id: ThemeMode; label: string };
const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export function renderSidebarConnectionStatus(state: AppViewState) {
  const label = state.connected ? t("common.online") : t("common.offline");
  const toneClass = state.connected
    ? "sidebar-connection-status--online"
    : "sidebar-connection-status--offline";

  return html`
    <span
      class="sidebar-version__status ${toneClass}"
      role="img"
      aria-live="polite"
      aria-label="Gateway status: ${label}"
      title="Gateway status: ${label}"
    ></span>
  `;
}

export function renderThemeToggle(state: AppViewState) {
  const themeIndex = Math.max(
    0,
    THEME_MODE_OPTIONS.findIndex((option) => option.id === state.theme),
  );
  const modeIcon = (mode: ThemeMode) => {
    if (mode === "system") {
      return icons.monitor;
    }
    if (mode === "light") {
      return icons.sun;
    }
    return icons.moon;
  };

  const applyMode = (mode: ThemeMode, e: Event) => {
    if (mode !== state.theme) {
      state.setTheme(mode, { element: e.currentTarget as HTMLElement });
    }
  };

  return html`
    <div class="theme-toggle" role="group" aria-label="Appearance">
      <div class="theme-toggle__track" style=${`--theme-index:${themeIndex};`}>
        <div class="theme-toggle__indicator" aria-hidden="true"></div>
        ${THEME_MODE_OPTIONS.map(
          (opt) => html`
            <button
              type="button"
              class="theme-toggle__button ${opt.id === state.theme ? "active" : ""}"
              title="Appearance: ${opt.label}"
              aria-label="Appearance: ${opt.label}"
              aria-pressed=${opt.id === state.theme}
              @click=${(e: Event) => applyMode(opt.id, e)}
            >
              <span class="theme-icon">${modeIcon(opt.id)}</span>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}
