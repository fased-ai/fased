import { html, nothing } from "lit";
import type { ChannelOnboardingUiAccess, ChannelOnboardingUiDmPolicy } from "../types.ts";
import type { ChannelsProps } from "./channels.types.ts";

type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type ChannelAccessPolicy = "allowlist" | "open" | "disabled";

const DM_POLICY_OPTIONS: Array<{ value: DmPolicy; label: string }> = [
  { value: "pairing", label: "Pairing" },
  { value: "allowlist", label: "Allowlist" },
  { value: "open", label: "Open" },
  { value: "disabled", label: "Disabled" },
];

const CHANNEL_ACCESS_OPTIONS: Array<{ value: ChannelAccessPolicy; label: string }> = [
  { value: "allowlist", label: "Allowlist (recommended)" },
  { value: "open", label: "Open (allow all channels)" },
  { value: "disabled", label: "Disabled (block all channels)" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function channelConfig(props: ChannelsProps, channelId: string): Record<string, unknown> {
  const channels = props.configForm?.channels;
  if (!isRecord(channels)) {
    return {};
  }
  const value = channels[channelId];
  return isRecord(value) ? value : {};
}

function pathFromKey(key: string): Array<string | number> {
  return key
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function valueAtPath(root: unknown, path: Array<string | number>): unknown {
  let current = root;
  for (const part of path) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function splitAllowFrom(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n]/g)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function patchAllowFrom(props: ChannelsProps, channelId: string, raw: string) {
  const entries = splitAllowFrom(raw);
  if (entries.length === 0) {
    props.onConfigRemove(["channels", channelId, "allowFrom"]);
    return;
  }
  props.onConfigPatch(["channels", channelId, "allowFrom"], entries);
}

function patchDmPolicy(props: ChannelsProps, channelId: string, policy: DmPolicy) {
  props.onConfigPatch(["channels", channelId, "dmPolicy"], policy);
  if (policy === "open") {
    const current = readStringArray(channelConfig(props, channelId).allowFrom);
    if (!current.includes("*")) {
      props.onConfigPatch(["channels", channelId, "allowFrom"], [...current, "*"]);
    }
  }
}

function patchDmPolicyAtPath(
  props: ChannelsProps,
  policyPath: Array<string | number>,
  allowFromPath: Array<string | number>,
  policy: DmPolicy,
) {
  props.onConfigPatch(policyPath, policy);
  if (policy === "open") {
    const current = readStringArray(valueAtPath(props.configForm, allowFromPath));
    if (!current.includes("*")) {
      props.onConfigPatch(allowFromPath, [...current, "*"]);
    }
  }
}

function patchAllowFromAtPath(
  props: ChannelsProps,
  allowFromPath: Array<string | number>,
  raw: string,
) {
  const entries = splitAllowFrom(raw);
  if (entries.length === 0) {
    props.onConfigRemove(allowFromPath);
    return;
  }
  props.onConfigPatch(allowFromPath, entries);
}

function patchGroupPolicy(props: ChannelsProps, channelId: string, policy: ChannelAccessPolicy) {
  props.onConfigPatch(["channels", channelId, "groupPolicy"], policy);
}

function splitList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n]/g)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function normalizeDiscordNameKey(value: string) {
  return value
    .trim()
    .replace(/^#/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function readDiscordChannelEntries(config: Record<string, unknown>): string {
  const guilds = isRecord(config.guilds) ? config.guilds : {};
  const entries: string[] = [];
  for (const [guildKey, rawGuild] of Object.entries(guilds)) {
    if (!isRecord(rawGuild)) {
      continue;
    }
    const channels = isRecord(rawGuild.channels) ? rawGuild.channels : {};
    const channelKeys = Object.keys(channels);
    if (channelKeys.length === 0) {
      entries.push(guildKey);
      continue;
    }
    for (const channelKey of channelKeys) {
      entries.push(guildKey === "*" ? channelKey : `${guildKey}/${channelKey}`);
    }
  }
  return entries.join(", ");
}

function patchDiscordChannelEntries(props: ChannelsProps, raw: string) {
  const entries = splitList(raw);
  if (entries.length === 0) {
    props.onConfigRemove(["channels", "discord", "guilds"]);
    return;
  }
  const guilds: Record<string, { channels?: Record<string, { allow: true }> }> = {};
  for (const entry of entries) {
    const text = entry.trim();
    if (!text) {
      continue;
    }
    const slash = text.indexOf("/");
    const hash = text.indexOf("#");
    const splitAt = slash >= 0 ? slash : hash > 0 ? hash : -1;
    if (splitAt >= 0) {
      const guildKey = normalizeDiscordNameKey(text.slice(0, splitAt)) || "*";
      const channelKey = normalizeDiscordNameKey(text.slice(splitAt + 1));
      if (!channelKey) {
        guilds[guildKey] ??= {};
        continue;
      }
      const guild = (guilds[guildKey] ??= {});
      guild.channels = { ...guild.channels, [channelKey]: { allow: true } };
      continue;
    }
    if (/^(?:guild:|server:)?\d+$/i.test(text)) {
      guilds[text.replace(/^(?:guild:|server:)/i, "")] ??= {};
      continue;
    }
    const channelKey = normalizeDiscordNameKey(text);
    if (!channelKey) {
      continue;
    }
    const wildcard = (guilds["*"] ??= {});
    wildcard.channels = { ...wildcard.channels, [channelKey]: { allow: true } };
  }
  props.onConfigPatch(["channels", "discord", "guilds"], guilds);
}

function readSimpleChannelEntries(config: Record<string, unknown>): string {
  const channels = isRecord(config.channels) ? config.channels : {};
  return Object.entries(channels)
    .filter(([, raw]) => !isRecord(raw) || (raw.allow !== false && raw.enabled !== false))
    .map(([key]) => key)
    .join(", ");
}

function readIrcChannelEntries(config: Record<string, unknown>): string {
  const groups = isRecord(config.groups) ? config.groups : {};
  return Object.keys(groups).join(", ");
}

function readMSTeamsChannelEntries(config: Record<string, unknown>): string {
  const teams = isRecord(config.teams) ? config.teams : {};
  const entries: string[] = [];
  for (const [teamKey, rawTeam] of Object.entries(teams)) {
    if (!isRecord(rawTeam)) {
      entries.push(teamKey);
      continue;
    }
    const channels = isRecord(rawTeam.channels) ? rawTeam.channels : {};
    const channelKeys = Object.keys(channels);
    if (channelKeys.length === 0) {
      entries.push(teamKey);
      continue;
    }
    for (const channelKey of channelKeys) {
      entries.push(`${teamKey}/${channelKey}`);
    }
  }
  return entries.join(", ");
}

function readMatrixRoomEntries(config: Record<string, unknown>): string {
  const groups = isRecord(config.groups)
    ? config.groups
    : isRecord(config.rooms)
      ? config.rooms
      : {};
  return Object.keys(groups).join(", ");
}

function readZalouserGroupEntries(config: Record<string, unknown>): string {
  const groups = isRecord(config.groups) ? config.groups : {};
  return Object.keys(groups).join(", ");
}

function patchSimpleChannelEntries(props: ChannelsProps, channelId: string, raw: string) {
  const entries = splitList(raw);
  if (entries.length === 0) {
    props.onConfigRemove(["channels", channelId, "channels"]);
    return;
  }
  props.onConfigPatch(
    ["channels", channelId, "channels"],
    Object.fromEntries(entries.map((entry) => [entry, { allow: true }])),
  );
}

function normalizeIrcChannelEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return `#${trimmed.replace(/^#+/, "")}`;
}

function patchIrcChannelEntries(props: ChannelsProps, raw: string) {
  const entries = splitList(raw)
    .map((entry) => normalizeIrcChannelEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (entries.length === 0) {
    props.onConfigRemove(["channels", "irc", "groups"]);
    return;
  }
  props.onConfigPatch(
    ["channels", "irc", "groups"],
    Object.fromEntries(entries.map((entry) => [entry, {}])),
  );
}

function patchMSTeamsChannelEntries(props: ChannelsProps, raw: string) {
  const entries = splitList(raw);
  if (entries.length === 0) {
    props.onConfigRemove(["channels", "msteams", "teams"]);
    return;
  }
  const teams: Record<string, { channels?: Record<string, Record<string, never>> }> = {};
  for (const entry of entries) {
    const text = entry.trim();
    if (!text) {
      continue;
    }
    const slash = text.indexOf("/");
    if (slash < 0) {
      teams[text] ??= {};
      continue;
    }
    const teamKey = text.slice(0, slash).trim();
    const channelKey = text.slice(slash + 1).trim();
    if (!teamKey) {
      continue;
    }
    if (!channelKey) {
      teams[teamKey] ??= {};
      continue;
    }
    const team = (teams[teamKey] ??= {});
    team.channels = { ...team.channels, [channelKey]: {} };
  }
  props.onConfigPatch(["channels", "msteams", "teams"], teams);
}

function patchMatrixRoomEntries(props: ChannelsProps, raw: string) {
  const entries = splitList(raw);
  if (entries.length === 0) {
    props.onConfigRemove(["channels", "matrix", "groups"]);
    return;
  }
  props.onConfigPatch(
    ["channels", "matrix", "groups"],
    Object.fromEntries(entries.map((entry) => [entry, { allow: true }])),
  );
}

function patchZalouserGroupEntries(props: ChannelsProps, raw: string) {
  const entries = splitList(raw);
  if (entries.length === 0) {
    props.onConfigRemove(["channels", "zalouser", "groups"]);
    return;
  }
  props.onConfigPatch(
    ["channels", "zalouser", "groups"],
    Object.fromEntries(entries.map((entry) => [entry, { allow: true }])),
  );
}

function renderSaveActions(_props: ChannelsProps) {
  return nothing;
}

function renderPolicySelect(params: {
  props: ChannelsProps;
  channelId: string;
  value: DmPolicy;
  disabled: boolean;
  policyPath?: Array<string | number>;
  allowFromPath?: Array<string | number>;
}) {
  return html`
    <label class="channel-signup-field">
      <span>DM policy</span>
      <select
        class="input"
        .value=${params.value}
        ?disabled=${params.disabled}
        @change=${(event: Event) => {
          const nextPolicy = (event.currentTarget as HTMLSelectElement).value as DmPolicy;
          if (params.policyPath && params.allowFromPath) {
            patchDmPolicyAtPath(params.props, params.policyPath, params.allowFromPath, nextPolicy);
            return;
          }
          patchDmPolicy(params.props, params.channelId, nextPolicy);
        }}
      >
        ${DM_POLICY_OPTIONS.map(
          (option) => html`
            <option value=${option.value} ?selected=${option.value === params.value}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

function renderAllowFromInput(params: {
  props: ChannelsProps;
  channelId: string;
  value: string;
  label: string;
  placeholder: string;
  disabled: boolean;
  allowFromPath?: Array<string | number>;
}) {
  return html`
    <label class="channel-signup-field channel-signup-field--wide">
      <span>${params.label}</span>
      <input
        class="input"
        type="text"
        .value=${params.value}
        placeholder=${params.placeholder}
        ?disabled=${params.disabled}
        @input=${(event: Event) => {
          const value = (event.currentTarget as HTMLInputElement).value;
          if (params.allowFromPath) {
            patchAllowFromAtPath(params.props, params.allowFromPath, value);
            return;
          }
          patchAllowFrom(params.props, params.channelId, value);
        }}
      />
    </label>
  `;
}

function renderWhatsAppDmAccess(params: {
  props: ChannelsProps;
  config: Record<string, unknown>;
  disabled: boolean;
}) {
  const { props, config, disabled } = params;
  const allowFrom = readStringArray(config.allowFrom);
  const allowFromText = allowFrom.join(", ");
  const selfChatMode = config.selfChatMode === true;
  const policy = (typeof config.dmPolicy === "string" ? config.dmPolicy : "pairing") as DmPolicy;
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">WhatsApp DM access</div>
        <div class="channel-dm-note">
          Pairing gives unknown senders an approval code. Personal phone mode uses allowlist.
        </div>
      </div>
      <div class="channel-signup-fields">
        <label class="channel-signup-field">
          <span>Phone setup</span>
          <select
            class="input"
            .value=${selfChatMode ? "personal" : "separate"}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              const mode = (event.currentTarget as HTMLSelectElement).value;
              if (mode === "personal") {
                props.onConfigPatch(["channels", "whatsapp", "selfChatMode"], true);
                props.onConfigPatch(["channels", "whatsapp", "dmPolicy"], "allowlist");
                return;
              }
              props.onConfigPatch(["channels", "whatsapp", "selfChatMode"], false);
              if (!config.dmPolicy) {
                props.onConfigPatch(["channels", "whatsapp", "dmPolicy"], "pairing");
              }
            }}
          >
            <option value="personal">This is my personal phone number</option>
            <option value="separate">Separate phone just for Fased</option>
          </select>
        </label>
        ${
          selfChatMode
            ? nothing
            : renderPolicySelect({
                props,
                channelId: "whatsapp",
                value: policy,
                disabled,
              })
        }
        ${renderAllowFromInput({
          props,
          channelId: "whatsapp",
          value: allowFromText,
          label: selfChatMode
            ? "Your personal WhatsApp number"
            : policy === "open"
              ? 'Allow from ("*" required for open)'
              : "Allow from",
          placeholder: selfChatMode ? "+15555550123" : "+15555550123, +447700900123",
          disabled,
        })}
      </div>
      ${renderSaveActions(props)}
    </div>
  `;
}

function renderDiscordChannelsAccess(params: {
  props: ChannelsProps;
  config: Record<string, unknown>;
  disabled: boolean;
  access?: Extract<ChannelOnboardingUiAccess, { kind: "discord-channels" }>;
}) {
  const { props, config, disabled } = params;
  const label = params.access?.label ?? "Discord channels";
  const policy = (
    config.groupPolicy === "open" || config.groupPolicy === "disabled"
      ? config.groupPolicy
      : "allowlist"
  ) as ChannelAccessPolicy;
  const entries = readDiscordChannelEntries(config);
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">${label} access</div>
        <div class="channel-dm-note">
          ${
            params.access?.note ??
            "Allowlist Discord server channels, open all channels, or block channel messages."
          }
        </div>
      </div>
      <div class="channel-signup-fields">
        <label class="channel-signup-field">
          <span>Channel access</span>
          <select
            class="input"
            .value=${policy}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              patchGroupPolicy(
                props,
                "discord",
                (event.currentTarget as HTMLSelectElement).value as ChannelAccessPolicy,
              );
            }}
          >
            ${CHANNEL_ACCESS_OPTIONS.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === policy}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        ${
          policy === "allowlist"
            ? html`
                <label class="channel-signup-field channel-signup-field--wide">
                  <span>${label} allowlist</span>
                  <input
                    class="input"
                    type="text"
                    .value=${entries}
                    placeholder=${
                      params.access?.placeholder ??
                      "My Server/#general, guildId/channelId, #support"
                    }
                    ?disabled=${disabled}
                    @input=${(event: Event) => {
                      patchDiscordChannelEntries(
                        props,
                        (event.currentTarget as HTMLInputElement).value,
                      );
                    }}
                  />
                </label>
              `
            : nothing
        }
      </div>
      ${renderSaveActions(props)}
    </div>
  `;
}

function renderSlackChannelsAccess(params: {
  props: ChannelsProps;
  config: Record<string, unknown>;
  disabled: boolean;
  access?: Extract<ChannelOnboardingUiAccess, { kind: "slack-channels" }>;
}) {
  const { props, config, disabled } = params;
  const label = params.access?.label ?? "Slack channels";
  const policy = (
    config.groupPolicy === "open" || config.groupPolicy === "disabled"
      ? config.groupPolicy
      : "allowlist"
  ) as ChannelAccessPolicy;
  const entries = readSimpleChannelEntries(config);
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">${label} access</div>
        <div class="channel-dm-note">
          ${
            params.access?.note ??
            "Allowlist Slack channels, open all channels, or block channel messages."
          }
        </div>
      </div>
      <div class="channel-signup-fields">
        <label class="channel-signup-field">
          <span>Channel access</span>
          <select
            class="input"
            .value=${policy}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              patchGroupPolicy(
                props,
                "slack",
                (event.currentTarget as HTMLSelectElement).value as ChannelAccessPolicy,
              );
            }}
          >
            ${CHANNEL_ACCESS_OPTIONS.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === policy}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        ${
          policy === "allowlist"
            ? html`
                <label class="channel-signup-field channel-signup-field--wide">
                  <span>${label} allowlist</span>
                  <input
                    class="input"
                    type="text"
                    .value=${entries}
                    placeholder=${params.access?.placeholder ?? "#general, #private, C123"}
                    ?disabled=${disabled}
                    @input=${(event: Event) => {
                      patchSimpleChannelEntries(
                        props,
                        "slack",
                        (event.currentTarget as HTMLInputElement).value,
                      );
                    }}
                  />
                </label>
              `
            : nothing
        }
      </div>
      ${renderSaveActions(props)}
    </div>
  `;
}

function renderIrcChannelsAccess(params: {
  props: ChannelsProps;
  config: Record<string, unknown>;
  disabled: boolean;
  access?: Extract<ChannelOnboardingUiAccess, { kind: "irc-channels" }>;
}) {
  const { props, config, disabled } = params;
  const label = params.access?.label ?? "IRC channels";
  const policy = (
    config.groupPolicy === "open" || config.groupPolicy === "disabled"
      ? config.groupPolicy
      : "allowlist"
  ) as ChannelAccessPolicy;
  const entries = readIrcChannelEntries(config);
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">${label} access</div>
        <div class="channel-dm-note">
          ${params.access?.note ?? "Allowlist IRC channels, open all channels, or block channel messages."}
        </div>
      </div>
      <div class="channel-signup-fields">
        <label class="channel-signup-field">
          <span>Channel access</span>
          <select
            class="input"
            .value=${policy}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              patchGroupPolicy(
                props,
                "irc",
                (event.currentTarget as HTMLSelectElement).value as ChannelAccessPolicy,
              );
            }}
          >
            ${CHANNEL_ACCESS_OPTIONS.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === policy}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        ${
          policy === "allowlist"
            ? html`
                <label class="channel-signup-field channel-signup-field--wide">
                  <span>${label} allowlist</span>
                  <input
                    class="input"
                    type="text"
                    .value=${entries}
                    placeholder=${params.access?.placeholder ?? "#fased, #ops"}
                    ?disabled=${disabled}
                    @input=${(event: Event) => {
                      patchIrcChannelEntries(
                        props,
                        (event.currentTarget as HTMLInputElement).value,
                      );
                    }}
                  />
                </label>
              `
            : nothing
        }
      </div>
      ${renderSaveActions(props)}
    </div>
  `;
}

