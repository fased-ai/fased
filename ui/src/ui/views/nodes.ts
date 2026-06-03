import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { CommandsCatalogScope } from "../controllers/commands.ts";
import type {
  DevicePairingList,
  DeviceTokenSummary,
  PairedDevice,
  PendingDevice,
} from "../controllers/devices.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "../controllers/exec-approvals.ts";
import { formatRelativeTimestamp, formatList } from "../format.ts";
import { icons } from "../icons.ts";
import type { CommandEntry, CommandsListResult } from "../types.ts";
import { renderExecApprovals, resolveExecApprovalsState } from "./nodes-exec-approvals.ts";
import { resolveConfigAgents, resolveNodeTargets, type NodeTargetOption } from "./nodes-shared.ts";
export type NodesProps = {
  loading: boolean;
  nodes: Array<Record<string, unknown>>;
  commandsCatalogLoading: boolean;
  commandsCatalogError: string | null;
  commandsCatalog: CommandsListResult | null;
  commandsCatalogScope: CommandsCatalogScope;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  configFormMode: "form" | "raw";
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  onRefresh: () => void;
  onCommandsRefresh: () => void;
  onCommandsScopeChange: (scope: CommandsCatalogScope) => void;
  onDevicesRefresh: () => void;
  onDeviceApprove: (requestId: string) => void;
  onDeviceReject: (requestId: string) => void;
  onDeviceRotate: (deviceId: string, role: string, scopes?: string[]) => void;
  onDeviceRevoke: (deviceId: string, role: string) => void;
  onLoadConfig: () => void;
  onLoadExecApprovals: () => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onSaveConfig: () => void;
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSaveBindings: () => void;
  onExecApprovalsTargetChange: (kind: "gateway" | "node", nodeId: string | null) => void;
  onExecApprovalsSelectAgent: (agentId: string) => void;
  onExecApprovalsPatch: (path: Array<string | number>, value: unknown) => void;
  onExecApprovalsRemove: (path: Array<string | number>) => void;
  onSaveExecApprovals: () => void;
};

