import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import type {
  ChannelAccountSnapshot,
  ChannelUiMetaEntry,
  ChannelsStatusSnapshot,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types.ts";
import { renderChannelCommandsPanel } from "./channels.commands.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderDiscordCard } from "./channels.discord.ts";
import { renderGoogleChatCard } from "./channels.googlechat.ts";
import { renderIMessageCard } from "./channels.imessage.ts";
import { renderChannelMessagesPanel } from "./channels.messages.ts";
import { renderNostrCard } from "./channels.nostr.ts";
import { renderChannelSessionsPanel } from "./channels.sessions.ts";
import {
  channelEnabled,
  renderChannelAccountCount,
  renderChannelRoutePanel,
  renderChannelRuntimeControls,
} from "./channels.shared.ts";
import { renderSignalCard } from "./channels.signal.ts";
import { channelHasConfiguredAccount, renderChannelSignupCard } from "./channels.signup.ts";
import { renderSlackCard } from "./channels.slack.ts";
import { renderTelegramCard } from "./channels.telegram.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./channels.types.ts";
import { renderChannelWebRuntimePanel } from "./channels.web-runtime.ts";
import { renderWhatsAppCard } from "./channels.whatsapp.ts";

export type ChannelsRenderOptions = {
  embedded?: boolean;
  showDebug?: boolean;
};

type ChannelRow = {
  key: string;
  enabled: boolean;
  status: ReturnType<typeof channelSummaryForRow>;
};

const CHANNEL_ACCOUNT_GROUPS: Array<{
  id: string;
  title: string;
  channelIds: string[];
}> = [
  {
    id: "major",
    title: "Major",
    channelIds: ["telegram", "whatsapp", "discord", "slack", "signal", "imessage", "bluebubbles"],
  },
  {
    id: "enterprise",
    title: "Enterprise",
    channelIds: ["googlechat", "teams", "msteams", "feishu", "line", "zalo", "zalouser"],
  },
  {
    id: "self-hosted",
    title: "Self-hosted / protocol",
    channelIds: [
      "matrix",
      "mattermost",
      "nextcloud",
      "nextcloud-talk",
      "synology",
      "synology-chat",
      "irc",
      "nostr",
      "tlon",
    ],
  },
  {
    id: "optional",
    title: "Optional / plugin",
    channelIds: ["twitch", "yuanbao", "qq", "qqbot", "wechat", "clickclack"],
  },
];

function channelConnectDialogId(channelKey: string) {
  return `channel-connect-${channelKey.replace(/[^a-z0-9_-]/gi, "-")}`;
}

function openChannelConnectDialog(event: Event, channelKey: string) {
  event.preventDefault();
  event.stopPropagation();
  const dialog = document.getElementById(channelConnectDialogId(channelKey));
  if (dialog instanceof HTMLDialogElement) {
    dialog.showModal();
  }
}

function closeChannelConnectDialog(event: Event) {
  const dialog = (event.currentTarget as HTMLElement).closest("dialog");
  if (dialog instanceof HTMLDialogElement) {
    dialog.close();
  }
}

function groupOrderedChannels(channels: ChannelRow[]) {
  const remaining = new Map(channels.map((channel) => [channel.key, channel]));
  const groups = CHANNEL_ACCOUNT_GROUPS.map((group) => {
    const groupIds = new Set(group.channelIds);
    const groupedChannels = channels.filter((channel) => groupIds.has(channel.key));
    for (const channel of groupedChannels) {
      remaining.delete(channel.key);
    }
    return {
      id: group.id,
      title: group.title,
      channels: groupedChannels,
    };
  }).filter((group) => group.channels.length > 0);

  const customChannels = [...remaining.values()];
  if (customChannels.length > 0) {
    groups.push({
      id: "other",
      title: "Other",
      channels: customChannels,
    });
  }
  return groups;
}

export function renderChannels(props: ChannelsProps, options: ChannelsRenderOptions = {}) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined;
  const telegram = (channels?.telegram ?? undefined) as TelegramStatus | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const googlechat = (channels?.googlechat ?? null) as GoogleChatStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const nostr = (channels?.nostr ?? null) as NostrStatus | null;
  const channelOrder = resolveChannelOrder(props.snapshot);
  const activeView = props.activeView ?? "accounts";
  const orderedChannels = channelOrder
    .map((key) => ({
      key,
      enabled: channelEnabled(key, props),
      status: channelSummaryForRow(props, key),
    }))
    .filter((channel) => shouldShowChannelRow(channel.status))
    .toSorted((left, right) => {
      const priority = (status: ReturnType<typeof channelSummaryForRow>) => {
        if (status.running || status.connected) {
          return 0;
        }
        if (status.configured) {
          return 1;
        }
        return 2;
      };
      const priorityDelta = priority(left.status) - priority(right.status);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return channelOrder.indexOf(left.key) - channelOrder.indexOf(right.key);
    });
  const showDebug = options.showDebug ?? true;

  return html`
    <style>
      .channels-shell {
        display: grid;
        gap: 16px;
      }

      .channels-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: stretch;
      }

      .channels-list {
        display: grid;
        gap: 18px;
      }

      .channels-group {
        display: grid;
        gap: 8px;
      }

      .channels-group__header {
        align-items: center;
        border-bottom: 1px solid var(--border);
        color: var(--muted);
        display: flex;
        font-size: 12px;
        font-weight: 760;
        justify-content: flex-start;
        letter-spacing: 0;
        padding: 0 2px 8px;
      }

      .channels-group__list {
        display: grid;
        gap: 8px;
      }

      .channels-tabs {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .channels-tab {
        align-items: center;
        background: transparent;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--muted);
        cursor: pointer;
        display: inline-flex;
        font: inherit;
        font-size: 12px;
        font-weight: 750;
        min-height: 34px;
        padding: 0 12px;
        transition:
          border-color var(--duration-fast) ease,
          color var(--duration-fast) ease,
          background var(--duration-fast) ease;
      }

      .channels-tab:hover,
      .channels-tab:focus-visible {
        background: var(--bg-hover);
        border-color: var(--border-strong);
        color: var(--text-strong);
        outline: none;
      }

      .channels-tab.active {
        background: var(--text-strong);
        border-color: var(--text-strong);
        color: var(--bg);
      }

      .channels-channel {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--panel);
        overflow: visible;
      }

      .channels-channel[open] {
        border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
      }

      .channels-channel__summary {
        align-items: center;
        cursor: pointer;
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(0, 1fr) auto;
        list-style: none;
        padding: 14px 16px;
      }

      .channels-channel__summary::-webkit-details-marker {
        display: none;
      }

      .channels-channel__main {
        align-items: center;
        display: flex;
        gap: 10px;
        min-width: 0;
      }

      .channels-channel__dot {
        border-radius: 999px;
        background: var(--muted);
        flex: 0 0 auto;
        height: 9px;
        width: 9px;
      }

      .channels-channel__dot.ok {
        background: var(--success);
      }

      .channels-channel__dot.warn {
        background: var(--warning);
      }

      .channels-channel__name {
        color: var(--text-strong);
        font-size: 15px;
        font-weight: 850;
      }

      .channels-channel__detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .channels-channel__status {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      .channels-channel__body {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 14px;
        padding: 14px 16px 16px;
      }

      .channels-channel__body > .card {
        border: 0;
        border-radius: 0;
        background: transparent;
        padding: 0;
      }

      .channels-channel__body > .card > .card-title,
      .channels-channel__body > .card > .card-sub {
        display: none;
      }

      .channel-connect-dialog {
        border: 0;
        border-radius: var(--radius-lg);
        background: transparent;
        color: var(--text);
        margin: auto;
        max-width: min(720px, calc(100vw - 32px));
        padding: 0;
        width: 100%;
      }

      .channel-connect-dialog::backdrop {
        background: rgb(0 0 0 / 58%);
      }

      .channel-connect-dialog__panel {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--panel);
        box-shadow: var(--shadow-lg);
        display: grid;
        gap: 14px;
        max-height: min(760px, calc(100vh - 40px));
        overflow: auto;
        padding: 16px;
      }

      .channel-connect-dialog__header {
        align-items: center;
        display: flex;
        gap: 12px;
        justify-content: space-between;
      }

      .channel-connect-dialog__title {
        color: var(--text-strong);
        font-size: 15px;
        font-weight: 850;
      }

      .channel-connect-dialog__meta {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .channel-connect-dialog__actions {
        align-items: center;
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      .channel-connect-dialog__close {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--secondary);
        color: var(--text);
        cursor: pointer;
        display: inline-flex;
        height: 34px;
        justify-content: center;
        padding: 0;
        width: 34px;
      }

      .channel-connect-dialog__close svg {
        height: 16px;
        width: 16px;
      }

      .channel-connect-dialog__body > .card {
        border: 0;
        border-radius: 0;
        background: transparent;
        padding: 0;
      }

      .channels-grid > .card,
      .channels-health-card {
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--panel);
        padding: 16px;
      }

      .channels-grid > .card {
        display: grid;
        gap: 14px;
        min-height: 100%;
      }

      .channels-shell .card-title {
        color: var(--text-strong);
        font-size: 18px;
        font-weight: 680;
        line-height: 1.15;
      }

      .channels-shell .card-sub {
        margin-top: -6px;
        color: var(--muted);
        line-height: 1.45;
      }

      .channels-shell .account-count {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        width: fit-content;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--secondary);
        color: var(--muted);
        font-size: 12px;
        font-weight: 560;
      }

      .channels-shell .status-list {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
        padding: 0;
        border: 0;
        background: none;
      }

      .channels-shell .status-list > div:not(.account-card-error) {
        display: grid;
        align-items: start;
        gap: 10px;
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-elevated);
      }

      .channels-shell .status-list .label {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .channels-shell .status-list div > span:last-child {
        color: var(--text-strong);
        font-weight: 560;
        text-align: left;
      }

      .channels-shell .account-card-list {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
      }

      .channels-shell .account-card {
        display: grid;
        gap: 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 14px;
      }

      .channels-shell .account-card-header {
        align-items: flex-start;
        flex-wrap: wrap;
      }

      .channels-shell .account-card-title {
        color: var(--text-strong);
        font-size: 15px;
        font-weight: 650;
      }

      .channels-shell .account-card-id {
        color: var(--muted);
        word-break: break-all;
      }

      .channels-shell .account-card-error {
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--danger-muted);
        background: var(--danger-subtle);
        color: var(--danger);
        font-size: 13px;
        line-height: 1.45;
      }

      .channels-shell .row {
        flex-wrap: wrap;
      }

      .channels-shell .row .btn {
        flex: 0 0 auto;
      }

      .channels-grid > .card > .row:last-child {
        margin-top: auto;
      }

      .channels-shell .callout {
        border-radius: var(--radius-sm);
      }

      .channels-shell .config-form {
        display: block;
        padding: 0;
        border: 0;
        background: transparent;
      }

      .channels-shell .channel-config-details {
        margin-top: 16px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--secondary);
      }

      .channels-shell .channel-config-details summary {
        cursor: pointer;
        list-style: none;
        padding: 12px;
        color: var(--text-strong);
        font-weight: 620;
      }

      .channels-shell .channel-config-details summary::-webkit-details-marker {
        display: none;
      }

      .channels-shell .channel-config-details summary::after {
        content: "+";
        float: right;
        color: var(--muted);
      }

      .channels-shell .channel-config-details[open] summary::after {
        content: "-";
      }

      .channels-shell .channel-config-details-body {
        display: grid;
        gap: 10px;
        padding: 0 12px 12px;
      }

      .channels-shell .channel-config-note {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .channels-shell .channel-config-empty {
        width: fit-content;
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .channels-shell .config-form > .cfg-fields {
        align-items: stretch;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .channels-shell .config-form > .cfg-fields > .cfg-field,
      .channels-shell .config-form > .cfg-fields > .cfg-toggle-row,
      .channels-shell .config-form > .cfg-fields > .cfg-object,
      .channels-shell .config-form > .cfg-fields > .cfg-array,
      .channels-shell .config-form > .cfg-fields > .cfg-map {
        flex: 1 1 250px;
        max-width: 420px;
        min-width: 220px;
      }

      .channels-shell .config-form > .cfg-fields > .cfg-field,
      .channels-shell .config-form > .cfg-fields > .cfg-toggle-row {
        min-height: 100%;
      }

      .channels-shell .config-form > .cfg-fields > .cfg-field {
        display: grid;
        gap: 7px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 620;
      }

      .channels-shell .config-form > .cfg-fields > .cfg-toggle-row {
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-elevated);
      }

      .channels-shell .config-form > .cfg-fields > .cfg-toggle-row {
        align-items: center;
        gap: 12px;
        justify-content: space-between;
      }

      .channels-shell .config-form > .cfg-fields > .cfg-object,
      .channels-shell .config-form > .cfg-fields > .cfg-array,
      .channels-shell .config-form > .cfg-fields > .cfg-map {
        border-radius: var(--radius-sm);
        background: var(--bg-elevated);
      }

      .channels-shell .config-form .cfg-input,
      .channels-shell .config-form .cfg-select,
      .channels-shell .config-form .cfg-textarea {
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-strong);
        min-height: 40px;
        padding: 9px 11px;
        width: 100%;
      }

      .channels-shell .config-form .cfg-number {
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        min-height: 40px;
        width: 100%;
      }

      .channels-shell .config-form .cfg-field__label,
      .channels-shell .channel-signup-field > span,
      .channels-shell .channel-message-field > span {
        color: var(--muted);
        font-size: 12px;
        font-weight: 680;
        letter-spacing: 0;
      }

      .channels-shell .channel-config-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-start;
      }

      .channels-shell .channel-route-panel {
        display: grid;
        gap: 12px;
        margin-top: 12px;
        padding: 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--secondary);
      }

      .channels-shell .channel-route-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        flex-wrap: wrap;
      }

      .channels-shell .channel-route-title {
        color: var(--text-strong);
        font-weight: 720;
      }

      .channels-shell .channel-route-sub,
      .channels-shell .channel-route-note,
      .channels-shell .channel-route-detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .channels-shell .channel-route-grid {
        align-items: stretch;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .channels-shell .channel-route-block {
        display: grid;
        gap: 8px;
        flex: 1 1 320px;
        max-width: 540px;
        padding: 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-elevated);
      }

      .channels-shell .channel-route-list {
        display: grid;
        gap: 8px;
      }

      .channels-shell .channel-route-section-title {
        color: var(--muted);
        font-size: 11px;
        font-weight: 650;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .channels-shell .channel-route-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(160px, 220px);
        gap: 10px;
        align-items: center;
      }

      .channels-shell .channel-route-label {
        display: block;
        color: var(--text-strong);
        font-weight: 560;
      }

      .channels-shell .channel-route-row select {
        min-width: 0;
        padding-top: 8px;
        padding-bottom: 8px;
      }

      .channels-shell .channel-route-specific {
        display: grid;
        gap: 8px;
      }

      .channels-shell .channel-route-specific-list {
        display: grid;
        gap: 6px;
      }

      .channels-shell .channel-route-specific-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        align-items: center;
        padding: 2px 0;
      }

      .channels-shell .channel-route-agent {
        width: fit-content;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--secondary);
        color: var(--muted);
        font-size: 12px;
        font-weight: 560;
      }

      .channels-health-card .code-block {
        max-height: 320px;
        overflow: auto;
      }

      .channel-message-panel {
        display: grid;
        gap: 12px;
      }

      .channel-message-card {
        display: grid;
        gap: 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--panel);
        padding: 14px;
      }

      .channel-message-card-title {
        color: var(--text-strong);
        font-size: 15px;
        font-weight: 720;
      }

      .channel-message-grid {
        align-items: stretch;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }

      .channel-message-field,
      .channel-message-toggle {
        display: grid;
        gap: 7px;
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 620;
        min-width: 0;
      }

      .channel-message-field {
        padding: 0;
        border: 0;
        background: transparent;
      }

      .channel-message-toggle {
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-elevated);
      }

      .channel-message-field--wide {
        grid-column: 1 / -1;
      }

      .channel-message-field .input,
      .channel-message-toggle .input,
      .channel-message-field select,
      .channel-message-field textarea {
        width: 100%;
        min-width: 0;
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-strong);
        min-height: 40px;
        padding: 9px 11px;
      }

      .channel-message-toggle {
        align-items: center;
        grid-template-columns: minmax(0, 1fr) auto;
      }

      .channel-message-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-start;
        flex-wrap: wrap;
      }

      .channels-shell .channel-signup-card {
        display: grid;
        gap: 12px;
      }

      .channels-shell .channel-signup-header {
        align-items: flex-start;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: space-between;
      }

      .channels-shell .channel-signup-heading {
        display: grid;
        gap: 4px;
        min-width: 0;
      }

      .channels-shell .channel-signup-heading .card-sub {
        margin-top: 0;
      }

      .channels-shell .channel-signup-fields {
        align-items: stretch;
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }

      .channels-shell .channel-signup-field {
        display: grid;
        gap: 7px;
        min-width: 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 620;
      }

      .channels-shell .channel-signup-field--wide {
        grid-column: 1 / -1;
      }

      .channels-shell .channel-signup-field .input {
        width: 100%;
        min-width: 0;
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-strong);
        min-height: 40px;
        padding: 9px 11px;
      }

      .channels-shell .channel-probe-button {
        align-items: center;
        display: inline-flex;
        gap: 6px;
      }

      .channels-shell .channel-probe-button__dot {
        border-radius: 999px;
        background: var(--danger);
        flex: 0 0 auto;
        height: 8px;
        width: 8px;
      }

      .channels-shell .channel-probe-button__dot.ok {
        background: var(--success);
      }

      .channels-shell .channel-dm-card {
        display: grid;
        gap: 10px;
        padding: 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--secondary);
      }

      .channels-shell .channel-dm-title {
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 760;
      }

      .channels-shell .channel-dm-note {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
        margin-top: 2px;
      }

      .channels-shell .channel-dm-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .channels-shell .channel-signup-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-start;
      }

      .channels-shell .channel-signup-empty {
        width: fit-content;
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .channels-shell .channel-signup-notes {
        align-items: center;
        background: color-mix(in srgb, var(--accent) 8%, var(--panel));
        border: 0;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent);
        color: var(--text-strong);
        cursor: help;
        display: inline-flex;
        flex: 0 0 auto;
        height: 32px;
        justify-content: center;
        position: relative;
        width: 32px;
        border-radius: 999px;
      }

      .channels-shell .channel-signup-notes svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
        fill: none;
      }

      .channels-shell .channel-signup-notes:hover,
      .channels-shell .channel-signup-notes:focus-visible {
        background: color-mix(in srgb, var(--accent) 14%, var(--panel));
        color: var(--accent);
      }

      .channels-shell .channel-signup-notes::after {
        content: attr(data-tooltip);
        position: absolute;
        right: 0;
        top: calc(100% + 8px);
        z-index: 40;
        width: min(340px, calc(100vw - 48px));
        max-width: max-content;
        padding: 10px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--panel);
        box-shadow: var(--shadow-lg);
        color: var(--text-strong);
        font-size: 12px;
        font-weight: 520;
        line-height: 1.45;
        opacity: 0;
        pointer-events: none;
        transform: translateY(-2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease;
        white-space: pre-line;
      }

      .channels-shell .channel-signup-notes:hover::after,
      .channels-shell .channel-signup-notes:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
      }

      .channels-shell .channel-debug-details summary {
        cursor: pointer;
        list-style: none;
      }

      .channels-shell .channel-debug-details summary::-webkit-details-marker {
        display: none;
      }

      @media (max-width: 1080px) {
        .channels-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 720px) {
        .channels-grid > .card,
        .channels-health-card {
          padding: 16px;
        }

        .channels-shell .status-list > div:not(.account-card-error) {
          gap: 6px;
        }

        .channels-shell .status-list div > span:last-child {
          margin-left: 0;
          text-align: left;
          width: 100%;
        }

        .channels-shell .config-form > .cfg-fields > .cfg-field,
        .channels-shell .config-form > .cfg-fields > .cfg-toggle-row,
        .channels-shell .config-form > .cfg-fields > .cfg-object,
        .channels-shell .config-form > .cfg-fields > .cfg-array,
        .channels-shell .config-form > .cfg-fields > .cfg-map {
          max-width: none;
          min-width: 0;
        }

        .channels-shell .account-card-list {
          grid-template-columns: 1fr;
        }

        .channels-shell .channel-route-row {
          grid-template-columns: 1fr;
        }

        .channels-shell .channel-route-block {
          max-width: none;
        }

        .channels-shell .channel-route-specific-row {
          grid-template-columns: 1fr;
        }
      }
    </style>

    <section class=${options.embedded ? "channels-shell channels-shell--embedded" : "channels-shell"}>
      ${props.notice ? html`<div class="callout info">${props.notice}</div>` : nothing}
      <div class="channels-tabs" role="tablist" aria-label="Channels sections">
        <button
          class="channels-tab ${activeView === "accounts" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${activeView === "accounts"}
          @click=${() => props.onViewChange?.("accounts")}
        >
          Accounts
        </button>
        <button
          class="channels-tab ${activeView === "messages" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${activeView === "messages"}
          @click=${() => props.onViewChange?.("messages")}
        >
          Behavior
        </button>
        <button
          class="channels-tab ${activeView === "commands" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${activeView === "commands"}
          @click=${() => props.onViewChange?.("commands")}
        >
          Access
        </button>
        <button
          class="channels-tab ${activeView === "sessions" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${activeView === "sessions"}
          @click=${() => props.onViewChange?.("sessions")}
        >
          Sessions
        </button>
        <button
          class="channels-tab ${activeView === "web" ? "active" : ""}"
          type="button"
          role="tab"
          aria-selected=${activeView === "web"}
          @click=${() => props.onViewChange?.("web")}
        >
          Runtime
        </button>
      </div>
      ${
        activeView === "messages"
          ? renderChannelMessagesPanel(props)
          : activeView === "commands"
            ? renderChannelCommandsPanel(props)
            : activeView === "sessions"
              ? renderChannelSessionsPanel(props)
              : activeView === "web"
                ? renderChannelWebRuntimePanel(props)
                : html`
      <section class="channels-list" aria-label="Channel status">
      ${groupOrderedChannels(orderedChannels).map(
        (group) => html`
        <section class="channels-group" data-channel-group=${group.id}>
          <div class="channels-group__header">
            <span>${group.title}</span>
          </div>
          <div class="channels-group__list">
      ${group.channels.map((channel) => {
        const status = channel.status;
        const docsPath = resolveChannelDocsPath(props.snapshot, channel.key);
        return html`
          <details class="channels-channel" data-channel-card=${channel.key}>
            <summary class="channels-channel__summary">
              <div class="channels-channel__main">
                <span
                  class="channels-channel__dot ${status.connected || status.running ? "ok" : status.configured ? "warn" : ""}"
                  title=${status.statusLabel}
                  aria-hidden="true"
                ></span>
                <div>
                  <div class="channels-channel__name">${status.label}</div>
                  <div class="channels-channel__detail">${status.detail}</div>
                </div>
              </div>
              <div class="channels-channel__status">
                ${
                  status.needsSetup
                    ? html`
                        <button
                          class="btn btn--sm"
                          type="button"
                          title=${status.statusLabel}
                          aria-label=${`${status.setupLabel} ${status.label}`}
                          @click=${(event: Event) => openChannelConnectDialog(event, channel.key)}
                        >
                          ${status.setupLabel}
                        </button>
                      `
                    : nothing
                }
                ${
                  status.accounts > 1
                    ? html`<span class="chip">${status.accounts} accounts</span>`
                    : nothing
                }
                ${
                  status.installPendingRestart
                    ? html`
                        <span class="chip chip-warn">Restart required</span>
                      `
                    : nothing
                }
                ${
                  status.catalogOnly && status.installAvailable && !status.installPendingRestart
                    ? html`
                        <button
                          class="btn btn--sm"
                          type="button"
                          title="Install channel plugin"
                          aria-label="Install channel plugin"
                          ?disabled=${status.busy}
                          @click=${(event: Event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            props.onChannelInstall(channel.key);
                          }}
                        >
                          Install
                        </button>
                      `
                    : nothing
                }
                ${
                  status.configured && !status.catalogOnly
                    ? html`
                        <button
                          class="btn btn--sm"
                          type="button"
                          title="Configure channel"
                          aria-label=${`Configure ${status.label}`}
                          @click=${(event: Event) => openChannelConnectDialog(event, channel.key)}
                        >
                          Configure
                        </button>
                        <button
                          class="btn btn--sm"
                          type="button"
                          title="Clear credentials"
                          aria-label="Clear credentials"
                          ?disabled=${status.busy}
                          @click=${(event: Event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            props.onChannelLogout(channel.key, status.defaultAccountId);
                          }}
                        >
                          × Clear
                        </button>
                      `
                    : nothing
                }
              </div>
            </summary>
            <div class="channels-channel__body">
              ${renderChannel(channel.key, props, {
                whatsapp,
                telegram,
                discord,
                googlechat,
                slack,
                signal,
                imessage,
                nostr,
                channelAccounts: props.snapshot?.channelAccounts ?? null,
              })}
            </div>
          </details>
          ${renderChannelConnectDialog({
            channel,
            status,
            docsPath,
            props,
            data: {
              whatsapp,
              telegram,
              discord,
              googlechat,
              slack,
              signal,
              imessage,
              nostr,
              channelAccounts: props.snapshot?.channelAccounts ?? null,
            },
          })}
        `;
      })}
          </div>
        </section>
      `,
      )}
      </section>

      ${
        showDebug
          ? html`
              <section class="card channels-health-card">
                <details class="channel-debug-details">
                  <summary>
                    <div class="row" style="justify-content: space-between;">
                      <div>
                        <div class="card-title">Debug snapshot</div>
                        <div class="card-sub">Raw app account status, auth, runtime, and command-route data.</div>
                      </div>
                      <div class="muted">${props.lastSuccessAt ? formatRelativeTimestamp(props.lastSuccessAt) : "n/a"}</div>
                    </div>
                  </summary>
                  ${
                    props.lastError
                      ? html`<div class="callout danger" style="margin-top: 12px;">
                        ${props.lastError}
                      </div>`
                      : nothing
                  }
                  <pre class="code-block" style="margin-top: 12px;">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : "No snapshot yet."}
                  </pre>
                </details>
              </section>
            `
          : nothing
      }
          `
      }
    </section>
  `;
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["telegram", "whatsapp", "discord", "irc", "googlechat", "slack", "signal", "imessage"];
}

