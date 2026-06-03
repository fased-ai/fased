import { html, nothing } from "lit";
import type { ChannelsProps } from "./channels.types.ts";

type MessageConfig = Record<string, unknown>;

const ACK_SCOPES = [
  ["group-mentions", "Group mentions"],
  ["group-all", "All group messages"],
  ["direct", "Direct messages"],
  ["all", "All messages"],
] as const;

const TTS_AUTO_MODES = [
  ["off", "Off"],
  ["tagged", "Tagged"],
  ["inbound", "Inbound"],
  ["always", "Always"],
] as const;

const TTS_MODES = [
  ["final", "Final replies"],
  ["all", "All reply blocks"],
] as const;

const TTS_PROVIDERS = [
  ["", "Default"],
  ["edge", "Edge"],
  ["openai", "OpenAI"],
  ["elevenlabs", "ElevenLabs"],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function messagesConfig(props: ChannelsProps): MessageConfig {
  const messages = props.configForm?.messages;
  return isRecord(messages) ? messages : {};
}

function childRecord(parent: MessageConfig, key: string): MessageConfig {
  const value = parent[key];
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function patchString(props: ChannelsProps, path: Array<string | number>, value: string) {
  const next = value.trim();
  if (next) {
    props.onConfigPatch(path, next);
  } else {
    props.onConfigRemove(path);
  }
}

function patchOptionalNumber(props: ChannelsProps, path: Array<string | number>, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    props.onConfigRemove(path);
    return;
  }
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) {
    props.onConfigPatch(path, Math.max(0, Math.floor(parsed)));
  }
}

function patchMentionPatterns(props: ChannelsProps, value: string) {
  const patterns = value
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (patterns.length > 0) {
    props.onConfigPatch(["messages", "groupChat", "mentionPatterns"], patterns);
  } else {
    props.onConfigRemove(["messages", "groupChat", "mentionPatterns"]);
  }
}

