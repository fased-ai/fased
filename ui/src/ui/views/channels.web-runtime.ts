import { html, nothing } from "lit";
import type { ChannelsProps } from "./channels.types.ts";

const TOGGLE_OPTIONS = [
  ["", "Default"],
  ["on", "On"],
  ["off", "Off"],
] as const;

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

function patchToggle(props: ChannelsProps, path: Array<string | number>, value: "" | "on" | "off") {
  if (!value) {
    props.onConfigRemove(path);
    return;
  }
  props.onConfigPatch(path, value === "on");
}

function patchPositiveIntegerOrRemove(
  props: ChannelsProps,
  path: Array<string | number>,
  value: string,
) {
  const next = value.trim();
  if (!next) {
    props.onConfigRemove(path);
    return;
  }
  const parsed = Number(next);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    props.onConfigPatch(path, parsed);
  }
}

function patchPositiveNumberOrRemove(
  props: ChannelsProps,
  path: Array<string | number>,
  value: string,
) {
  const next = value.trim();
  if (!next) {
    props.onConfigRemove(path);
    return;
  }
  const parsed = Number(next);
  if (Number.isFinite(parsed) && parsed > 0) {
    props.onConfigPatch(path, parsed);
  }
}

function patchJitterOrRemove(props: ChannelsProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (!next) {
    props.onConfigRemove(path);
    return;
  }
  const parsed = Number(next);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    props.onConfigPatch(path, parsed);
  }
}

function renderSelect(params: {
  label: string;
  value: "" | "on" | "off";
  disabled: boolean;
  onChange: (value: "" | "on" | "off") => void;
}) {
  return html`
    <label class="channel-message-field">
      <span>${params.label}</span>
      <select
        class="input"
        aria-label=${params.label}
        .value=${params.value}
        ?disabled=${params.disabled}
        @change=${(event: Event) =>
          params.onChange((event.target as HTMLSelectElement).value as "" | "on" | "off")}
      >
        ${TOGGLE_OPTIONS.map(
          ([value, label]) =>
            html`<option value=${value} ?selected=${params.value === value}>${label}</option>`,
        )}
      </select>
    </label>
  `;
}

function renderNumber(params: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  min?: string;
  max?: string;
  step?: string;
  onInput: (value: string) => void;
}) {
  return html`
    <label class="channel-message-field">
      <span>${params.label}</span>
      <input
        class="input"
        aria-label=${params.label}
        type="number"
        min=${params.min ?? "1"}
        max=${params.max ?? nothing}
        step=${params.step ?? "1"}
        .value=${params.value}
        placeholder=${params.placeholder}
        ?disabled=${params.disabled}
        @input=${(event: Event) => params.onInput((event.target as HTMLInputElement).value)}
      />
    </label>
  `;
}

function renderWebRuntimeCard(title: string, body: unknown) {
  return html`
    <section class="channel-message-card">
      <div class="channel-message-card-title">${title}</div>
      <div class="channel-message-grid">${body}</div>
    </section>
  `;
}

export function renderChannelWebRuntimePanel(props: ChannelsProps) {
  const config = props.configForm;
  const disabled = props.configSaving || !config;
  return html`
    <section class="channel-message-panel">
      ${
        !config
          ? html`
              <div class="callout info">Load config before editing web-client runtime.</div>
            `
          : nothing
      }
      ${renderWebRuntimeCard(
        "Web Client Runtime",
        html`
          ${renderSelect({
            label: "Runtime",
            value: toggleValue(config, ["web", "enabled"]),
            disabled,
            onChange: (value) => patchToggle(props, ["web", "enabled"], value),
          })}
          ${renderNumber({
            label: "Heartbeat seconds",
            value: stringValue(config, ["web", "heartbeatSeconds"]),
            placeholder: "60",
            disabled,
            onInput: (value) =>
              patchPositiveIntegerOrRemove(props, ["web", "heartbeatSeconds"], value),
          })}
        `,
      )}
      ${renderWebRuntimeCard(
        "Reconnect Policy",
        html`
          ${renderNumber({
            label: "Initial ms",
            value: stringValue(config, ["web", "reconnect", "initialMs"]),
            placeholder: "2000",
            disabled,
            onInput: (value) =>
              patchPositiveNumberOrRemove(props, ["web", "reconnect", "initialMs"], value),
          })}
          ${renderNumber({
            label: "Max ms",
            value: stringValue(config, ["web", "reconnect", "maxMs"]),
            placeholder: "30000",
            disabled,
            onInput: (value) =>
              patchPositiveNumberOrRemove(props, ["web", "reconnect", "maxMs"], value),
          })}
          ${renderNumber({
            label: "Factor",
            value: stringValue(config, ["web", "reconnect", "factor"]),
            placeholder: "1.8",
            disabled,
            min: "1.1",
            step: "0.1",
            onInput: (value) =>
              patchPositiveNumberOrRemove(props, ["web", "reconnect", "factor"], value),
          })}
          ${renderNumber({
            label: "Jitter",
            value: stringValue(config, ["web", "reconnect", "jitter"]),
            placeholder: "0.25",
            disabled,
            min: "0",
            max: "1",
            step: "0.05",
            onInput: (value) => patchJitterOrRemove(props, ["web", "reconnect", "jitter"], value),
          })}
          ${renderNumber({
            label: "Max attempts",
            value: stringValue(config, ["web", "reconnect", "maxAttempts"]),
            placeholder: "12",
            disabled,
            onInput: (value) =>
              patchPositiveIntegerOrRemove(props, ["web", "reconnect", "maxAttempts"], value),
          })}
        `,
      )}
      <div class="channel-message-actions">
        <button
          class="btn primary"
          ?disabled=${props.configSaving || !props.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.configSaving ? "Saving..." : "Save web runtime"}
        </button>
        <button class="btn" ?disabled=${props.configSaving} @click=${() => props.onConfigReload()}>
          Reload
        </button>
      </div>
    </section>
  `;
}
