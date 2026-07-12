import { html, nothing } from "lit";
import { formatAgentDisplayName } from "../agent-display.ts";
import type { DreamingStatus } from "../controllers/dreaming.ts";
import { icons } from "../icons.ts";
import type {
  AgentsListResult,
  DoctorMemoryInventoryPayload,
  DoctorMemoryValidationPayload,
} from "../types.ts";

type Tone = "default" | "ok" | "warn" | "danger";

export type MemoryProps = {
  loading: boolean;
  error: string | null;
  configForm?: Record<string, unknown> | null;
  configSaving?: boolean;
  configDirty?: boolean;
  inventory: DoctorMemoryInventoryPayload | null;
  validation: DoctorMemoryValidationPayload | null;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: DreamingStatus | null;
  dreamDiaryLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  onConfigPatch?: (path: Array<string | number>, value: unknown) => void;
  onConfigSave?: () => void;
  onSelectAgent: (agentId: string) => void;
  onRefresh: () => void;
  onOpenDebug: () => void;
};

function toneClass(tone: Tone): string {
  return `memory-card__value${tone === "default" ? "" : ` ${tone}`}`;
}

function validationTone(validation: DoctorMemoryValidationPayload | null): Tone {
  if (!validation) {
    return "default";
  }
  if (validation.summary.errors > 0) {
    return "danger";
  }
  if (validation.summary.warnings > 0) {
    return "warn";
  }
  return "ok";
}

function validationValue(validation: DoctorMemoryValidationPayload | null): string {
  if (!validation) {
    return "Not loaded";
  }
  if (validation.summary.errors > 0) {
    return `${validation.summary.errors} errors`;
  }
  if (validation.summary.warnings > 0) {
    return `${validation.summary.warnings} warnings`;
  }
  return "OK";
}

function validationDetail(validation: DoctorMemoryValidationPayload | null): string {
  if (!validation) {
    return "Memory validation has not run yet.";
  }
  return `${validation.summary.errors} errors, ${validation.summary.warnings} warnings, ${validation.summary.info} info for agent ${formatAgentDisplayName({ id: validation.agentId })}.`;
}

function pathDetail(
  path: { path?: string; exists?: boolean; kind?: string; markdownFiles?: number } | undefined,
) {
  if (!path) {
    return "not reported";
  }
  const markdown =
    typeof path.markdownFiles === "number" ? `, ${path.markdownFiles} markdown files` : "";
  return `${path.path ?? "unknown"} - ${path.exists ? (path.kind ?? "exists") : "missing"}${markdown}`;
}

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

function readBoolean(
  root: unknown,
  path: ReadonlyArray<string | number>,
  fallback = false,
): boolean {
  const value = readPath(root, path);
  return typeof value === "boolean" ? value : fallback;
}

function readString(root: unknown, path: ReadonlyArray<string | number>, fallback = ""): string {
  const value = readPath(root, path);
  return typeof value === "string" ? value : fallback;
}

function renderStatusCard(params: { label: string; value: string; detail: string; tone?: Tone }) {
  return html`
    <div class="memory-card">
      <div class="memory-card__label">${params.label}</div>
      <div class=${toneClass(params.tone ?? "default")}>${params.value}</div>
      <div class="memory-card__detail">${params.detail}</div>
    </div>
  `;
}

function renderMemoryHelp(text: string) {
  return html`
    <span class="memory-help" role="img" tabindex="0" aria-label=${text} data-tooltip=${text}>
      ${icons.info}
    </span>
  `;
}

function renderAgentSelector(props: MemoryProps) {
  const agents = props.agentsList?.agents ?? [];
  const selectedId =
    props.selectedAgentId ??
    props.inventory?.agentId ??
    props.agentsList?.defaultId ??
    agents[0]?.id ??
    "";
  return html`
    <label class="memory-agent-select">
      <span>Agent</span>
      <select
        .value=${selectedId}
        ?disabled=${props.loading || agents.length === 0}
        @change=${(event: Event) => props.onSelectAgent((event.target as HTMLSelectElement).value)}
      >
        ${
          agents.length === 0
            ? html`<option value=${selectedId}>${selectedId ? formatAgentDisplayName({ id: selectedId }) : "No agents"}</option>`
            : agents.map(
                (agent) => html`
                <option value=${agent.id}>
                  ${formatAgentDisplayName({ id: agent.id, name: agent.name, identity: agent.identity })}
                </option>
              `,
              )
        }
      </select>
    </label>
  `;
}

