import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  ExecApprovalsAllowlistEntry,
  ExecApprovalsFile,
} from "../controllers/exec-approvals.ts";
import { clampText, formatRelativeTimestamp } from "../format.ts";
import {
  resolveConfigAgents as resolveSharedConfigAgents,
  resolveNodeTargets,
  type NodeTargetOption,
} from "./nodes-shared.ts";
import type { NodesProps } from "./nodes.ts";

type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";
type ExecApprovalForwardingMode = "session" | "targets" | "both";

type ExecApprovalsResolvedDefaults = {
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ExecSecurity;
  autoAllowSkills: boolean;
};

type ExecApprovalsAgentOption = {
  id: string;
  name?: string;
  isDefault?: boolean;
};

type ExecApprovalsTargetNode = NodeTargetOption;

type ExecApprovalForwardTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
};

type ExecApprovalForwardingState = {
  ready: boolean;
  disabled: boolean;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  formMode: "form" | "raw";
  enabled: boolean;
  mode: ExecApprovalForwardingMode;
  agentFilter: string[];
  sessionFilter: string[];
  targets: ExecApprovalForwardTarget[];
  onLoadConfig: () => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove: (path: Array<string | number>) => void;
  onSave: () => void;
};

type ExecApprovalsState = {
  ready: boolean;
  disabled: boolean;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  form: ExecApprovalsFile | null;
  defaults: ExecApprovalsResolvedDefaults;
  selectedScope: string;
  selectedAgent: Record<string, unknown> | null;
  agents: ExecApprovalsAgentOption[];
  allowlist: ExecApprovalsAllowlistEntry[];
  target: "gateway" | "node";
  targetNodeId: string | null;
  targetNodes: ExecApprovalsTargetNode[];
  forwarding: ExecApprovalForwardingState;
  onSelectScope: (agentId: string) => void;
  onSelectTarget: (kind: "gateway" | "node", nodeId: string | null) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove: (path: Array<string | number>) => void;
  onLoad: () => void;
  onSave: () => void;
};

const EXEC_APPROVALS_DEFAULT_SCOPE = "__defaults__";

const SECURITY_OPTIONS: Array<{ value: ExecSecurity; label: string }> = [
  { value: "deny", label: "Deny" },
  { value: "allowlist", label: "Allowlist" },
  { value: "full", label: "Full" },
];

const ASK_OPTIONS: Array<{ value: ExecAsk; label: string }> = [
  { value: "off", label: "Off" },
  { value: "on-miss", label: "On miss" },
  { value: "always", label: "Always" },
];

const FORWARDING_MODE_OPTIONS: Array<{ value: ExecApprovalForwardingMode; label: string }> = [
  { value: "session", label: "Origin session" },
  { value: "targets", label: "Fixed targets" },
  { value: "both", label: "Session and targets" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function readBoolean(root: unknown, path: ReadonlyArray<string | number>): boolean {
  const value = readPath(root, path);
  return typeof value === "boolean" ? value : false;
}

function readStringArray(root: unknown, path: ReadonlyArray<string | number>): string[] {
  const value = readPath(root, path);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function normalizeForwardingMode(value: unknown): ExecApprovalForwardingMode {
  if (value === "targets" || value === "both" || value === "session") {
    return value;
  }
  return "session";
}

function parseCsvList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function readForwardTargets(root: unknown): ExecApprovalForwardTarget[] {
  const rawTargets = readPath(root, ["approvals", "exec", "targets"]);
  if (!Array.isArray(rawTargets)) {
    return [];
  }
  return rawTargets
    .map((entry) => {
      const record = asRecord(entry);
      const channel = typeof record.channel === "string" ? record.channel.trim() : "";
      const to = typeof record.to === "string" ? record.to.trim() : "";
      if (!channel && !to) {
        return null;
      }
      const accountId = typeof record.accountId === "string" ? record.accountId.trim() : "";
      const threadId =
        typeof record.threadId === "string" || typeof record.threadId === "number"
          ? record.threadId
          : undefined;
      return {
        channel,
        to,
        ...(accountId ? { accountId } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
      };
    })
    .filter((entry): entry is ExecApprovalForwardTarget => Boolean(entry));
}

function normalizeSecurity(value?: string): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") {
    return value;
  }
  return "deny";
}

function normalizeAsk(value?: string): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") {
    return value;
  }
  return "on-miss";
}