function renderMSTeamsChannelsAccess(params: {
  props: ChannelsProps;
  config: Record<string, unknown>;
  disabled: boolean;
  access?: Extract<ChannelOnboardingUiAccess, { kind: "msteams-channels" }>;
}) {
  const { props, config, disabled } = params;
  const label = params.access?.label ?? "MS Teams channels";
  const policy = (
    config.groupPolicy === "open" || config.groupPolicy === "disabled"
      ? config.groupPolicy
      : "allowlist"
  ) as ChannelAccessPolicy;
  const entries = readMSTeamsChannelEntries(config);
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">${label} access</div>
        <div class="channel-dm-note">
          ${
            params.access?.note ??
            "Allowlist Teams channels, open all channels, or block channel messages."
          }
        </div>
      </div>
      <div class="channel-signup-fields">
        <label class="channel-signup-field">
          <span>Channel access</span>
          <select
            class="input"
            .value=${policy}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              patchGroupPolicy(
                props,
                "msteams",
                (event.currentTarget as HTMLSelectElement).value as ChannelAccessPolicy,
              );
            }}
          >
            ${CHANNEL_ACCESS_OPTIONS.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === policy}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        ${
          policy === "allowlist"
            ? html`
                <label class="channel-signup-field channel-signup-field--wide">
                  <span>${label} allowlist</span>
                  <input
                    class="input"
                    type="text"
                    .value=${entries}
                    placeholder=${
                      params.access?.placeholder ?? "Team Name/Channel Name, teamId/conversationId"
                    }
                    ?disabled=${disabled}
                    @input=${(event: Event) => {
                      patchMSTeamsChannelEntries(
                        props,
                        (event.currentTarget as HTMLInputElement).value,
                      );
                    }}
                  />
                </label>
              `
            : nothing
        }
      </div>
      ${renderSaveActions(props)}
    </div>
  `;
}

function renderMatrixRoomsAccess(params: {
  props: ChannelsProps;
  config: Record<string, unknown>;
  disabled: boolean;
  access?: Extract<ChannelOnboardingUiAccess, { kind: "matrix-rooms" }>;
}) {
  const { props, config, disabled } = params;
  const label = params.access?.label ?? "Matrix rooms";
  const policy = (
    config.groupPolicy === "open" || config.groupPolicy === "disabled"
      ? config.groupPolicy
      : "allowlist"
  ) as ChannelAccessPolicy;
  const entries = readMatrixRoomEntries(config);
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">${label} access</div>
        <div class="channel-dm-note">
          ${params.access?.note ?? "Allowlist Matrix rooms, open all rooms, or block room messages."}
        </div>
      </div>
      <div class="channel-signup-fields">
        <label class="channel-signup-field">
          <span>Room access</span>
          <select
            class="input"
            .value=${policy}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              patchGroupPolicy(
                props,
                "matrix",
                (event.currentTarget as HTMLSelectElement).value as ChannelAccessPolicy,
              );
            }}
          >
            ${CHANNEL_ACCESS_OPTIONS.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === policy}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        ${
          policy === "allowlist"
            ? html`
                <label class="channel-signup-field channel-signup-field--wide">
                  <span>${label} allowlist</span>
                  <input
                    class="input"
                    type="text"
                    .value=${entries}
                    placeholder=${
                      params.access?.placeholder ?? "!roomId:server, #alias:server, Project Room"
                    }
                    ?disabled=${disabled}
                    @input=${(event: Event) => {
                      patchMatrixRoomEntries(
                        props,
                        (event.currentTarget as HTMLInputElement).value,
                      );
                    }}
                  />
                </label>
              `
            : nothing
        }
      </div>
      ${renderSaveActions(props)}
    </div>
  `;
}