function renderMemoryRoots(inventory: DoctorMemoryInventoryPayload | null) {
  const roots = inventory?.workspace.memoryRoots ?? [];
  if (roots.length === 0) {
    return html`
      <div class="empty-state">Workspace memory roots are not loaded yet.</div>
    `;
  }
  return html`
    <div class="memory-list">
      ${roots.map((root) => {
        const optionalLegacyMissing = root.id === "memory.md" && !root.exists;
        return html`
          <div class="memory-row">
            <div>
              <div class="memory-row__title">${root.id}</div>
              <div class="memory-row__detail">
                ${
                  optionalLegacyMissing
                    ? `${root.path} - optional legacy root not present`
                    : pathDetail(root)
                }
              </div>
            </div>
            <span class="pill ${root.exists ? "ok" : ""}">
              ${optionalLegacyMissing ? "optional" : root.exists ? root.kind : "missing"}
            </span>
          </div>
        `;
      })}
    </div>
  `;
}

function renderValidationFindings(validation: DoctorMemoryValidationPayload | null) {
  const findings = validation?.findings ?? [];
  if (findings.length === 0) {
    return html`
      <div class="empty-state">No memory validation findings are visible.</div>
    `;
  }
  return html`
    <div class="memory-list">
      ${findings.slice(0, 8).map(
        (finding) => html`
          <div class="memory-row">
            <div>
              <div class="memory-row__title">${finding.code} - ${finding.area}</div>
              <div class="memory-row__detail">
                ${finding.message}${finding.path ? html`<br />${finding.path}` : nothing}
              </div>
            </div>
            <span class="pill ${finding.severity === "error" ? "danger" : finding.severity === "warn" ? "warn" : ""}">
              ${finding.severity}
            </span>
          </div>
        `,
      )}
      ${findings.length > 8 ? html`<div class="memory-more">${findings.length - 8} more findings in Debug.</div>` : nothing}
    </div>
  `;
}

function renderFilenameDiagnostics(inventory: DoctorMemoryInventoryPayload | null) {
  const diagnostics = inventory?.sessionMemory.filenameDiagnostics;
  if (!diagnostics) {
    return html`
      <div class="empty-state">Filename collision diagnostics are unavailable.</div>
    `;
  }
  if (diagnostics.groups.length === 0) {
    return html`
      <div class="empty-state">No same-minute session archive filename collisions were found.</div>
    `;
  }
  return html`
    <div class="memory-list">
      ${diagnostics.groups.slice(0, 6).map(
        (group) => html`
          <div class="memory-row memory-row--stack">
            <div>
              <div class="memory-row__title">${group.stem}</div>
              <div class="memory-row__detail">${group.state}</div>
            </div>
            <div class="memory-files">
              ${group.files.map((file) => html`<code>${file.name}</code>`)}
            </div>
          </div>
        `,
      )}
      ${diagnostics.groups.length > 6 ? html`<div class="memory-more">${diagnostics.groups.length - 6} more groups in Debug.</div>` : nothing}
    </div>
  `;
}

function renderDreamingSummary(props: MemoryProps) {
  const status = props.dreamingStatus;
  return html`
    <div class="memory-grid">
      ${renderStatusCard({
        label: "Dreaming",
        value: props.dreamingStatusLoading
          ? "Loading"
          : status?.enabled
            ? "Enabled"
            : status
              ? "Disabled"
              : "Not loaded",
        detail: status
          ? `${status.shortTermCount} short-term records, ${status.totalSignalCount} signals, ${status.promotedToday} promoted today.`
          : (props.dreamingStatusError ?? "Dreaming status has not loaded yet."),
        tone: status?.enabled ? "ok" : status ? "default" : "warn",
      })}
    </div>
  `;
}