export function renderNodes(props: NodesProps) {
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);
  return html`
    <section class="surface-stack">
      ${renderNodesOverview(props)}
      <div class="surface-grid">
        ${renderDevices(props)}
        ${renderLiveNodes(props)}
      </div>
      <details class="nodes-advanced-section">
        <summary class="node-section-summary">
          <span>
            <span class="card-title">Remote Execution</span>
            <span class="card-sub">Approvals, Agent bindings, and guarded system.run routing.</span>
          </span>
        </summary>
        <div class="surface-grid" style="margin-top: 16px;">
          ${renderExecApprovals(approvalsState)} ${renderBindings(bindingState)}
        </div>
      </details>
      <details class="nodes-advanced-section">
        <summary class="node-section-summary">
          <span>
            <span class="card-title">Gateway Node Settings</span>
            <span class="card-sub">Discovery, Canvas host, and command catalog details.</span>
          </span>
        </summary>
        <div class="surface-grid" style="margin-top: 16px;">
          ${renderDiscoveryControls(props)} ${renderCanvasHostControls(props)}
          ${renderCommandCatalog(props)}
        </div>
      </details>
    </section>
  `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readConfigPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function stringConfigValue(root: unknown, path: ReadonlyArray<string | number>): string {
  const value = readConfigPath(root, path);
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function toggleConfigValue(root: unknown, path: ReadonlyArray<string | number>): "" | "on" | "off" {
  const value = readConfigPath(root, path);
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  return "";
}

function patchStringOrRemove(props: NodesProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (next) {
    props.onConfigPatch(path, next);
  } else {
    props.onConfigRemove(path);
  }
}

function patchToggle(props: NodesProps, path: Array<string | number>, value: "" | "on" | "off") {
  if (!value) {
    props.onConfigRemove(path);
    return;
  }
  props.onConfigPatch(path, value === "on");
}

function patchPositiveIntegerOrRemove(
  props: NodesProps,
  path: Array<string | number>,
  value: string,
) {
  const next = value.trim();
  if (!next) {
    props.onConfigRemove(path);
    return;
  }
  const parsed = Number.parseInt(next, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    props.onConfigPatch(path, parsed);
  }
}

function renderNodesOverview(props: NodesProps) {
  const summary = summarizeRuntimeNodes(props);
  const hasPending = summary.pendingDevices > 0;
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 16px; align-items: flex-start;">
        <div>
          <div class="card-title">Nodes</div>
          <div class="card-sub">
            Pair local devices or host nodes so Agents can use approved camera, screen, browser,
            canvas, notification, location, or command-execution capabilities.
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
          <button class="btn" ?disabled=${props.devicesLoading} @click=${props.onDevicesRefresh}>
            ${props.devicesLoading ? t("common.loading") : "Pair Devices"}
          </button>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
      </div>
      <div class="nodes-counter-grid">
        <div class="nodes-counter-card">
          <div class="nodes-counter-title">Nodes</div>
          <div class="nodes-mini-grid">
            ${renderNodeMiniMetric(summary.connectedNodes, "connected")}
            ${renderNodeMiniMetric(summary.totalNodes, "live")}
            ${renderNodeMiniMetric(summary.pairedNodes, "paired")}
            ${renderNodeMiniMetric(summary.systemRunCapable, "exec")}
          </div>
        </div>
        <div class="nodes-counter-card">
          <div class="nodes-counter-title">Runtime</div>
          <div class="nodes-mini-grid">
            ${renderNodeMiniMetric(summary.pairedDevices, "devices")}
            ${renderNodeMiniMetric(summary.pendingDevices, "pending")}
            ${renderNodeMiniMetric(summary.activeTokens, "tokens")}
            ${renderNodeMiniMetric(summary.commandCatalogCount, "commands")}
          </div>
        </div>
      </div>
      <div class="chip-row" style="margin-top: 12px;">
        <span class="chip ${summary.connectedNodes > 0 ? "chip-ok" : "chip-warn"}">
          ${summary.connectedNodes}/${summary.totalNodes} live nodes
        </span>
        <span class="chip ${hasPending ? "chip-warn" : "chip-ok"}">
          ${hasPending ? `${summary.pendingDevices} pending approval` : "no pending approvals"}
        </span>
        <span class="chip">${summary.commandCatalogCount} gateway commands</span>
        <span class="chip">${summary.activeTokens} active tokens</span>
      </div>
    </section>
  `;
}

function renderNodeMiniMetric(value: number, label: string) {
  return html`
    <div class="nodes-mini-tile">
      <div class="nodes-mini-value">${value}</div>
      <div class="nodes-mini-label">${label}</div>
    </div>
  `;
}

function renderDiscoveryControls(props: NodesProps) {
  const config = props.configForm;
  const disabled = props.configSaving || props.configFormMode === "raw" || !config;
  const mdnsMode = stringConfigValue(config, ["discovery", "mdns", "mode"]);
  const wideAreaEnabled = toggleConfigValue(config, ["discovery", "wideArea", "enabled"]);
  const wideAreaDomain = stringConfigValue(config, ["discovery", "wideArea", "domain"]);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">Gateway Discovery</div>
          <div class="card-sub">
            mDNS and wide-area DNS-SD advertising for finding this gateway from other machines.
          </div>
        </div>
        <button
          class="btn"
          data-test-id="node-discovery-save"
          ?disabled=${props.configSaving || !props.configDirty}
          @click=${props.onSaveConfig}
        >
          ${props.configSaving ? t("common.saving") : t("common.save")}
        </button>
      </div>
      ${
        props.configFormMode === "raw"
          ? html`
              <div class="callout warn" style="margin-top: 12px">
                Switch Advanced Config back to Form mode before editing discovery controls here.
              </div>
            `
          : nothing
      }
      ${
        !config
          ? html`
              <div class="row" style="margin-top: 12px; gap: 12px;">
                <div class="muted">Load config to edit gateway discovery.</div>
                <button class="btn" ?disabled=${props.configLoading} @click=${props.onLoadConfig}>
                  ${props.configLoading ? t("common.loading") : t("common.loadConfig")}
                </button>
              </div>
            `
          : html`
              <div
                class="node-discovery-grid"
                style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 16px;"
              >
                <label class="field">
                  <span>mDNS mode</span>
                  <select
                    aria-label="mDNS discovery mode"
                    .value=${mdnsMode}
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchStringOrRemove(
                        props,
                        ["discovery", "mdns", "mode"],
                        (event.target as HTMLSelectElement).value,
                      )}
                  >
                    <option value="">Default</option>
                    <option value="minimal">Minimal</option>
                    <option value="off">Off</option>
                    <option value="full">Full</option>
                  </select>
                </label>
                <label class="field">
                  <span>Wide-area</span>
                  <select
                    aria-label="Wide-area discovery"
                    .value=${wideAreaEnabled}
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchToggle(
                        props,
                        ["discovery", "wideArea", "enabled"],
                        (event.target as HTMLSelectElement).value as "" | "on" | "off",
                      )}
                  >
                    <option value="">Default</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <label class="field">
                  <span>Wide-area domain</span>
                  <input
                    aria-label="Wide-area discovery domain"
                    .value=${wideAreaDomain}
                    placeholder="fased.internal"
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchStringOrRemove(
                        props,
                        ["discovery", "wideArea", "domain"],
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
              </div>
            `
      }
    </section>
  `;
}

