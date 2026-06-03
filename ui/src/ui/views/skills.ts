import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import type {
  ClawHubInstallTarget,
  ClawHubInstallTargetValue,
  ClawHubMarketplaceReview,
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillCreateTemplate,
  SkillMarketplaceArchiveFinding,
  SkillMarketplaceArchiveScan,
  SkillMarketplacePermissionSummary,
  SkillMarketplaceSourceTrust,
  SkillEditorState,
  SkillMessageMap,
} from "../controllers/skills.ts";
import { closeDialogOnBackdropClick, openDialogSafely } from "../dialog.ts";
import { clampText } from "../format.ts";
import { resolveSafeExternalUrl } from "../open-external-url.ts";
import type { AgentsListResult, SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { groupSkills } from "./skills-grouping.ts";
import {
  computeSkillReasons,
  getSkillReadiness,
  renderSkillStatusChips,
  skillReadinessClass,
} from "./skills-shared.ts";

function safeExternalHref(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  return resolveSafeExternalUrl(raw, window.location.href);
}

export type SkillsStatusFilter = "all" | "ready" | "needs-setup" | "disabled";
export type SkillsLibraryPanel = "skills" | "clawhub";

export type SkillsProps = {
  connected: boolean;
  loading: boolean;
  report: SkillStatusReport | null;
  error: string | null;
  libraryPanel?: SkillsLibraryPanel;
  filter: string;
  statusFilter: SkillsStatusFilter;
  edits: Record<string, string>;
  envEdits: Record<string, Record<string, string>>;
  configEdits: Record<string, string>;
  busyKey: string | null;
  messages: SkillMessageMap;
  createOpen: boolean;
  createName: string;
  createDescription: string;
  createAgentId: string;
  createTemplate: SkillCreateTemplate;
  createBusy: boolean;
  createError: string | null;
  skillEditor: SkillEditorState | null;
  skillEditorDraft: string;
  skillEditorLoading: boolean;
  skillEditorSaving: boolean;
  skillEditorError: string | null;
  detailKey: string | null;
  attachAgentId: string;
  configForm: Record<string, unknown> | null;
  clawhubQuery: string;
  clawhubResults: ClawHubSearchResult[] | null;
  clawhubSearchLoading: boolean;
  clawhubSearchError: string | null;
  clawhubDetail: ClawHubSkillDetail | null;
  clawhubDetailSlug: string | null;
  clawhubDetailLoading: boolean;
  clawhubDetailError: string | null;
  clawhubInstallSlug: string | null;
  clawhubInstallMessage: { kind: "success" | "error"; text: string } | null;
  clawhubReview: ClawHubMarketplaceReview | null;
  clawhubReviewLoading: boolean;
  clawhubReviewError: string | null;
  clawhubInstallTarget: ClawHubInstallTargetValue;
  agentsList: AgentsListResult | null;
  onLibraryPanelChange?: (panel: SkillsLibraryPanel) => void;
  onFilterChange: (next: string) => void;
  onStatusFilterChange: (next: SkillsStatusFilter) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onEnvEdit: (skillKey: string, envName: string, value: string) => void;
  onConfigEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onSaveEnv: (skillKey: string) => void;
  onSaveConfig: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
  onTestSkill: (skillKey: string, name: string) => void;
  onCopyToWorkspace: (skillKey: string, agentId: string) => void;
  onCreateOpen: () => void;
  onCreateClose: () => void;
  onCreateDraftChange: (
    patch: Partial<
      Pick<SkillsProps, "createName" | "createDescription" | "createAgentId" | "createTemplate">
    >,
  ) => void;
  onCreateSave: () => void;
  onOpenEditor: (skillKey: string) => void;
  onCloseEditor: () => void;
  onEditorDraftChange: (draft: string) => void;
  onSaveEditor: () => void;
  onDetailOpen: (skillKey: string) => void;
  onDetailClose: () => void;
  onAttachAgentChange: (agentId: string) => void;
  onAttachToAgent: (skillKey: string, agentId: string) => void;
  onOpenAgentSkills: (agentId: string) => void;
  onOpenAgentTools: (agentId: string) => void;
  onSaveRootConfig?: (skillKey: string, path: string, json: string) => void;
  onClawHubQueryChange: (query: string) => void;
  onClawHubDetailOpen: (slug: string) => void;
  onClawHubDetailClose: () => void;
  onClawHubInstall: (slug: string) => void;
  onClawHubTargetChange: (target: string) => void;
  onClawHubUpdatePreview: (slug: string) => void;
  onClawHubReviewClose: () => void;
  onClawHubReviewConfirm: () => void;
};

type StatusTabDef = { id: SkillsStatusFilter; label: string };
type SkillConfigField = NonNullable<SkillStatusEntry["configFields"]>[number];

const STATUS_TABS: StatusTabDef[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "needs-setup", label: "Needs Setup" },
  { id: "disabled", label: "Hidden" },
];

const SKILL_CREATE_TEMPLATES: Array<{
  id: SkillCreateTemplate;
  label: string;
  detail: string;
}> = [
  {
    id: "general",
    label: "General workflow",
    detail: "Trigger, steps, limits, and output contract.",
  },
  {
    id: "research",
    label: "Research/review",
    detail: "Source review, evidence checks, and citation expectations.",
  },
  {
    id: "tool",
    label: "Tool/API workflow",
    detail: "Inputs, tool preconditions, errors, and result format.",
  },
  {
    id: "wallet-safe",
    label: "Wallet-safe workflow",
    detail: "No signing or spending unless explicit Wallet grants allow it.",
  },
  {
    id: "runbook",
    label: "Operational runbook",
    detail: "Triage, checks, remediation, and escalation notes.",
  },
  {
    id: "task",
    label: "Task automation",
    detail: "Repeatable task inputs, schedule assumptions, and result checks.",
  },
  {
    id: "channel",
    label: "Channel workflow",
    detail: "Rules for Telegram, Discord, Slack, or other app interactions.",
  },
];

function skillMatchesStatus(skill: SkillStatusEntry, status: SkillsStatusFilter): boolean {
  const readiness = getSkillReadiness(skill);
  switch (status) {
    case "all":
      return true;
    case "ready":
      return readiness.kind === "ready";
    case "needs-setup":
      return readiness.kind !== "ready" && readiness.kind !== "disabled";
    case "disabled":
      return readiness.kind === "disabled";
  }
}

function valueForClawHubInstallTarget(target: ClawHubInstallTarget): ClawHubInstallTargetValue {
  if (target.scope === "agent") {
    return `agent:${target.agentId}`;
  }
  return target.scope;
}

function labelForClawHubInstallTarget(
  props: SkillsProps,
  target?: ClawHubInstallTarget | ClawHubInstallTargetValue,
) {
  const selected =
    typeof target === "string"
      ? target
      : target
        ? valueForClawHubInstallTarget(target)
        : props.clawhubInstallTarget;
  if (selected === "shared") {
    return "Shared library";
  }
  if (selected === "default-agent") {
    const defaultId = props.agentsList?.defaultId ?? props.agentsList?.mainKey ?? "main";
    const agent = props.agentsList?.agents.find((entry) => entry.id === defaultId);
    return agent?.name ?? agent?.identity?.name ?? agentLabel(props, defaultId);
  }
  const agentId = selected.slice("agent:".length);
  return agentLabel(props, agentId);
}

function defaultSkillAttachAgentId(props: SkillsProps) {
  return (
    props.attachAgentId.trim() ||
    props.agentsList?.defaultId ||
    props.agentsList?.mainKey ||
    props.agentsList?.agents[0]?.id ||
    "main"
  );
}

function agentLabel(props: SkillsProps, agentId: string) {
  const agent = props.agentsList?.agents.find((entry) => entry.id === agentId);
  if (agent?.name || agent?.identity?.name) {
    return agent.name ?? agent.identity?.name ?? agentId;
  }
  return agentId === "main" ? "Assistant" : agentId;
}

function readAgentSkillAllowlist(
  config: Record<string, unknown> | null,
  agentId: string,
): string[] | null {
  const agents = config?.agents as { list?: unknown[] | Record<string, unknown> } | undefined;
  const list = agents?.list;
  let entry: unknown;
  if (Array.isArray(list)) {
    entry = list.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        "id" in candidate &&
        (candidate as { id?: unknown }).id === agentId,
    );
  } else if (list && typeof list === "object") {
    entry = list[agentId];
  }
  const skills = entry && typeof entry === "object" ? (entry as { skills?: unknown }).skills : null;
  return Array.isArray(skills) ? skills.map((value) => String(value).trim()).filter(Boolean) : null;
}

function readSkillConfigEntry(config: Record<string, unknown> | null, skillKey: string) {
  const skills = config?.skills as { entries?: Record<string, unknown> } | undefined;
  const entry = skills?.entries?.[skillKey];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as { env?: Record<string, unknown>; config?: Record<string, unknown> })
    : null;
}

