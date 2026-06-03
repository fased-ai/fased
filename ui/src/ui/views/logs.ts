import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { LogEntry, LogLevel } from "../types.ts";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export type LogsProps = {
  loading: boolean;
  error: string | null;
  file: string | null;
  entries: LogEntry[];
  configForm?: Record<string, unknown> | null;
  configSaving?: boolean;
  filterText: string;
  levelFilters: Record<LogLevel, boolean>;
  autoFollow: boolean;
  truncated: boolean;
  onConfigPatch?: (path: Array<string | number>, value: unknown) => void;
  onFilterTextChange: (next: string) => void;
  onLevelToggle: (level: LogLevel, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onRefresh: () => void;
  onExport: (lines: string[], label: string) => void;
  onScroll: (event: Event) => void;
};

function formatTime(value?: string | null) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function matchesFilter(entry: LogEntry, needle: string) {
  if (!needle) {
    return true;
  }
  const haystack = [entry.message, entry.subsystem, entry.raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function readConfigString(
  config: Record<string, unknown> | null | undefined,
  path: Array<string | number>,
  fallback: string,
): string {
  let cursor: unknown = config;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return fallback;
    }
    cursor = (cursor as Record<string, unknown>)[String(segment)];
  }
  return typeof cursor === "string" && cursor.trim() ? cursor : fallback;
}

function renderLogSwitch(params: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  tone?: LogLevel;
  onChange: (checked: boolean) => void;
}) {
  return html`
    <label class="logs-switch ${params.tone ? `logs-switch--${params.tone}` : ""}">
      <input
        type="checkbox"
        .checked=${params.checked}
        ?disabled=${params.disabled === true}
        @change=${(event: Event) => params.onChange((event.target as HTMLInputElement).checked)}
      />
      <span class="logs-switch__track" aria-hidden="true">
        <span class="logs-switch__thumb"></span>
      </span>
      <span class="logs-switch__label">${params.label}</span>
    </label>
  `;
}

function renderLoggingConfigCard(props: LogsProps) {
  const config = props.configForm ?? null;
  const canEdit = Boolean(config && props.onConfigPatch);
  const disabled = !canEdit || props.configSaving === true;
  const fileLevel = readConfigString(config, ["logging", "level"], "info");
  const consoleLevel = readConfigString(config, ["logging", "consoleLevel"], "info");
  const consoleStyle = readConfigString(config, ["logging", "consoleStyle"], "pretty");
  const redaction = readConfigString(config, ["logging", "redactSensitive"], "tools");

  const renderSelect = (params: {
    label: string;
    value: string;
    options: string[];
    path: Array<string | number>;
  }) => html`
    <label class="field">
      <span>${params.label}</span>
      <select
        .value=${params.value}
        ?disabled=${disabled}
        @change=${(event: Event) =>
          props.onConfigPatch?.(params.path, (event.target as HTMLSelectElement).value)}
      >
        ${params.options.map(
          (option) =>
            html`<option value=${option} ?selected=${option === params.value}>${option}</option>`,
        )}
      </select>
    </label>
  `;

  return html`
    <details class="card logs-settings">
      <summary class="logs-settings__summary">
        <span class="card-title">Logging</span>
        <span class="logs-settings__status">${props.configSaving ? "Saving..." : "Auto-save"}</span>
      </summary>
      <div class="logs-settings__grid">
        ${renderSelect({
          label: "File level",
          value: fileLevel,
          options: ["silent", "fatal", "error", "warn", "info", "debug", "trace"],
          path: ["logging", "level"],
        })}
        ${renderSelect({
          label: "Console level",
          value: consoleLevel,
          options: ["silent", "fatal", "error", "warn", "info", "debug", "trace"],
          path: ["logging", "consoleLevel"],
        })}
        ${renderSelect({
          label: "Console style",
          value: consoleStyle,
          options: ["pretty", "compact", "json"],
          path: ["logging", "consoleStyle"],
        })}
        ${renderSelect({
          label: "Redaction",
          value: redaction,
          options: ["tools", "off"],
          path: ["logging", "redactSensitive"],
        })}
      </div>
    </details>
  `;
}

