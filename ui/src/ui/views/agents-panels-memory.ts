import { html, nothing } from "lit";
import { formatAgentDisplayName } from "../agent-display.ts";
import type { Tab } from "../navigation.ts";
import type { MemoryState } from "./agents.ts";

type Tone = "default" | "ok" | "warn" | "danger";

function valueTone(tone: Tone): string {
  return `agent-memory-card__value${tone === "default" ? "" : ` ${tone}`}`;
}

function pathDetail(
  path: { path?: string; exists?: boolean; kind?: string; markdownFiles?: number } | undefined,
): string {
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

function validationSummary(memory: MemoryState): { value: string; detail: string; tone: Tone } {
  const validation = memory.validation;
  if (!validation) {
    return {
      value: "Not loaded",
      detail: "Memory validation has not loaded yet.",
      tone: "default",
    };
  }
  if (validation.summary.errors > 0) {
    return {
      value: `${validation.summary.errors} errors`,
      detail: `${validation.summary.warnings} warnings, ${validation.summary.info} info.`,
      tone: "danger",
    };
  }
  if (validation.summary.warnings > 0) {
    return {
      value: `${validation.summary.warnings} warnings`,
      detail: `${validation.summary.errors} errors, ${validation.summary.info} info.`,
      tone: "warn",
    };
  }
  return {
    value: "OK",
    detail: `${validation.summary.info} info findings for ${formatAgentDisplayName({
      id: validation.agentId,
    })}.`,
    tone: "ok",
  };
}

function renderMemoryHelp(text: string) {
  return html`
    <span class="agent-memory-help" tabindex="0" aria-label=${text}>
      ?
      <span class="agent-memory-help__tip">${text}</span>
    </span>
  `;
}

function renderStatusCard(params: {
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
  help?: string;
}) {
  return html`
    <div class="agent-memory-card">
      <div class="agent-memory-card__label">
        <span>${params.label}</span>
        ${params.help ? renderMemoryHelp(params.help) : nothing}
      </div>
      <div class=${valueTone(params.tone ?? "default")}>${params.value}</div>
      <div class="agent-memory-card__detail">${params.detail}</div>
    </div>
  `;
}

function renderMemoryRoots(memory: MemoryState) {
  const roots = memory.inventory?.workspace.memoryRoots ?? [];
  if (roots.length === 0) {
    return html`
      <div class="agent-memory-empty">Workspace memory roots have not loaded yet.</div>
    `;
  }
  return html`
    <div class="agent-memory-list">
      ${roots.map((root) => {
        const optionalLegacyMissing = root.id === "memory.md" && !root.exists;
        return html`
          <div class="agent-memory-row">
            <div>
              <div class="agent-memory-row__title">${root.id}</div>
              <div class="agent-memory-row__detail">
                ${
                  optionalLegacyMissing
                    ? `${root.path} - optional legacy root not present`
                    : pathDetail(root)
                }
              </div>
            </div>
            <span class="chip ${root.exists ? "ok" : ""}">
              ${optionalLegacyMissing ? "optional" : root.exists ? (root.kind ?? "exists") : "missing"}
            </span>
          </div>
        `;
      })}
    </div>
  `;
}

function renderFilenameDiagnostics(memory: MemoryState) {
  const diagnostics = memory.inventory?.sessionMemory.filenameDiagnostics;
  if (!diagnostics) {
    return html`
      <div class="agent-memory-empty">Filename collision diagnostics are unavailable.</div>
    `;
  }
  if (diagnostics.groups.length === 0) {
    return html`
      <div class="agent-memory-empty">No same-minute session archive filename collisions were found.</div>
    `;
  }
  return html`
    <div class="agent-memory-list">
      ${diagnostics.groups.slice(0, 6).map(
        (group) => html`
          <div class="agent-memory-row agent-memory-row--stack">
            <div>
              <div class="agent-memory-row__title">${group.stem}</div>
              <div class="agent-memory-row__detail">${group.state}</div>
            </div>
            <div class="agent-memory-files">
              ${group.files.map((file) => html`<code>${file.name}</code>`)}
            </div>
          </div>
        `,
      )}
      ${
        diagnostics.groups.length > 6
          ? html`
              <div class="agent-memory-more">
                ${diagnostics.groups.length - 6} more groups in Debug.
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderValidationFindings(memory: MemoryState) {
  const findings = memory.validation?.findings ?? [];
  if (findings.length === 0) {
    return html`
      <div class="agent-memory-empty">No memory validation findings are visible.</div>
    `;
  }
  return html`
    <div class="agent-memory-list">
      ${findings.slice(0, 8).map(
        (finding) => html`
          <div class="agent-memory-row">
            <div>
              <div class="agent-memory-row__title">${finding.code} - ${finding.area}</div>
              <div class="agent-memory-row__detail">
                ${finding.message}${finding.path ? html`<br />${finding.path}` : nothing}
              </div>
            </div>
            <span
              class="chip ${
                finding.severity === "error" ? "danger" : finding.severity === "warn" ? "warn" : ""
              }"
            >
              ${finding.severity}
            </span>
          </div>
        `,
      )}
      ${
        findings.length > 8
          ? html`
              <div class="agent-memory-more">${findings.length - 8} more findings in Debug.</div>
            `
          : nothing
      }
    </div>
  `;
}

function renderDreamingSummary(memory: MemoryState) {
  const status = memory.dreamingStatus;
  return html`
    <div class="agent-memory-grid">
      ${renderStatusCard({
        label: "Dreaming",
        value: memory.dreamingStatusLoading
          ? "Loading"
          : status?.enabled
            ? "Enabled"
            : status
              ? "Disabled"
              : "Not loaded",
        detail: status
          ? `${status.shortTermCount} short-term records · ${status.totalSignalCount} signals · ${status.promotedToday} promoted today`
          : (memory.dreamingStatusError ?? "Dreaming status has not loaded yet."),
        tone: status?.enabled ? "ok" : status ? "default" : "warn",
      })}
    </div>
  `;
}

function renderWikiDetail(memory: MemoryState): { value: string; detail: string; tone: Tone } {
  const wiki = memory.wiki;
  if (!wiki) {
    return {
      value: memory.loading ? "Loading" : "Not built",
      detail: memory.wikiError ?? "Rebuild the wiki to export current memory files.",
      tone: memory.wikiError ? "warn" : "default",
    };
  }
  if (wiki.error) {
    return {
      value: "Error",
      detail: wiki.error,
      tone: "warn",
    };
  }
  if (!wiki.built) {
    return {
      value: "Not built",
      detail: "Rebuild the wiki to compile MEMORY.md and memory/*.md into a read-only export.",
      tone: "default",
    };
  }
  const builtAt =
    typeof wiki.lastBuiltAtMs === "number"
      ? new Date(wiki.lastBuiltAtMs).toLocaleString()
      : "built";
  return {
    value: `${wiki.pages} pages`,
    detail: `${wiki.sources} sources · ${builtAt} · ${wiki.indexPath}`,
    tone: "ok",
  };
}

export function renderAgentMemory(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  memory: MemoryState;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
  onMemoryWikiRebuild?: () => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigSave: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  const inventory = params.memory.inventory;
  const sessionMemory = inventory?.sessionMemory;
  const backend = inventory?.backend;
  const qmd = inventory?.qmd;
  const plugin = inventory?.memoryPlugin;
  const validation = validationSummary(params.memory);
  const wiki = renderWikiDetail(params.memory);
  const sessionMemoryEnabled = sessionMemory?.enabled === true;
  const canEdit = Boolean(params.configForm) && !params.configLoading && !params.configSaving;
  const loadedForSelectedAgent = inventory?.agentId === params.agentId;
  const memoryBackend = readString(params.configForm, ["memory", "backend"], "builtin");
  const memoryCitations = readString(params.configForm, ["memory", "citations"], "auto");
  const qmdCommand = readString(params.configForm, ["memory", "qmd", "command"], "qmd");
  const includeDefaultMemory = readBoolean(
    params.configForm,
    ["memory", "qmd", "includeDefaultMemory"],
    true,
  );
  const qmdSessionIndexing = readBoolean(params.configForm, [
    "memory",
    "qmd",
    "sessions",
    "enabled",
  ]);

  return html`
    <section class="card agent-memory-panel">
      <style>
        .agent-memory-panel {
          display: grid;
          gap: 14px;
        }

        .agent-memory-head {
          align-items: flex-start;
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          justify-content: space-between;
        }

        .agent-memory-title {
          color: var(--text-strong);
          font-size: 18px;
          font-weight: 800;
        }

        .agent-memory-sub,
        .agent-memory-card__detail,
        .agent-memory-row__detail {
          color: var(--muted);
          font-size: 12px;
          line-height: 1.45;
        }

        .agent-memory-sub {
          margin-top: 4px;
        }

        .agent-memory-actions {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: flex-end;
        }

        .agent-memory-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        }

        .agent-memory-card,
        .agent-memory-roots {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: none;
        }

        .agent-memory-card {
          display: grid;
          gap: 8px;
          padding: 14px;
        }

        .agent-memory-card__label {
          align-items: center;
          color: var(--muted);
          display: flex;
          font-size: 11px;
          font-weight: 800;
          gap: 6px;
          justify-content: space-between;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .agent-memory-card__value {
          color: var(--text-strong);
          font-family: var(--mono);
          font-size: 20px;
          font-weight: 800;
          line-height: 1;
          overflow-wrap: anywhere;
        }

        .agent-memory-card__value.ok {
          color: var(--ok);
        }

        .agent-memory-card__value.warn {
          color: var(--warn);
        }

        .agent-memory-card__value.danger {
          color: var(--danger);
        }

        .agent-memory-roots {
          display: grid;
          gap: 10px;
          padding: 14px;
        }

        .agent-memory-roots__title,
        .agent-memory-row__title {
          color: var(--text-strong);
          font-weight: 800;
        }

        .agent-memory-list {
          display: grid;
          gap: 8px;
        }

        .agent-memory-row {
          align-items: flex-start;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          display: flex;
          gap: 10px;
          justify-content: space-between;
          padding: 10px;
        }

        .agent-memory-row--stack {
          display: grid;
        }

        .agent-memory-files {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .agent-memory-files code {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text);
          font-family: var(--mono);
          font-size: 11px;
          padding: 3px 6px;
        }

        .agent-memory-more {
          color: var(--muted);
          font-size: 12px;
        }

        .agent-memory-help {
          align-items: center;
          border: 1px solid var(--border);
          border-radius: 999px;
          color: var(--muted);
          cursor: help;
          display: inline-flex;
          font-size: 11px;
          height: 18px;
          justify-content: center;
          letter-spacing: 0;
          line-height: 1;
          position: relative;
          text-transform: none;
          width: 18px;
        }

        .agent-memory-help__tip {
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-md);
          color: var(--text);
          font-size: 12px;
          font-weight: 560;
          left: 50%;
          letter-spacing: 0;
          line-height: 1.4;
          max-width: min(280px, calc(100vw - 48px));
          opacity: 0;
          padding: 8px 10px;
          pointer-events: none;
          position: absolute;
          text-transform: none;
          top: calc(100% + 8px);
          transform: translateX(-50%);
          transition: opacity 120ms ease;
          width: max-content;
          z-index: 20;
        }

        .agent-memory-help:hover,
        .agent-memory-help:focus-visible {
          color: var(--text-strong);
          outline: none;
        }

        .agent-memory-help:hover .agent-memory-help__tip,
        .agent-memory-help:focus-visible .agent-memory-help__tip {
          opacity: 1;
        }

        .agent-memory-form {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          display: grid;
          gap: 10px;
          padding: 14px;
        }

        .agent-memory-form-grid {
          display: grid;
          gap: 10px;
          grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        }

        .agent-memory-field {
          display: grid;
          gap: 6px;
          min-width: 0;
        }

        .agent-memory-field span,
        .agent-memory-form__label {
          color: var(--muted);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .agent-memory-field input,
        .agent-memory-field select {
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          color: var(--text-strong);
          min-height: 38px;
          min-width: 0;
          padding: 0 12px;
          width: 100%;
        }

        .agent-memory-switches {
          align-items: center;
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .agent-memory-empty {
          border: 1px dashed var(--border);
          border-radius: var(--radius-sm);
          color: var(--muted);
          padding: 12px;
        }

        .agent-memory-details {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          padding: 0;
        }

        .agent-memory-details > summary {
          align-items: center;
          color: var(--text-strong);
          cursor: pointer;
          display: flex;
          font-weight: 800;
          gap: 8px;
          justify-content: space-between;
          list-style: none;
          padding: 12px 14px;
        }

        .agent-memory-details > summary::-webkit-details-marker {
          display: none;
        }

        .agent-memory-details__body {
          border-top: 1px solid var(--border);
          display: grid;
          gap: 10px;
          padding: 14px;
        }

        @media (max-width: 740px) {
          .agent-memory-actions {
            justify-content: flex-start;
          }
        }
      </style>

      <div class="agent-memory-head">
        <div>
          <div class="agent-memory-title">Memory</div>
          <div class="agent-memory-sub">
            Session archive and memory health for ${formatAgentDisplayName({ id: params.agentId })}.
            Hook packs and developer lifecycle hooks live in Extensions.
          </div>
        </div>
        <div class="agent-memory-actions">
          <button
            type="button"
            class="btn btn--sm"
            data-session-memory-toggle="true"
            ?disabled=${!canEdit}
            @click=${() => params.onSessionMemoryEnabledChange(!sessionMemoryEnabled)}
          >
            ${sessionMemoryEnabled ? "Disable session archive" : "Enable session archive"}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            data-agent-memory-save="true"
            ?disabled=${params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? "Saving..." : "Save config"}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            data-agent-memory-diagnostics="true"
            @click=${() => params.onNavigate("debug")}
          >
            Diagnostics
          </button>
          <button
            type="button"
            class="btn btn--sm"
            data-agent-memory-wiki-rebuild="true"
            ?disabled=${params.memory.wikiRebuilding || !params.onMemoryWikiRebuild}
            @click=${() => params.onMemoryWikiRebuild?.()}
          >
            ${params.memory.wikiRebuilding ? "Rebuilding..." : "Rebuild wiki"}
          </button>
        </div>
      </div>

      ${
        inventory && !loadedForSelectedAgent
          ? html`
              <div class="callout warn">
                Memory diagnostics are currently loaded for
                ${formatAgentDisplayName({ id: inventory.agentId })}. Agent-scoped memory inventory
                is the next backend cleanup.
              </div>
            `
          : nothing
      }

      <div class="agent-memory-grid">
        ${renderStatusCard({
          label: "Session archive",
          value: sessionMemory?.enabled ? "Enabled" : sessionMemory ? "Disabled" : "Not loaded",
          detail: sessionMemory
            ? `${sessionMemory.hookConfigured ? "configured" : "missing"} · ${sessionMemory.messages ?? 0} messages · ${pathDetail(sessionMemory.memoryDir)}`
            : "Session-memory status has not loaded yet.",
          tone: sessionMemory?.enabled ? "ok" : sessionMemory ? "warn" : "default",
          help: "Session archive records lightweight session artifacts for this Agent. It does not replace curated MEMORY.md notes.",
        })}
        ${renderStatusCard({
          label: "Backend",
          value: backend?.active ?? backend?.configured ?? "Not loaded",
          detail: backend
            ? `${backend.files ?? 0} files · ${backend.chunks ?? 0} chunks · citations ${backend.citations}`
            : "Memory backend status has not loaded yet.",
          tone: backend?.error ? "warn" : backend ? "ok" : "default",
          help: "The backend powers memory_search and memory_get. Builtin is the default; QMD is optional.",
        })}
        ${renderStatusCard({
          label: "Validation",
          value: validation.value,
          detail: validation.detail,
          tone: validation.tone,
          help: "Validation checks memory roots, plugin state, archive paths, QMD state, and safe repair findings.",
        })}
        ${renderStatusCard({
          label: "QMD",
          value: qmd?.enabled ? "Enabled" : qmd ? "Disabled" : "Not loaded",
          detail: qmd?.enabled
            ? `${qmd.collections?.length ?? 0} collections · sessions ${qmd.sessions?.enabled ? "on" : "off"}`
            : "QMD index/export is not enabled for this Agent.",
          tone: qmd?.enabled ? "ok" : "default",
          help: "QMD is an optional local search sidecar. Leave it disabled unless you intentionally want that backend.",
        })}
        ${renderStatusCard({
          label: "Recall tools",
          value: plugin?.active ? plugin.active.status : plugin?.enabled ? "Enabled" : "Inactive",
          detail: plugin?.active
            ? `${plugin.active.name} · ${plugin.active.toolNames.length} tools`
            : (plugin?.reason ?? "No active memory plugin loaded."),
          tone: plugin?.active?.status === "error" ? "danger" : plugin?.active ? "ok" : "default",
          help: "Fased exposes memory through explicit tools such as memory_search and memory_get. It does not auto-grant extra tools.",
        })}
        ${renderStatusCard({
          label: "Memory Wiki",
          value: wiki.value,
          detail: wiki.detail,
          tone: wiki.tone,
          help: "Memory Wiki is a read-only export built from current memory Markdown files for review and navigation.",
        })}
      </div>

      <div class="agent-memory-roots">
        <div class="agent-memory-roots__title">Workspace memory roots</div>
        ${renderMemoryRoots(params.memory)}
      </div>

      <details class="agent-memory-details">
        <summary>
          <span>QMD setup</span>
          ${renderMemoryHelp(
            "Advanced memory backend settings. Builtin memory is enough for most users.",
          )}
        </summary>
        <div class="agent-memory-details__body">
          <div class="agent-memory-card__detail">
            QMD is a global memory backend with per-Agent index state. Use this when local
            search should be powered by the QMD sidecar instead of the built-in indexer.
          </div>
          <div class="agent-memory-form-grid">
            <label class="agent-memory-field">
              <span>Citations</span>
              <select
                .value=${memoryCitations}
                ?disabled=${!canEdit}
                @change=${(event: Event) =>
                  params.onConfigPatch(
                    ["memory", "citations"],
                    (event.target as HTMLSelectElement).value,
                  )}
              >
                <option value="auto" ?selected=${memoryCitations === "auto"}>Auto</option>
                <option value="on" ?selected=${memoryCitations === "on"}>On</option>
                <option value="off" ?selected=${memoryCitations === "off"}>Off</option>
              </select>
            </label>
            <label class="agent-memory-field">
              <span>Backend</span>
              <select
                .value=${memoryBackend}
                ?disabled=${!canEdit}
                @change=${(event: Event) =>
                  params.onConfigPatch(
                    ["memory", "backend"],
                    (event.target as HTMLSelectElement).value,
                  )}
              >
                <option value="builtin" ?selected=${memoryBackend !== "qmd"}>Builtin</option>
                <option value="qmd" ?selected=${memoryBackend === "qmd"}>QMD</option>
              </select>
            </label>
            <label class="agent-memory-field">
              <span>QMD binary</span>
              <input
                type="text"
                autocomplete="off"
                spellcheck="false"
                .value=${qmdCommand}
                placeholder="qmd"
                ?disabled=${!canEdit}
                @input=${(event: Event) =>
                  params.onConfigPatch(
                    ["memory", "qmd", "command"],
                    (event.target as HTMLInputElement).value,
                  )}
              />
            </label>
          </div>
          <div class="agent-memory-switches">
            <label class="cfg-toggle">
              <input
                type="checkbox"
                .checked=${includeDefaultMemory}
                ?disabled=${!canEdit}
                @change=${(event: Event) =>
                  params.onConfigPatch(
                    ["memory", "qmd", "includeDefaultMemory"],
                    (event.target as HTMLInputElement).checked,
                  )}
              />
              <span class="cfg-toggle__track"></span>
              <span>Index memory roots</span>
            </label>
            <label class="cfg-toggle">
              <input
                type="checkbox"
                .checked=${qmdSessionIndexing}
                ?disabled=${!canEdit}
                @change=${(event: Event) =>
                  params.onConfigPatch(
                    ["memory", "qmd", "sessions", "enabled"],
                    (event.target as HTMLInputElement).checked,
                  )}
              />
              <span class="cfg-toggle__track"></span>
              <span>Index session archives</span>
            </label>
          </div>
        </div>
      </details>

      <details class="agent-memory-details">
        <summary><span>Session archive filename state</span></summary>
        <div class="agent-memory-details__body">${renderFilenameDiagnostics(params.memory)}</div>
      </details>

      <details class="agent-memory-details">
        <summary><span>Validation findings</span></summary>
        <div class="agent-memory-details__body">${renderValidationFindings(params.memory)}</div>
      </details>

      <details class="agent-memory-details">
        <summary><span>Dreaming status</span></summary>
        <div class="agent-memory-details__body">${renderDreamingSummary(params.memory)}</div>
      </details>
    </section>
  `;
}