function stringifySkillConfig(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function parseRootConfigPath(path: string): string[] {
  return path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function readRootConfigPath(config: Record<string, unknown> | null, path: string): unknown {
  let current: unknown = config;
  for (const segment of parseRootConfigPath(path)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function defaultRootConfigDraft(path: string): string {
  if (path === "channels.bluebubbles") {
    return JSON.stringify(
      {
        enabled: true,
        serverUrl: "http://<mac-host>:1234",
        password: "<bluebubbles-api-password>",
        webhookPath: "/bluebubbles-webhook",
      },
      null,
      2,
    );
  }
  return "{}";
}

function stringifyRootConfigDraft(config: Record<string, unknown> | null, path: string): string {
  const current = readRootConfigPath(config, path);
  if (current === undefined) {
    return defaultRootConfigDraft(path);
  }
  return JSON.stringify(current, null, 2);
}

function rootConfigLeaf(path: string): string {
  const parts = parseRootConfigPath(path);
  return parts[parts.length - 1] ?? path;
}

function rootConfigFieldLabel(path: string): string {
  const parts = parseRootConfigPath(path);
  const leaf = parts[parts.length - 1] ?? path;
  const parent = parts[parts.length - 2];
  if (parent && parent !== "entries") {
    return `${parent} ${leaf}`.replace(/[-_]/g, " ");
  }
  return leaf.replace(/[-_]/g, " ");
}

function isSecretRootConfigPath(path: string): boolean {
  return /token|secret|password|api[-_]?key|auth/i.test(rootConfigLeaf(path));
}

function shouldRenderRootConfigAsBoolean(path: string, current: unknown): boolean {
  return typeof current === "boolean" || /^(enabled|disabled)$/i.test(rootConfigLeaf(path));
}

function shouldRenderRootConfigAsPlainField(path: string, current: unknown): boolean {
  if (shouldRenderRootConfigAsBoolean(path, current)) {
    return true;
  }
  if (current !== undefined && (typeof current !== "object" || current === null)) {
    return true;
  }
  const parts = parseRootConfigPath(path);
  return parts.length >= 3;
}

function formatRootConfigPlainValue(current: unknown): string {
  if (current === undefined || current === null) {
    return "";
  }
  if (typeof current === "string") {
    return current;
  }
  if (typeof current === "number" || typeof current === "boolean") {
    return String(current);
  }
  return JSON.stringify(current);
}

function parseSkillConfigDraft(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function configKeyFromPath(path: string): string | undefined {
  const marker = ".config.";
  const index = path.indexOf(marker);
  if (index === -1) {
    return undefined;
  }
  const key = path
    .slice(index + marker.length)
    .split(".")[0]
    ?.trim();
  return key || undefined;
}

function skillConfigKeys(
  skill: SkillStatusEntry,
  entryConfig: Record<string, unknown> | undefined,
  draftConfig: Record<string, unknown>,
): string[] {
  const keys = new Set<string>();
  Object.keys(entryConfig ?? {}).forEach((key) => keys.add(key));
  Object.keys(draftConfig).forEach((key) => keys.add(key));
  skill.requirements.config.forEach((path) => {
    const key = configKeyFromPath(path);
    if (key) {
      keys.add(key);
    }
  });
  skill.configChecks.forEach((check) => {
    const key = configKeyFromPath(check.path);
    if (key) {
      keys.add(key);
    }
  });
  (skill.configFields ?? []).forEach((field) => {
    if (field.key) {
      keys.add(field.key);
    }
  });
  return Array.from(keys).toSorted((a, b) => a.localeCompare(b));
}

function findSkillConfigField(
  skill: SkillStatusEntry,
  configKey: string,
): SkillConfigField | undefined {
  return (skill.configFields ?? []).find((field) => field.key === configKey);
}

function setSkillConfigDraftValue(draft: string, key: string, value: unknown): string {
  const parsed = parseSkillConfigDraft(draft);
  parsed[key] = value;
  return stringifySkillConfig(parsed);
}

function formatSkillConfigInputValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function renderSkillConfigInput(params: {
  skillKey: string;
  configKey: string;
  field?: SkillConfigField;
  value: unknown;
  draft: string;
  onConfigEdit: SkillsProps["onConfigEdit"];
}) {
  const label = params.field?.label || params.configKey;
  const type = params.field?.type;
  if (type === "boolean" || typeof params.value === "boolean") {
    return html`
      <label class="field field--checkbox">
        <input
          type="checkbox"
          .checked=${params.value === true}
          @change=${(event: Event) =>
            params.onConfigEdit(
              params.skillKey,
              setSkillConfigDraftValue(
                params.draft,
                params.configKey,
                (event.target as HTMLInputElement).checked,
              ),
            )}
        />
        <span>${label}</span>
      </label>
    `;
  }
  if (type === "textarea") {
    return html`
      <label class="field">
        <span>${label}</span>
        <textarea
          .value=${formatSkillConfigInputValue(params.value)}
          placeholder=${params.field?.placeholder ?? params.configKey}
          @input=${(event: Event) =>
            params.onConfigEdit(
              params.skillKey,
              setSkillConfigDraftValue(
                params.draft,
                params.configKey,
                (event.target as HTMLTextAreaElement).value,
              ),
            )}
        ></textarea>
      </label>
    `;
  }
  if (type === "number" || (typeof params.value === "number" && Number.isFinite(params.value))) {
    return html`
      <label class="field">
        <span>${label}</span>
        <input
          type="number"
          .value=${String(params.value)}
          @input=${(event: Event) => {
            const raw = (event.target as HTMLInputElement).value;
            const next = raw.trim() ? Number(raw) : "";
            params.onConfigEdit(
              params.skillKey,
              setSkillConfigDraftValue(params.draft, params.configKey, next),
            );
          }}
        />
      </label>
    `;
  }
  return html`
    <label class="field">
      <span>${label}</span>
      <input
        type=${type === "secret" ? "password" : "text"}
        .value=${formatSkillConfigInputValue(params.value)}
        placeholder=${params.field?.placeholder ?? params.configKey}
        @input=${(event: Event) =>
          params.onConfigEdit(
            params.skillKey,
            setSkillConfigDraftValue(
              params.draft,
              params.configKey,
              (event.target as HTMLInputElement).value,
            ),
          )}
      />
    </label>
  `;
}

function renderSkillAgentAttach(skill: SkillStatusEntry, props: SkillsProps) {
  const agents = props.agentsList?.agents ?? [];
  const selectedAgentId = defaultSkillAttachAgentId(props);
  const explicitAllowlist = readAgentSkillAllowlist(props.configForm, selectedAgentId);
  const skillName = skill.name.trim() || skill.skillKey;
  const alreadyAllowed =
    explicitAllowlist === null || explicitAllowlist.some((entry) => entry === skillName);
  const inheritedAll = explicitAllowlist === null;
  const busy = props.busyKey === skill.skillKey;
  if (agents.length === 0) {
    return nothing;
  }

  return html`
    <div class="callout" style="display: grid; gap: 10px;">
      <div
        style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;"
      >
        <label class="field" style="min-width: 220px; margin: 0;">
          <span>Agent</span>
          <select
            data-testid="skill-attach-agent"
            .value=${selectedAgentId}
            @change=${(event: Event) =>
              props.onAttachAgentChange((event.target as HTMLSelectElement).value)}
          >
            ${agents.map(
              (agent) => html`<option value=${agent.id}>${agentLabel(props, agent.id)}</option>`,
            )}
          </select>
        </label>
        <div class="chip-row" style="flex: 1; min-width: 240px;">
          <span class="chip">Library ${skill.disabled ? "Hidden" : "Available"}</span>
          <span class="chip">
            Agent skills ${inheritedAll ? "Inherits all" : alreadyAllowed ? "Allowed" : "Not allowed"}
          </span>
          <span class="chip">Tool grants Agent Tools</span>
        </div>
        ${
          inheritedAll || alreadyAllowed
            ? nothing
            : html`
                <button
                  class="btn primary"
                  type="button"
                  ?disabled=${busy}
                  @click=${() => props.onAttachToAgent(skill.skillKey, selectedAgentId)}
                >
                  ${busy ? "Saving..." : "Allow on Agent"}
                </button>
              `
        }
      </div>
    </div>
  `;
}

export function renderSkillsSurface(
  props: SkillsProps,
  options: {
    renderDialogs?: boolean;
    title?: string;
    subtitle?: string;
  } = {},
) {
  const skills = props.report?.skills ?? [];
  const activePanel = props.libraryPanel ?? "skills";
  const title = options.title ?? "Skills";
  const subtitle =
    options.subtitle ?? "Install, review, configure, and edit reusable skill instructions.";

  const statusCounts: Record<SkillsStatusFilter, number> = {
    all: skills.length,
    ready: 0,
    "needs-setup": 0,
    disabled: 0,
  };
  for (const s of skills) {
    const readiness = getSkillReadiness(s);
    if (readiness.kind === "disabled") {
      statusCounts.disabled++;
    } else if (readiness.kind === "ready") {
      statusCounts.ready++;
    } else {
      statusCounts["needs-setup"]++;
    }
  }

  const afterStatus =
    props.statusFilter === "all"
      ? skills
      : skills.filter((s) => skillMatchesStatus(s, props.statusFilter));

  const filter = props.filter.trim().toLowerCase();
  const filtered = filter
    ? afterStatus.filter((skill) =>
        [skill.name, skill.description, skill.source].join(" ").toLowerCase().includes(filter),
      )
    : afterStatus;
  const groups = groupSkills(filtered);

  return html`
    <style>
      .skills-shell {
        display: grid;
        gap: 16px;
      }

      .skills-workspace {
        display: grid;
        gap: 16px;
        align-items: start;
      }

      .skills-card {
        min-height: 100%;
        border-radius: var(--radius-md);
        background: var(--panel);
      }

      .skills-discovery-card {
        display: grid;
        gap: 12px;
      }

      .skills-results-list .list-item {
        border-radius: var(--radius-sm);
        background: var(--secondary);
        border: 1px solid var(--border);
      }

      .skills-library-tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 14px;
      }

      .skills-library-tabs .btn[aria-selected="true"] {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--accent-contrast, var(--bg));
      }

      .skill-row-message {
        margin-top: 8px;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        font-size: 12px;
        line-height: 1.35;
      }

      .skill-row-message.success {
        border-color: var(--ok-subtle);
        background: var(--ok-subtle);
        color: var(--success);
      }

      .skill-row-message.danger {
        border-color: var(--danger-subtle);
        background: var(--danger-subtle);
        color: var(--danger);
      }

    </style>

    <section class="skills-shell">
      <div class="skills-workspace">
        <section class="card skills-card">
      <div class="row" style="justify-content: space-between;">
        <div>
            <div class="card-title">${title}</div>
            <div class="card-sub">${subtitle}</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <button
            class="btn"
            type="button"
            data-testid="skills-create-open"
            @click=${props.onCreateOpen}
          >
            + Skill
          </button>
          <button
            class="btn"
            type="button"
            ?disabled=${props.loading || !props.connected}
            @click=${props.onRefresh}
          >
            ${props.loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
      </div>

      <div class="skills-library-tabs" role="tablist" aria-label="Skills sections">
        <button
          class="btn"
          role="tab"
          aria-selected=${activePanel === "skills" ? "true" : "false"}
          @click=${() => props.onLibraryPanelChange?.("skills")}
        >
          Skills
        </button>
        <button
          class="btn"
          role="tab"
          aria-selected=${activePanel === "clawhub" ? "true" : "false"}
          @click=${() => props.onLibraryPanelChange?.("clawhub")}
        >
          ClawHub
        </button>
      </div>

      ${
        activePanel === "skills"
          ? html`<div class="agent-tabs" style="margin-top: 14px;">
        ${STATUS_TABS.map(
          (tab) => html`
            <button
              class="agent-tab ${props.statusFilter === tab.id ? "active" : ""}"
              @click=${() => props.onStatusFilterChange(tab.id)}
            >
              ${tab.label}<span class="agent-tab-count">(${statusCounts[tab.id]})</span>
            </button>
          `,
        )}
      </div>

      <div
        class="filters"
        style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;"
      >
        <label class="field" style="flex: 1; min-width: 180px;">
          <input
            .value=${props.filter}
            @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder="Filter skills"
            autocomplete="off"
            name="skills-filter"
          />
        </label>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }
      ${
        filtered.length === 0
          ? html`
            <div class="muted" style="margin-top: 16px">
              ${
                !props.connected && !props.report ? "Not connected to gateway." : "No skills found."
              }
            </div>
          `
          : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) => {
                return html`
                  <details class="agent-skills-group">
                    <summary class="agent-skills-header">
                      <span>${group.label}</span>
                      <span class="muted">${group.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${group.skills.map((skill) => renderSkill(skill, props))}
                    </div>
                  </details>
                `;
              })}
            </div>
          `
      }`
          : renderClawHubPanel(props)
      }
        </section>
      </div>
    </section>

    ${options.renderDialogs === false ? nothing : renderSkillDialogs(props)}
  `;
}

export function renderSkills(props: SkillsProps) {
  return renderSkillsSurface(props, { renderDialogs: true });
}

export function renderClawHubPanel(
  props: SkillsProps,
  options: {
    title?: string;
    subtitle?: string;
    showInstallTarget?: boolean;
    showHeader?: boolean;
  } = {},
) {
  const title = options.title ?? "ClawHub";
  const subtitle = options.subtitle ?? "Search, review, and install skills from the registry.";
  const showInstallTarget = options.showInstallTarget ?? true;
  const showHeader = options.showHeader ?? true;

  return html`
    <section class="skills-discovery-card" style="display: grid; gap: 12px;">
      ${
        showHeader
          ? html`
              <div>
                <div class="card-title">${title}</div>
                <div class="card-sub">${subtitle}</div>
              </div>
            `
          : nothing
      }
      ${
        showInstallTarget
          ? html`
              <label class="field" style="margin-top: 12px;">
                <span>Install target</span>
                <select
                  data-testid="clawhub-install-target"
                  @change=${(event: Event) =>
                    props.onClawHubTargetChange((event.target as HTMLSelectElement).value)}
                >
                  <option
                    value="default-agent"
                    ?selected=${props.clawhubInstallTarget === "default-agent"}
                  >
                    ${labelForClawHubInstallTarget(props, "default-agent")}
                  </option>
                  <option value="shared" ?selected=${props.clawhubInstallTarget === "shared"}>
                    Shared library - reusable
                  </option>
                  ${(props.agentsList?.agents ?? []).map(
                    (agent) => html`
                      <option
                        value=${`agent:${agent.id}`}
                        ?selected=${props.clawhubInstallTarget === `agent:${agent.id}`}
                      >
                        ${agentLabel(props, agent.id)}
                      </option>
                    `,
                  )}
                </select>
              </label>
            `
          : nothing
      }
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 14px;">
        <label class="field" style="flex: 1; min-width: 180px;">
          <input
            .value=${props.clawhubQuery}
            @input=${(e: Event) => props.onClawHubQueryChange((e.target as HTMLInputElement).value)}
            placeholder="Search ClawHub skills…"
            autocomplete="off"
            name="clawhub-search"
          />
        </label>
        ${
          props.clawhubSearchLoading
            ? html`
                <span class="muted">Searching…</span>
              `
            : nothing
        }
      </div>
      ${
        props.clawhubSearchError
          ? html`<div class="callout danger" style="margin-top: 10px;">
              ${props.clawhubSearchError}
            </div>`
          : nothing
      }
      ${
        props.clawhubReviewLoading
          ? html`
              <div class="callout" style="margin-top: 10px" aria-live="polite">Opening skill review...</div>
            `
          : nothing
      }
      ${
        props.clawhubInstallMessage
          ? html`<div
              class="callout ${props.clawhubInstallMessage.kind === "error" ? "danger" : "success"}"
              style="margin-top: 10px;"
            >
              ${props.clawhubInstallMessage.text}
            </div>`
          : nothing
      }
      <div class="skills-results-list" style="margin-top: 10px;">
        ${renderClawHubResults(props)}
      </div>
    </section>
  `;
}

export function renderSkillDialogs(props: SkillsProps) {
  const skills = props.report?.skills ?? [];
  const detailSkill = props.detailKey
    ? (skills.find((skill) => skill.skillKey === props.detailKey) ?? null)
    : null;
  return html`
    ${detailSkill ? renderSkillDetail(detailSkill, props) : nothing}
    ${props.createOpen ? renderCreateSkillDialog(props) : nothing}
    ${props.clawhubDetailSlug ? renderClawHubDetailDialog(props) : nothing}
    ${
      props.clawhubReview || props.clawhubReviewLoading || props.clawhubReviewError
        ? renderClawHubReviewDialog(props)
        : nothing
    }
  `;
}

function renderClawHubResults(props: SkillsProps) {
  const results = props.clawhubResults;
  if (!results) {
    return nothing;
  }
  if (results.length === 0) {
    return html`
      <div class="muted" style="margin-top: 8px">No skills found on ClawHub.</div>
    `;
  }
  return html`
    <div class="list" style="margin-top: 8px;">
      ${results.map(
        (r) => html`
          <div
            class="list-item list-item-clickable"
            @click=${() => props.onClawHubDetailOpen(r.slug)}
          >
            <div class="list-main">
              <div class="list-title">${r.displayName}</div>
              <div class="list-sub">${r.summary ? clampText(r.summary, 120) : r.slug}</div>
              <div class="muted" style="margin-top: 6px; font-size: 12px;">
                Click for details. Review install opens the safety preview.
              </div>
            </div>
            <div class="list-meta" style="display: flex; align-items: center; gap: 8px;">
              ${
                r.version
                  ? html`<span class="muted" style="font-size: 12px;">v${r.version}</span>`
                  : nothing
              }
              <button
                class="btn btn--sm"
                type="button"
                data-testid=${`clawhub-review-install-${r.slug}`}
                ?disabled=${props.clawhubInstallSlug !== null || props.clawhubReviewLoading}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  props.onClawHubInstall(r.slug);
                }}
              >
                ${
                  props.clawhubReviewLoading
                    ? "Reviewing..."
                    : props.clawhubInstallSlug === r.slug
                      ? "Installing..."
                      : "Review install"
                }
              </button>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderClawHubDetailDialog(props: SkillsProps) {
  const detail = props.clawhubDetail;

  return html`
    <dialog
      class="md-preview-dialog"
      ${ref(openDialogSafely)}
      @click=${closeDialogOnBackdropClick}
      @close=${props.onClawHubDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${detail?.skill?.displayName ?? props.clawhubDetailSlug}
          </div>
          <button
            class="btn btn--sm"
            @click=${(e: Event) => {
              (e.currentTarget as HTMLElement).closest("dialog")?.close();
            }}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          ${
            props.clawhubDetailLoading
              ? html`<div class="muted">${t("common.loading")}</div>`
              : props.clawhubDetailError
                ? html`<div class="callout danger">${props.clawhubDetailError}</div>`
                : detail?.skill
                  ? html`
                    <div style="font-size: 14px; line-height: 1.5;">
                      ${detail.skill.summary ?? ""}
                    </div>
                    ${
                      detail.owner?.displayName
                        ? html`<div class="muted" style="font-size: 13px;">
                          By
                          ${detail.owner.displayName}${
                            detail.owner.handle ? html` (@${detail.owner.handle})` : nothing
                          }
                        </div>`
                        : nothing
                    }
                    ${
                      detail.latestVersion
                        ? html`<div class="muted" style="font-size: 13px;">
                          Latest: v${detail.latestVersion.version}
                        </div>`
                        : nothing
                    }
                    ${
                      detail.latestVersion?.changelog
                        ? html`<div
                          style="font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; white-space: pre-wrap;"
                        >
                          ${detail.latestVersion.changelog}
                        </div>`
                        : nothing
                    }
                    ${
                      detail.metadata?.os
                        ? html`<div class="muted" style="font-size: 12px;">
                          Platforms: ${detail.metadata.os.join(", ")}
                        </div>`
                        : nothing
                    }
                    <button
                      class="btn primary"
                      type="button"
                      data-testid="clawhub-detail-review-install"
                      ?disabled=${props.clawhubInstallSlug !== null}
                      @click=${() => {
                        if (props.clawhubDetailSlug) {
                          props.onClawHubInstall(props.clawhubDetailSlug);
                        }
                      }}
                    >
                      ${
                        props.clawhubInstallSlug === props.clawhubDetailSlug
                          ? "Installing\u2026"
                          : `Review install for ${detail.skill.displayName}`
                      }
                    </button>
                  `
                  : html`
                      <div class="muted">Skill not found.</div>
                    `
          }
        </div>
      </div>
    </dialog>
  `;
}

function summarizePermissionSummary(permissions: SkillMarketplacePermissionSummary): string[] {
  const lines: string[] = [];
  const wallet = permissions.walletActions;
  if (wallet) {
    const parts = [
      wallet.actions?.length ? `actions ${wallet.actions.join(", ")}` : null,
      wallet.roles?.length ? `roles ${wallet.roles.join(", ")}` : null,
      wallet.chains?.length ? `chains ${wallet.chains.join(", ")}` : null,
      wallet.inputMints?.length ? `input ${wallet.inputMints.join(", ")}` : null,
      wallet.outputMints?.length ? `output ${wallet.outputMints.join(", ")}` : null,
      wallet.maxAmount ? `max ${wallet.maxAmount}` : null,
      typeof wallet.maxSlippageBps === "number" ? `slippage ${wallet.maxSlippageBps} bps` : null,
      wallet.autonomous ? "autonomous" : null,
      wallet.cron ? "cron" : null,
    ].filter(Boolean);
    lines.push(`wallet: ${parts.join("; ") || "requested"}`);
  }
  if (permissions.toolAccess?.length) {
    lines.push(`tools: ${permissions.toolAccess.join(", ")}`);
  }
  if (permissions.install?.kinds?.length || permissions.install?.bins?.length) {
    const parts = [
      permissions.install.kinds?.length ? `install ${permissions.install.kinds.join(", ")}` : null,
      permissions.install.bins?.length ? `bins ${permissions.install.bins.join(", ")}` : null,
    ].filter(Boolean);
    lines.push(parts.join("; "));
  }
  if (lines.length === 0) {
    lines.push("none");
  }
  return lines;
}

function renderArchiveFindings(findings: SkillMarketplaceArchiveFinding[]) {
  if (findings.length === 0) {
    return html`
      <div class="muted">No archive warnings.</div>
    `;
  }
  return html`
    <div style="display: grid; gap: 6px;">
      ${findings.map(
        (finding) => html`
          <div class="callout ${finding.severity === "block" ? "danger" : ""}">
            <div style="font-weight: 600;">
              ${finding.severity === "block" ? "Blocked" : "Warning"}: ${finding.code}
            </div>
            <div>${finding.path}: ${finding.message}</div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderSourceTrust(sourceTrust?: SkillMarketplaceSourceTrust) {
  if (!sourceTrust) {
    return html`
      <section style="display: grid; gap: 8px">
        <div style="font-weight: 600">Source trust</div>
        <div class="callout info">
          Gateway preview accepted the source, but this response did not include registry detail.
        </div>
      </section>
    `;
  }
  const modeLabel =
    sourceTrust.mode === "tracked-legacy" ? "tracked legacy install" : "registry allowlist";
  return html`
    <section style="display: grid; gap: 8px;">
      <div style="font-weight: 600;">Source trust</div>
      <div class="callout success">
        <div>Registry: ${sourceTrust.registry}</div>
        <div>Trusted by: ${modeLabel}</div>
        <div>Allowed registries: ${sourceTrust.allowlist.join(", ") || "default ClawHub"}</div>
      </div>
    </section>
  `;
}

function countFindings(
  scan: SkillMarketplaceArchiveScan,
  codes: string[],
  severity?: SkillMarketplaceArchiveFinding["severity"],
) {
  const codeSet = new Set(codes);
  return scan.findings.filter(
    (finding) => codeSet.has(finding.code) && (!severity || finding.severity === severity),
  ).length;
}

function renderDependencyScriptPolicy(scan: SkillMarketplaceArchiveScan) {
  const dependencyWarnings = countFindings(scan, ["dependency_manifest"], "warn");
  const dependencyBlocks = countFindings(scan, ["package_dependencies"], "block");
  const scriptWarnings = countFindings(scan, ["script_file"], "warn");
  const scriptBlocks = countFindings(
    scan,
    ["install_script_file", "package_lifecycle_script"],
    "block",
  );
  const hasPolicyFindings =
    dependencyWarnings + dependencyBlocks + scriptWarnings + scriptBlocks > 0;

  return html`
    <section style="display: grid; gap: 8px;">
      <div style="font-weight: 600;">Dependency/script policy</div>
      <div class="chip-row">
        <span class="chip ${dependencyBlocks > 0 ? "chip-warn" : ""}">
          package dependencies ${dependencyBlocks > 0 ? "blocked" : "not present"}
        </span>
        <span class="chip ${scriptBlocks > 0 ? "chip-warn" : ""}">
          installer scripts ${scriptBlocks > 0 ? "blocked" : "not present"}
        </span>
        <span class="chip ${dependencyWarnings > 0 ? "chip-warn" : ""}">
          dependency manifests ${dependencyWarnings}
        </span>
        <span class="chip ${scriptWarnings > 0 ? "chip-warn" : ""}">
          script files ${scriptWarnings}
        </span>
      </div>
      <div class=${hasPolicyFindings ? "callout info" : "muted"}>
        ${
          hasPolicyFindings
            ? "Marketplace installs do not run dependency installers or lifecycle scripts automatically. Blocked items must be removed before enable/update."
            : "No dependency manifests, package dependency declarations, installer scripts, or standalone script files were reported."
        }
      </div>
    </section>
  `;
}

function marketplaceRequestsWalletOrMining(
  permissions: SkillMarketplacePermissionSummary,
): boolean {
  if (permissions.walletActions) {
    return true;
  }
  return (permissions.toolAccess ?? []).some((tool) => /wallet|mining|sat_/i.test(tool));
}

function renderReviewList(title: string, items: string[]) {
  if (items.length === 0) {
    return nothing;
  }
  return html`
    <div style="display: grid; gap: 4px;">
      <div style="font-weight: 600;">${title}</div>
      <ul style="margin: 0; padding-left: 18px;">
        ${items.map((item) => html`<li>${item}</li>`)}
      </ul>
    </div>
  `;
}

function renderArchiveFilePreview(scan: SkillMarketplaceArchiveScan) {
  const files = scan.files ?? [];
  if (files.length === 0) {
    return html`
      <div class="muted">File list was not included in this scan response.</div>
    `;
  }
  return html`
    <div style="display: grid; gap: 6px;">
      <div class="chip-row">
        ${files.slice(0, 24).map((file) => html`<span class="chip mono">${file}</span>`)}
      </div>
      ${
        scan.filesTruncated || files.length > 24
          ? html`
              <div class="muted">
                Showing first ${Math.min(files.length, 24)} files from ${scan.fileCount}.
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function shortDigest(value?: string): string {
  return value ? value.slice(0, 12) : "none";
}

function renderClawHubReviewDialog(props: SkillsProps) {
  const review = props.clawhubReview;
  const close = (e: Event) => {
    (e.currentTarget as HTMLElement).closest("dialog")?.close();
  };

  const blocked =
    review?.ok === true &&
    (review.installScan.blocked ||
      review.installScan.findings.some((finding) => finding.severity === "block"));
  const title =
    review?.ok === true
      ? `${review.mode === "install" ? "Install" : "Update"} ${review.slug}`
      : "Review ClawHub skill";

  return html`
    <dialog
      class="md-preview-dialog"
      ${ref(openDialogSafely)}
      @click=${closeDialogOnBackdropClick}
      @close=${props.onClawHubReviewClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">${title}</div>
          <button class="btn btn--sm" @click=${close}>Close</button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 14px;">
          ${
            props.clawhubReviewLoading
              ? html`<div class="muted">${t("common.loading")}</div>`
              : props.clawhubReviewError
                ? html`<div class="callout danger">${props.clawhubReviewError}</div>`
                : review?.ok === false
                  ? html`<div class="callout danger">${review.error}</div>`
                  : review?.ok === true
                    ? html`
                      <div class="callout ${blocked ? "danger" : review.permissions.risky ? "" : "success"}">
                        <div style="font-weight: 600; margin-bottom: 6px;">
                          ${review.mode === "install" ? "Install preview" : "Update preview"}
                        </div>
                        <div>Slug: ${review.slug}</div>
                        <div>
                          Version:
                          ${
                            review.previousVersion
                              ? `${review.previousVersion} -> ${review.version}`
                              : review.version
                          }
                        </div>
                        <div>Target: ${review.targetDir}</div>
                        <div>Target scope: ${labelForClawHubInstallTarget(props, review.target)}</div>
                        <div>
                          Permission digest:
                          ${shortDigest(review.updateReview.previousPermissionDigest)} ->
                          ${shortDigest(review.updateReview.nextPermissionDigest)}
                        </div>
                      </div>

                      ${renderSourceTrust(review.sourceTrust)}

                      <section style="display: grid; gap: 8px;">
                        <div style="font-weight: 600;">Requested permissions</div>
                        <div class="muted" style="display: grid; gap: 4px;">
                          ${summarizePermissionSummary(review.permissions).map(
                            (line) => html`<div>${line}</div>`,
                          )}
                        </div>
	                        ${
                            marketplaceRequestsWalletOrMining(review.permissions)
                              ? html`
                                  <div class="callout">
                                    Wallet and mining access are request metadata only. Install does not grant wallet signing, mining
                                    wallets, vault wallets, autonomous spend, or cron execution. Use Wallet skill grants after install
                                    if the skill is trusted.
                                  </div>
                                `
                              : nothing
                          }
                      </section>

                      <section style="display: grid; gap: 8px;">
                        <div style="font-weight: 600;">Archive scan</div>
	                        <div class="muted">
	                          ${review.installScan.fileCount} files,
	                          ${Math.round(review.installScan.totalBytes / 1024)} KB
	                        </div>
	                        ${renderArchiveFilePreview(review.installScan)}
	                        ${renderArchiveFindings(review.installScan.findings)}
	                      </section>

                      ${renderDependencyScriptPolicy(review.installScan)}

                      <section style="display: grid; gap: 8px;">
                        <div style="font-weight: 600;">Update review</div>
                        <div class="${review.updateReview.approvalRequired ? "callout" : "muted"}">
                          ${
                            review.updateReview.approvalRequired
                              ? `Approval required: ${review.updateReview.reasons.join(", ")}`
                              : "No new permission approval required."
                          }
                        </div>
                        ${
                          review.updateReview.permissionDigestChanged
                            ? html`
                              <div class="muted">
                                Permission digest changed:
                                ${shortDigest(review.updateReview.previousPermissionDigest)} ->
                                ${shortDigest(review.updateReview.nextPermissionDigest)}
                              </div>
                              ${renderReviewList(
                                "Added permissions",
                                review.updateReview.permissionDiff?.added ?? [],
                              )}
                              ${renderReviewList(
                                "Removed permissions",
                                review.updateReview.permissionDiff?.removed ?? [],
                              )}
                            `
                            : html`
                                <div class="muted">Permissions unchanged.</div>
                              `
                        }
                        ${
                          review.updateReview.addedScanFindings.length > 0
                            ? html`
                              <div style="display: grid; gap: 6px;">
                                <div style="font-weight: 600;">New archive warnings</div>
                                ${renderArchiveFindings(review.updateReview.addedScanFindings)}
                              </div>
                            `
                            : html`
                                <div class="muted">No new archive warnings.</div>
                              `
                        }
                      </section>

                      <div style="display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap;">
                        <button class="btn" @click=${close}>Cancel</button>
                        <button
                          class="btn primary"
                          type="button"
                          data-testid="clawhub-review-confirm"
                          ?disabled=${blocked || props.clawhubInstallSlug !== null}
                          @click=${props.onClawHubReviewConfirm}
                        >
                          ${
                            blocked
                              ? "Blocked by scan"
                              : review.mode === "update" && review.updateReview.approvalRequired
                                ? "Approve and update"
                                : review.mode === "update"
                                  ? "Update"
                                  : "Install"
                          }
                        </button>
                      </div>
                    `
                    : nothing
          }
        </div>
      </div>
    </dialog>
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const dotClass = skillReadinessClass(skill);
  const readiness = getSkillReadiness(skill);
  const marketplaceBlocked = isMarketplaceEnableBlocked(skill);
  const message = props.messages[skill.skillKey] ?? null;

  return html`
    <div
      class="list-item list-item-clickable"
      data-testid=${`skill-row-${skill.skillKey}`}
      @click=${() => props.onDetailOpen(skill.skillKey)}
    >
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${dotClass}"></span>
          <span>${skill.name}</span>
        </div>
        <div class="list-sub">${clampText(skill.description, 140)}</div>
        ${renderSkillStatusChips({ skill })}
        ${
          message
            ? html`
                <div
                  class="skill-row-message ${message.kind === "error" ? "danger" : "success"}"
                  role="status"
                >
                  ${message.message}
                </div>
              `
            : nothing
        }
      </div>
      <div
        class="list-meta"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px;"
      >
        ${renderSkillQuickAction({ skill, readiness, props, busy })}
        <label class="cfg-toggle" @click=${(e: Event) => e.stopPropagation()}>
          <input
            type="checkbox"
            .checked=${!skill.disabled}
            ?disabled=${busy || (skill.disabled && marketplaceBlocked)}
            @change=${(e: Event) => {
              e.stopPropagation();
              props.onToggle(skill.skillKey, skill.disabled);
            }}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `;
}

function renderSkillQuickAction(params: {
  skill: SkillStatusEntry;
  readiness: ReturnType<typeof getSkillReadiness>;
  props: SkillsProps;
  busy: boolean;
}) {
  const { skill, readiness, props, busy } = params;
  const stop = (event: Event) => event.stopPropagation();
  switch (readiness.kind) {
    case "ready":
      return nothing;
    case "disabled":
      return html`
        <button
          type="button"
          class="btn btn--sm"
          data-testid=${`skill-show-${skill.skillKey}`}
          ?disabled=${busy || isMarketplaceEnableBlocked(skill)}
          @click=${(event: Event) => {
            stop(event);
            props.onToggle(skill.skillKey, true);
          }}
        >
          Show in library
        </button>
      `;
    case "needs-api-key":
      return html`
        <button
          type="button"
          class="btn btn--sm"
          data-testid=${`skill-configure-${skill.skillKey}`}
          ?disabled=${busy}
          @click=${(event: Event) => {
            stop(event);
            props.onDetailOpen(skill.skillKey);
          }}
        >
          Add API key
        </button>
      `;
    case "needs-dependency":
      return skill.install[0]?.id
        ? html`
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`skill-install-dependency-${skill.skillKey}`}
              ?disabled=${busy}
              @click=${(event: Event) => {
                stop(event);
                props.onDetailOpen(skill.skillKey);
              }}
            >
              Install dependency
            </button>
          `
        : html`
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`skill-configure-${skill.skillKey}`}
              ?disabled=${busy}
              @click=${(event: Event) => {
                stop(event);
                props.onDetailOpen(skill.skillKey);
              }}
            >
              Configure
            </button>
          `;
    case "needs-config":
      return html`
        <button
          type="button"
          class="btn btn--sm"
          data-testid=${`skill-configure-${skill.skillKey}`}
          ?disabled=${busy}
          @click=${(event: Event) => {
            stop(event);
            props.onDetailOpen(skill.skillKey);
          }}
        >
          Configure
        </button>
      `;
    case "unsupported-os":
      return html`
        <button
          type="button"
          class="btn btn--sm"
          data-testid=${`skill-details-${skill.skillKey}`}
          ?disabled=${busy}
          @click=${(event: Event) => {
            stop(event);
            props.onDetailOpen(skill.skillKey);
          }}
        >
          Details
        </button>
      `;
  }
}

function renderCreateSkillDialog(props: SkillsProps) {
  const agents = props.agentsList?.agents ?? [];
  const selectedAgentId =
    props.createAgentId ||
    props.agentsList?.defaultId ||
    props.agentsList?.mainKey ||
    agents[0]?.id ||
    "";
  return html`
    <dialog
      class="md-preview-dialog"
      ${ref(openDialogSafely)}
      @click=${closeDialogOnBackdropClick}
      @close=${props.onCreateClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">Create skill</div>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.createBusy}
            @click=${(event: Event) => {
              (event.currentTarget as HTMLElement).closest("dialog")?.close();
            }}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 14px;">
          ${
            props.createError
              ? html`<div class="callout danger">${props.createError}</div>`
              : nothing
          }
          <label class="field">
            <span>Name</span>
            <input
              .value=${props.createName}
              autocomplete="off"
              placeholder="Research helper"
              @input=${(event: Event) =>
                props.onCreateDraftChange({
                  createName: (event.target as HTMLInputElement).value,
                })}
            />
          </label>
          <label class="field">
            <span>Description</span>
            <textarea
              style="min-height: 92px; resize: vertical;"
              .value=${props.createDescription}
              placeholder="When this skill should be used and what workflow it teaches."
              @input=${(event: Event) =>
                props.onCreateDraftChange({
                  createDescription: (event.target as HTMLTextAreaElement).value,
                })}
            ></textarea>
          </label>
          <label class="field">
            <span>Template</span>
            <select
              data-testid="skill-create-template"
              .value=${props.createTemplate}
              @change=${(event: Event) =>
                props.onCreateDraftChange({
                  createTemplate: (event.target as HTMLSelectElement).value as SkillCreateTemplate,
                })}
            >
              ${SKILL_CREATE_TEMPLATES.map(
                (template) => html`
                  <option value=${template.id}>${template.label} - ${template.detail}</option>
                `,
              )}
            </select>
          </label>
          <details>
            <summary>Template details</summary>
            <div style="display: grid; gap: 8px; margin-top: 8px;">
              ${SKILL_CREATE_TEMPLATES.map(
                (template) => html`
                  <div>
                    <strong>${template.label}</strong>
                    <div class="muted" style="font-size: 12px;">${template.detail}</div>
                  </div>
                `,
              )}
              <div class="muted" style="font-size: 12px;">
                Templates are starters. Create the skill, then open it and edit SKILL.md.
              </div>
            </div>
	          </details>
	          <label class="field">
	            <span>Save in Agent</span>
            <select
              data-testid="skill-create-agent"
              .value=${selectedAgentId}
              @change=${(event: Event) =>
                props.onCreateDraftChange({
                  createAgentId: (event.target as HTMLSelectElement).value,
                })}
	            >
	              ${(agents.length > 0 ? agents : [{ id: "main", name: "Assistant" }]).map(
                  (agent) => html`
	                  <option value=${agent.id}>${agentLabel(props, agent.id)}</option>
	                `,
                )}
            </select>
          </label>
          <div style="display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
            <button class="btn" type="button" ?disabled=${props.createBusy} @click=${props.onCreateClose}>
              Cancel
            </button>
            <button
              class="btn primary"
              type="button"
              ?disabled=${props.createBusy || !props.createName.trim()}
              @click=${props.onCreateSave}
            >
              ${props.createBusy ? "Creating..." : "Create skill"}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  `;
}

function isMarketplaceEnableBlocked(skill: SkillStatusEntry): boolean {
  const marketplace = skill.marketplace;
  if (!marketplace) {
    return false;
  }
  return (
    marketplace.scanBlocked || marketplace.scanBlocks > 0 || marketplace.updateApprovalRequired
  );
}

function isSkillEditableInUi(skill: SkillStatusEntry): boolean {
  return [
    "fased-managed",
    "fased-workspace",
    "agents-skills-project",
    "agents-skills-personal",
  ].includes(skill.source);
}

function renderSkillFileEditor(skill: SkillStatusEntry, props: SkillsProps) {
  const editable = isSkillEditableInUi(skill);
  const editorOpen = props.skillEditor?.skillKey === skill.skillKey;
  const showError = Boolean(props.skillEditorError && (!props.skillEditor || editorOpen));
  const copyAgentId = defaultSkillAttachAgentId(props);
  const busy = props.busyKey === skill.skillKey;
  return html`
    <div class="callout" style="display: grid; gap: 10px;">
      <div style="display: flex; justify-content: space-between; gap: 12px; align-items: center;">
        <div>
          <div style="font-weight: 700;">Skill file</div>
          <div class="muted mono" style="font-size: 12px; word-break: break-all;">
            ${skill.filePath}
          </div>
        </div>
        ${
          editable
            ? html`
                <button
                  class="btn btn--sm"
                  type="button"
                  data-testid="skill-open-editor"
                  ?disabled=${props.skillEditorLoading || props.skillEditorSaving}
                  @click=${() =>
                    editorOpen ? props.onCloseEditor() : props.onOpenEditor(skill.skillKey)}
                >
                  ${
                    props.skillEditorLoading && !editorOpen
                      ? "Opening..."
                      : editorOpen
                        ? "Close editor"
                        : "Edit SKILL.md"
                  }
                </button>
              `
            : html`
                <button
                  class="btn btn--sm"
                  type="button"
                  data-testid="skill-copy-workspace"
                  ?disabled=${busy}
                  @click=${() => props.onCopyToWorkspace(skill.skillKey, copyAgentId)}
                >
                  ${busy ? "Copying..." : "Make editable copy"}
                </button>
              `
        }
      </div>
      ${
        !editable
          ? html`
	              <div class="muted" style="font-size: 13px">
	                This source is read-only. Make an editable copy for ${agentLabel(
                    props,
                    copyAgentId,
                  )} when you want to change SKILL.md. This does not install external
                binaries or grant tool/wallet access.
              </div>
            `
          : nothing
      }
      ${showError ? html`<div class="callout danger">${props.skillEditorError}</div>` : nothing}
      ${
        editorOpen
          ? html`
              ${
                props.messages[skill.skillKey]
                  ? html`
                      <div
                        class="callout ${
                          props.messages[skill.skillKey]?.kind === "error" ? "danger" : "success"
                        }"
                      >
                        ${props.messages[skill.skillKey]?.message}
                      </div>
                    `
                  : nothing
              }
              <textarea
                class="code-editor"
                style="min-height: 360px; width: 100%; resize: vertical; font-family: var(--mono);"
                spellcheck="false"
                .value=${props.skillEditorDraft}
                @input=${(event: Event) =>
                  props.onEditorDraftChange((event.target as HTMLTextAreaElement).value)}
              ></textarea>
              <div style="display: flex; justify-content: flex-end; gap: 8px;">
                <button
                  class="btn"
                  type="button"
                  ?disabled=${props.skillEditorSaving}
                  @click=${props.onCloseEditor}
                >
                  Cancel
                </button>
                <button
                  class="btn primary"
                  type="button"
                  ?disabled=${props.skillEditorSaving}
                  @click=${props.onSaveEditor}
                >
                  ${props.skillEditorSaving ? "Saving..." : "Save file"}
                </button>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderRootConfigPathEditor(
  skill: SkillStatusEntry,
  path: string,
  props: SkillsProps,
  field?: SkillConfigField,
) {
  const busy = props.busyKey === skill.skillKey;
  const current = readRootConfigPath(props.configForm, path);
  const currentValue = stringifyRootConfigDraft(props.configForm, path);
  const fieldLabel = field?.label || rootConfigFieldLabel(path);
  const asBoolean = field?.type === "boolean" || shouldRenderRootConfigAsBoolean(path, current);
  const asPlainField =
    field?.type && field.type !== "textarea"
      ? true
      : shouldRenderRootConfigAsPlainField(path, current);
  if (asBoolean) {
    const checked = current === true;
    return html`
      <div class="skill-root-config-editor callout" style="display: grid; gap: 8px;">
        <div class="row" style="justify-content: space-between; gap: 12px; flex-wrap: wrap;">
          <label class="field field--checkbox" style="margin: 0;">
            <input type="checkbox" .checked=${checked} />
            <span>${fieldLabel}</span>
          </label>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${busy || !props.onSaveRootConfig}
            @click=${(event: Event) => {
              const root = (event.currentTarget as HTMLElement).closest(
                ".skill-root-config-editor",
              );
              const input = root?.querySelector<HTMLInputElement>("input");
              props.onSaveRootConfig?.(
                skill.skillKey,
                path,
                JSON.stringify(input?.checked ?? false),
              );
            }}
          >
            Save
          </button>
        </div>
      </div>
    `;
  }
  if (asPlainField) {
    const value = formatRootConfigPlainValue(current);
    return html`
      <div class="skill-root-config-editor callout" style="display: grid; gap: 8px;">
        <div
          style="display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; align-items: end;"
        >
          <label class="field" style="min-width: 0;">
            <span>${fieldLabel} <span class="muted mono">${path}</span></span>
            <input
              type=${
                field?.type === "secret" || isSecretRootConfigPath(path)
                  ? "password"
                  : field?.type === "number"
                    ? "number"
                    : "text"
              }
              .value=${value}
              placeholder=${field?.placeholder ?? path}
              autocomplete="off"
            />
          </label>
          <button
            class="btn btn--sm primary"
            type="button"
            ?disabled=${busy || !props.onSaveRootConfig}
            @click=${(event: Event) => {
              const root = (event.currentTarget as HTMLElement).closest(
                ".skill-root-config-editor",
              );
              const input = root?.querySelector<HTMLInputElement>("input");
              const rawValue = input?.value ?? "";
              const nextValue =
                field?.type === "number" && rawValue.trim() ? Number(rawValue) : rawValue;
              props.onSaveRootConfig?.(skill.skillKey, path, JSON.stringify(nextValue));
            }}
          >
            Save
          </button>
        </div>
      </div>
    `;
  }
  return html`
    <div class="skill-root-config-editor callout" style="display: grid; gap: 8px;">
      <div class="row" style="justify-content: space-between; gap: 12px; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="mono" style="font-weight: 700;">${path}</div>
          <div class="muted" style="font-size: 12px;">
            Saved directly in gateway config at this path.
          </div>
        </div>
        <button
          class="btn btn--sm primary"
          type="button"
          ?disabled=${busy || !props.onSaveRootConfig}
          @click=${(event: Event) => {
            const root = (event.currentTarget as HTMLElement).closest(".skill-root-config-editor");
            const textarea = root?.querySelector("textarea");
            props.onSaveRootConfig?.(skill.skillKey, path, textarea?.value ?? currentValue);
          }}
        >
          Save
        </button>
      </div>
      <textarea
        class="code-editor"
        style="min-height: 150px; width: 100%; resize: vertical; font-family: var(--mono);"
        spellcheck="false"
        .value=${currentValue}
      ></textarea>
    </div>
  `;
}

function renderSkillConfigEditor(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const entry = readSkillConfigEntry(props.configForm, skill.skillKey);
  const envNames = skill.requirements.env
    .filter((name) => name !== skill.primaryEnv)
    .filter((name, index, all) => all.indexOf(name) === index);
  const envEdits = props.envEdits[skill.skillKey] ?? {};
  const configDraft =
    props.configEdits[skill.skillKey] ?? stringifySkillConfig(entry?.config ?? undefined);
  const draftConfig = parseSkillConfigDraft(configDraft);
  const typedConfigKeys = skillConfigKeys(skill, entry?.config, draftConfig);
  const hasEnv = envNames.length > 0;
  const hasConfigPaths = skill.requirements.config.length > 0 || skill.configChecks.length > 0;
  const configPaths = [
    ...skill.requirements.config,
    ...skill.configChecks.map((check) => check.path),
    ...(skill.configFields ?? []).map((field) => field.path ?? ""),
  ].filter((path, index, all) => path && all.indexOf(path) === index);
  const rootConfigPaths = configPaths.filter((path) => !configKeyFromPath(path));
  const rootConfigFields = new Map(
    (skill.configFields ?? [])
      .filter((field): field is SkillConfigField & { path: string } => Boolean(field.path))
      .map((field) => [field.path, field]),
  );
  const onlyExternalChannelConfig =
    hasConfigPaths && typedConfigKeys.length === 0 && rootConfigPaths.length > 0;
  const hasSavedConfig = Boolean(entry?.config && Object.keys(entry.config).length > 0);
  const hasAnyConfigSurface = hasEnv || typedConfigKeys.length > 0 || rootConfigPaths.length > 0;
  if (!hasAnyConfigSurface && !hasConfigPaths) {
    return nothing;
  }
  return html`
    <div class="callout" style="display: grid; gap: 12px;">
      <div>
        <div style="font-weight: 700;">Setup</div>
      </div>
      ${
        hasEnv
          ? html`
              <div style="display: grid; gap: 8px;">
                <div class="label">Environment values</div>
                ${envNames.map((envName) => {
                  const saved = Boolean(
                    entry?.env && Object.prototype.hasOwnProperty.call(entry.env, envName),
                  );
                  return html`
                    <label class="field">
                      <span>${envName}</span>
                      <input
                        type="password"
                        .value=${envEdits[envName] ?? ""}
                        placeholder=${saved ? "Saved in config" : "Not set"}
                        autocomplete="off"
                        @input=${(event: Event) =>
                          props.onEnvEdit(
                            skill.skillKey,
                            envName,
                            (event.target as HTMLInputElement).value,
                          )}
                      />
                    </label>
                  `;
                })}
                <div style="display: flex; justify-content: flex-end;">
                  <button
                    class="btn btn--sm primary"
                    type="button"
                    ?disabled=${busy}
                    @click=${() => props.onSaveEnv(skill.skillKey)}
                  >
                    Save env
                  </button>
                </div>
              </div>
            `
          : nothing
      }
      <div style="display: grid; gap: 8px;">
        ${
          typedConfigKeys.length > 0
            ? html`
                <div class="label">Skill config</div>
                <div class="settings-grid">
                  ${typedConfigKeys.map((configKey) =>
                    renderSkillConfigInput({
                      skillKey: skill.skillKey,
                      configKey,
                      field: findSkillConfigField(skill, configKey),
                      value: draftConfig[configKey],
                      draft: configDraft,
                      onConfigEdit: props.onConfigEdit,
                    }),
                  )}
                </div>
              `
            : onlyExternalChannelConfig
              ? nothing
              : html`
                  ${
                    hasConfigPaths
                      ? nothing
                      : html`
                          <div class="muted">
                            This skill has not declared typed config fields. Use Advanced JSON for custom values.
                          </div>
                        `
                  }
                `
        }
        ${
          rootConfigPaths.length > 0
            ? html`
                <div style="display: grid; gap: 10px;">
                  ${rootConfigPaths.map((path) =>
                    renderRootConfigPathEditor(skill, path, props, rootConfigFields.get(path)),
                  )}
                </div>
              `
            : nothing
        }
        ${
          onlyExternalChannelConfig
            ? nothing
            : html`
                <details>
                  <summary>Advanced JSON</summary>
                  <textarea
                    class="code-editor"
                    style="min-height: ${hasSavedConfig ? "180px" : "120px"}; width: 100%; resize: vertical; font-family: var(--mono); margin-top: 8px;"
                    spellcheck="false"
                    .value=${configDraft}
                    @input=${(event: Event) =>
                      props.onConfigEdit(
                        skill.skillKey,
                        (event.target as HTMLTextAreaElement).value,
                      )}
                  ></textarea>
                </details>
                <div style="display: flex; justify-content: flex-end;">
                  <button
                    class="btn btn--sm primary"
                    type="button"
                    ?disabled=${busy}
                    @click=${() => props.onSaveConfig(skill.skillKey)}
                  >
                    Save config
                  </button>
                </div>
              `
        }
      </div>
    </div>
  `;
}

function renderSkillMarketplaceDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const marketplace = skill.marketplace;
  if (!marketplace) {
    return nothing;
  }
  const requested: string[] = [];
  if (marketplace.requestedWalletActions) {
    requested.push("wallet actions");
  }
  if (marketplace.requestedToolAccess.length > 0) {
    requested.push(`tools: ${marketplace.requestedToolAccess.join(", ")}`);
  }
  if (marketplace.requestedInstallKinds.length > 0) {
    requested.push(`install: ${marketplace.requestedInstallKinds.join(", ")}`);
  }
  const scanText =
    marketplace.scanBlocks > 0 || marketplace.scanBlocked
      ? `${marketplace.scanBlocks} block${marketplace.scanBlocks === 1 ? "" : "s"}`
      : marketplace.scanWarnings > 0
        ? `${marketplace.scanWarnings} warning${marketplace.scanWarnings === 1 ? "" : "s"}`
        : "clean";
  const reviewText = marketplace.updateApprovalRequired
    ? `approval required${marketplace.updateReviewReasons.length > 0 ? `: ${marketplace.updateReviewReasons.join(", ")}` : ""}`
    : "clean";

  return html`
    <div
      class="callout ${
        marketplace.updateApprovalRequired || marketplace.scanBlocked || marketplace.scanBlocks > 0
          ? "danger"
          : marketplace.requestedRisky || marketplace.scanWarnings > 0
            ? ""
            : "success"
      }"
      style="display: grid; gap: 6px;"
    >
      <div style="font-weight: 600;">ClawHub marketplace review</div>
      <div>Source: ${marketplace.registry} / ${marketplace.slug} v${marketplace.installedVersion}</div>
      <div>Requested permissions: ${requested.length > 0 ? requested.join("; ") : "none"}</div>
      <div>Archive scan: ${scanText}</div>
      <div>Last update review: ${reviewText}</div>
      <div style="display: flex; justify-content: flex-end;">
        <button
          class="btn btn--sm"
          ?disabled=${props.clawhubReviewLoading || props.clawhubInstallSlug !== null}
          @click=${() => props.onClawHubUpdatePreview(marketplace.slug)}
        >
          Review update
        </button>
      </div>
    </div>
  `;
}

function renderSkillInstallTrust(option: SkillStatusEntry["install"][number] | undefined) {
  if (!option) {
    return nothing;
  }
  const warnings = option.trustWarnings ?? [];
  if (!option.external && warnings.length === 0) {
    return nothing;
  }
  const pinnedLabel = option.pinned ? "Version pinned" : "Unpinned version";
  const integrityLabel = option.integrityPinned ? "Integrity pinned" : "No integrity pin";
  return html`
    <div class="callout" style="display: grid; gap: 8px; border-color: var(--warn-subtle);">
      <div style="font-weight: 700;">External package trust</div>
      <div class="muted" style="font-size: 12px;">
        Review the package source before installing. Dependency install does not grant Agent tools,
        wallet access, mining access, or task autonomy.
      </div>
      <div class="chip-row">
        <span class="chip chip-warn">${option.kind}</span>
        <span class="chip ${option.pinned ? "chip-ok" : "chip-warn"}">${pinnedLabel}</span>
        <span class="chip ${option.integrityPinned ? "chip-ok" : "chip-warn"}">
          ${integrityLabel}
        </span>
      </div>
      ${
        warnings.length > 0
          ? html`<div class="muted" style="font-size: 12px;">${warnings.join("; ")}</div>`
          : nothing
      }
    </div>
  `;
}

function renderSkillInstallPlan(option: SkillStatusEntry["install"][number] | undefined) {
  const plan = option?.plan;
  if (!option || !plan) {
    return nothing;
  }
  const binRows = plan.bins.length > 0 ? plan.bins : option.bins.map((bin) => ({ bin }));
  const targetPreview = plan.pathTargets.slice(0, 4);
  const extraTargets = Math.max(plan.pathTargets.length - targetPreview.length, 0);
  const packageLabel = plan.packageRef || option.label;
  const pinLabel = option.pinned ? "pinned" : "unpinned";
  const integrityLabel = option.integrityPinned ? "integrity pinned" : "no integrity";
  return html`
    <details
      style="border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--secondary);"
    >
      <summary
        style="align-items: center; cursor: pointer; display: flex; gap: 12px; justify-content: space-between; list-style: none; padding: 10px 12px;"
      >
        <span style="color: var(--text-strong); font-size: 13px; font-weight: 760;">Install plan</span>
        <span style="color: var(--muted); font-size: 12px; line-height: 1.35; text-align: right;">
          ${plan.manager} · ${packageLabel} · ${pinLabel} · ${integrityLabel}
        </span>
      </summary>
      <div style="border-top: 1px solid var(--border); display: grid; gap: 10px; padding: 12px;">
        <div>
          <div class="label">Command</div>
          <code class="inline-code" style="display: block; white-space: pre-wrap; margin-top: 4px;">
            ${plan.commandPreview}
          </code>
        </div>
        ${
          plan.toolchainAvailable
            ? nothing
            : html`
                <div class="callout danger" style="font-size: 13px;">
                  ${plan.toolchainMessage ?? "Required installer is not visible to the gateway PATH."}
                </div>
              `
        }
        ${
          binRows.length > 0
            ? html`
                <div style="display: grid; gap: 6px;">
                  <div class="label">Dependency health</div>
                  ${binRows.map((row) => {
                    const typed = row as {
                      bin: string;
                      available?: boolean;
                      outsidePath?: string;
                      pathTargets?: string[];
                    };
                    const status = typed.available
                      ? "ready"
                      : typed.outsidePath
                        ? `installed outside PATH: ${typed.outsidePath}`
                        : "missing from gateway PATH";
                    return html`
                      <div class="mini-card" style="display: flex; justify-content: space-between; gap: 12px;">
                        <span class="mono">${typed.bin}</span>
                        <span>${status}</span>
                      </div>
                    `;
                  })}
                </div>
              `
            : nothing
        }
        ${
          targetPreview.length > 0
            ? html`
                <div class="muted" style="font-size: 12px;">
                  PATH targets checked:
                  ${targetPreview.map((target) => html`<span class="mono">${target}</span>`)}
                  ${extraTargets > 0 ? `+ ${extraTargets} more` : ""}
                </div>
              `
            : nothing
        }
      </div>
    </details>
  `;
}

function renderSkillDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const canInstall = skill.install.length > 0 && skill.missing.bins.length > 0;
  const showBundledBadge = Boolean(skill.bundled && skill.source !== "fased-bundled");
  const setupMissing = [
    ...skill.missing.env.map((value) => `env:${value}`),
    ...skill.missing.config.map((value) => `config:${value}`),
  ];
  const runtimeMissing = [
    ...skill.missing.bins.map((value) => `bin:${value}`),
    ...skill.missing.os.map((value) => `os:${value}`),
  ];
  const missingDependencyText =
    skill.missing.bins.length > 0
      ? `Needs dependency: ${skill.missing.bins.join(", ")}`
      : skill.missing.os.length > 0
        ? `Unsupported OS: ${skill.missing.os.join(", ")}`
        : "";
  const reasons = computeSkillReasons(skill);

  return html`
    <dialog
      class="md-preview-dialog"
      ${ref(openDialogSafely)}
      @click=${closeDialogOnBackdropClick}
      @close=${props.onDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div
            class="md-preview-dialog__title"
            style="display: flex; align-items: center; gap: 8px;"
          >
            <span class="statusDot ${skillReadinessClass(skill)}"></span>
            <span>${skill.name}</span>
          </div>
          <button
            class="btn btn--sm"
            type="button"
            @click=${(e: Event) => {
              (e.currentTarget as HTMLElement).closest("dialog")?.close();
              props.onDetailClose();
            }}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          <div>
            <div style="font-size: 14px; line-height: 1.5; color: var(--text);">
              ${skill.description}
            </div>
            ${renderSkillStatusChips({ skill, showBundledBadge })}
          </div>

          ${
            runtimeMissing.length > 0
              ? html`
                <div
                  class="callout"
                  style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                >
                  <div style="font-weight: 600; margin-bottom: 4px;">
                    ${missingDependencyText || "Runtime requirement"}
                  </div>
                  <div>${runtimeMissing.join(", ")}</div>
                </div>
              `
              : nothing
          }
          ${
            reasons.length > 0
              ? html`
                <div class="muted" style="font-size: 13px;">Reason: ${reasons.join(", ")}</div>
              `
              : nothing
          }
          ${renderSkillMarketplaceDetail(skill, props)}

          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
            <label class="cfg-toggle">
              <input
                type="checkbox"
                .checked=${!skill.disabled}
                ?disabled=${busy || (skill.disabled && isMarketplaceEnableBlocked(skill))}
                @change=${() => props.onToggle(skill.skillKey, skill.disabled)}
              />
              <span class="cfg-toggle__track"></span>
            </label>
            <span style="font-size: 13px; font-weight: 500;">
              ${skill.disabled ? "Hidden from library" : "Available in library"}
            </span>
          </div>
          ${
            canInstall
              ? html`
                  <div
                    class="callout"
                    style="display: grid; gap: 8px; border-color: var(--border); background: var(--secondary);"
                  >
                    <div
                      style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;"
                    >
                      <div>
                        <div style="font-size: 12px; text-transform: uppercase; color: var(--muted); font-weight: 700;">
                          Installer
                        </div>
                        <div style="font-weight: 600;">${skill.install[0].label}</div>
                      </div>
                      <button
                        class="btn"
                        type="button"
                        data-testid=${`skill-install-dependency-modal-${skill.skillKey}`}
                        ?disabled=${busy}
                        @click=${() =>
                          props.onInstall(skill.skillKey, skill.name, skill.install[0].id)}
                      >
                        ${busy ? "Installing\u2026" : skill.install[0].label}
                      </button>
                    </div>
                    ${renderSkillInstallPlan(skill.install[0])}
                    ${renderSkillInstallTrust(skill.install[0])}
                    <div class="muted" style="font-size: 12px;">
                      Install is complete only when ${skill.missing.bins.join(", ")} is visible to the
                      gateway PATH after the command finishes.
                    </div>
                  </div>
                `
              : nothing
          }
          <div style="display: flex; justify-content: flex-end;">
            <button
              class="btn"
              type="button"
              data-testid=${`skill-test-${skill.skillKey}`}
              @click=${() => props.onTestSkill(skill.skillKey, skill.name)}
            >
              Test skill
            </button>
          </div>
          ${renderSkillAgentAttach(skill, props)}
          ${renderSkillFileEditor(skill, props)}
          ${renderSkillConfigEditor(skill, props)}

          ${
            message && props.skillEditor?.skillKey !== skill.skillKey
              ? html`<div class="callout ${message.kind === "error" ? "danger" : "success"}">
                ${message.message}
              </div>`
              : nothing
          }
          ${
            skill.primaryEnv
              ? html`
                <div style="display: grid; gap: 8px;">
                  <div class="field">
                    <span
                      >API key
                      <span class="muted" style="font-weight: normal; font-size: 0.88em;"
                        >(${skill.primaryEnv})</span
                      ></span
                    >
                    <input
                      type="password"
                      .value=${apiKey}
                      @input=${(e: Event) =>
                        props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                    />
                  </div>
                  ${(() => {
                    const href = safeExternalHref(skill.homepage);
                    return href
                      ? html`<div class="muted" style="font-size: 13px;">
                          Get your key:
                          <a href="${href}" target="_blank" rel="noopener noreferrer"
                            >${skill.homepage}</a
                          >
                        </div>`
                      : nothing;
                  })()}
                  <button
                    class="btn primary"
                    ?disabled=${busy}
                    @click=${() => props.onSaveKey(skill.skillKey)}
                  >
                    Save key
                  </button>
                </div>
              `
              : nothing
          }
          ${
            setupMissing.length > 0
              ? html`
                  <div class="muted" style="font-size: 12px;">
                    Setup requirement: ${setupMissing.join(", ")}
                  </div>
                `
              : nothing
          }

        </div>
      </div>
    </dialog>
  `;
}