function resolveExecApprovalsDefaults(
  form: ExecApprovalsFile | null,
): ExecApprovalsResolvedDefaults {
  const defaults = form?.defaults ?? {};
  return {
    security: normalizeSecurity(defaults.security),
    ask: normalizeAsk(defaults.ask),
    askFallback: normalizeSecurity(defaults.askFallback ?? "deny"),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? false),
  };
}

function resolveExecApprovalForwardingState(props: NodesProps): ExecApprovalForwardingState {
  const config = props.configForm;
  return {
    ready: Boolean(config),
    disabled: props.configSaving || props.configFormMode === "raw" || !config,
    dirty: props.configDirty,
    loading: props.configLoading,
    saving: props.configSaving,
    formMode: props.configFormMode,
    enabled: readBoolean(config, ["approvals", "exec", "enabled"]),
    mode: normalizeForwardingMode(readPath(config, ["approvals", "exec", "mode"])),
    agentFilter: readStringArray(config, ["approvals", "exec", "agentFilter"]),
    sessionFilter: readStringArray(config, ["approvals", "exec", "sessionFilter"]),
    targets: readForwardTargets(config),
    onLoadConfig: props.onLoadConfig,
    onPatch: props.onConfigPatch,
    onRemove: props.onConfigRemove,
    onSave: props.onSaveConfig,
  };
}

function resolveConfigAgents(config: Record<string, unknown> | null): ExecApprovalsAgentOption[] {
  return resolveSharedConfigAgents(config).map((entry) => ({
    id: entry.id,
    name: entry.name,
    isDefault: entry.isDefault,
  }));
}

function resolveExecApprovalsAgents(
  config: Record<string, unknown> | null,
  form: ExecApprovalsFile | null,
): ExecApprovalsAgentOption[] {
  const configAgents = resolveConfigAgents(config);
  const approvalsAgents = Object.keys(form?.agents ?? {});
  const merged = new Map<string, ExecApprovalsAgentOption>();
  configAgents.forEach((agent) => merged.set(agent.id, agent));
  approvalsAgents.forEach((id) => {
    if (merged.has(id)) {
      return;
    }
    merged.set(id, { id });
  });
  const agents = Array.from(merged.values());
  if (agents.length === 0) {
    agents.push({ id: "main", isDefault: true });
  }
  agents.sort((a, b) => {
    if (a.isDefault && !b.isDefault) {
      return -1;
    }
    if (!a.isDefault && b.isDefault) {
      return 1;
    }
    const aLabel = a.name?.trim() ? a.name : a.id;
    const bLabel = b.name?.trim() ? b.name : b.id;
    return aLabel.localeCompare(bLabel);
  });
  return agents;
}

function resolveExecApprovalsScope(
  selected: string | null,
  agents: ExecApprovalsAgentOption[],
): string {
  if (selected === EXEC_APPROVALS_DEFAULT_SCOPE) {
    return EXEC_APPROVALS_DEFAULT_SCOPE;
  }
  if (selected && agents.some((agent) => agent.id === selected)) {
    return selected;
  }
  return EXEC_APPROVALS_DEFAULT_SCOPE;
}

export function resolveExecApprovalsState(props: NodesProps): ExecApprovalsState {
  const form = props.execApprovalsForm ?? props.execApprovalsSnapshot?.file ?? null;
  const ready = Boolean(form);
  const defaults = resolveExecApprovalsDefaults(form);
  const agents = resolveExecApprovalsAgents(props.configForm, form);
  const targetNodes = resolveExecApprovalsNodes(props.nodes);
  const target = props.execApprovalsTarget;
  let targetNodeId =
    target === "node" && props.execApprovalsTargetNodeId ? props.execApprovalsTargetNodeId : null;
  if (target === "node" && targetNodeId && !targetNodes.some((node) => node.id === targetNodeId)) {
    targetNodeId = null;
  }
  const selectedScope = resolveExecApprovalsScope(props.execApprovalsSelectedAgent, agents);
  const selectedAgent =
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
      ? (((form?.agents ?? {})[selectedScope] as Record<string, unknown> | undefined) ?? null)
      : null;
  const allowlist = Array.isArray((selectedAgent as { allowlist?: unknown })?.allowlist)
    ? ((selectedAgent as { allowlist?: ExecApprovalsAllowlistEntry[] }).allowlist ?? [])
    : [];
  return {
    ready,
    disabled: props.execApprovalsSaving || props.execApprovalsLoading,
    dirty: props.execApprovalsDirty,
    loading: props.execApprovalsLoading,
    saving: props.execApprovalsSaving,
    form,
    defaults,
    selectedScope,
    selectedAgent,
    agents,
    allowlist,
    target,
    targetNodeId,
    targetNodes,
    forwarding: resolveExecApprovalForwardingState(props),
    onSelectScope: props.onExecApprovalsSelectAgent,
    onSelectTarget: props.onExecApprovalsTargetChange,
    onPatch: props.onExecApprovalsPatch,
    onRemove: props.onExecApprovalsRemove,
    onLoad: props.onLoadExecApprovals,
    onSave: props.onSaveExecApprovals,
  };
}

