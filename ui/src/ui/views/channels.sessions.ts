import { html } from "lit";
import type { ChannelsProps } from "./channels.types.ts";

type SessionResetKind = "direct" | "group" | "thread";

const DM_SCOPE_OPTIONS = [
  ["", "Default"],
  ["main", "Main session"],
  ["per-peer", "Per peer"],
  ["per-channel-peer", "Per channel + peer"],
  ["per-account-channel-peer", "Per account + channel + peer"],
] as const;

const TOGGLE_OPTIONS = [
  ["", "Default"],
  ["on", "On"],
  ["off", "Off"],
] as const;

const RESET_MODE_OPTIONS = [
  ["", "Default"],
  ["daily", "Daily"],
  ["idle", "Idle"],
] as const;

const RESET_KINDS: Array<{ key: SessionResetKind; label: string }> = [
  { key: "direct", label: "Direct" },
  { key: "group", label: "Group" },
  { key: "thread", label: "Thread" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function stringValue(root: unknown, path: ReadonlyArray<string | number>): string {
  const value = readPath(root, path);
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function toggleValue(root: unknown, path: ReadonlyArray<string | number>): "" | "on" | "off" {
  const value = readPath(root, path);
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  return "";
}

function patchStringOrRemove(props: ChannelsProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (next) {
    props.onConfigPatch(path, next);
  } else {
    props.onConfigRemove(path);
  }
}

function patchIntegerOrRemove(props: ChannelsProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (!next) {
    props.onConfigRemove(path);
    return;
  }
  const parsed = Number(next);
  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    props.onConfigPatch(path, parsed);
  }
}

function patchToggle(props: ChannelsProps, path: Array<string | number>, value: "" | "on" | "off") {
  if (!value) {
    props.onConfigRemove(path);
    return;
  }
  props.onConfigPatch(path, value === "on");
}

function formatIdentityLinks(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function patchIdentityLinks(props: ChannelsProps, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    props.onConfigRemove(["session", "identityLinks"]);
    return;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      props.onConfigPatch(["session", "identityLinks"], parsed);
    }
  } catch {
    // Keep current config while the field contains incomplete JSON.
  }
}

function renderResetRule(props: ChannelsProps, kind: SessionResetKind, label: string) {
  const config = props.configForm;
  const basePath = ["session", "resetByType", kind] as const;
  const mode = stringValue(config, [...basePath, "mode"]);
  const idleMinutes = stringValue(config, [...basePath, "idleMinutes"]);
  const atHour = stringValue(config, [...basePath, "atHour"]);
  const disabled = props.configSaving;
  return html`
    <div class="channel-message-card">
      <div class="channel-message-card-title">${label}</div>
      <div class="channel-message-grid">
        <label class="channel-message-field">
          <span>Mode</span>
          <select
            class="input"
            ?disabled=${disabled}
            @change=${(event: Event) =>
              patchStringOrRemove(
                props,
                [...basePath, "mode"],
                (event.target as HTMLSelectElement).value,
              )}
          >
            ${RESET_MODE_OPTIONS.map(
              ([value, optionLabel]) =>
                html`<option value=${value} ?selected=${mode === value}>
                  ${optionLabel}
                </option>`,
            )}
          </select>
        </label>
        <label class="channel-message-field">
          <span>Idle minutes</span>
          <input
            class="input"
            .value=${idleMinutes}
            inputmode="numeric"
            placeholder="60"
            ?disabled=${disabled}
            @change=${(event: Event) =>
              patchIntegerOrRemove(
                props,
                [...basePath, "idleMinutes"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>
        <label class="channel-message-field">
          <span>Daily hour</span>
          <input
            class="input"
            .value=${atHour}
            inputmode="numeric"
            placeholder="4"
            ?disabled=${disabled}
            @change=${(event: Event) =>
              patchIntegerOrRemove(
                props,
                [...basePath, "atHour"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>
      </div>
    </div>
  `;
}

export function renderChannelSessionsPanel(props: ChannelsProps) {
  const config = props.configForm;
  const dmScope = stringValue(config, ["session", "dmScope"]);
  const threadBindingsEnabled = toggleValue(config, ["session", "threadBindings", "enabled"]);
  const threadIdleHours = stringValue(config, ["session", "threadBindings", "idleHours"]);
  const threadMaxAgeHours = stringValue(config, ["session", "threadBindings", "maxAgeHours"]);
  const identityLinks = formatIdentityLinks(readPath(config, ["session", "identityLinks"]));
  const disabled = props.configSaving;
  if (!config) {
    return html`
      <section class="channel-message-panel">
        <section class="channel-message-card">
          <div class="channel-message-card-title">Session Routing</div>
          <div class="muted">Load config to edit channel session routing.</div>
          <div class="channel-message-actions">
            <button class="btn btn--sm" ?disabled=${props.configSchemaLoading} @click=${props.onConfigReload}>
              ${props.configSchemaLoading ? "Loading..." : "Reload config"}
            </button>
          </div>
        </section>
      </section>
    `;
  }
  return html`
    <section class="channel-message-panel">
      <section class="channel-message-card">
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
          <div>
            <div class="channel-message-card-title">Session Routing</div>
          </div>
          <div class="channel-message-actions">
            <button class="btn btn--sm" ?disabled=${props.configSaving} @click=${props.onConfigReload}>
              Reload
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${props.configSaving || !props.configFormDirty}
              @click=${props.onConfigSave}
            >
              ${props.configSaving ? "Saving..." : "Save session routing"}
            </button>
          </div>
        </div>
        <div class="channel-message-grid">
          <label class="channel-message-field">
            <span>DM scope</span>
            <select
              class="input"
              ?disabled=${disabled}
              @change=${(event: Event) =>
                patchStringOrRemove(
                  props,
                  ["session", "dmScope"],
                  (event.target as HTMLSelectElement).value,
                )}
            >
              ${DM_SCOPE_OPTIONS.map(
                ([value, label]) =>
                  html`<option value=${value} ?selected=${dmScope === value}>
                    ${label}
                  </option>`,
              )}
            </select>
          </label>
          <label class="channel-message-field channel-message-field--wide">
            <span>Identity links</span>
            <textarea
              class="input"
              rows="5"
              .value=${identityLinks}
              placeholder='{"person:alex":["telegram:123","discord:456"]}'
              ?disabled=${disabled}
              @change=${(event: Event) =>
                patchIdentityLinks(props, (event.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
        </div>
      </section>

      <section class="channel-message-card">
        <div class="channel-message-card-title">Thread Sessions</div>
        <div class="channel-message-grid">
          <label class="channel-message-field">
            <span>Enabled</span>
            <select
              class="input"
              ?disabled=${disabled}
              @change=${(event: Event) =>
                patchToggle(
                  props,
                  ["session", "threadBindings", "enabled"],
                  (event.target as HTMLSelectElement).value as "" | "on" | "off",
                )}
            >
              ${TOGGLE_OPTIONS.map(
                ([value, label]) =>
                  html`<option value=${value} ?selected=${threadBindingsEnabled === value}>
                    ${label}
                  </option>`,
              )}
            </select>
          </label>
          <label class="channel-message-field">
            <span>Idle hours</span>
            <input
              class="input"
              .value=${threadIdleHours}
              inputmode="numeric"
              placeholder="24"
              ?disabled=${disabled}
              @change=${(event: Event) =>
                patchIntegerOrRemove(
                  props,
                  ["session", "threadBindings", "idleHours"],
                  (event.target as HTMLInputElement).value,
                )}
            />
          </label>
          <label class="channel-message-field">
            <span>Max age hours</span>
            <input
              class="input"
              .value=${threadMaxAgeHours}
              inputmode="numeric"
              placeholder="0"
              ?disabled=${disabled}
              @change=${(event: Event) =>
                patchIntegerOrRemove(
                  props,
                  ["session", "threadBindings", "maxAgeHours"],
                  (event.target as HTMLInputElement).value,
                )}
            />
          </label>
        </div>
      </section>

      <section class="channel-message-card">
        <div class="channel-message-card-title">Reset Rules</div>
        <div class="channel-message-grid">
          ${RESET_KINDS.map((entry) => renderResetRule(props, entry.key, entry.label))}
        </div>
      </section>
    </section>
  `;
}
