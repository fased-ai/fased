import type { FasedAgentApp } from "./app.ts";
import {
  installChannelPlugin,
  loadChannels,
  logoutChannel,
  logoutWhatsApp,
  startChannelQrLogin,
  startWhatsAppLogin,
  waitChannelQrLogin,
  waitWhatsAppLogin,
} from "./controllers/channels.ts";
import { loadConfig, saveConfig, updateConfigFormValue } from "./controllers/config.ts";
import type { NostrProfile } from "./types.ts";
import { createNostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

export type ChannelConfirmAction = { kind: "clear"; channelId: string; accountId?: string };

export async function handleWhatsAppStart(host: FasedAgentApp, force: boolean) {
  await startWhatsAppLogin(host, force);
  await loadChannels(host, true);
}

export async function handleWhatsAppWait(host: FasedAgentApp) {
  await waitWhatsAppLogin(host);
  await loadChannels(host, true);
}

export async function handleWhatsAppLogout(host: FasedAgentApp) {
  await logoutWhatsApp(host);
  await loadChannels(host, true);
}

export async function handleChannelQrStart(
  host: FasedAgentApp,
  channelId: string,
  force = false,
  accountId?: string,
) {
  await startChannelQrLogin(host, channelId, force, accountId);
  await loadChannels(host, true);
}

export async function handleChannelQrWait(
  host: FasedAgentApp,
  channelId: string,
  accountId?: string,
) {
  await waitChannelQrLogin(host, channelId, accountId);
  await loadChannels(host, true);
}

export async function handleChannelLogout(
  host: FasedAgentApp,
  channelId: string,
  accountId?: string,
) {
  host.channelConfirmAction = { kind: "clear", channelId, ...(accountId ? { accountId } : {}) };
}

export async function handleChannelInstall(host: FasedAgentApp, channelId: string) {
  await installChannelPlugin(host, channelId);
}

export function cancelChannelConfirmAction(host: FasedAgentApp) {
  host.channelConfirmAction = null;
}

export async function confirmChannelAction(host: FasedAgentApp) {
  const action = host.channelConfirmAction;
  if (!action) {
    return;
  }
  host.channelConfirmAction = null;
  await logoutChannel(host, action.channelId, action.accountId);
}

export async function handleChannelEnable(host: FasedAgentApp, channelId: string) {
  const busyKey = `install:${channelId}`;
  if (host.channelRuntimeBusy[busyKey]) {
    return;
  }
  host.channelRuntimeBusy = { ...host.channelRuntimeBusy, [busyKey]: true };
  host.channelsError = null;
  host.channelsNotice = null;
  try {
    if (!host.configSnapshot?.hash) {
      await loadConfig(host);
    }
    updateConfigFormValue(host, ["channels", channelId, "enabled"], true);
    await saveConfig(host);
    if (host.lastError) {
      host.channelsError = host.lastError;
      return;
    }
    await loadChannels(host, false);
    host.channelsNotice = `Enabled ${channelId}. Continue setup in this channel card.`;
  } finally {
    const nextBusy = { ...host.channelRuntimeBusy };
    delete nextBusy[busyKey];
    host.channelRuntimeBusy = nextBusy;
  }
}

export async function handleChannelConfigSave(host: FasedAgentApp) {
  await saveConfig(host);
  await loadConfig(host);
  await loadChannels(host, true);
}

export async function handleChannelConfigReload(host: FasedAgentApp) {
  await loadConfig(host);
  await loadChannels(host, true);
}

function parseValidationErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = message;
    }
  }
  return errors;
}

