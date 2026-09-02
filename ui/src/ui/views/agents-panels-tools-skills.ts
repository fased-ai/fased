import { html, nothing } from "lit";
import { normalizeToolName } from "../../../../src/agents/tool-policy-shared.js";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import type {
  SkillStatusEntry,
  SkillStatusReport,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../types.ts";
import {
  type AgentToolEntry,
  type AgentToolSection,
  isAllowedByPolicy,
  isVisibleAgentToolId,
  matchesList,
  resolveAgentConfig,
  resolveToolProfileOptions,
  resolveToolProfile,
  resolveToolSections,
} from "./agents-utils.ts";
import type { SkillGroup } from "./skills-grouping.ts";
import { groupSkills } from "./skills-grouping.ts";
import { computeSkillMissing, computeSkillReasons, getSkillReadiness } from "./skills-shared.ts";
import { renderClawHubPanel, type SkillsProps } from "./skills.ts";

const AGENT_SKILL_STATUS_TABS = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "needs-setup", label: "Needs Setup" },
  { id: "disabled", label: "Hidden" },
] as const;

function renderAgentHelp(text: string, label = "Help") {
  return html`
    <span
      class="agent-help"
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

function renderToolBadges(section: AgentToolSection, tool: AgentToolEntry) {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  const badges: string[] = [];
  if (source === "plugin" && pluginId) {
    badges.push(`plugin:${pluginId}`);
  } else if (source === "core") {
    badges.push("core");
  }
  if (tool.optional) {
    badges.push("optional");
  }
  if (badges.length === 0) {
    return nothing;
  }
  return html`
    <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px;">
      ${badges.map((badge) => html`<span class="agent-pill">${badge}</span>`)}
    </div>
  `;
}

function renderEffectiveToolBadge(tool: {
  source: "core" | "plugin" | "channel";
  pluginId?: string | null;
  channelId?: string | null;
}) {
  if (tool.source === "plugin") {
    return tool.pluginId
      ? t("agentTools.connectedSource", { id: tool.pluginId })
      : t("agentTools.connected");
  }
  if (tool.source === "channel") {
    return tool.channelId
      ? t("agentTools.channelSource", { id: tool.channelId })
      : t("agentTools.channel");
  }
  return t("agentTools.builtIn");
}

function getEffectiveToolsFailureGuidance(error: string, runtimeSessionKey: string) {
  if (!runtimeSessionKey) {
    return {
      title: "No active runtime session selected.",
      next: "Open a chat session for this Agent, then reload this panel.",
    };
  }

  const normalized = error.toLowerCase();
  if (
    /web[-_ ]?search|web[-_ ]?fetch|firecrawl|github|gmail|google|workspace|brave|serpapi|tavily|perplexity|credential|api key|auth/.test(
      normalized,
    )
  ) {
    return {
      title: "A service connector is missing or not authenticated.",
      next: "Open Services for the matching row, then reload this panel.",
    };
  }
  if (/plugin|extension|runtime/.test(normalized)) {
    return {
      title: "An extension runtime is missing or not loaded.",
      next: "Open Extensions, enable or restart the plugin, then reload this panel.",
    };
  }
  if (/policy|allow|deny|blocked|forbidden|not allowed/.test(normalized)) {
    return {
      title: "Tool policy is blocking this session.",
      next: "Adjust this Agent's Tool Access profile or allow/deny overrides. Changes save automatically.",
    };
  }
  if (/session|conversation|chat/.test(normalized)) {
    return {
      title: "The active chat session is not available.",
      next: "Open or create a chat session for this Agent, then reload this panel.",
    };
  }
  if (/gateway|rpc|connect|offline|unavailable|failed to fetch/.test(normalized)) {
    return {
      title: "The gateway runtime could not answer the tool request.",
      next: "Open Debug to check runtime health, then reload this panel.",
    };
  }
  return {
    title: "Live tools could not be resolved.",
    next: "Check the active chat session first, then Services for credentials or Extensions for plugin runtime.",
  };
}

export function renderAgentTools(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  onProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const agentTools = config.entry?.tools ?? {};
  const globalTools = config.globalTools ?? {};
  const profile = agentTools.profile ?? globalTools.profile ?? "full";
  const profileOptions = resolveToolProfileOptions(params.toolsCatalogResult);
  const toolSections = resolveToolSections(params.toolsCatalogResult);
  const profileSource = agentTools.profile
    ? "agent override"
    : globalTools.profile
      ? "global default"
      : "default";
  const hasAgentAllow = Array.isArray(agentTools.allow) && agentTools.allow.length > 0;
  const hasGlobalAllow = Array.isArray(globalTools.allow) && globalTools.allow.length > 0;
  const editable =
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !hasAgentAllow &&
    !(params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError);
  const alsoAllow = hasAgentAllow
    ? []
    : Array.isArray(agentTools.alsoAllow)
      ? agentTools.alsoAllow
      : [];
  const deny = hasAgentAllow ? [] : Array.isArray(agentTools.deny) ? agentTools.deny : [];
  const basePolicy = hasAgentAllow
    ? { allow: agentTools.allow ?? [], deny: agentTools.deny ?? [] }
    : (resolveToolProfile(profile) ?? undefined);
  const toolIds = toolSections.flatMap((section) => section.tools.map((tool) => tool.id));

  const resolveAllowed = (toolId: string) => {
    const baseAllowed = isAllowedByPolicy(toolId, basePolicy);
    const extraAllowed = matchesList(toolId, alsoAllow);
    const denied = matchesList(toolId, deny);
    const allowed = (baseAllowed || extraAllowed) && !denied;
    return {
      allowed,
      baseAllowed,
      denied,
    };
  };
  const enabledCount = toolIds.filter((toolId) => resolveAllowed(toolId).allowed).length;
  const toolsEffectiveFailure = params.toolsEffectiveError
    ? getEffectiveToolsFailureGuidance(params.toolsEffectiveError, params.runtimeSessionKey)
    : null;
  const effectiveGroups = (params.toolsEffectiveResult?.groups ?? [])
    .map((group) => ({
      ...group,
      tools: group.tools.filter((tool) => isVisibleAgentToolId(tool.id)),
    }))
    .filter((group) => group.tools.length > 0);
  const effectiveToolCount = effectiveGroups.reduce((sum, group) => sum + group.tools.length, 0);
  const toolsHelp =
    "Per-Agent allow/deny only. Services connect API credentials; this panel grants or blocks this Agent from using the resulting tools.";
  const liveToolsHelp =
    "Tools actually loaded for the current chat session after service credentials, extension runtime state, and this Agent policy are applied.";

  const updateTool = (toolId: string, nextEnabled: boolean) => {
    const nextAllow = new Set(
      alsoAllow.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const nextDeny = new Set(
      deny.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const baseAllowed = resolveAllowed(toolId).baseAllowed;
    const normalized = normalizeToolName(toolId);
    if (nextEnabled) {
      nextDeny.delete(normalized);
      if (!baseAllowed) {
        nextAllow.add(normalized);
      }
    } else {
      nextAllow.delete(normalized);
      nextDeny.add(normalized);
    }
    params.onOverridesChange(params.agentId, [...nextAllow], [...nextDeny]);
  };

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title" style="align-items: center; display: flex; gap: 8px;">
            <span>Tool Access</span>
            ${renderAgentHelp(toolsHelp, "Tool Access help")}
          </div>
          <div class="card-sub">
            <span class="mono">${enabledCount}/${toolIds.length}</span> enabled.
          </div>
        </div>
      </div>

      ${
        !params.configForm
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Load the gateway config to adjust tool profiles.
              </div>
            `
          : nothing
      }
      ${
        hasAgentAllow
          ? html`
              <div class="callout info" style="margin-top: 12px">
                This agent is using an explicit allowlist in config. Tool overrides are managed in the Config tab.
              </div>
            `
          : nothing
      }
      ${
        hasGlobalAllow
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Global tools.allow is set. Agent overrides cannot enable tools that are globally blocked.
              </div>
            `
          : nothing
      }
      ${
        params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError
          ? html`
              <div class="callout info" style="margin-top: 12px">Loading runtime tool catalog…</div>
            `
          : nothing
      }
      ${
        params.toolsCatalogError
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Could not load runtime tool catalog. Showing built-in fallback list instead.
              </div>
            `
          : nothing
      }

      <div class="agent-tools-presets" style="margin-top: 16px;">
        <div class="row" style="justify-content: space-between; gap: 10px; flex-wrap: wrap;">
          <div class="label">Quick Presets</div>
          <div class="row" style="gap: 6px; flex-wrap: wrap;">
            <span class="agent-pill">source: ${profileSource}</span>
          </div>
        </div>
        <div class="agent-tools-buttons">
          ${profileOptions.map(
            (option) => html`
              <button
                class="btn btn--sm ${profile === option.id ? "active" : ""}"
                ?disabled=${!editable}
                @click=${() => params.onProfileChange(params.agentId, option.id, true)}
              >
                ${option.label}
              </button>
            `,
          )}
          <button
            class="btn btn--sm ${!agentTools.profile ? "active" : ""}"
            ?disabled=${!editable}
            @click=${() => params.onProfileChange(params.agentId, null, false)}
          >
            Inherit
          </button>
        </div>
      </div>

      <details class="agent-tools-section-details agent-tools-section-details--runtime">
        <summary class="agent-tools-section-summary">
          <div>
            <div class="label" style="align-items: center; display: flex; gap: 8px;">
              <span>Available Right Now</span>
              ${renderAgentHelp(liveToolsHelp, "Available tools help")}
            </div>
            <div class="card-sub">
              <span class="mono">${params.runtimeSessionKey || "no session"}</span>
            </div>
          </div>
          <span class="agent-pill ${params.toolsEffectiveError ? "warn" : ""}">
            ${
              params.toolsEffectiveLoading &&
              !params.toolsEffectiveResult &&
              !params.toolsEffectiveError
                ? "loading"
                : params.toolsEffectiveError
                  ? "needs attention"
                  : `${effectiveToolCount} tools`
            }
          </span>
        </summary>
        <div class="agent-tools-section-body">
          ${
            !params.runtimeSessionMatchesSelectedAgent
              ? html`
                  <div class="callout info">Switch chat to this agent to view its live runtime tools.</div>
                `
              : params.toolsEffectiveLoading &&
                  !params.toolsEffectiveResult &&
                  !params.toolsEffectiveError
                ? html`
                    <div class="callout info">Loading available tools…</div>
                  `
                : params.toolsEffectiveError
                  ? html`
                      <div class="callout info">
                        <div><strong>${toolsEffectiveFailure?.title}</strong></div>
                        <div class="card-sub" style="margin-top: 4px;">
                          ${toolsEffectiveFailure?.next}
                        </div>
                        <div style="margin-top: 8px;">
                          Reason: <span class="mono">${params.toolsEffectiveError}</span>
                        </div>
                      </div>
                    `
                  : effectiveGroups.length === 0
                    ? html`
                        <div class="callout info">No tools are available for this session right now.</div>
                      `
                    : html`
                      <div class="agent-tools-grid">
                        ${effectiveGroups.map(
                          (group) => html`
                            <details class="agent-tools-section-details">
                              <summary class="agent-tools-section-summary">
                                <span class="agent-tools-header">${group.label}</span>
                                <span class="agent-pill">${group.tools.length} tools</span>
                              </summary>
                              <div class="agent-tools-list agent-tools-section-body">
                                ${group.tools.map((tool) => {
                                  return html`
                                    <details class="agent-tool-details">
                                      <summary class="agent-tool-row agent-tool-summary">
                                        <div class="agent-tool-main">
                                          <div class="agent-tool-title">${tool.label}</div>
                                        </div>
                                        ${renderAgentHelp(
                                          tool.description || "No description available.",
                                          `${tool.label} help`,
                                        )}
                                      </summary>
                                      <div class="agent-tool-detail">
                                        <div class="agent-tool-sub">${tool.description}</div>
                                        <div
                                          style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px;"
                                        >
                                          <span class="agent-pill"
                                            >${renderEffectiveToolBadge(tool)}</span
                                          >
                                        </div>
                                      </div>
                                    </details>
                                  `;
                                })}
                              </div>
                            </details>
                          `,
                        )}
                      </div>
                    `
          }
        </div>
      </details>

      <div class="agent-tools-grid" style="margin-top: 20px;">
        ${toolSections.map((section) => {
          const sectionEnabledCount = section.tools.filter(
            (tool) => resolveAllowed(tool.id).allowed,
          ).length;
          return html`
            <details class="agent-tools-section-details">
              <summary class="agent-tools-section-summary">
                <span class="agent-tools-header">${section.label}</span>
                <span class="row" style="gap: 6px;">
                  <span class="agent-pill">${sectionEnabledCount}/${section.tools.length}</span>
                  ${
                    section.source === "plugin" && section.pluginId
                      ? html`<span class="agent-pill">plugin:${section.pluginId}</span>`
                      : nothing
                  }
                </span>
              </summary>
              <div class="agent-tools-list agent-tools-section-body">
                ${section.tools.map((tool) => {
                  const { allowed } = resolveAllowed(tool.id);
                  return html`
                    <details class="agent-tool-details">
                      <summary class="agent-tool-row agent-tool-summary">
                        <div class="agent-tool-main">
                          <div class="agent-tool-title mono">${tool.label}</div>
                        </div>
                        <div class="row" style="gap: 8px;">
                          ${renderAgentHelp(
                            tool.description || "No description available.",
                            `${tool.label} help`,
                          )}
                          <label class="cfg-toggle" @click=${(e: Event) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              .checked=${allowed}
                              ?disabled=${!editable}
                              @change=${(e: Event) =>
                                updateTool(tool.id, (e.target as HTMLInputElement).checked)}
                            />
                            <span class="cfg-toggle__track"></span>
                          </label>
                        </div>
                      </summary>
                      <div class="agent-tool-detail">
                        <div class="agent-tool-sub">${tool.description}</div>
                        ${renderToolBadges(section, tool)}
                      </div>
                    </details>
                  `;
                })}
              </div>
            </details>
          `;
        })}
      </div>
    </section>
  `;
}

export function renderAgentSkills(params: {
  agentId: string;
  report: SkillStatusReport | null;
  loading: boolean;
  error: string | null;
  activeAgentId: string | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  filter: string;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onClear: (agentId: string) => void;
  onNarrowToSelected: (agentId: string) => void;
  onDisableAll: (agentId: string) => void;
  onOpenSkillDetail?: (skillKey: string) => void;
  onCreateSkill?: () => void;
  skillsLibrary?: SkillsProps;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const editable = Boolean(params.configForm) && !params.configLoading && !params.configSaving;
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const allowlist = Array.isArray(config.entry?.skills) ? config.entry?.skills : undefined;
  const allowSet = new Set((allowlist ?? []).map((name) => name.trim()).filter(Boolean));
  const usingAllowlist = allowlist !== undefined;
  const reportReady = Boolean(params.report && params.activeAgentId === params.agentId);
  const rawSkills = reportReady ? (params.report?.skills ?? []) : [];
  const agentStatusFilter = params.skillsLibrary?.statusFilter ?? "all";
  const statusCounts = {
    all: rawSkills.length,
    ready: rawSkills.filter((skill) => getSkillReadiness(skill).kind === "ready").length,
    "needs-setup": rawSkills.filter((skill) => {
      const readiness = getSkillReadiness(skill).kind;
      return readiness !== "ready" && readiness !== "disabled";
    }).length,
    disabled: rawSkills.filter((skill) => getSkillReadiness(skill).kind === "disabled").length,
  };
  const statusFiltered =
    agentStatusFilter === "all"
      ? rawSkills
      : rawSkills.filter((skill) => {
          const readiness = getSkillReadiness(skill).kind;
          if (agentStatusFilter === "ready") {
            return readiness === "ready";
          }
          if (agentStatusFilter === "needs-setup") {
            return readiness !== "ready" && readiness !== "disabled";
          }
          return readiness === "disabled";
        });
  const filter = params.filter.trim().toLowerCase();
  const filtered = filter
    ? statusFiltered.filter((skill) =>
        [skill.name, skill.description, skill.source].join(" ").toLowerCase().includes(filter),
      )
    : statusFiltered;
  const groups = groupSkills(filtered);
  const enabledCount = usingAllowlist
    ? rawSkills.filter((skill) => allowSet.has(skill.name)).length
    : rawSkills.length;
  const totalCount = rawSkills.length;
  const activePanel = params.skillsLibrary?.libraryPanel ?? "skills";
  const agentSkillsLibrary = params.skillsLibrary
    ? {
        ...params.skillsLibrary,
        attachAgentId: params.agentId,
        createAgentId: params.agentId,
        clawhubInstallTarget: `agent:${params.agentId}` as const,
        onCreateOpen: () => {
          if (params.onCreateSkill) {
            params.onCreateSkill();
            return;
          }
          params.skillsLibrary?.onCreateOpen();
        },
        onDetailOpen: (skillKey: string) => {
          if (params.onOpenSkillDetail) {
            params.onOpenSkillDetail(skillKey);
            return;
          }
          params.skillsLibrary?.onAttachAgentChange(params.agentId);
          params.skillsLibrary?.onDetailOpen(skillKey);
        },
        onClawHubInstall: (slug: string) => {
          params.skillsLibrary?.onClawHubTargetChange(`agent:${params.agentId}`);
          params.skillsLibrary?.onClawHubInstall(slug);
        },
      }
    : null;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">Skills</div>
          <div class="card-sub">
            <span class="mono">${enabledCount}/${totalCount}</span> allowed for this Agent.
            ${
              usingAllowlist
                ? nothing
                : html`
                    <span class="muted"> Inherits all library skills.</span>
                  `
            }
            ${
              usingAllowlist && enabledCount === 0
                ? html`
                    <span class="muted"> No skills are allowed.</span>
                  `
                : nothing
            }
          </div>
        </div>
        ${
          params.onCreateSkill
            ? html`
                <button class="btn btn--sm primary" type="button" @click=${params.onCreateSkill}>
                  ${icons.plus} Skill
                </button>
              `
            : nothing
        }
      </div>

      <div class="agent-tabs" style="margin-top: 14px;">
        <button
          class="agent-tab ${activePanel === "skills" ? "active" : ""}"
          type="button"
          @click=${() => params.skillsLibrary?.onLibraryPanelChange?.("skills")}
        >
          Skills
        </button>
      </div>

      ${
        activePanel === "clawhub"
          ? agentSkillsLibrary
            ? html`
                <div style="margin-top: 14px;">
                  ${renderClawHubPanel(agentSkillsLibrary, {
                    showInstallTarget: false,
                    showHeader: false,
                    title: "ClawHub",
                    subtitle: "Search, review, and install skills for this Agent.",
                  })}
                </div>
              `
            : html`
                <div class="muted" style="margin-top: 16px">Skill registry state is not loaded.</div>
              `
          : html`
      ${
        !params.configForm
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Load the gateway config to set this Agent's skill access.
              </div>
            `
          : nothing
      }
      <div class="agent-tabs" style="margin-top: 14px;">
        ${AGENT_SKILL_STATUS_TABS.map(
          (tab) => html`
            <button
              class="agent-tab ${agentStatusFilter === tab.id ? "active" : ""}"
              type="button"
              @click=${() => params.skillsLibrary?.onStatusFilterChange(tab.id)}
            >
              ${tab.label}<span class="agent-tab-count">(${statusCounts[tab.id]})</span>
            </button>
          `,
        )}
      </div>
      ${
        !reportReady && !params.loading
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Load skills for this agent to view workspace-specific entries.
              </div>
            `
          : nothing
      }
      ${
        params.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
          : nothing
      }

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>Filter</span>
          <input
            .value=${params.filter}
            @input=${(e: Event) => params.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder="Search skills"
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="row" style="align-self: end; gap: 6px; flex-wrap: wrap;">
          <button
            class="btn btn--sm"
            type="button"
            style="min-height: 36px;"
            ?disabled=${!editable || !usingAllowlist}
            @click=${() => params.onClear(params.agentId)}
          >
            Enable all
          </button>
          <button
            class="btn btn--sm"
            type="button"
            style="min-height: 36px;"
            ?disabled=${!editable || (usingAllowlist && enabledCount === 0)}
            @click=${() => params.onDisableAll(params.agentId)}
          >
            Disable all
          </button>
        </div>
      </div>

      ${
        filtered.length === 0
          ? html`
              <div class="muted" style="margin-top: 16px">No skills found.</div>
            `
          : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) =>
                renderAgentSkillGroup(group, {
                  agentId: params.agentId,
                  allowSet,
                  usingAllowlist,
                  editable,
                  onToggle: params.onToggle,
                  onOpenSkillDetail: params.onOpenSkillDetail,
                }),
              )}
            </div>
          `
      }
          `
      }
    </section>
  `;
}

function renderAgentSkillGroup(
  group: SkillGroup,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
    onOpenSkillDetail?: (skillKey: string) => void;
  },
) {
  return html`
    <details class="agent-skills-group">
      <summary class="agent-skills-header">
        <span>${group.label}</span>
        <span class="muted">${group.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${group.skills.map((skill) =>
          renderAgentSkillRow(skill, {
            agentId: params.agentId,
            allowSet: params.allowSet,
            usingAllowlist: params.usingAllowlist,
            editable: params.editable,
            onToggle: params.onToggle,
            onOpenSkillDetail: params.onOpenSkillDetail,
          }),
        )}
      </div>
    </details>
  `;
}

function renderAgentSkillRow(
  skill: SkillStatusEntry,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
    onOpenSkillDetail?: (skillKey: string) => void;
  },
) {
  const enabled = params.usingAllowlist ? params.allowSet.has(skill.name) : true;
  const readiness = getSkillReadiness(skill);
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  const detail = missing.length > 0 ? missing.join(", ") : reasons[0] || readiness.detail;
  return html`
    <div
      class="list-item list-item-clickable agent-skill-row"
      data-testid=${`agent-skill-row-${skill.skillKey}`}
      @click=${() => params.onOpenSkillDetail?.(skill.skillKey)}
    >
      <div class="list-main">
        <div class="row" style="gap: 8px; min-width: 0;">
          <span class="statusDot ${readiness.kind === "ready" ? "ok" : "warn"}"></span>
          <div class="list-title">${skill.name}</div>
          <span class="agent-pill">${readiness.label}</span>
        </div>
        <div class="list-sub">${skill.description}</div>
        <div class="muted" style="font-size: 12px; margin-top: 6px;">${detail}</div>
      </div>
      <div class="list-meta">
        <label class="cfg-toggle" @click=${(event: Event) => event.stopPropagation()}>
          <input
            type="checkbox"
            .checked=${enabled}
            ?disabled=${!params.editable}
            @change=${(e: Event) =>
              params.onToggle(params.agentId, skill.name, (e.target as HTMLInputElement).checked)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `;
}
