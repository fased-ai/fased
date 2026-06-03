import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type {
  ChannelAccountSnapshot,
  ChannelOnboardingUiField,
  ChannelOnboardingUiSetup,
} from "../types.ts";
import { renderChannelDmAccessCard } from "./channels.dm-access.ts";
import type { ChannelKey, ChannelsProps } from "./channels.types.ts";

type SignupField = ChannelOnboardingUiField;
type SignupSpec = ChannelOnboardingUiSetup;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function valueAtPath(root: Record<string, unknown> | null, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!isRecord(current) && !Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function fieldDisplayValue(value: unknown, kind: SignupField["kind"]): string {
  if (Array.isArray(value)) {
    return value
      .filter(
        (entry): entry is string | number => typeof entry === "string" || typeof entry === "number",
      )
      .join(", ");
  }
  if (kind === "number" && typeof value === "number") {
    return String(value);
  }
  if (kind === "boolean" && typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return typeof value === "string" ? value : "";
}

function patchField(props: ChannelsProps, field: SignupField, raw: string) {
  const value = raw.trim();
  const channelId =
    field.path[0] === "channels" && typeof field.path[1] === "string" ? field.path[1] : null;
  if (!value) {
    props.onConfigRemove(field.path);
    return;
  }
  if (channelId) {
    props.onConfigPatch(["channels", channelId, "enabled"], true);
  }
  if (field.kind === "number") {
    const parsed = Number(value);
    props.onConfigPatch(field.path, Number.isFinite(parsed) ? parsed : value);
    return;
  }
  if (field.kind === "boolean") {
    props.onConfigPatch(field.path, value === "true");
    return;
  }
  if (field.kind === "list") {
    props.onConfigPatch(
      field.path,
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
    return;
  }
  props.onConfigPatch(field.path, value);
}

function renderSignupField(props: ChannelsProps, field: SignupField) {
  const disabled = props.configSaving || props.configSchemaLoading || !props.configForm;
  const value = fieldDisplayValue(valueAtPath(props.configForm, field.path), field.kind);
  if (field.kind === "select" || field.kind === "boolean") {
    const options =
      field.kind === "boolean"
        ? [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]
        : (field.options ?? []);
    return html`
      <label class="channel-signup-field">
        <span>${field.label}</span>
        <select
          class="input"
          .value=${value}
          ?disabled=${disabled}
          @change=${(event: Event) => {
            patchField(props, field, (event.currentTarget as HTMLSelectElement).value);
          }}
        >
          <option value="">Select…</option>
          ${options.map(
            (option) => html`
              <option value=${option.value} ?selected=${option.value === value}>
                ${option.label}
              </option>
            `,
          )}
        </select>
      </label>
    `;
  }
  return html`
    <label class="channel-signup-field">
      <span>${field.label}</span>
      <input
        class="input"
        type=${field.kind === "password" ? "password" : field.kind === "number" ? "number" : "text"}
        autocomplete=${field.kind === "password" ? "off" : "on"}
        placeholder=${field.placeholder ?? ""}
        .value=${value}
        ?disabled=${disabled}
        @input=${(event: Event) => {
          patchField(props, field, (event.currentTarget as HTMLInputElement).value);
        }}
      />
    </label>
  `;
}

function renderSignupActions(params: {
  channelId: string;
  props: ChannelsProps;
  catalogOnly?: boolean;
  installAvailable?: boolean;
  installPendingRestart?: boolean;
  install?: unknown;
}) {
  const { channelId, props } = params;
  const disabled = props.configSaving || props.configSchemaLoading || !props.connected;
  const localEnable = isLocalChannelInstall(params.install);
  const externalInstall = params.installAvailable && !localEnable && !params.installPendingRestart;
  if (externalInstall) {
    return nothing;
  }
  return html`
    <div class="channel-signup-actions">
      ${
        params.installPendingRestart
          ? html`
              <button class="btn" type="button" disabled title="Restart gateway to load this channel plugin">
                Restart required
              </button>
            `
          : nothing
      }
      ${
        !externalInstall && channelId !== "whatsapp"
          ? html`
              <button
                class="btn primary"
                type="button"
                ?disabled=${disabled || !props.configFormDirty}
                @click=${() => props.onConfigSave()}
              >
                ${props.configSaving ? "Saving..." : "Save"}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

function renderSignupNotes(spec: SignupSpec) {
  if (!spec.notes?.length) {
    return nothing;
  }
  const notes = spec.notes.join("\n");
  return html`
    <span
      class="channel-signup-notes"
      role="img"
      tabindex="0"
      aria-label=${`Setup notes: ${notes}`}
      data-tooltip=${notes}
    >
      ${icons.info}
    </span>
  `;
}

function renderQrLoginPanel(params: { props: ChannelsProps; channelId: string; spec: SignupSpec }) {
  const { props, channelId, spec } = params;
  if (!spec.qrLogin) {
    return nothing;
  }
  const login = props.channelQrLogin[channelId] ?? {
    message: null,
    qrDataUrl: null,
    connected: null,
  };
  const busy = Boolean(props.channelRuntimeBusy[`qr:${channelId}:`]);
  return html`
    ${
      login.message
        ? html`<div class="callout" style="margin-top: 12px;">${login.message}</div>`
        : nothing
    }
    ${
      login.qrDataUrl
        ? html`<div class="qr-wrap"><img src=${login.qrDataUrl} alt=${spec.qrLogin.alt ?? `${spec.title} QR`} /></div>`
        : nothing
    }
    <div class="channel-signup-actions">
      <button
        class="btn primary"
        type="button"
        ?disabled=${busy || !props.connected}
        @click=${() => props.onChannelQrStart(channelId, false)}
      >
        ${busy ? "Working..." : (spec.qrLogin.startLabel ?? "Show QR")}
      </button>
      <button
        class="btn"
        type="button"
        ?disabled=${busy || !props.connected}
        @click=${() => props.onChannelQrWait(channelId)}
      >
        ${spec.qrLogin.waitLabel ?? "Wait for scan"}
      </button>
    </div>
  `;
}

function stripLeadingChannelName(text: string, title: string): string {
  const trimmed = text.trim();
  const normalizedTitle = title.trim();
  if (!trimmed || !normalizedTitle) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  const titleLower = normalizedTitle.toLowerCase();
  if (lower === titleLower) {
    return "";
  }
  for (const separator of [" ", ":", "–", "—", "/"]) {
    const prefix = `${titleLower}${separator}`;
    if (lower.startsWith(prefix)) {
      return trimmed.slice(normalizedTitle.length + separator.length).trim();
    }
  }
  return trimmed;
}

function signupDetail(spec: SignupSpec): string {
  return stripLeadingChannelName(spec.detail, spec.title) || "Account setup.";
}

function renderWhatsAppSignup(params: {
  props: ChannelsProps;
  catalogOnly?: boolean;
  installAvailable?: boolean;
  installPendingRestart?: boolean;
  install?: unknown;
}) {
  const { props } = params;
  const spec = resolveSignupSpec(props, "whatsapp", "WhatsApp");
  if (params.installAvailable) {
    return html`
      <div class="card channel-signup-card">
        <div class="channel-signup-header">
          <div class="channel-signup-heading">
            ${renderInstallHelp("whatsapp", params.install, params.installPendingRestart)}
          </div>
        </div>
        ${renderSignupActions({
          channelId: "whatsapp",
          props,
          catalogOnly: params.catalogOnly,
          installAvailable: params.installAvailable,
          installPendingRestart: params.installPendingRestart,
          install: params.install,
        })}
      </div>
    `;
  }
  return html`
    <div class="card channel-signup-card">
      <div class="channel-signup-header">
        <div class="channel-signup-heading">
          <div class="card-sub">${signupDetail(spec)}</div>
        </div>
        ${renderSignupNotes(spec)}
      </div>
      ${
        props.whatsappMessage
          ? html`<div class="callout" style="margin-top: 12px;">${props.whatsappMessage}</div>`
          : nothing
      }
      ${
        props.whatsappQrDataUrl
          ? html`<div class="qr-wrap"><img src=${props.whatsappQrDataUrl} alt="WhatsApp QR" /></div>`
          : nothing
      }
      <div class="channel-signup-actions">
        ${html`
            <button
              class="btn primary"
              type="button"
              ?disabled=${props.whatsappBusy || !props.connected}
              @click=${() => props.onWhatsAppStart(false)}
            >
              ${props.whatsappBusy ? "Working…" : "Show QR"}
            </button>
            <button
              class="btn"
              type="button"
              ?disabled=${props.whatsappBusy || !props.connected}
              @click=${() => props.onWhatsAppWait()}
            >
              Wait for scan
            </button>
          `}
        <button class="btn" type="button" @click=${() => props.onRefresh(true)}>Refresh</button>
      </div>
      ${renderSetupAccess(spec, "whatsapp", "WhatsApp", props)}
    </div>
  `;
}

function fallbackSpec(channelId: string, label: string): SignupSpec {
  return {
    title: label,
    detail: "Channel account setup.",
    fields: [],
  };
}

function resolveSignupSpec(props: ChannelsProps, channelId: string, label: string): SignupSpec {
  return props.snapshot?.channelSetup?.[channelId] ?? fallbackSpec(channelId, label);
}

function renderSetupAccess(
  spec: SignupSpec,
  channelId: string,
  label: string,
  props: ChannelsProps,
) {
  const hasAccess = Boolean(spec.access);
  const hasDmPolicy = channelId !== "whatsapp" && Boolean(spec.dmPolicy);
  if (!hasAccess && !hasDmPolicy) {
    return nothing;
  }
  return html`
    ${spec.access ? renderChannelDmAccessCard({ channelId, label, props, access: spec.access }) : nothing}
    ${
      hasDmPolicy && spec.dmPolicy
        ? renderChannelDmAccessCard({ channelId, label, props, dmPolicy: spec.dmPolicy })
        : nothing
    }
  `;
}

export function channelHasConfiguredAccount(
  status: unknown,
  accounts?: ChannelAccountSnapshot[] | null,
): boolean {
  if (accounts?.some((account) => account.configured === true || account.linked === true)) {
    return true;
  }
  return isRecord(status) && (status.configured === true || status.linked === true);
}

export function renderChannelSignupCard(params: {
  channelId: ChannelKey;
  label: string;
  props: ChannelsProps;
  catalogOnly?: boolean;
  installAvailable?: boolean;
  installPendingRestart?: boolean;
  install?: unknown;
}) {
  const { channelId, props } = params;
  if (channelId === "whatsapp") {
    return renderWhatsAppSignup({
      props,
      catalogOnly: params.catalogOnly,
      installAvailable: params.installAvailable,
      installPendingRestart: params.installPendingRestart,
      install: params.install,
    });
  }
  const spec = resolveSignupSpec(props, channelId, params.label);
  const localEnable = isLocalChannelInstall(params.install);
  const externalInstall = params.installAvailable && !localEnable;
  return html`
    <div class="card channel-signup-card">
      <div class="channel-signup-header">
        <div class="channel-signup-heading">
          ${
            externalInstall || params.installPendingRestart
              ? renderInstallHelp(channelId, params.install, params.installPendingRestart)
              : html`<div class="card-sub">${signupDetail(spec)}</div>`
          }
        </div>
        ${externalInstall || params.installPendingRestart ? nothing : renderSignupNotes(spec)}
      </div>
      ${
        externalInstall
          ? nothing
          : spec.fields.length > 0
            ? html`
                <div class="channel-signup-fields">${spec.fields.map((field) => renderSignupField(props, field))}</div>
              `
            : html`
                <div class="channel-signup-empty">No signup fields are exposed for this plugin.</div>
              `
      }
      ${externalInstall || params.installPendingRestart ? nothing : renderQrLoginPanel({ props, channelId, spec })}
      ${
        externalInstall || params.installPendingRestart
          ? nothing
          : renderSetupAccess(spec, channelId, params.label, props)
      }
      ${renderSignupActions({
        channelId,
        props,
        catalogOnly: params.catalogOnly,
        installAvailable: params.installAvailable,
        installPendingRestart: params.installPendingRestart,
        install: params.install,
      })}
    </div>
  `;
}

function installCommand(channelId: string, install: unknown): string {
  if (!isRecord(install)) {
    return `fased plugins install ${channelId}`;
  }
  const localPath = install.localPath;
  if (typeof localPath === "string" && localPath.trim()) {
    return `fased plugins install ${localPath.trim()}`;
  }
  const spec = install.npmSpec;
  return `fased plugins install ${typeof spec === "string" && spec.trim() ? spec.trim() : channelId}`;
}

function isLocalChannelInstall(install: unknown): boolean {
  return (
    isRecord(install) &&
    typeof install.localPath === "string" &&
    install.localPath.trim().length > 0
  );
}

function renderInstallHelp(channelId: string, install: unknown, pendingRestart?: boolean) {
  const localEnable = isLocalChannelInstall(install);
  const command = installCommand(channelId, install);
  return html`
    <div class="card-sub">
      ${
        pendingRestart
          ? "Enabled. Restart the gateway so the channel runtime loads."
          : localEnable
            ? "Enable this channel, then restart the gateway."
            : "Install the channel plugin, then restart the gateway."
      }
      ${localEnable ? nothing : html`<span class="mono">${command}</span>`}
    </div>
  `;
}
