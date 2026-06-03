import { ChannelsStatusSnapshot } from "../types.ts";
import type { ChannelsState } from "./channels.types.ts";

export type { ChannelsState };

type PluginMarketplaceMutationResult = {
  pluginId: string;
  action: string;
  requiresRestart: boolean;
  message: string;
  warnings: string[];
};

function channelRuntimeControlKey(channel: string, accountId?: string) {
  return `${channel}:${accountId ?? ""}`;
}

function channelInstallControlKey(channel: string) {
  return `install:${channel}`;
}

function channelQrControlKey(channel: string, accountId?: string) {
  return `qr:${channel}:${accountId ?? ""}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const FALLBACK_CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  zalouser: "Zalo Personal",
};

function channelLabel(snapshot: ChannelsStatusSnapshot | null, channel: string) {
  return snapshot?.channelLabels?.[channel] ?? FALLBACK_CHANNEL_LABELS[channel] ?? channel;
}

function channelInstallCommand(snapshot: ChannelsStatusSnapshot | null, channel: string) {
  const status = snapshot?.channels?.[channel];
  if (!isRecord(status) || !isRecord(status.install)) {
    return `fased plugins install ${channel}`;
  }
  const localPath = status.install.localPath;
  if (typeof localPath === "string" && localPath.trim()) {
    return `fased plugins install ${localPath.trim()}`;
  }
  const spec = status.install.npmSpec;
  return `fased plugins install ${typeof spec === "string" && spec.trim() ? spec.trim() : channel}`;
}

function formatChannelError(
  err: unknown,
  channel?: string,
  snapshot?: ChannelsStatusSnapshot | null,
) {
  const message = String(err);
  if (message.includes("web login provider is not available")) {
    const label = channel ? channelLabel(snapshot ?? null, channel) : "Channel";
    return `${label} QR login is unavailable because the ${label} channel plugin is not loaded. Enable or install it, restart the gateway, then open Show QR again.`;
  }
  return message;
}

function setChannelQrLogin(
  state: ChannelsState,
  channel: string,
  next: {
    message?: string | null;
    qrDataUrl?: string | null;
    connected?: boolean | null;
  },
) {
  const current = state.channelQrLogin[channel] ?? {
    message: null,
    qrDataUrl: null,
    connected: null,
  };
  const value = {
    message: "message" in next ? (next.message ?? null) : current.message,
    qrDataUrl: "qrDataUrl" in next ? (next.qrDataUrl ?? null) : current.qrDataUrl,
    connected: "connected" in next ? (next.connected ?? null) : current.connected,
  };
  state.channelQrLogin = { ...state.channelQrLogin, [channel]: value };
  if (channel === "whatsapp") {
    state.whatsappLoginMessage = value.message;
    state.whatsappLoginQrDataUrl = value.qrDataUrl;
    state.whatsappLoginConnected = value.connected;
  }
}

export async function loadChannels(state: ChannelsState, probe: boolean) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.channelsLoading) {
    return;
  }
  state.channelsLoading = true;
  state.channelsError = null;
  try {
    const res = await state.client.request<ChannelsStatusSnapshot | null>("channels.status", {
      probe,
      timeoutMs: 8000,
    });
    state.channelsSnapshot = res;
    state.channelsLastSuccess = Date.now();
  } catch (err) {
    state.channelsError = formatChannelError(err);
  } finally {
    state.channelsLoading = false;
  }
}

async function controlChannelRuntime(
  state: ChannelsState,
  method: "channels.start" | "channels.stop",
  channel: string,
  accountId?: string,
) {
  if (!state.client || !state.connected) {
    return;
  }
  const key = channelRuntimeControlKey(channel, accountId);
  if (state.channelRuntimeBusy[key]) {
    return;
  }
  state.channelRuntimeBusy = { ...state.channelRuntimeBusy, [key]: true };
  state.channelsError = null;
  state.channelsNotice = null;
  try {
    await state.client.request(method, {
      channel,
      ...(accountId ? { accountId } : {}),
    });
    await loadChannels(state, false);
  } catch (err) {
    state.channelsError = formatChannelError(err);
  } finally {
    const nextBusy = { ...state.channelRuntimeBusy };
    delete nextBusy[key];
    state.channelRuntimeBusy = nextBusy;
  }
}

export async function startChannelRuntime(
  state: ChannelsState,
  channel: string,
  accountId?: string,
) {
  await controlChannelRuntime(state, "channels.start", channel, accountId);
}

export async function stopChannelRuntime(
  state: ChannelsState,
  channel: string,
  accountId?: string,
) {
  await controlChannelRuntime(state, "channels.stop", channel, accountId);
}

export async function logoutChannel(state: ChannelsState, channel: string, accountId?: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const key = channelRuntimeControlKey(channel, accountId);
  if (state.channelRuntimeBusy[key]) {
    return;
  }
  state.channelRuntimeBusy = { ...state.channelRuntimeBusy, [key]: true };
  state.channelsError = null;
  state.channelsNotice = null;
  try {
    const result = await state.client.request<{
      cleared?: boolean;
      loggedOut?: boolean;
      accountId?: string | null;
    }>("channels.logout", {
      channel,
      ...(accountId ? { accountId } : {}),
    });
    await loadChannels(state, true);
    const target = result.accountId || accountId;
    const label = `${channel}${target ? `/${target}` : ""}`;
    state.channelsNotice =
      result.cleared || result.loggedOut
        ? `Cleared ${label}.`
        : `No stored credentials were cleared for ${label}.`;
  } catch (err) {
    state.channelsError = formatChannelError(err);
  } finally {
    const nextBusy = { ...state.channelRuntimeBusy };
    delete nextBusy[key];
    state.channelRuntimeBusy = nextBusy;
  }
}

export async function installChannelPlugin(state: ChannelsState, channel: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const key = channelInstallControlKey(channel);
  if (state.channelRuntimeBusy[key]) {
    return;
  }
  state.channelRuntimeBusy = { ...state.channelRuntimeBusy, [key]: true };
  state.channelsError = null;
  state.channelsNotice = null;
  try {
    const result = await state.client.request<PluginMarketplaceMutationResult>(
      "plugins.marketplace.install",
      { id: channel },
    );
    await loadChannels(state, false);
    state.channelsNotice = result.requiresRestart
      ? `${result.message} Restart the gateway to load this channel plugin. Until restart, this channel will stay in restart-required state.`
      : result.message;
  } catch (err) {
    state.channelsError = `${formatChannelError(err)}. Manual install: ${channelInstallCommand(
      state.channelsSnapshot,
      channel,
    )}. Restart the gateway after install.`;
  } finally {
    const nextBusy = { ...state.channelRuntimeBusy };
    delete nextBusy[key];
    state.channelRuntimeBusy = nextBusy;
  }
}

export async function startChannelQrLogin(
  state: ChannelsState,
  channel: string,
  force = false,
  accountId?: string,
) {
  const busyKey = channelQrControlKey(channel, accountId);
  if (!state.client || !state.connected || state.channelRuntimeBusy[busyKey]) {
    return;
  }
  if (channel === "whatsapp" && state.whatsappBusy) {
    return;
  }
  state.channelRuntimeBusy = { ...state.channelRuntimeBusy, [busyKey]: true };
  if (channel === "whatsapp") {
    state.whatsappBusy = true;
  }
  try {
    const res = await state.client.request<{ message?: string; qrDataUrl?: string }>(
      "web.login.start",
      {
        channel,
        force,
        timeoutMs: 30000,
        ...(accountId ? { accountId } : {}),
      },
    );
    setChannelQrLogin(state, channel, {
      message: res.message ?? null,
      qrDataUrl: res.qrDataUrl ?? null,
      connected: null,
    });
  } catch (err) {
    setChannelQrLogin(state, channel, {
      message: formatChannelError(err, channel, state.channelsSnapshot),
      qrDataUrl: null,
      connected: null,
    });
  } finally {
    const nextBusy = { ...state.channelRuntimeBusy };
    delete nextBusy[busyKey];
    state.channelRuntimeBusy = nextBusy;
    if (channel === "whatsapp") {
      state.whatsappBusy = false;
    }
  }
}

export async function waitChannelQrLogin(
  state: ChannelsState,
  channel: string,
  accountId?: string,
) {
  const busyKey = channelQrControlKey(channel, accountId);
  if (!state.client || !state.connected || state.channelRuntimeBusy[busyKey]) {
    return;
  }
  if (channel === "whatsapp" && state.whatsappBusy) {
    return;
  }
  state.channelRuntimeBusy = { ...state.channelRuntimeBusy, [busyKey]: true };
  if (channel === "whatsapp") {
    state.whatsappBusy = true;
  }
  try {
    const res = await state.client.request<{ message?: string; connected?: boolean }>(
      "web.login.wait",
      {
        channel,
        timeoutMs: 120000,
        ...(accountId ? { accountId } : {}),
      },
    );
    setChannelQrLogin(state, channel, {
      message: res.message ?? null,
      connected: res.connected ?? null,
    });
    if (res.connected) {
      setChannelQrLogin(state, channel, { qrDataUrl: null });
      await loadChannels(state, true);
    }
  } catch (err) {
    setChannelQrLogin(state, channel, {
      message: formatChannelError(err, channel, state.channelsSnapshot),
      connected: null,
    });
  } finally {
    const nextBusy = { ...state.channelRuntimeBusy };
    delete nextBusy[busyKey];
    state.channelRuntimeBusy = nextBusy;
    if (channel === "whatsapp") {
      state.whatsappBusy = false;
    }
  }
}

export async function startWhatsAppLogin(state: ChannelsState, force: boolean) {
  await startChannelQrLogin(state, "whatsapp", force);
}

export async function waitWhatsAppLogin(state: ChannelsState) {
  await waitChannelQrLogin(state, "whatsapp");
}

export async function logoutWhatsApp(state: ChannelsState) {
  if (!state.client || !state.connected || state.whatsappBusy) {
    return;
  }
  state.whatsappBusy = true;
  try {
    await state.client.request("channels.logout", { channel: "whatsapp" });
    state.whatsappLoginMessage = "Logged out.";
    state.whatsappLoginQrDataUrl = null;
    state.whatsappLoginConnected = null;
  } catch (err) {
    state.whatsappLoginMessage = formatChannelError(err, "whatsapp", state.channelsSnapshot);
  } finally {
    state.whatsappBusy = false;
  }
}