function channelSummaryForRow(props: ChannelsProps, key: ChannelKey) {
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const defaultAccountId = props.snapshot?.channelDefaultAccountId?.[key];
  const busy = Boolean(
    props.channelRuntimeBusy[`${key}:${defaultAccountId ?? ""}`] ||
    props.channelRuntimeBusy[`install:${key}`],
  );
  const configured =
    key === "whatsapp"
      ? whatsAppHasLinkedAccount(status, accounts)
      : channelHasConfiguredAccount(status, accounts);
  const running =
    accounts.length > 0 ? accounts.some((account) => account.running) : status?.running === true;
  const connected =
    accounts.length > 0
      ? accounts.some((account) => account.connected)
      : status?.connected === true;
  const catalogOnly = status?.catalogOnly === true;
  const install = status?.install;
  const installAvailable = hasChannelInstallMetadata(install);
  const localInstall = isLocalChannelInstall(install);
  const installPendingRestart = status?.pendingRestart === true;
  const label = resolveChannelLabel(props.snapshot, key);
  const meta = resolveChannelMetaMap(props.snapshot)[key];
  const rawDetail =
    props.snapshot?.channelDetailLabels?.[key] ??
    meta?.detailLabel ??
    (accounts.length > 0
      ? accounts
          .map((account) => account.name?.trim() || account.accountId)
          .filter(Boolean)
          .slice(0, 2)
          .join(", ")
      : "Channel account");
  const detail = stripLeadingChannelLabel(String(rawDetail), label) || "Channel account";
  let statusLabel = "setup needed";
  if (connected) {
    statusLabel = "connected";
  } else if (running) {
    statusLabel = "running";
  } else if (configured) {
    statusLabel = "configured";
  } else if (catalogOnly) {
    statusLabel = installAvailable ? "install channel" : "source install required";
  } else if (key === "whatsapp") {
    statusLabel = "sign up";
  }
  return {
    label,
    detail,
    accounts: accounts.length,
    configured,
    running,
    connected,
    defaultAccountId,
    busy,
    statusLabel,
    catalogOnly,
    installAvailable,
    localInstall,
    installPendingRestart,
    needsSetup: !configured && !catalogOnly,
    setupLabel: "Connect",
  };
}

