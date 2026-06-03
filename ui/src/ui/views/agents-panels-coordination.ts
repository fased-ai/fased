import { html, nothing } from "lit";
import type { AgentsListResult } from "../types.ts";
import { resolveAgentConfig } from "./agents-utils.ts";

type ConfigRecord = Record<string, unknown>;

function asRecord(value: unknown): ConfigRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ConfigRecord)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findAgentConfigIndex(configForm: Record<string, unknown> | null, agentId: string) {
  const list = asRecord(configForm?.agents)?.list;
  if (!Array.isArray(list)) {
    return -1;
  }
  return list.findIndex((entry) => asRecord(entry)?.id === agentId);
}

function csv(values: string[]) {
  return values.join(", ");
}

function parseCsv(raw: string) {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function renderNumberField(params: {
  label: string;
  value: number | null;
  min?: number;
  max?: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  return html`
    <label class="field coordination-field">
      <span>${params.label}</span>
      <input
        type="number"
        min=${String(params.min ?? 0)}
        max=${params.max == null ? "" : String(params.max)}
        .value=${params.value == null ? "" : String(params.value)}
        ?disabled=${params.disabled}
        @change=${(event: Event) => {
          const raw = (event.target as HTMLInputElement).value.trim();
          const parsed = raw ? Number(raw) : null;
          params.onChange(parsed != null && Number.isFinite(parsed) ? parsed : null);
        }}
      />
    </label>
  `;
}

function renderAgentChoiceButtons(params: {
  agents: AgentsListResult["agents"];
  selected: string[];
  disabled: boolean;
  includeAny: boolean;
  testPrefix: string;
  onChange: (next: string[]) => void;
}) {
  const selected = new Set(params.selected);
  const anySelected = selected.has("*");
  const toggle = (agentId: string) => {
    const next = new Set(anySelected && agentId !== "*" ? [] : selected);
    if (agentId === "*") {
      params.onChange(anySelected ? [] : ["*"]);
      return;
    }
    if (next.has(agentId)) {
      next.delete(agentId);
    } else {
      next.add(agentId);
    }
    next.delete("*");
    params.onChange([...next]);
  };

  return html`
    <div class="coordination-agent-picks">
      ${
        params.includeAny
          ? html`
              <button
                type="button"
                class="btn btn--sm ${anySelected ? "primary" : ""}"
                data-test-id=${`${params.testPrefix}-any`}
                ?disabled=${params.disabled}
                @click=${() => toggle("*")}
              >
                Any Agent
              </button>
            `
          : nothing
      }
      ${params.agents.map(
        (agent) => html`
          <button
            type="button"
            class="btn btn--sm ${selected.has(agent.id) && !anySelected ? "primary" : ""}"
            data-test-id=${`${params.testPrefix}-${agent.id}`}
            ?disabled=${params.disabled || anySelected}
            @click=${() => toggle(agent.id)}
          >
            ${agent.name || agent.identity?.name || agent.id}
          </button>
        `,
      )}
    </div>
  `;
}

export function renderAgentCoordination(params: {
  agentId: string;
  agentsList: AgentsListResult | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const cfg = params.configForm;
  const root = asRecord(cfg);
  const agentsRoot = asRecord(root?.agents);
  const defaults = asRecord(agentsRoot?.defaults);
  const defaultsSubagents = asRecord(defaults?.subagents);
  const tools = asRecord(root?.tools);
  const toolA2A = asRecord(tools?.agentToAgent);
  const session = asRecord(root?.session);
  const sessionA2A = asRecord(session?.agentToAgent);
  const agentSubagents = asRecord(config.entry?.subagents);
  const agentIndex = findAgentConfigIndex(params.configForm, params.agentId);
  const otherAgents = (params.agentsList?.agents ?? []).filter(
    (agent) => agent.id !== params.agentId,
  );
  const editable =
    Boolean(params.configForm) && agentIndex >= 0 && !params.configLoading && !params.configSaving;
  const allowedSpawnAgents = asStringArray(agentSubagents?.allowAgents);
  const a2aAllowedAgents = asStringArray(toolA2A?.allow);
  const a2aEnabled = toolA2A?.enabled === true;

  const setNumber = (path: Array<string | number>, value: number | null) => {
    if (value == null) {
      params.onConfigRemove(path);
      return;
    }
    params.onConfigPatch(path, Math.max(0, Math.floor(value)));
  };
  const setArray = (path: Array<string | number>, value: string[]) => {
    if (value.length === 0) {
      params.onConfigRemove(path);
      return;
    }
    params.onConfigPatch(path, value);
  };

  return html`
    <section class="card">
      <style>
        .coordination-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          margin-top: 14px;
        }

        .coordination-card {
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          display: grid;
          gap: 12px;
          min-width: 0;
          padding: 14px;
        }

        .coordination-card--wide {
          grid-column: 1 / -1;
        }

        .coordination-card__head {
          align-items: start;
          display: flex;
          gap: 12px;
          justify-content: space-between;
        }

        .coordination-title {
          color: var(--text-strong);
          font-size: 14px;
          font-weight: 800;
        }

        .coordination-sub {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
          margin-top: 3px;
        }

        .coordination-fields {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .coordination-field {
          min-width: 0;
        }

        .coordination-field input {
          min-width: 0;
          width: 100%;
        }

        .coordination-agent-picks {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }

        .coordination-inline {
          align-items: center;
          display: flex;
          gap: 10px;
          min-width: 0;
        }

        .coordination-inline input {
          flex: 1 1 260px;
          min-width: 0;
        }

        .coordination-status {
          color: var(--muted);
          font-size: 12px;
        }

        @media (max-width: 980px) {
          .coordination-grid,
          .coordination-fields {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">Coordination</div>
          <div class="card-sub">
            Delegation, subagent spawning, and Agent-to-Agent access for this Agent.
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm" ?disabled=${params.configLoading} @click=${params.onConfigReload}>
            Reload
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      ${
        !params.configForm
          ? html`
              <div class="callout info" style="margin-top: 12px">
                Load the gateway config to adjust coordination settings.
              </div>
            `
          : agentIndex < 0
            ? html`
                <div class="callout warn" style="margin-top: 12px">
                  This Agent is not present in the editable config yet.
                </div>
              `
            : nothing
      }

      <div class="coordination-grid">
        <div class="coordination-card coordination-card--wide">
          <div class="coordination-card__head">
            <div>
              <div class="coordination-title">Subagent Spawn Policy</div>
              <div class="coordination-sub">
                Choose which configured Agents this Agent may spawn as delegated child sessions.
              </div>
            </div>
            <span class="agent-pill">
              ${
                allowedSpawnAgents.includes("*")
                  ? "any"
                  : allowedSpawnAgents.length
                    ? `${allowedSpawnAgents.length} allowed`
                    : "none"
              }
            </span>
          </div>
          ${renderAgentChoiceButtons({
            agents: otherAgents,
            selected: allowedSpawnAgents,
            disabled: !editable,
            includeAny: true,
            testPrefix: "coordination-spawn-agent",
            onChange: (next) =>
              setArray(["agents", "list", agentIndex, "subagents", "allowAgents"], next),
          })}
        </div>

        <div class="coordination-card coordination-card--wide">
          <div class="coordination-card__head">
            <div>
              <div class="coordination-title">Subagent Limits</div>
              <div class="coordination-sub">
                Global defaults used by subagent spawning unless a runtime path overrides them.
              </div>
            </div>
            <span class="agent-pill">defaults</span>
          </div>
          <div class="coordination-fields">
            ${renderNumberField({
              label: "Max concurrent",
              value: asNumber(defaultsSubagents?.maxConcurrent),
              min: 1,
              disabled: !editable,
              onChange: (value) =>
                setNumber(["agents", "defaults", "subagents", "maxConcurrent"], value),
            })}
            ${renderNumberField({
              label: "Max spawn depth",
              value: asNumber(defaultsSubagents?.maxSpawnDepth),
              min: 1,
              max: 5,
              disabled: !editable,
              onChange: (value) =>
                setNumber(["agents", "defaults", "subagents", "maxSpawnDepth"], value),
            })}
            ${renderNumberField({
              label: "Max children",
              value: asNumber(defaultsSubagents?.maxChildrenPerAgent),
              min: 1,
              disabled: !editable,
              onChange: (value) =>
                setNumber(["agents", "defaults", "subagents", "maxChildrenPerAgent"], value),
            })}
            ${renderNumberField({
              label: "Archive after min",
              value: asNumber(defaultsSubagents?.archiveAfterMinutes),
              min: 1,
              disabled: !editable,
              onChange: (value) =>
                setNumber(["agents", "defaults", "subagents", "archiveAfterMinutes"], value),
            })}
            ${renderNumberField({
              label: "Run timeout sec",
              value: asNumber(defaultsSubagents?.runTimeoutSeconds),
              min: 0,
              disabled: !editable,
              onChange: (value) =>
                setNumber(["agents", "defaults", "subagents", "runTimeoutSeconds"], value),
            })}
            ${renderNumberField({
              label: "Announce timeout ms",
              value: asNumber(defaultsSubagents?.announceTimeoutMs),
              min: 1,
              disabled: !editable,
              onChange: (value) =>
                setNumber(["agents", "defaults", "subagents", "announceTimeoutMs"], value),
            })}
          </div>
        </div>

        <div class="coordination-card">
          <div class="coordination-card__head">
            <div>
              <div class="coordination-title">Agent-to-Agent Access</div>
              <div class="coordination-sub">
                Allow session tools to list, inspect, or send across configured Agents.
              </div>
            </div>
            <label class="cfg-toggle" title="Enable Agent-to-Agent access">
              <input
                type="checkbox"
                .checked=${a2aEnabled}
                ?disabled=${!editable}
                @change=${(event: Event) =>
                  params.onConfigPatch(
                    ["tools", "agentToAgent", "enabled"],
                    (event.target as HTMLInputElement).checked,
                  )}
              />
              <span class="cfg-toggle__track"></span>
            </label>
          </div>
          <div class="coordination-status">
            ${a2aEnabled ? "Enabled" : "Disabled"} · ${
              a2aAllowedAgents.length ? csv(a2aAllowedAgents) : "no allowlist"
            }
          </div>
        </div>

        <div class="coordination-card">
          <div>
            <div class="coordination-title">Loop Guard</div>
            <div class="coordination-sub">
              Maximum reply-back turns between requester and target Agent.
            </div>
          </div>
          ${renderNumberField({
            label: "Ping-pong turns",
            value: asNumber(sessionA2A?.maxPingPongTurns),
            min: 0,
            max: 5,
            disabled: !editable,
            onChange: (value) => setNumber(["session", "agentToAgent", "maxPingPongTurns"], value),
          })}
        </div>

        <div class="coordination-card coordination-card--wide">
          <div>
            <div class="coordination-title">Agent-to-Agent Allowlist</div>
            <div class="coordination-sub">
              Optional global target allowlist for Agent-to-Agent tools.
            </div>
          </div>
          ${renderAgentChoiceButtons({
            agents: params.agentsList?.agents ?? [],
            selected: a2aAllowedAgents,
            disabled: !editable || !a2aEnabled,
            includeAny: false,
            testPrefix: "coordination-a2a-agent",
            onChange: (next) => setArray(["tools", "agentToAgent", "allow"], next),
          })}
          <div class="coordination-inline">
            <span class="coordination-status">Manual IDs</span>
            <input
              type="text"
              .value=${csv(a2aAllowedAgents)}
              ?disabled=${!editable || !a2aEnabled}
              @change=${(event: Event) =>
                setArray(
                  ["tools", "agentToAgent", "allow"],
                  parseCsv((event.target as HTMLInputElement).value),
                )}
            />
          </div>
        </div>
      </div>
    </section>
  `;
}