function fieldText(params: {
  label: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  return html`
    <label class="channel-message-field">
      <span>${params.label}</span>
      <input
        class="input"
        .value=${params.value}
        placeholder=${params.placeholder ?? ""}
        ?disabled=${params.disabled}
        @input=${(event: Event) => params.onInput((event.target as HTMLInputElement).value)}
      />
    </label>
  `;
}

function fieldNumber(params: {
  label: string;
  value: string;
  disabled: boolean;
  placeholder?: string;
  onInput: (value: string) => void;
}) {
  return html`
    <label class="channel-message-field">
      <span>${params.label}</span>
      <input
        class="input"
        type="number"
        min="0"
        .value=${params.value}
        placeholder=${params.placeholder ?? ""}
        ?disabled=${params.disabled}
        @input=${(event: Event) => params.onInput((event.target as HTMLInputElement).value)}
      />
    </label>
  `;
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

function fieldToggle(params: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return html`
    <label class="channel-message-toggle">
      <span>${params.label}</span>
      <input
        type="checkbox"
        .checked=${params.checked}
        ?disabled=${params.disabled}
        @change=${(event: Event) => params.onChange((event.target as HTMLInputElement).checked)}
      />
    </label>
  `;
}

function renderMessageCard(title: string, body: unknown) {
  return html`
    <section class="channel-message-card">
      <div class="channel-message-card-title">${title}</div>
      <div class="channel-message-grid">${body}</div>
    </section>
  `;
}

export function renderChannelMessagesPanel(props: ChannelsProps) {
  const disabled = props.configSaving || !props.configForm;
  const messages = messagesConfig(props);
  const groupChat = childRecord(messages, "groupChat");
  const inbound = childRecord(messages, "inbound");
  const statusReactions = childRecord(messages, "statusReactions");
  const tts = childRecord(messages, "tts");
  const mentionPatterns = Array.isArray(groupChat.mentionPatterns)
    ? groupChat.mentionPatterns.filter((entry): entry is string => typeof entry === "string")
    : [];

  return html`
    <section class="channel-message-panel">
      ${
        !props.configForm
          ? html`
              <div class="callout info">Load config before editing message behavior.</div>
            `
          : nothing
      }
      ${renderMessageCard(
        "Reply Behavior",
        html`
          ${fieldText({
            label: "Reply prefix",
            value: stringValue(messages.responsePrefix),
            disabled,
            placeholder: "none",
            onInput: (value) => patchString(props, ["messages", "responsePrefix"], value),
          })}
          ${fieldToggle({
            label: "Suppress tool error warnings",
            checked: booleanValue(messages.suppressToolErrors),
            disabled,
            onChange: (checked) =>
              checked
                ? props.onConfigPatch(["messages", "suppressToolErrors"], true)
                : props.onConfigRemove(["messages", "suppressToolErrors"]),
          })}
        `,
      )}
      ${renderMessageCard(
        "Ack And Status Reactions",
        html`
          ${fieldText({
            label: "Ack reaction",
            value: stringValue(messages.ackReaction),
            disabled,
            placeholder: "emoji",
            onInput: (value) => patchString(props, ["messages", "ackReaction"], value),
          })}
          ${fieldSelect({
            label: "Ack scope",
            value: stringValue(messages.ackReactionScope) || "group-mentions",
            disabled,
            options: ACK_SCOPES,
            onChange: (value) => props.onConfigPatch(["messages", "ackReactionScope"], value),
          })}
          ${fieldToggle({
            label: "Remove ack after reply",
            checked: booleanValue(messages.removeAckAfterReply),
            disabled,
            onChange: (checked) =>
              checked
                ? props.onConfigPatch(["messages", "removeAckAfterReply"], true)
                : props.onConfigRemove(["messages", "removeAckAfterReply"]),
          })}
          ${fieldToggle({
            label: "Lifecycle status reactions",
            checked: booleanValue(statusReactions.enabled),
            disabled,
            onChange: (checked) =>
              checked
                ? props.onConfigPatch(["messages", "statusReactions", "enabled"], true)
                : props.onConfigRemove(["messages", "statusReactions", "enabled"]),
          })}
        `,
      )}
      ${renderMessageCard(
        "Inbound Debounce",
        html`
          ${fieldNumber({
            label: "Debounce ms",
            value: numberText(inbound.debounceMs),
            disabled,
            placeholder: "0",
            onInput: (value) =>
              patchOptionalNumber(props, ["messages", "inbound", "debounceMs"], value),
          })}
        `,
      )}
      ${renderMessageCard(
        "Group Mention Behavior",
        html`
          <label class="channel-message-field channel-message-field--wide">
            <span>Mention patterns</span>
            <textarea
              class="input"
              rows="3"
              .value=${mentionPatterns.join("\n")}
              placeholder="@fased"
              ?disabled=${disabled}
              @input=${(event: Event) =>
                patchMentionPatterns(props, (event.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
          ${fieldNumber({
            label: "History limit",
            value: numberText(groupChat.historyLimit),
            disabled,
            placeholder: "default",
            onInput: (value) =>
              patchOptionalNumber(props, ["messages", "groupChat", "historyLimit"], value),
          })}
        `,
      )}
      ${renderMessageCard(
        "TTS And Voice",
        html`
          ${fieldSelect({
            label: "Auto TTS",
            value: stringValue(tts.auto) || "off",
            disabled,
            options: TTS_AUTO_MODES,
            onChange: (value) => props.onConfigPatch(["messages", "tts", "auto"], value),
          })}
          ${fieldSelect({
            label: "Reply scope",
            value: stringValue(tts.mode) || "final",
            disabled,
            options: TTS_MODES,
            onChange: (value) => props.onConfigPatch(["messages", "tts", "mode"], value),
          })}
          ${fieldSelect({
            label: "Provider",
            value: stringValue(tts.provider),
            disabled,
            options: TTS_PROVIDERS,
            onChange: (value) =>
              value
                ? props.onConfigPatch(["messages", "tts", "provider"], value)
                : props.onConfigRemove(["messages", "tts", "provider"]),
          })}
          ${fieldNumber({
            label: "Text cap",
            value: numberText(tts.maxTextLength),
            disabled,
            placeholder: "default",
            onInput: (value) =>
              patchOptionalNumber(props, ["messages", "tts", "maxTextLength"], value),
          })}
          ${fieldText({
            label: "Summary model",
            value: stringValue(tts.summaryModel),
            disabled,
            placeholder: "default",
            onInput: (value) => patchString(props, ["messages", "tts", "summaryModel"], value),
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