function isLocalChannelInstall(install: unknown): boolean {
  return (
    isRecord(install) &&
    typeof install.localPath === "string" &&
    install.localPath.trim().length > 0
  );
}

function shouldShowChannelRow(status: ReturnType<typeof channelSummaryForRow>): boolean {
  void status;
  return true;
}

function stripLeadingChannelLabel(text: string, label: string): string {
  const trimmed = text.trim();
  const normalizedLabel = label.trim();
  if (!trimmed || !normalizedLabel) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  const labelLower = normalizedLabel.toLowerCase();
  if (lower === labelLower) {
    return "";
  }
  for (const separator of [" ", ":", "–", "—", "/"]) {
    const prefix = `${labelLower}${separator}`;
    if (lower.startsWith(prefix)) {
      return trimmed.slice(normalizedLabel.length + separator.length).trim();
    }
  }
  return trimmed;
}

function renderChannel(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  const accountCountLabel = renderChannelAccountCount(key, data.channelAccounts);
  if (isCatalogOnlyChannel(props, key)) {
    return renderCatalogOnlyChannelCard(key, props, data.channelAccounts ?? {});
  }
  const status = props.snapshot?.channels?.[key];
  const accounts = data.channelAccounts?.[key] ?? [];
  if (key === "whatsapp" && !whatsAppHasLinkedAccount(status, accounts)) {
    return renderChannelSignupCard({
      channelId: key,
      label: resolveChannelLabel(props.snapshot, key),
      props,
    });
  }
  if (!channelHasConfiguredAccount(status, accounts)) {
    return renderChannelSignupCard({
      channelId: key,
      label: resolveChannelLabel(props.snapshot, key),
      props,
    });
  }
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        whatsappAccounts: data.channelAccounts?.whatsapp ?? [],
        accountCountLabel,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        accountCountLabel,
      });
    case "discord":
      return renderDiscordCard({
        props,
        discord: data.discord,
        discordAccounts: data.channelAccounts?.discord ?? [],
        accountCountLabel,
      });
    case "googlechat":
      return renderGoogleChatCard({
        props,
        googleChat: data.googlechat,
        googleChatAccounts: data.channelAccounts?.googlechat ?? [],
        accountCountLabel,
      });
    case "slack":
      return renderSlackCard({
        props,
        slack: data.slack,
        slackAccounts: data.channelAccounts?.slack ?? [],
        accountCountLabel,
      });
    case "signal":
      return renderSignalCard({
        props,
        signal: data.signal,
        signalAccounts: data.channelAccounts?.signal ?? [],
        accountCountLabel,
      });
    case "imessage":
      return renderIMessageCard({
        props,
        imessage: data.imessage,
        imessageAccounts: data.channelAccounts?.imessage ?? [],
        accountCountLabel,
      });
    case "nostr": {
      const nostrAccounts = data.channelAccounts?.nostr ?? [];
      const primaryAccount = nostrAccounts[0];
      const accountId = primaryAccount?.accountId ?? "default";
      const profile =
        (primaryAccount as { profile?: NostrProfile | null } | undefined)?.profile ?? null;
      const showForm =
        props.nostrProfileAccountId === accountId ? props.nostrProfileFormState : null;
      const profileFormCallbacks = showForm
        ? {
            onFieldChange: props.onNostrProfileFieldChange,
            onSave: props.onNostrProfileSave,
            onImport: props.onNostrProfileImport,
            onCancel: props.onNostrProfileCancel,
            onToggleAdvanced: props.onNostrProfileToggleAdvanced,
          }
        : null;
      return renderNostrCard({
        props,
        nostr: data.nostr,
        nostrAccounts,
        accountCountLabel,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelCard(key, props, data.channelAccounts ?? {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function whatsAppHasLinkedAccount(
  status: unknown,
  accounts?: ChannelAccountSnapshot[] | null,
): boolean {
  if (accounts?.some((account) => account.linked === true || account.connected === true)) {
    return true;
  }
  return isRecord(status) && (status.linked === true || status.connected === true);
}

function hasChannelInstallMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (typeof value.npmSpec === "string" && value.npmSpec.trim().length > 0) ||
    (typeof value.localPath === "string" && value.localPath.trim().length > 0)
  );
}

function isCatalogOnlyChannel(props: ChannelsProps, key: ChannelKey): boolean {
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  return status?.catalogOnly === true;
}

function renderCatalogOnlyChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const label = resolveChannelLabel(props.snapshot, key);
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const install = isRecord(status?.install) ? status.install : null;
  const installAvailable = hasChannelInstallMetadata(install);
  const installPendingRestart = status?.pendingRestart === true;
  void channelAccounts;
  if (!installAvailable) {
    return html`
      <div class="card">
        <div class="card-title">Source install required</div>
        <div class="card-sub">
          This channel runtime is not installed. Install its source-maintained extension before adding
          account credentials.
        </div>
      </div>
    `;
  }
  return renderChannelSignupCard({
    channelId: key,
    label,
    props,
    catalogOnly: true,
    installAvailable,
    installPendingRestart,
    install,
  });
}

function renderGenericChannelCard(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const label = resolveChannelLabel(props.snapshot, key);
  const status = props.snapshot?.channels?.[key] as Record<string, unknown> | undefined;
  const configured = typeof status?.configured === "boolean" ? status.configured : undefined;
  const running = typeof status?.running === "boolean" ? status.running : undefined;
  const connected = typeof status?.connected === "boolean" ? status.connected : undefined;
  const lastError = typeof status?.lastError === "string" ? status.lastError : undefined;
  const catalogOnly = status?.catalogOnly === true;
  const install =
    (status?.install && typeof status.install === "object"
      ? (status.install as Record<string, unknown>)
      : null) ?? null;
  const accounts = channelAccounts[key] ?? [];
  const accountCountLabel = renderChannelAccountCount(key, channelAccounts);
  if (!channelHasConfiguredAccount(status, accounts)) {
    return renderChannelSignupCard({
      channelId: key,
      label,
      props,
      catalogOnly,
      installAvailable: hasChannelInstallMetadata(install),
      install,
    });
  }

  return html`
    <div class="card">
      <div class="card-title">${label}</div>
      <div class="card-sub">Channel status and configuration.</div>
      ${accountCountLabel}

      ${
        accounts.length > 0
          ? html`
            <div class="account-card-list">
              ${accounts.map((account) => renderGenericAccount(key, account, props))}
            </div>
          `
          : html`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${configured == null ? "n/a" : configured ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${running == null ? "n/a" : running ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Connected</span>
                <span>${connected == null ? "n/a" : connected ? "Yes" : "No"}</span>
              </div>
            </div>
          `
      }

      ${catalogOnly ? nothing : renderChannelRoutePanel({ props, channelId: key, accounts })}

      ${
        lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${lastError}
          </div>`
          : nothing
      }

      ${
        catalogOnly
          ? html`
              <div class="callout info" style="margin-top: 12px;">
                Install this channel plugin before setup fields are available.
                ${
                  typeof install?.npmSpec === "string"
                    ? html`<span class="mono">${install.npmSpec}</span>`
                    : nothing
                }
              </div>
            `
          : html`
              ${renderChannelConfigSection({
                channelId: key,
                props,
                configured:
                  configured === true || accounts.some((account) => account.configured === true),
              })}
            `
      }
      ${
        catalogOnly
          ? nothing
          : accounts.length > 0
            ? nothing
            : renderChannelRuntimeControls({ props, channelId: key, running })
      }
    </div>
  `;
}

function resolveChannelDocsPath(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  void snapshot;
  return `/channels/${key}`;
}

function renderChannelConnectDialog(params: {
  channel: ChannelRow;
  status: ReturnType<typeof channelSummaryForRow>;
  docsPath: string;
  props: ChannelsProps;
  data: ChannelsChannelData;
}) {
  const { channel, status, docsPath, props, data } = params;
  return html`
    <dialog
      id=${channelConnectDialogId(channel.key)}
      class="channel-connect-dialog"
      data-channel-connect-dialog=${channel.key}
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          (event.currentTarget as HTMLDialogElement).close();
        }
      }}
    >
      <div class="channel-connect-dialog__panel" role="document">
        <header class="channel-connect-dialog__header">
          <div>
            <div class="channel-connect-dialog__title">${status.label}</div>
            <div class="channel-connect-dialog__meta">
              ${status.configured ? "Configure account fields and runtime access." : "Connect account fields exposed by this channel."}
            </div>
          </div>
          <div class="channel-connect-dialog__actions">
            <a class="btn btn--sm" href=${docsPath} target="_blank" rel="noreferrer">Docs</a>
            <button
              class="channel-connect-dialog__close"
              type="button"
              aria-label="Close"
              @click=${closeChannelConnectDialog}
            >
              ${icons.x}
            </button>
          </div>
        </header>
        <div class="channel-connect-dialog__body">
          ${renderChannelConnectContent(channel.key, status, props, data)}
        </div>
      </div>
    </dialog>
  `;
}

function renderChannelConnectContent(
  key: ChannelKey,
  status: ReturnType<typeof channelSummaryForRow>,
  props: ChannelsProps,
  data: ChannelsChannelData,
) {
  if (isCatalogOnlyChannel(props, key)) {
    return renderCatalogOnlyChannelCard(key, props, data.channelAccounts ?? {});
  }
  return renderChannelSignupCard({
    channelId: key,
    label: status.label,
    props,
  });
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) {
    return {};
  }
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

const RECENT_ACTIVITY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function hasRecentActivity(account: ChannelAccountSnapshot): boolean {
  if (!account.lastInboundAt) {
    return false;
  }
  return Date.now() - account.lastInboundAt < RECENT_ACTIVITY_THRESHOLD_MS;
}

function deriveRunningStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" {
  if (account.running) {
    return "Yes";
  }
  // If we have recent inbound activity, the channel is effectively running
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "No";
}

function deriveConnectedStatus(account: ChannelAccountSnapshot): "Yes" | "No" | "Active" | "n/a" {
  if (account.connected === true) {
    return "Yes";
  }
  if (account.connected === false) {
    return "No";
  }
  // If connected is null/undefined but we have recent activity, show as active
  if (hasRecentActivity(account)) {
    return "Active";
  }
  return "n/a";
}

function renderGenericAccount(
  channelId: ChannelKey,
  account: ChannelAccountSnapshot,
  props: ChannelsProps,
) {
  const runningStatus = deriveRunningStatus(account);
  const connectedStatus = deriveConnectedStatus(account);

  return html`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${account.name || account.accountId}</div>
        <div class="account-card-id">${account.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">Running</span>
          <span>${runningStatus}</span>
        </div>
        <div>
          <span class="label">Configured</span>
          <span>${account.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${connectedStatus}</span>
        </div>
        <div>
          <span class="label">Last inbound</span>
          <span>${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}</span>
        </div>
        ${
          account.lastError
            ? html`
              <div class="account-card-error">
                ${account.lastError}
              </div>
            `
            : nothing
        }
      </div>
      ${renderChannelRuntimeControls({
        props,
        channelId,
        accountId: account.accountId,
        running: account.running,
      })}
    </div>
  `;
}