function renderCanvasHostControls(props: NodesProps) {
  const config = props.configForm;
  const disabled = props.configSaving || props.configFormMode === "raw" || !config;
  const enabled = toggleConfigValue(config, ["canvasHost", "enabled"]);
  const root = stringConfigValue(config, ["canvasHost", "root"]);
  const port = stringConfigValue(config, ["canvasHost", "port"]);
  const liveReload = toggleConfigValue(config, ["canvasHost", "liveReload"]);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">Node Canvas Host</div>
          <div class="card-sub">
            Runtime host for node canvas presentation, snapshots, A2UI, and mobile display surfaces.
          </div>
        </div>
        <button
          class="btn"
          data-test-id="node-canvas-host-save"
          ?disabled=${props.configSaving || !props.configDirty}
          @click=${props.onSaveConfig}
        >
          ${props.configSaving ? t("common.saving") : t("common.save")}
        </button>
      </div>
      ${
        props.configFormMode === "raw"
          ? html`
              <div class="callout warn" style="margin-top: 12px">
                Switch Advanced Config back to Form mode before editing canvas host controls here.
              </div>
            `
          : nothing
      }
      ${
        !config
          ? html`
              <div class="row" style="margin-top: 12px; gap: 12px;">
                <div class="muted">Load config to edit node canvas host settings.</div>
                <button class="btn" ?disabled=${props.configLoading} @click=${props.onLoadConfig}>
                  ${props.configLoading ? t("common.loading") : t("common.loadConfig")}
                </button>
              </div>
            `
          : html`
              <div
                class="node-discovery-grid"
                style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 16px;"
              >
                <label class="field">
                  <span>Canvas host</span>
                  <select
                    aria-label="Canvas host enabled"
                    .value=${enabled}
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchToggle(
                        props,
                        ["canvasHost", "enabled"],
                        (event.target as HTMLSelectElement).value as "" | "on" | "off",
                      )}
                  >
                    <option value="">Default</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <label class="field">
                  <span>Root</span>
                  <input
                    aria-label="Canvas host root"
                    .value=${root}
                    placeholder="~/.fased/workspace/canvas"
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchStringOrRemove(
                        props,
                        ["canvasHost", "root"],
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
                <label class="field">
                  <span>Port</span>
                  <input
                    aria-label="Canvas host port"
                    type="number"
                    min="1"
                    .value=${port}
                    placeholder="derived"
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchPositiveIntegerOrRemove(
                        props,
                        ["canvasHost", "port"],
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
                <label class="field">
                  <span>Live reload</span>
                  <select
                    aria-label="Canvas host live reload"
                    .value=${liveReload}
                    ?disabled=${disabled}
                    @change=${(event: Event) =>
                      patchToggle(
                        props,
                        ["canvasHost", "liveReload"],
                        (event.target as HTMLSelectElement).value as "" | "on" | "off",
                      )}
                  >
                    <option value="">Default</option>
                    <option value="on">On</option>
                    <option value="off">Off</option>
                  </select>
                </label>
              </div>
              <div class="callout info" style="margin-top: 12px;">
                Canvas host changes require a gateway restart before connected nodes see the new host.
              </div>
            `
      }
    </section>
  `;
}

type CommandSource = CommandEntry["source"];

const COMMAND_SCOPE_OPTIONS: Array<{ value: CommandsCatalogScope; label: string }> = [
  { value: "both", label: "All" },
  { value: "text", label: "Chat" },
  { value: "native", label: "Native" },
];

function summarizeCommandSources(commands: CommandEntry[]): Record<CommandSource, number> {
  return commands.reduce<Record<CommandSource, number>>(
    (acc, command) => {
      acc[command.source] += 1;
      return acc;
    },
    { native: 0, plugin: 0, skill: 0 },
  );
}

function summarizeRuntimeNodes(props: NodesProps) {
  const nodes = props.nodes ?? [];
  const pairedDevices = props.devicesList?.paired ?? [];
  const pendingDevices = props.devicesList?.pending ?? [];
  const catalogCommands = props.commandsCatalog?.commands ?? [];
  const advertisedCommandCount = nodes.reduce((count, node) => {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    return count + commands.length;
  }, 0);
  const systemRunCapable = nodes.filter((node) => {
    const caps = Array.isArray(node.caps) ? node.caps : [];
    const commands = Array.isArray(node.commands) ? node.commands : [];
    return [...caps, ...commands].some((entry) => String(entry) === "system.run");
  }).length;
  const activeTokens = pairedDevices.reduce((count, device) => {
    const tokens = Array.isArray(device.tokens) ? device.tokens : [];
    return count + tokens.filter((token) => !token.revokedAtMs).length;
  }, 0);
  return {
    totalNodes: nodes.length,
    connectedNodes: nodes.filter((node) => Boolean(node.connected)).length,
    pairedNodes: nodes.filter((node) => Boolean(node.paired)).length,
    systemRunCapable,
    pendingDevices: pendingDevices.length,
    pairedDevices: pairedDevices.length,
    activeTokens,
    commandCatalogCount: catalogCommands.length,
    advertisedCommandCount,
  };
}

function renderCommandCatalog(props: NodesProps) {
  const commands = props.commandsCatalog?.commands ?? [];
  const counts = summarizeCommandSources(commands);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
        <div>
          <div class="card-title">Command Catalog</div>
          <div class="card-sub">Gateway command surfaces exposed to chat, skills, and plugins.</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
          <label class="field">
            <span>Scope</span>
            <select
              ?disabled=${props.commandsCatalogLoading}
              @change=${(event: Event) =>
                props.onCommandsScopeChange(
                  (event.target as HTMLSelectElement).value as CommandsCatalogScope,
                )}
            >
              ${COMMAND_SCOPE_OPTIONS.map(
                (option) => html`
                  <option value=${option.value} ?selected=${props.commandsCatalogScope === option.value}>
                    ${option.label}
                  </option>
                `,
              )}
            </select>
          </label>
          <button class="btn" ?disabled=${props.commandsCatalogLoading} @click=${props.onCommandsRefresh}>
            ${props.commandsCatalogLoading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
      </div>

      ${
        props.commandsCatalogError
          ? html`<div class="callout danger" style="margin-top: 12px;">
              ${props.commandsCatalogError}
            </div>`
          : nothing
      }

      <div class="chip-row" style="margin-top: 12px;">
        <span class="chip">${commands.length} total</span>
        <span class="chip">native ${counts.native}</span>
        <span class="chip">skills ${counts.skill}</span>
        <span class="chip">plugins ${counts.plugin}</span>
      </div>

      <div class="list" style="margin-top: 12px;">
        ${
          commands.length === 0
            ? html`
                <div class="muted">
                  ${
                    props.commandsCatalog
                      ? "No commands loaded for this scope."
                      : "Command catalog is not loaded yet."
                  }
                </div>
              `
            : commands.slice(0, 12).map(renderCommandEntry)
        }
      </div>

      ${
        commands.length > 12
          ? html`<div class="muted" style="margin-top: 8px;">
              Showing 12 of ${commands.length}. Use scope filtering to narrow the catalog.
            </div>`
          : nothing
      }
    </section>
  `;
}