function renderZalouserGroupsAccess(params: {
  props: ChannelsProps;
  config: Record<string, unknown>;
  disabled: boolean;
  access?: Extract<ChannelOnboardingUiAccess, { kind: "zalouser-groups" }>;
}) {
  const { props, config, disabled } = params;
  const label = params.access?.label ?? "Zalo groups";
  const policy = (
    config.groupPolicy === "open" || config.groupPolicy === "disabled"
      ? config.groupPolicy
      : "allowlist"
  ) as ChannelAccessPolicy;
  const entries = readZalouserGroupEntries(config);
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">${label} access</div>
        <div class="channel-dm-note">
          ${params.access?.note ?? "Allowlist Zalo groups, open all groups, or block group messages."}
        </div>
      </div>
      <div class="channel-signup-fields">
        <label class="channel-signup-field">
          <span>Group access</span>
          <select
            class="input"
            .value=${policy}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              patchGroupPolicy(
                props,
                "zalouser",
                (event.currentTarget as HTMLSelectElement).value as ChannelAccessPolicy,
              );
            }}
          >
            ${CHANNEL_ACCESS_OPTIONS.map(
              (option) => html`
                <option value=${option.value} ?selected=${option.value === policy}>
                  ${option.label}
                </option>
              `,
            )}
          </select>
        </label>
        ${
          policy === "allowlist"
            ? html`
                <label class="channel-signup-field channel-signup-field--wide">
                  <span>${label} allowlist</span>
                  <input
                    class="input"
                    type="text"
                    .value=${entries}
                    placeholder=${params.access?.placeholder ?? "Family, Work, 123456789"}
                    ?disabled=${disabled}
                    @input=${(event: Event) => {
                      patchZalouserGroupEntries(
                        props,
                        (event.currentTarget as HTMLInputElement).value,
                      );
                    }}
                  />
                </label>
              `
            : nothing
        }
      </div>
      ${renderSaveActions(props)}
    </div>
  `;
}

function renderGenericDmPolicyAccess(params: {
  props: ChannelsProps;
  channelId: string;
  dmPolicy: ChannelOnboardingUiDmPolicy;
  disabled: boolean;
}) {
  const policyPath = pathFromKey(params.dmPolicy.policyKey);
  const allowFromPath = pathFromKey(params.dmPolicy.allowFromKey);
  const policy = (valueAtPath(params.props.configForm, policyPath) ?? "pairing") as DmPolicy;
  const allowFrom = readStringArray(valueAtPath(params.props.configForm, allowFromPath));
  return html`
    <div class="channel-dm-card">
      <div>
        <div class="channel-dm-title">DM access</div>
      </div>
      <div class="channel-signup-fields">
        ${renderPolicySelect({
          props: params.props,
          channelId: params.channelId,
          value: policy,
          disabled: params.disabled,
          policyPath,
          allowFromPath,
        })}
        ${renderAllowFromInput({
          props: params.props,
          channelId: params.channelId,
          value: allowFrom.join(", "),
          label: policy === "open" ? 'Allow from ("*" required for open)' : "Allow from",
          placeholder: "* or sender IDs",
          disabled: params.disabled,
          allowFromPath,
        })}
      </div>
      ${renderSaveActions(params.props)}
    </div>
  `;
}

export function renderChannelDmAccessCard(params: {
  props: ChannelsProps;
  channelId: string;
  label?: string;
  access?: ChannelOnboardingUiAccess;
  dmPolicy?: ChannelOnboardingUiDmPolicy;
}) {
  const { props, channelId } = params;
  const config = channelConfig(props, channelId);
  const disabled = props.configSaving || props.configSchemaLoading || !props.configForm;
  if (channelId === "whatsapp") {
    return renderWhatsAppDmAccess({ props, config, disabled });
  }
  if (channelId === "discord") {
    return renderDiscordChannelsAccess({
      props,
      config,
      disabled,
      access: params.access?.kind === "discord-channels" ? params.access : undefined,
    });
  }
  if (channelId === "slack") {
    return renderSlackChannelsAccess({
      props,
      config,
      disabled,
      access: params.access?.kind === "slack-channels" ? params.access : undefined,
    });
  }
  if (channelId === "irc") {
    return renderIrcChannelsAccess({
      props,
      config,
      disabled,
      access: params.access?.kind === "irc-channels" ? params.access : undefined,
    });
  }
  if (channelId === "msteams") {
    return renderMSTeamsChannelsAccess({
      props,
      config,
      disabled,
      access: params.access?.kind === "msteams-channels" ? params.access : undefined,
    });
  }
  if (channelId === "matrix" && params.access?.kind === "matrix-rooms") {
    return renderMatrixRoomsAccess({
      props,
      config,
      disabled,
      access: params.access,
    });
  }
  if (channelId === "zalouser" && params.access?.kind === "zalouser-groups") {
    return renderZalouserGroupsAccess({
      props,
      config,
      disabled,
      access: params.access,
    });
  }
  if (params.dmPolicy) {
    return renderGenericDmPolicyAccess({
      props,
      channelId,
      dmPolicy: params.dmPolicy,
      disabled,
    });
  }
  return nothing;
}