function renderLogsStyles() {
  return html`
    <style>
      .logs-shell {
        display: grid;
        gap: 12px;
      }

      .logs-settings {
        padding: 0;
      }

      .logs-settings__summary {
        align-items: center;
        cursor: pointer;
        display: flex;
        gap: 12px;
        justify-content: space-between;
        list-style: none;
        padding: 14px 16px;
      }

      .logs-settings__summary::-webkit-details-marker {
        display: none;
      }

      .logs-settings__summary:hover {
        background: var(--bg-hover);
      }

      .logs-settings__status {
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 760;
        padding: 5px 8px;
        white-space: nowrap;
      }

      .logs-settings__grid {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        padding: 14px 16px 16px;
      }

      .logs-card {
        display: grid;
        gap: 12px;
      }

      .logs-toolbar {
        align-items: end;
        display: grid;
        gap: 10px;
        grid-template-columns: minmax(220px, 1fr) auto auto auto;
      }

      .logs-levels {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .logs-switch {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--muted);
        display: inline-flex;
        gap: 8px;
        min-height: 36px;
        padding: 7px 10px;
      }

      .logs-switch input {
        height: 1px;
        opacity: 0;
        position: absolute;
        width: 1px;
      }

      .logs-switch__track {
        align-items: center;
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: 999px;
        display: inline-flex;
        flex: 0 0 auto;
        height: 18px;
        padding: 2px;
        width: 34px;
      }

      .logs-switch__thumb {
        background: var(--muted);
        border-radius: 999px;
        display: block;
        height: 12px;
        transform: translateX(0);
        transition:
          background var(--duration-fast) ease,
          transform var(--duration-fast) ease;
        width: 12px;
      }

      .logs-switch input:checked + .logs-switch__track .logs-switch__thumb {
        background: var(--text-strong);
        transform: translateX(16px);
      }

      .logs-switch input:disabled + .logs-switch__track {
        opacity: 0.55;
      }

      .logs-switch__label {
        color: inherit;
        font-size: 12px;
        font-weight: 740;
        white-space: nowrap;
      }

      .logs-switch--warn {
        color: var(--warn);
      }

      .logs-switch--error,
      .logs-switch--fatal {
        color: var(--danger);
      }

      .logs-switch--info {
        color: var(--info);
      }

      @media (max-width: 820px) {
        .logs-toolbar {
          align-items: stretch;
          grid-template-columns: 1fr;
        }
      }
    </style>
  `;
}

export function renderLogs(props: LogsProps) {
  const needle = props.filterText.trim().toLowerCase();
  const levelFiltered = LEVELS.some((level) => !props.levelFilters[level]);
  const filtered = props.entries.filter((entry) => {
    if (entry.level && !props.levelFilters[entry.level]) {
      return false;
    }
    return matchesFilter(entry, needle);
  });
  const exportLabel = needle || levelFiltered ? "filtered" : "visible";

  return html`
    <section class="logs-shell">
      ${renderLogsStyles()}
      ${renderLoggingConfigCard(props)}
      <section class="card logs-card">
      <div class="logs-toolbar">
        <label class="field">
          <span>Filter</span>
          <input
            .value=${props.filterText}
            @input=${(e: Event) => props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder="Search logs"
          />
        </label>
        ${renderLogSwitch({
          label: "Auto-follow",
          checked: props.autoFollow,
          onChange: props.onToggleAutoFollow,
        })}
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? t("common.loading") : t("common.refresh")}
          </button>
          <button
            class="btn"
            ?disabled=${filtered.length === 0}
            @click=${() =>
              props.onExport(
                filtered.map((entry) => entry.raw),
                exportLabel,
              )}
          >
            Export ${exportLabel}
          </button>
      </div>

      <div class="logs-levels">
        ${LEVELS.map((level) =>
          renderLogSwitch({
            label: level,
            checked: props.levelFilters[level],
            tone: level,
            onChange: (enabled) => props.onLevelToggle(level, enabled),
          }),
        )}
      </div>

      ${
        props.file
          ? html`<div class="muted" style="margin-top: 10px;">File: ${props.file}</div>`
          : nothing
      }
      ${
        props.truncated
          ? html`
              <div class="callout" style="margin-top: 10px">Log output truncated; showing latest chunk.</div>
            `
          : nothing
      }
      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 10px;">${props.error}</div>`
          : nothing
      }

      <div class="log-stream" style="margin-top: 12px;" @scroll=${props.onScroll}>
        ${
          filtered.length === 0
            ? html`
                <div class="muted" style="padding: 12px">No log entries.</div>
              `
            : filtered.map(
                (entry) => html`
                <div class="log-row">
                  <div class="log-time mono">${formatTime(entry.time)}</div>
                  <div class="log-level ${entry.level ?? ""}">${entry.level ?? ""}</div>
                  <div class="log-subsystem mono">${entry.subsystem ?? ""}</div>
                  <div class="log-message mono">${entry.message ?? entry.raw}</div>
                </div>
              `,
              )
        }
      </div>
      </section>
    </section>
  `;
}
