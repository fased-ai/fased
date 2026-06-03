import { html, nothing } from "lit";
import type { ChannelsProps } from "./channels.types.ts";

type CommandConfig = Record<string, unknown>;

const COMMAND_MODES = [
  ["default", "Default"],
  ["on", "On"],
  ["off", "Off"],
] as const;

const NATIVE_COMMAND_MODES = [
  ["auto", "Auto"],
  ["on", "On"],
  ["off", "Off"],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function commandsConfig(props: ChannelsProps): CommandConfig {
  const commands = props.configForm?.commands;
  return isRecord(commands) ? commands : {};
}

function booleanCommandMode(value: unknown): "default" | "on" | "off" {
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  return "default";
}

function nativeCommandMode(value: unknown): "auto" | "on" | "off" {
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  return "auto";
}

function patchBooleanMode(
  props: ChannelsProps,
  path: Array<string | number>,
  value: "default" | "on" | "off",
) {
  if (value === "default") {
    props.onConfigRemove(path);
    return;
  }
  props.onConfigPatch(path, value === "on");
}

function patchNativeMode(
  props: ChannelsProps,
  path: Array<string | number>,
  value: "auto" | "on" | "off",
) {
  if (value === "auto") {
    props.onConfigRemove(path);
    return;
  }
  props.onConfigPatch(path, value === "on");
}

function parseList(value: string): Array<string | number> {
  return value
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parsed = Number(entry);
      return Number.isSafeInteger(parsed) && String(parsed) === entry ? parsed : entry;
    });
}

function patchList(props: ChannelsProps, path: Array<string | number>, value: string) {
  const entries = parseList(value);
  if (entries.length > 0) {
    props.onConfigPatch(path, entries);
  } else {
    props.onConfigRemove(path);
  }
}

function formatList(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map((entry) => String(entry)).join("\n");
}

function formatAllowFrom(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function patchAllowFrom(props: ChannelsProps, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    props.onConfigRemove(["commands", "allowFrom"]);
    return;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      props.onConfigPatch(["commands", "allowFrom"], parsed);
    }
  } catch {
    // Leave the config untouched while the user is still editing invalid JSON.
  }
}

function fieldSelect(params: {
  label: string;
  value: string;
  disabled: boolean;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return html`
    <label class="channel-message-field">
      <span>${params.label}</span>
      <select
        class="input"
        .value=${params.value}
        ?disabled=${params.disabled}
        @change=${(event: Event) => params.onChange((event.target as HTMLSelectElement).value)}
      >
        ${params.options.map(
          ([value, label]) =>
            html`<option value=${value} ?selected=${params.value === value}>${label}</option>`,
        )}
      </select>
    </label>
  `;
}

function fieldTextarea(params: {
  label: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  rows?: number;
  onInput: (value: string) => void;
}) {
  return html`
    <label class="channel-message-field channel-message-field--wide">
      <span>${params.label}</span>
      <textarea
        class="input"
        rows=${String(params.rows ?? 3)}
        .value=${params.value}
        placeholder=${params.placeholder ?? ""}
        ?disabled=${params.disabled}
        @input=${(event: Event) => params.onInput((event.target as HTMLTextAreaElement).value)}
      ></textarea>
    </label>
  `;
}

function renderCommandCard(title: string, body: unknown) {
  return html`
    <section class="channel-message-card">
      <div class="channel-message-card-title">${title}</div>
      <div class="channel-message-grid">${body}</div>
    </section>
  `;
}

export function renderChannelCommandsPanel(props: ChannelsProps) {
  const disabled = props.configSaving || !props.configForm;
  const commands = commandsConfig(props);

  return html`
    <section class="channel-message-panel">
      ${
        !props.configForm
          ? html`
              <div class="callout info">Load config before editing command policy.</div>
            `
          : nothing
      }
      ${renderCommandCard(
        "Command Behavior",
        html`
          ${fieldSelect({
            label: "Text commands",
            value: booleanCommandMode(commands.text),
            disabled,
            options: COMMAND_MODES,
            onChange: (value) =>
              patchBooleanMode(props, ["commands", "text"], value as "default" | "on" | "off"),
          })}
          ${fieldSelect({
            label: "Native commands",
            value: nativeCommandMode(commands.native),
            disabled,
            options: NATIVE_COMMAND_MODES,
            onChange: (value) =>
              patchNativeMode(props, ["commands", "native"], value as "auto" | "on" | "off"),
          })}
          ${fieldSelect({
            label: "Native skill commands",
            value: nativeCommandMode(commands.nativeSkills),
            disabled,
            options: NATIVE_COMMAND_MODES,
            onChange: (value) =>
              patchNativeMode(props, ["commands", "nativeSkills"], value as "auto" | "on" | "off"),
          })}
        `,
      )}
      ${renderCommandCard(
        "Command Access",
        html`
          ${fieldSelect({
            label: "Use access groups",
            value: booleanCommandMode(commands.useAccessGroups),
            disabled,
            options: COMMAND_MODES,
            onChange: (value) =>
              patchBooleanMode(
                props,
                ["commands", "useAccessGroups"],
                value as "default" | "on" | "off",
              ),
          })}
          ${fieldTextarea({
            label: "Owner allowlist",
            value: formatList(commands.ownerAllowFrom),
            disabled,
            placeholder: "telegram:123456789\ndiscord:user:123",
            onInput: (value) => patchList(props, ["commands", "ownerAllowFrom"], value),
          })}
          ${fieldTextarea({
            label: "Command allowlist JSON",
            value: formatAllowFrom(commands.allowFrom),
            disabled,
            rows: 5,
            placeholder: '{ "*": ["telegram:123456789"], "discord": ["user:123"] }',
            onInput: (value) => patchAllowFrom(props, value),
          })}
        `,
      )}
      <div class="channel-message-actions">
        <button
          class="btn primary"
          ?disabled=${props.configSaving || !props.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.configSaving ? "Saving..." : "Save"}
        </button>
        <button class="btn" ?disabled=${props.configSaving} @click=${() => props.onConfigReload()}>
          Reload
        </button>
      </div>
    </section>
  `;
}