function renderQmdSetup(props: MemoryProps) {
  const config = props.configForm ?? {};
  const disabled = !props.configForm || props.configSaving === true;
  const backend = readString(config, ["memory", "backend"], "builtin");
  const citations = readString(config, ["memory", "citations"], "auto");
  const command = readString(config, ["memory", "qmd", "command"], "qmd");
  const includeDefaultMemory = readBoolean(config, ["memory", "qmd", "includeDefaultMemory"], true);
  const indexSessions = readBoolean(config, ["memory", "qmd", "sessions", "enabled"]);
  return html`
    <section class="memory-panel">
      <div class="memory-panel__title">QMD setup</div>
      <div class="memory-row memory-row--stack">
        <div class="memory-row__detail">
          QMD is an optional local search sidecar. The backend switch is global, while the
          index and diagnostics are still reported per Agent.
        </div>
        <div class="memory-form-grid">
          <label class="memory-field">
            <span>Citations</span>
            <select
              .value=${citations}
              ?disabled=${disabled}
              @change=${(event: Event) =>
                props.onConfigPatch?.(
                  ["memory", "citations"],
                  (event.target as HTMLSelectElement).value,
                )}
            >
              <option value="auto" ?selected=${citations === "auto"}>Auto</option>
              <option value="on" ?selected=${citations === "on"}>On</option>
              <option value="off" ?selected=${citations === "off"}>Off</option>
            </select>
          </label>
          <label class="memory-field">
            <span>Backend</span>
            <select
              .value=${backend}
              ?disabled=${disabled}
              @change=${(event: Event) =>
                props.onConfigPatch?.(
                  ["memory", "backend"],
                  (event.target as HTMLSelectElement).value,
                )}
            >
              <option value="builtin" ?selected=${backend !== "qmd"}>Builtin</option>
              <option value="qmd" ?selected=${backend === "qmd"}>QMD</option>
            </select>
          </label>
          <label class="memory-field">
            <span>QMD binary</span>
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              .value=${command}
              placeholder="qmd"
              ?disabled=${disabled}
              @input=${(event: Event) =>
                props.onConfigPatch?.(
                  ["memory", "qmd", "command"],
                  (event.target as HTMLInputElement).value,
                )}
            />
          </label>
        </div>
        <div class="memory-switch-row">
          <label class="cfg-toggle">
            <input
              type="checkbox"
              .checked=${includeDefaultMemory}
              ?disabled=${disabled}
              @change=${(event: Event) =>
                props.onConfigPatch?.(
                  ["memory", "qmd", "includeDefaultMemory"],
                  (event.target as HTMLInputElement).checked,
                )}
            />
            <span class="cfg-toggle__track"></span>
            <span>Index workspace memory roots</span>
          </label>
          <label class="cfg-toggle">
            <input
              type="checkbox"
              .checked=${indexSessions}
              ?disabled=${disabled}
              @change=${(event: Event) =>
                props.onConfigPatch?.(
                  ["memory", "qmd", "sessions", "enabled"],
                  (event.target as HTMLInputElement).checked,
                )}
            />
            <span class="cfg-toggle__track"></span>
            <span>Index session archives</span>
          </label>
        </div>
        <div class="memory-actions-inline">
          <button
            class="btn btn--sm primary"
            ?disabled=${props.configSaving || !props.configDirty || !props.onConfigSave}
            @click=${() => props.onConfigSave?.()}
          >
            ${props.configSaving ? "Saving..." : "Save memory"}
          </button>
        </div>
      </div>
    </section>
  `;
}