function renderCommandEntry(command: CommandEntry) {
  const aliases = command.textAliases?.filter(Boolean) ?? [];
  const args = command.args?.filter(Boolean) ?? [];
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">
          ${command.name}
          ${
            command.nativeName && command.nativeName !== command.name
              ? html`<span class="muted"> · ${command.nativeName}</span>`
              : nothing
          }
        </div>
        <div class="list-sub">${command.description}</div>
        <div class="chip-row" style="margin-top: 8px;">
          <span class="chip">${command.source}</span>
          <span class="chip">${command.scope}</span>
          ${command.category ? html`<span class="chip">${command.category}</span>` : nothing}
          ${
            command.acceptsArgs
              ? html`
                  <span class="chip">args</span>
                `
              : nothing
          }
        </div>
        ${
          aliases.length > 0 || args.length > 0
            ? html`
                <div class="muted" style="margin-top: 8px;">
                  ${aliases.length > 0 ? `Aliases: ${aliases.join(", ")}` : ""}
                  ${aliases.length > 0 && args.length > 0 ? " · " : ""}
                  ${
                    args.length > 0
                      ? `Args: ${args
                          .map((arg) => `${arg.name}${arg.required ? "*" : ""}`)
                          .join(", ")}`
                      : ""
                  }
                </div>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderDevices(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Devices</div>
          <div class="card-sub">Pairing requests + role tokens.</div>
        </div>
        <button class="btn" ?disabled=${props.devicesLoading} @click=${props.onDevicesRefresh}>
          ${props.devicesLoading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      ${
        props.devicesError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.devicesError}</div>`
          : nothing
      }
      <div class="list" style="margin-top: 16px;">
        ${
          pending.length > 0
            ? html`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${pending.map((req) => renderPendingDevice(req, props))}
            `
            : nothing
        }
        ${
          paired.length > 0
            ? html`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${paired.map((device) => renderPairedDevice(device, props))}
            `
            : nothing
        }
        ${
          pending.length === 0 && paired.length === 0
            ? html`
                <div class="muted">No paired devices.</div>
              `
            : nothing
        }
      </div>
    </section>
  `;
}

function renderLiveNodes(props: NodesProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Live Nodes</div>
          <div class="card-sub">Currently advertised node links and capabilities.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${
          props.nodes.length === 0
            ? html`
                <div class="muted">No live nodes found.</div>
              `
            : props.nodes.map((n) => renderNode(n))
        }
      </div>
    </section>
  `;
}