function resolveNostrAccountId(host: FasedAgentApp): string {
  const accounts = host.channelsSnapshot?.channelAccounts?.nostr ?? [];
  return accounts[0]?.accountId ?? host.nostrProfileAccountId ?? "default";
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

function resolveGatewayHttpAuthHeader(host: FasedAgentApp): string | null {
  const deviceToken = host.hello?.auth?.deviceToken?.trim();
  if (deviceToken) {
    return `Bearer ${deviceToken}`;
  }
  const token = host.settings.token.trim();
  if (token) {
    return `Bearer ${token}`;
  }
  const password = host.password.trim();
  if (password) {
    return `Bearer ${password}`;
  }
  return null;
}

function buildGatewayHttpHeaders(host: FasedAgentApp): Record<string, string> {
  const authorization = resolveGatewayHttpAuthHeader(host);
  return authorization ? { Authorization: authorization } : {};
}

export function handleNostrProfileEdit(
  host: FasedAgentApp,
  accountId: string,
  profile: NostrProfile | null,
) {
  host.nostrProfileAccountId = accountId;
  host.nostrProfileFormState = createNostrProfileFormState(profile ?? undefined);
}

export function handleNostrProfileCancel(host: FasedAgentApp) {
  host.nostrProfileFormState = null;
  host.nostrProfileAccountId = null;
}

export function handleNostrProfileFieldChange(
  host: FasedAgentApp,
  field: keyof NostrProfile,
  value: string,
) {
  const state = host.nostrProfileFormState;
  if (!state) {
    return;
  }
  host.nostrProfileFormState = {
    ...state,
    values: {
      ...state.values,
      [field]: value,
    },
    fieldErrors: {
      ...state.fieldErrors,
      [field]: "",
    },
  };
}

export function handleNostrProfileToggleAdvanced(host: FasedAgentApp) {
  const state = host.nostrProfileFormState;
  if (!state) {
    return;
  }
  host.nostrProfileFormState = {
    ...state,
    showAdvanced: !state.showAdvanced,
  };
}

export async function handleNostrProfileSave(host: FasedAgentApp) {
  const state = host.nostrProfileFormState;
  if (!state || state.saving) {
    return;
  }
  const accountId = resolveNostrAccountId(host);

  host.nostrProfileFormState = {
    ...state,
    saving: true,
    error: null,
    success: null,
    fieldErrors: {},
  };

  try {
    const response = await fetch(buildNostrProfileUrl(accountId), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...buildGatewayHttpHeaders(host),
      },
      body: JSON.stringify(state.values),
    });
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      details?: unknown;
      persisted?: boolean;
    } | null;

    if (!response.ok || data?.ok === false || !data) {
      const errorMessage = data?.error ?? `Profile update failed (${response.status})`;
      host.nostrProfileFormState = {
        ...state,
        saving: false,
        error: errorMessage,
        success: null,
        fieldErrors: parseValidationErrors(data?.details),
      };
      return;
    }

    if (!data.persisted) {
      host.nostrProfileFormState = {
        ...state,
        saving: false,
        error: "Profile publish failed on all relays.",
        success: null,
      };
      return;
    }

    host.nostrProfileFormState = {
      ...state,
      saving: false,
      error: null,
      success: "Profile published to relays.",
      fieldErrors: {},
      original: { ...state.values },
    };
    await loadChannels(host, true);
  } catch (err) {
    host.nostrProfileFormState = {
      ...state,
      saving: false,
      error: `Profile update failed: ${String(err)}`,
      success: null,
    };
  }
}

export async function handleNostrProfileImport(host: FasedAgentApp) {
  const state = host.nostrProfileFormState;
  if (!state || state.importing) {
    return;
  }
  const accountId = resolveNostrAccountId(host);

  host.nostrProfileFormState = {
    ...state,
    importing: true,
    error: null,
    success: null,
  };

  try {
    const response = await fetch(buildNostrProfileUrl(accountId, "/import"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildGatewayHttpHeaders(host),
      },
      body: JSON.stringify({ autoMerge: true }),
    });
    const data = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      imported?: NostrProfile;
      merged?: NostrProfile;
      saved?: boolean;
    } | null;

    if (!response.ok || data?.ok === false || !data) {
      const errorMessage = data?.error ?? `Profile import failed (${response.status})`;
      host.nostrProfileFormState = {
        ...state,
        importing: false,
        error: errorMessage,
        success: null,
      };
      return;
    }

    const merged = data.merged ?? data.imported ?? null;
    const nextValues = merged ? { ...state.values, ...merged } : state.values;
    const showAdvanced = Boolean(
      nextValues.banner || nextValues.website || nextValues.nip05 || nextValues.lud16,
    );

    host.nostrProfileFormState = {
      ...state,
      importing: false,
      values: nextValues,
      error: null,
      success: data.saved
        ? "Profile imported from relays. Review and publish."
        : "Profile imported. Review and publish.",
      showAdvanced,
    };

    if (data.saved) {
      await loadChannels(host, true);
    }
  } catch (err) {
    host.nostrProfileFormState = {
      ...state,
      importing: false,
      error: `Profile import failed: ${String(err)}`,
      success: null,
    };
  }
}