export function renderExecApprovals(state: ExecApprovalsState) {
  const ready = state.ready;
  const targetReady = state.target !== "node" || Boolean(state.targetNodeId);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Exec approvals</div>
          <div class="card-sub">
            Allowlist and approval policy for <span class="mono">exec host=gateway/node</span>.
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.dirty || !targetReady}
          @click=${state.onSave}
        >
          ${state.saving ? "Saving…" : "Save"}
        </button>
      </div>

      ${renderExecApprovalsTarget(state)}
      ${renderExecApprovalForwarding(state.forwarding)}
      ${
        !ready
          ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">Load exec approvals to edit allowlists.</div>
            <button class="btn" ?disabled=${state.loading || !targetReady} @click=${state.onLoad}>
              ${state.loading ? t("common.loading") : t("common.loadApprovals")}
            </button>
          </div>`
          : html`
            ${renderExecApprovalsTabs(state)} ${renderExecApprovalsPolicy(state)}
            ${
              state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE
                ? nothing
                : renderExecApprovalsAllowlist(state)
            }
          `
      }
    </section>
  `;
}

function renderExecApprovalForwarding(state: ExecApprovalForwardingState) {
  const modeNeedsTargets = state.mode === "targets" || state.mode === "both";
  const saveDisabled = state.disabled || !state.dirty;
  return html`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Prompt forwarding</div>
          <div class="list-sub">
            Optional delivery of exec approval prompts to the origin chat session or fixed channel
            targets. This does not change host security, ask policy, or allowlists.
          </div>
        </div>
        <div class="list-meta">
          <span class="agent-pill">${state.enabled ? "forwarding on" : "forwarding off"}</span>
          <button class="btn btn--sm" ?disabled=${saveDisabled} @click=${state.onSave}>
            ${state.saving ? "Saving…" : "Save forwarding"}
          </button>
        </div>
      </div>

      ${
        state.formMode === "raw"
          ? html`
              <div class="callout warn">
                Switch Advanced Config back to form mode before editing approval forwarding here.
              </div>
            `
          : !state.ready
            ? html`<div class="list-item">
              <div class="list-main">
                <div class="list-title">Config not loaded</div>
                <div class="list-sub">Load config to edit approval forwarding.</div>
              </div>
              <div class="list-meta">
                <button class="btn btn--sm" ?disabled=${state.loading} @click=${state.onLoadConfig}>
                  ${state.loading ? t("common.loading") : t("common.loadConfig")}
                </button>
              </div>
            </div>`
            : html`
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">Delivery</div>
                  <div class="list-sub">Forward only when approval prompts are created.</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>Enabled</span>
                    <input
                      type="checkbox"
                      ?disabled=${state.disabled}
                      .checked=${state.enabled}
                      @change=${(event: Event) =>
                        state.onPatch(
                          ["approvals", "exec", "enabled"],
                          (event.target as HTMLInputElement).checked,
                        )}
                    />
                  </label>
                  <label class="field">
                    <span>Mode</span>
                    <select
                      ?disabled=${state.disabled}
                      @change=${(event: Event) =>
                        state.onPatch(
                          ["approvals", "exec", "mode"],
                          (event.target as HTMLSelectElement).value,
                        )}
                    >
                      ${FORWARDING_MODE_OPTIONS.map(
                        (option) => html`
                          <option value=${option.value} ?selected=${state.mode === option.value}>
                            ${option.label}
                          </option>
                        `,
                      )}
                    </select>
                  </label>
                </div>
              </div>

              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">Filters</div>
                  <div class="list-sub">Comma-separated Agent IDs or session patterns. Blank means all.</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>Agents</span>
                    <input
                      type="text"
                      .value=${state.agentFilter.join(", ")}
                      placeholder="main, research"
                      ?disabled=${state.disabled}
                      @input=${(event: Event) => {
                        const next = parseCsvList((event.target as HTMLInputElement).value);
                        if (next.length === 0) {
                          state.onRemove(["approvals", "exec", "agentFilter"]);
                        } else {
                          state.onPatch(["approvals", "exec", "agentFilter"], next);
                        }
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Sessions</span>
                    <input
                      type="text"
                      .value=${state.sessionFilter.join(", ")}
                      placeholder="telegram:, ^agent:main:"
                      ?disabled=${state.disabled}
                      @input=${(event: Event) => {
                        const next = parseCsvList((event.target as HTMLInputElement).value);
                        if (next.length === 0) {
                          state.onRemove(["approvals", "exec", "sessionFilter"]);
                        } else {
                          state.onPatch(["approvals", "exec", "sessionFilter"], next);
                        }
                      }}
                    />
                  </label>
                </div>
              </div>

              ${
                modeNeedsTargets
                  ? html`
                    <div class="row" style="justify-content: space-between; margin-top: 4px;">
                      <div>
                        <div class="list-title">Fixed targets</div>
                        <div class="list-sub">Channel destinations for approval prompts.</div>
                      </div>
                      <button
                        class="btn btn--sm"
                        ?disabled=${state.disabled}
                        @click=${() =>
                          state.onPatch(
                            ["approvals", "exec", "targets"],
                            [...state.targets, { channel: "", to: "" }],
                          )}
                      >
                        Add target
                      </button>
                    </div>
                    ${
                      state.targets.length === 0
                        ? html`
                            <div class="muted">No fixed approval targets.</div>
                          `
                        : state.targets.map((target, index) =>
                            renderExecApprovalForwardTarget(state, target, index),
                          )
                    }
                  `
                  : nothing
              }
            `
      }
    </div>
  `;
}

function renderExecApprovalForwardTarget(
  state: ExecApprovalForwardingState,
  target: ExecApprovalForwardTarget,
  index: number,
) {
  const basePath = ["approvals", "exec", "targets", index];
  const removeTarget = () => {
    if (state.targets.length <= 1) {
      state.onRemove(["approvals", "exec", "targets"]);
      return;
    }
    state.onRemove(basePath);
  };
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${target.channel || "New target"}</div>
        <div class="list-sub">${target.to || "destination required"}</div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Channel</span>
          <input
            type="text"
            .value=${target.channel}
            placeholder="telegram"
            ?disabled=${state.disabled}
            @input=${(event: Event) =>
              state.onPatch([...basePath, "channel"], (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>To</span>
          <input
            type="text"
            .value=${target.to}
            placeholder="chat/user/channel ID"
            ?disabled=${state.disabled}
            @input=${(event: Event) =>
              state.onPatch([...basePath, "to"], (event.target as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Account</span>
          <input
            type="text"
            .value=${target.accountId ?? ""}
            placeholder="default"
            ?disabled=${state.disabled}
            @input=${(event: Event) => {
              const next = (event.target as HTMLInputElement).value.trim();
              if (next) {
                state.onPatch([...basePath, "accountId"], next);
              } else {
                state.onRemove([...basePath, "accountId"]);
              }
            }}
          />
        </label>
        <label class="field">
          <span>Thread</span>
          <input
            type="text"
            .value=${target.threadId == null ? "" : String(target.threadId)}
            placeholder="optional"
            ?disabled=${state.disabled}
            @input=${(event: Event) => {
              const next = (event.target as HTMLInputElement).value.trim();
              if (next) {
                state.onPatch([...basePath, "threadId"], next);
              } else {
                state.onRemove([...basePath, "threadId"]);
              }
            }}
          />
        </label>
        <button class="btn btn--sm danger" ?disabled=${state.disabled} @click=${removeTarget}>
          Remove
        </button>
      </div>
    </div>
  `;
}

function renderExecApprovalsTarget(state: ExecApprovalsState) {
  const hasNodes = state.targetNodes.length > 0;
  const nodeValue = state.targetNodeId ?? "";
  return html`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Target</div>
          <div class="list-sub">Gateway edits local approvals; node edits the selected node.</div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Host</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (value === "node") {
                  const first = state.targetNodes[0]?.id ?? null;
                  state.onSelectTarget("node", nodeValue || first);
                } else {
                  state.onSelectTarget("gateway", null);
                }
              }}
            >
              <option value="gateway" ?selected=${state.target === "gateway"}>Gateway</option>
              <option value="node" ?selected=${state.target === "node"}>Node</option>
            </select>
          </label>
          ${
            state.target === "node"
              ? html`
                <label class="field">
                  <span>Node</span>
                  <select
                    ?disabled=${state.disabled || !hasNodes}
                    @change=${(event: Event) => {
                      const target = event.target as HTMLSelectElement;
                      const value = target.value.trim();
                      state.onSelectTarget("node", value ? value : null);
                    }}
                  >
                    <option value="" ?selected=${nodeValue === ""}>Select node</option>
                    ${state.targetNodes.map(
                      (node) =>
                        html`<option value=${node.id} ?selected=${nodeValue === node.id}>
                          ${node.label}
                        </option>`,
                    )}
                  </select>
                </label>
              `
              : nothing
          }
        </div>
      </div>
      ${
        state.target === "node" && !hasNodes
          ? html`
              <div class="muted">No nodes advertise exec approvals yet.</div>
            `
          : nothing
      }
    </div>
  `;
}

function renderExecApprovalsTabs(state: ExecApprovalsState) {
  return html`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">Scope</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${
            state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE ? "active" : ""
          }"
          @click=${() => state.onSelectScope(EXEC_APPROVALS_DEFAULT_SCOPE)}
        >
          Defaults
        </button>
        ${state.agents.map((agent) => {
          const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
          return html`
            <button
              class="btn btn--sm ${state.selectedScope === agent.id ? "active" : ""}"
              @click=${() => state.onSelectScope(agent.id)}
            >
              ${label}
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

function renderExecApprovalsPolicy(state: ExecApprovalsState) {
  const isDefaults = state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE;
  const defaults = state.defaults;
  const agent = state.selectedAgent ?? {};
  const basePath = isDefaults ? ["defaults"] : ["agents", state.selectedScope];
  const agentSecurity = typeof agent.security === "string" ? agent.security : undefined;
  const agentAsk = typeof agent.ask === "string" ? agent.ask : undefined;
  const agentAskFallback = typeof agent.askFallback === "string" ? agent.askFallback : undefined;
  const securityValue = isDefaults ? defaults.security : (agentSecurity ?? "__default__");
  const askValue = isDefaults ? defaults.ask : (agentAsk ?? "__default__");
  const askFallbackValue = isDefaults ? defaults.askFallback : (agentAskFallback ?? "__default__");
  const autoOverride =
    typeof agent.autoAllowSkills === "boolean" ? agent.autoAllowSkills : undefined;
  const autoEffective = autoOverride ?? defaults.autoAllowSkills;
  const autoIsDefault = autoOverride == null;

  return html`
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Security</div>
          <div class="list-sub">
            ${isDefaults ? "Default security mode." : `Default: ${defaults.security}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "security"]);
                } else {
                  state.onPatch([...basePath, "security"], value);
                }
              }}
            >
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${securityValue === "__default__"}>
                    Use default (${defaults.security})
                  </option>`
                  : nothing
              }
              ${SECURITY_OPTIONS.map(
                (option) =>
                  html`<option value=${option.value} ?selected=${securityValue === option.value}>
                    ${option.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask</div>
          <div class="list-sub">
            ${isDefaults ? "Default prompt policy." : `Default: ${defaults.ask}.`}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Mode</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "ask"]);
                } else {
                  state.onPatch([...basePath, "ask"], value);
                }
              }}
            >
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${askValue === "__default__"}>
                    Use default (${defaults.ask})
                  </option>`
                  : nothing
              }
              ${ASK_OPTIONS.map(
                (option) =>
                  html`<option value=${option.value} ?selected=${askValue === option.value}>
                    ${option.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Ask fallback</div>
          <div class="list-sub">
            ${
              isDefaults
                ? "Applied when the UI prompt is unavailable."
                : `Default: ${defaults.askFallback}.`
            }
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Fallback</span>
            <select
              ?disabled=${state.disabled}
              @change=${(event: Event) => {
                const target = event.target as HTMLSelectElement;
                const value = target.value;
                if (!isDefaults && value === "__default__") {
                  state.onRemove([...basePath, "askFallback"]);
                } else {
                  state.onPatch([...basePath, "askFallback"], value);
                }
              }}
            >
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${askFallbackValue === "__default__"}>
                    Use default (${defaults.askFallback})
                  </option>`
                  : nothing
              }
              ${SECURITY_OPTIONS.map(
                (option) =>
                  html`<option value=${option.value} ?selected=${askFallbackValue === option.value}>
                    ${option.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">Auto-allow skill CLIs</div>
          <div class="list-sub">
            ${
              isDefaults
                ? "Allow skill executables listed by the Gateway."
                : autoIsDefault
                  ? `Using default (${defaults.autoAllowSkills ? "on" : "off"}).`
                  : `Override (${autoEffective ? "on" : "off"}).`
            }
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>Enabled</span>
            <input
              type="checkbox"
              ?disabled=${state.disabled}
              .checked=${autoEffective}
              @change=${(event: Event) => {
                const target = event.target as HTMLInputElement;
                state.onPatch([...basePath, "autoAllowSkills"], target.checked);
              }}
            />
          </label>
          ${
            !isDefaults && !autoIsDefault
              ? html`<button
                class="btn btn--sm"
                ?disabled=${state.disabled}
                @click=${() => state.onRemove([...basePath, "autoAllowSkills"])}
              >
                Use default
              </button>`
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

function renderExecApprovalsAllowlist(state: ExecApprovalsState) {
  const allowlistPath = ["agents", state.selectedScope, "allowlist"];
  const entries = state.allowlist;
  return html`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">Allowlist</div>
        <div class="card-sub">Case-insensitive glob patterns.</div>
      </div>
      <button
        class="btn btn--sm"
        ?disabled=${state.disabled}
        @click=${() => {
          const next = [...entries, { pattern: "" }];
          state.onPatch(allowlistPath, next);
        }}
      >
        Add pattern
      </button>
    </div>
    <div class="list" style="margin-top: 12px;">
      ${
        entries.length === 0
          ? html`
              <div class="muted">No allowlist entries yet.</div>
            `
          : entries.map((entry, index) => renderAllowlistEntry(state, entry, index))
      }
    </div>
  `;
}

function renderAllowlistEntry(
  state: ExecApprovalsState,
  entry: ExecApprovalsAllowlistEntry,
  index: number,
) {
  const lastUsed = entry.lastUsedAt ? formatRelativeTimestamp(entry.lastUsedAt) : "never";
  const lastCommand = entry.lastUsedCommand ? clampText(entry.lastUsedCommand, 120) : null;
  const lastPath = entry.lastResolvedPath ? clampText(entry.lastResolvedPath, 120) : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.pattern?.trim() ? entry.pattern : "New pattern"}</div>
        <div class="list-sub">Last used: ${lastUsed}</div>
        ${lastCommand ? html`<div class="list-sub mono">${lastCommand}</div>` : nothing}
        ${lastPath ? html`<div class="list-sub mono">${lastPath}</div>` : nothing}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${entry.pattern ?? ""}
            ?disabled=${state.disabled}
            @input=${(event: Event) => {
              const target = event.target as HTMLInputElement;
              state.onPatch(
                ["agents", state.selectedScope, "allowlist", index, "pattern"],
                target.value,
              );
            }}
          />
        </label>
        <button
          class="btn btn--sm danger"
          ?disabled=${state.disabled}
          @click=${() => {
            if (state.allowlist.length <= 1) {
              state.onRemove(["agents", state.selectedScope, "allowlist"]);
              return;
            }
            state.onRemove(["agents", state.selectedScope, "allowlist", index]);
          }}
        >
          Remove
        </button>
      </div>
    </div>
  `;
}

function resolveExecApprovalsNodes(
  nodes: Array<Record<string, unknown>>,
): ExecApprovalsTargetNode[] {
  return resolveNodeTargets(nodes, ["system.execApprovals.get", "system.execApprovals.set"]);
}