function shortNodeIdentifier(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length <= 22) {
    return trimmed;
  }
  return `${trimmed.slice(0, 10)}...${trimmed.slice(-8)}`;
}

async function copyNodeText(value: string | null | undefined): Promise<void> {
  const text = String(value ?? "").trim();
  if (!text || typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best effort only; the full value stays visible in the title.
  }
}

function renderNodeIdentifier(value: string | null | undefined, label: string) {
  const text = String(value ?? "").trim();
  if (!text) {
    return nothing;
  }
  return html`
    <span class="node-id-inline">
      <span class="node-id-inline__text" title=${text}>${shortNodeIdentifier(text)}</span>
      <button
        type="button"
        class="node-id-copy"
        title=${`Copy ${label}`}
        aria-label=${`Copy ${label}`}
        @click=${() => void copyNodeText(text)}
      >
        ${icons.copy}
      </button>
    </span>
  `;
}

function renderPendingDevice(req: PendingDevice, props: NodesProps) {
  const name = req.displayName?.trim() || "Pairing request";
  const age = typeof req.ts === "number" ? formatRelativeTimestamp(req.ts) : t("common.na");
  const roleValue = req.role?.trim() || formatList(req.roles);
  const scopesValue = formatList(req.scopes);
  const repair = req.isRepair ? " · repair" : "";
  const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub node-id-line">${renderNodeIdentifier(req.deviceId, "device ID")}${ip}</div>
        <div class="muted" style="margin-top: 6px;">
          role: ${roleValue} · scopes: ${scopesValue} · requested ${age}${repair}
        </div>
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${() => props.onDeviceApprove(req.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${() => props.onDeviceReject(req.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderPairedDevice(device: PairedDevice, props: NodesProps) {
  const name = device.displayName?.trim() || "Paired device";
  const ip = device.remoteIp ? ` · ${device.remoteIp}` : "";
  const roles = `roles: ${formatList(device.roles)}`;
  const scopes = `scopes: ${formatList(device.scopes)}`;
  const tokens = Array.isArray(device.tokens) ? device.tokens : [];
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub node-id-line">
          ${renderNodeIdentifier(device.deviceId, "device ID")}${ip}
        </div>
        <div class="muted" style="margin-top: 6px;">${roles} · ${scopes}</div>
        ${
          tokens.length === 0
            ? html`
                <div class="muted" style="margin-top: 6px">Tokens: none</div>
              `
            : html`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${tokens.map((token) => renderTokenRow(device.deviceId, token, props))}
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderTokenRow(deviceId: string, token: DeviceTokenSummary, props: NodesProps) {
  const status = token.revokedAtMs ? "revoked" : "active";
  const scopes = `scopes: ${formatList(token.scopes)}`;
  const when = formatRelativeTimestamp(
    token.rotatedAtMs ?? token.createdAtMs ?? token.lastUsedAtMs ?? null,
  );
  return html`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${token.role} · ${status} · ${scopes} · ${when}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${() => props.onDeviceRotate(deviceId, token.role, token.scopes)}
        >
          Rotate
        </button>
        ${
          token.revokedAtMs
            ? nothing
            : html`
              <button
                class="btn btn--sm danger"
                @click=${() => props.onDeviceRevoke(deviceId, token.role)}
              >
                Revoke
              </button>
            `
        }
      </div>
    </div>
  `;
}

type BindingAgent = {
  id: string;
  name: string | undefined;
  index: number;
  isDefault: boolean;
  binding: string | null;
};

type BindingNode = NodeTargetOption;

type BindingState = {
  ready: boolean;
  disabled: boolean;
  configDirty: boolean;
  configLoading: boolean;
  configSaving: boolean;
  defaultBinding?: string | null;
  agents: BindingAgent[];
  nodes: BindingNode[];
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSave: () => void;
  onLoadConfig: () => void;
  formMode: "form" | "raw";
};

function resolveBindingsState(props: NodesProps): BindingState {
  const config = props.configForm;
  const nodes = resolveExecNodes(props.nodes);
  const { defaultBinding, agents } = resolveAgentBindings(config);
  const ready = Boolean(config);
  const disabled = props.configSaving || props.configFormMode === "raw";
  return {
    ready,
    disabled,
    configDirty: props.configDirty,
    configLoading: props.configLoading,
    configSaving: props.configSaving,
    defaultBinding,
    agents,
    nodes,
    onBindDefault: props.onBindDefault,
    onBindAgent: props.onBindAgent,
    onSave: props.onSaveBindings,
    onLoadConfig: props.onLoadConfig,
    formMode: props.configFormMode,
  };
}

function renderBindings(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const defaultValue = state.defaultBinding ?? "";
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${t("nodes.binding.execNodeBinding")}</div>
          <div class="card-sub">${t("nodes.binding.execNodeBindingSubtitle")}</div>
        </div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.configDirty}
          @click=${state.onSave}
        >
          ${state.configSaving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      ${
        state.formMode === "raw"
          ? html`
            <div class="callout warn" style="margin-top: 12px">
              ${t("nodes.binding.formModeHint")}
            </div>
          `
          : nothing
      }
      ${
        !state.ready
          ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${t("nodes.binding.loadConfigHint")}</div>
            <button class="btn" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
              ${state.configLoading ? t("common.loading") : t("common.loadConfig")}
            </button>
          </div>`
          : html`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${t("nodes.binding.defaultBinding")}</div>
                  <div class="list-sub">${t("nodes.binding.defaultBindingHint")}</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>${t("nodes.binding.node")}</span>
                    <select
                      ?disabled=${state.disabled || !supportsBinding}
                      @change=${(event: Event) => {
                        const target = event.target as HTMLSelectElement;
                        const value = target.value.trim();
                        state.onBindDefault(value ? value : null);
                      }}
                    >
                      <option value="" ?selected=${defaultValue === ""}>Any node</option>
                      ${state.nodes.map(
                        (node) =>
                          html`<option value=${node.id} ?selected=${defaultValue === node.id}>
                            ${node.label}
                          </option>`,
                      )}
                    </select>
                  </label>
                  ${
                    !supportsBinding
                      ? html`
                          <div class="muted">No nodes with system.run available.</div>
                        `
                      : nothing
                  }
                </div>
              </div>

              ${
                state.agents.length === 0
                  ? html`
                      <div class="muted">No agents found.</div>
                    `
                  : state.agents.map((agent) => renderAgentBinding(agent, state))
              }
            </div>
          `
      }
    </section>
  `;
}

function renderAgentBinding(agent: BindingAgent, state: BindingState) {
  const bindingValue = agent.binding ?? "__default__";
  const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
  const supportsBinding = state.nodes.length > 0;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${label}</div>
        <div class="list-sub">
          ${agent.isDefault ? "default agent" : "agent"} ·
          ${
            bindingValue === "__default__"
              ? `uses default (${state.defaultBinding ?? "any"})`
              : `override: ${agent.binding}`
          }
        </div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>Binding</span>
          <select
            ?disabled=${state.disabled || !supportsBinding}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value.trim();
              state.onBindAgent(agent.index, value === "__default__" ? null : value);
            }}
          >
            <option value="__default__" ?selected=${bindingValue === "__default__"}>
              Use default
            </option>
            ${state.nodes.map(
              (node) =>
                html`<option value=${node.id} ?selected=${bindingValue === node.id}>
                  ${node.label}
                </option>`,
            )}
          </select>
        </label>
      </div>
    </div>
  `;
}

function resolveExecNodes(nodes: Array<Record<string, unknown>>): BindingNode[] {
  return resolveNodeTargets(nodes, ["system.run"]);
}

function resolveAgentBindings(config: Record<string, unknown> | null): {
  defaultBinding?: string | null;
  agents: BindingAgent[];
} {
  const fallbackAgent: BindingAgent = {
    id: "main",
    name: undefined,
    index: 0,
    isDefault: true,
    binding: null,
  };
  if (!config || typeof config !== "object") {
    return { defaultBinding: null, agents: [fallbackAgent] };
  }
  const tools = (config.tools ?? {}) as Record<string, unknown>;
  const exec = (tools.exec ?? {}) as Record<string, unknown>;
  const defaultBinding =
    typeof exec.node === "string" && exec.node.trim() ? exec.node.trim() : null;

  const agentsNode = (config.agents ?? {}) as Record<string, unknown>;
  if (!Array.isArray(agentsNode.list) || agentsNode.list.length === 0) {
    return { defaultBinding, agents: [fallbackAgent] };
  }

  const agents = resolveConfigAgents(config).map((entry) => {
    const toolsEntry = (entry.record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim() ? execEntry.node.trim() : null;
    return {
      id: entry.id,
      name: entry.name,
      index: entry.index,
      isDefault: entry.isDefault,
      binding,
    };
  });

  if (agents.length === 0) {
    agents.push(fallbackAgent);
  }

  return { defaultBinding, agents };
}

function renderNode(node: Record<string, unknown>) {
  const connected = Boolean(node.connected);
  const paired = Boolean(node.paired);
  const title =
    (typeof node.displayName === "string" && node.displayName.trim()) ||
    (typeof node.nodeId === "string" ? "Live node" : "Unknown node");
  const caps = Array.isArray(node.caps) ? (node.caps as unknown[]) : [];
  const commands = Array.isArray(node.commands) ? (node.commands as unknown[]) : [];
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${title}</div>
        <div class="list-sub node-id-line">
          ${renderNodeIdentifier(typeof node.nodeId === "string" ? node.nodeId : "", "node ID")}
          ${typeof node.remoteIp === "string" ? ` · ${node.remoteIp}` : ""}
          ${typeof node.version === "string" ? ` · ${node.version}` : ""}
        </div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${paired ? "paired" : "unpaired"}</span>
          <span class="chip ${connected ? "chip-ok" : "chip-warn"}">
            ${connected ? "connected" : "offline"}
          </span>
          ${caps.slice(0, 12).map((c) => html`<span class="chip">${String(c)}</span>`)}
          ${commands.slice(0, 8).map((c) => html`<span class="chip">${String(c)}</span>`)}
        </div>
      </div>
    </div>
  `;
}