export function renderMemory(props: MemoryProps) {
  const inventory = props.inventory;
  const validation = props.validation;
  const backend = inventory?.backend;
  const sessionMemory = inventory?.sessionMemory;
  const qmd = inventory?.qmd;
  const plugin = inventory?.memoryPlugin;
  const semanticState =
    backend?.semantic?.state ??
    (backend?.vector?.enabled === true && backend.vector.available === true
      ? "ready"
      : backend
        ? "not-configured"
        : undefined);
  const semanticReady = semanticState === "ready";
  const keywordReady = backend?.fts?.enabled === true && backend.fts.available;
  const memoryIndexTone: Tone = backend?.error
    ? "danger"
    : backend?.dirty
      ? "warn"
      : semanticState === "unavailable"
        ? "warn"
        : semanticReady
          ? "ok"
          : "default";
  return html`
    <style>
      .memory-page {
        display: grid;
        gap: 16px;
      }

      .memory-head {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 12px;
      }

      .memory-head__title {
        color: var(--text-strong);
        font-size: 22px;
        font-weight: 800;
        letter-spacing: -0.03em;
      }

      .memory-card__detail,
      .memory-row__detail,
      .memory-more,
      .memory-diary p {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .memory-head__title-row {
        align-items: center;
        display: inline-flex;
        gap: 8px;
      }

      .memory-help {
        align-items: center;
        background: color-mix(in srgb, var(--accent) 8%, var(--panel));
        border-radius: 999px;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent);
        color: var(--text-strong);
        cursor: help;
        display: inline-flex;
        height: 26px;
        justify-content: center;
        position: relative;
        width: 26px;
      }

      .memory-help svg {
        fill: none;
        height: 15px;
        stroke: currentColor;
        width: 15px;
      }

      .memory-help::after {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        color: var(--text-strong);
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
        width: min(340px, calc(100vw - 48px));
        z-index: 50;
      }

      .memory-help:hover,
      .memory-help:focus-visible {
        background: color-mix(in srgb, var(--accent) 14%, var(--panel));
        color: var(--accent);
      }

      .memory-help:hover::after,
      .memory-help:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
      }

      .memory-actions {
        align-items: end;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .memory-agent-select {
        display: grid;
        gap: 5px;
        min-width: min(260px, 100%);
      }

      .memory-agent-select span {
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .memory-agent-select select {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        color: var(--text-strong);
        min-height: 38px;
        padding: 0 34px 0 12px;
        width: 100%;
      }

      .memory-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      }

      .memory-card,
      .memory-panel,
      .memory-diary {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--card);
        box-shadow: none;
      }

      .memory-card {
        display: grid;
        gap: 8px;
        padding: 15px;
      }

      .memory-card__label {
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .memory-card__value {
        color: var(--text-strong);
        font-family: var(--mono);
        font-size: 22px;
        font-weight: 800;
        line-height: 1;
      }

      .memory-card__value.ok {
        color: var(--ok);
      }

      .memory-card__value.warn {
        color: var(--warn);
      }

      .memory-card__value.danger {
        color: var(--danger);
      }

      .memory-panel {
        display: grid;
        gap: 12px;
        padding: 16px;
      }

      .memory-form-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        margin-top: 8px;
      }

      .memory-field {
        display: grid;
        gap: 6px;
        min-width: 0;
      }

      .memory-field span {
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .memory-field input,
      .memory-field select {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        color: var(--text-strong);
        min-height: 38px;
        min-width: 0;
        padding: 0 12px;
        width: 100%;
      }

      .memory-switch-row,
      .memory-actions-inline {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 8px;
      }

      .memory-panel__title {
        color: var(--text-strong);
        font-size: 16px;
        font-weight: 800;
      }

      .memory-list {
        display: grid;
        gap: 8px;
      }

      .memory-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--panel);
        padding: 12px;
      }

      .memory-row--stack {
        display: grid;
      }

      .memory-row__title {
        color: var(--text-strong);
        font-weight: 800;
      }

      .memory-files {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .memory-files code {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-elevated);
        color: var(--text);
        font-family: var(--mono);
        font-size: 11px;
        padding: 3px 6px;
      }

      .empty-state {
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        color: var(--muted);
        padding: 14px;
      }
    </style>

    <section class="memory-page">
      <section class="card">
        <div class="memory-head">
          <div>
            <div class="memory-head__title-row">
              <div class="memory-head__title">Memory overview</div>
              ${renderMemoryHelp(
                "Global diagnostics for Agent memory archives, workspace roots, backend health, QMD scope, and dreaming status. Agent-owned archive controls live in Agent > Memory.",
              )}
            </div>
          </div>
          <div class="memory-actions">
            ${renderAgentSelector(props)}
            <button class="btn" @click=${() => props.onRefresh()} ?disabled=${props.loading}>
              ${props.loading ? "Refreshing..." : "Refresh"}
            </button>
            <button class="btn btn--subtle" @click=${() => props.onOpenDebug()}>
              Advanced diagnostics
            </button>
          </div>
        </div>
      </section>

      ${props.error ? html`<div class="callout warn">${props.error}</div>` : nothing}

      <section class="memory-grid">
        ${renderStatusCard({
          label: "Agent",
          value: inventory?.agentId
            ? formatAgentDisplayName({ id: inventory.agentId })
            : "Not loaded",
          detail: inventory?.workspace.path ?? "Memory inventory has not loaded yet.",
          tone: inventory ? "ok" : "default",
        })}
        ${renderStatusCard({
          label: "Validation",
          value: validationValue(validation),
          detail: validationDetail(validation),
          tone: validationTone(validation),
        })}
        ${renderStatusCard({
          label: "Session Archives",
          value: sessionMemory?.enabled ? "Enabled" : sessionMemory ? "Disabled" : "Not loaded",
          detail: sessionMemory
            ? `${sessionMemory.hookConfigured ? "hook configured" : "hook missing"}, ${sessionMemory.messages ?? 0} messages, ${pathDetail(sessionMemory.memoryDir)}`
            : "Session-memory hook status has not loaded yet.",
          tone: sessionMemory?.enabled ? "ok" : sessionMemory ? "warn" : "default",
        })}
        ${renderStatusCard({
          label: "Backend",
          value: backend?.active ?? backend?.configured ?? "Not loaded",
          detail: backend
            ? `${backend.files ?? 0} files, ${backend.chunks ?? 0} chunks, citations ${backend.citations}`
            : "Memory backend status has not loaded yet.",
          tone: memoryIndexTone,
        })}
        ${renderStatusCard({
          label: "Keyword Recall",
          value: keywordReady ? "Ready" : backend ? "Unavailable" : "Not loaded",
          detail: backend
            ? backend.dirty
              ? "The keyword index is stale and needs a rebuild."
              : keywordReady
                ? `${backend.files ?? 0} files and ${backend.chunks ?? 0} searchable chunks are indexed.`
                : (backend.fts?.error ?? "The keyword index is not available.")
            : "Keyword readiness has not loaded yet.",
          tone: backend?.dirty ? "warn" : keywordReady ? "ok" : backend ? "warn" : "default",
        })}
        ${renderStatusCard({
          label: "Semantic Recall",
          value:
            semanticState === "ready"
              ? "Ready"
              : semanticState === "not-configured"
                ? "Not configured"
                : semanticState === "disabled"
                  ? "Disabled"
                  : backend
                    ? "Unavailable"
                    : "Not loaded",
          detail: backend
            ? semanticReady
              ? `${backend.provider ?? "configured"} embeddings and vector search are available.`
              : semanticState === "not-configured"
                ? "Keyword recall works; configure an embedding provider to add semantic recall."
                : (backend.semantic?.reason ??
                  backend.error ??
                  backend.fallback?.reason ??
                  "Semantic recall is not available.")
            : "Memory readiness has not loaded yet.",
          tone: semanticReady ? "ok" : semanticState === "unavailable" ? "warn" : "default",
        })}
        ${renderStatusCard({
          label: "QMD",
          value: qmd?.enabled ? "Enabled" : qmd ? "Disabled" : "Not loaded",
          detail: qmd?.enabled
            ? `${qmd.collections?.length ?? 0} collections, sessions ${qmd.sessions?.enabled ? "enabled" : "disabled"}`
            : "QMD index/export is not enabled for this agent.",
          tone: qmd?.enabled ? "ok" : "default",
        })}
        ${renderStatusCard({
          label: "Memory Plugin",
          value: plugin?.active ? plugin.active.status : plugin?.enabled ? "Enabled" : "Inactive",
          detail: plugin?.active
            ? `${plugin.active.name} - ${plugin.active.toolNames.length} tools`
            : (plugin?.reason ?? "No active memory plugin loaded."),
          tone: plugin?.active?.status === "error" ? "danger" : plugin?.active ? "ok" : "default",
        })}
      </section>

      <section class="memory-panel">
        <div class="memory-panel__title">Workspace memory roots</div>
        ${renderMemoryRoots(inventory)}
      </section>

      ${renderQmdSetup(props)}

      <section class="memory-panel">
        <div class="memory-panel__title">Session archive filename state</div>
        ${renderFilenameDiagnostics(inventory)}
      </section>

      <section class="memory-panel">
        <div class="memory-panel__title">Validation findings</div>
        ${renderValidationFindings(validation)}
      </section>

      <section class="memory-panel">
        <div class="memory-panel__title">Dreaming status</div>
        ${renderDreamingSummary(props)}
      </section>

      <div class="callout">
        Repair preview and repair execution remain in Debug. This page is intentionally read-only for memory diagnostics.
      </div>
    </section>
  `;
}
