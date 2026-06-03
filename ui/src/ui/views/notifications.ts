import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import {
  NOTIFICATION_CATEGORY_ORDER,
  NOTIFICATION_DEFINITIONS,
  resolveNotificationRouteTarget,
  resolveNotificationRouteLabel,
  summarizeNotificationRoute,
  type AppNotification,
  type NotificationCategory,
} from "../notifications.ts";
import type { UiSettings } from "../storage.ts";
import type { ChannelAccountSnapshot, ChannelsStatusSnapshot } from "../types.ts";

export type NotificationsViewProps = {
  settings: UiSettings;
  snapshot: ChannelsStatusSnapshot | null;
  configForm?: Record<string, unknown> | null;
  events: AppNotification[];
  onSettingsChange: (next: UiSettings) => void;
  onDismiss: (id: string) => void;
  onSendTest?: () => void;
};

function categoryLabel(category: NotificationCategory): string {
  if (category === "mining") {
    return "Mining";
  }
  if (category === "wallet") {
    return "Wallet";
  }
  if (category === "task") {
    return "Tasks";
  }
  return "Fased Network";
}

function resolveChannels(snapshot: ChannelsStatusSnapshot | null): string[] {
  const channelOrder = snapshot?.channelOrder ?? [];
  if (channelOrder.length > 0) {
    return channelOrder.filter(
      (channel) => (snapshot?.channelAccounts?.[channel]?.length ?? 0) > 0,
    );
  }
  return Object.keys(snapshot?.channelAccounts ?? {}).filter(
    (channel) => (snapshot?.channelAccounts?.[channel]?.length ?? 0) > 0,
  );
}

function resolveAccounts(
  snapshot: ChannelsStatusSnapshot | null,
  channel: string,
): ChannelAccountSnapshot[] {
  return snapshot?.channelAccounts?.[channel] ?? [];
}

function renderRouteCard(props: NotificationsViewProps) {
  const channels = resolveChannels(props.snapshot);
  const selectedChannel = props.settings.notificationRouteChannel.trim() || channels[0] || "";
  const accounts = resolveAccounts(props.snapshot, selectedChannel);
  const selectedAccountId =
    props.settings.notificationRouteAccountId.trim() ||
    props.snapshot?.channelDefaultAccountId?.[selectedChannel] ||
    accounts[0]?.accountId ||
    "";
  const routeLabel = resolveNotificationRouteLabel(
    props.snapshot,
    selectedChannel,
    selectedAccountId,
  );
  const routeTarget =
    props.settings.notificationRouteTo.trim() ||
    resolveNotificationRouteTarget(
      props.snapshot,
      selectedChannel,
      selectedAccountId,
      props.configForm,
    );
  const routeReady =
    props.settings.notificationRouteMode === "channel" &&
    selectedChannel &&
    selectedAccountId &&
    routeTarget;
  const routeIncomplete = props.settings.notificationRouteMode === "channel" && !routeReady;
  const routeTone = routeReady ? "ok" : routeIncomplete ? "warn" : "default";
  const routeStatus = routeReady ? "Ready" : routeIncomplete ? "Incomplete" : "UI only";

  return html`
    <section class="card notification-card">
      <div class="notification-card__head">
        <div>
          <div class="notification-title-row">
            <div class="card-title">Delivery</div>
            <span
              class="notification-help"
              role="img"
              tabindex="0"
              aria-label="In-app history is always kept. External delivery uses the selected channel route."
              data-tooltip="In-app history is always kept. External delivery uses the selected channel route."
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2-3 4" />
                <path d="M12 17h.01" />
              </svg>
            </span>
          </div>
        </div>
        <div class="notification-card__actions">
          <span class="notification-route-status">
            <span class="notification-status-dot ${routeTone}" aria-hidden="true"></span>
            ${routeStatus}
          </span>
          ${
            props.onSendTest
              ? html`
                  <button class="btn btn--sm primary notification-test-button" @click=${props.onSendTest}>Test</button>
                `
              : nothing
          }
        </div>
      </div>

      <div class="notification-route-grid">
        <label class="field">
          <span>Delivery mode</span>
          <select
            .value=${props.settings.notificationRouteMode}
            @change=${(event: Event) =>
              props.onSettingsChange({
                ...props.settings,
                notificationRouteMode:
                  (event.target as HTMLSelectElement).value === "channel" ? "channel" : "ui-only",
              })}
          >
            <option value="ui-only">In-app only</option>
            <option value="channel">Route to channel</option>
          </select>
        </label>

        <label class="field">
          <span>Channel</span>
          <select
            .value=${selectedChannel}
            ?disabled=${channels.length === 0}
            @change=${(event: Event) => {
              const nextChannel = (event.target as HTMLSelectElement).value;
              const nextAccounts = resolveAccounts(props.snapshot, nextChannel);
              const nextAccountId =
                props.snapshot?.channelDefaultAccountId?.[nextChannel] ??
                nextAccounts[0]?.accountId ??
                "";
              props.onSettingsChange({
                ...props.settings,
                notificationRouteChannel: nextChannel,
                notificationRouteAccountId: nextAccountId,
              });
            }}
          >
            ${
              channels.length === 0
                ? html`
                    <option value="">No configured channel accounts</option>
                  `
                : channels.map((channel) => {
                    const label =
                      props.snapshot?.channelLabels?.[channel] ??
                      props.snapshot?.channelMeta?.find((entry) => entry.id === channel)?.label ??
                      channel;
                    return html`<option value=${channel}>${label}</option>`;
                  })
            }
          </select>
        </label>

        <label class="field">
          <span>Account</span>
          <select
            .value=${selectedAccountId}
            ?disabled=${accounts.length === 0}
            @change=${(event: Event) =>
              props.onSettingsChange({
                ...props.settings,
                notificationRouteAccountId: (event.target as HTMLSelectElement).value,
              })}
          >
            ${
              accounts.length === 0
                ? html`
                    <option value="">No accounts</option>
                  `
                : accounts.map((account) => {
                    const label = String(account.name ?? "").trim() || account.accountId;
                    return html`<option value=${account.accountId}>${label}</option>`;
                  })
            }
          </select>
        </label>

        <label class="field">
          <span>Destination</span>
          <input
            type="text"
            .value=${props.settings.notificationRouteTo}
            placeholder=${routeTarget || "Channel, user, room, phone, or route target"}
            @input=${(event: Event) =>
              props.onSettingsChange({
                ...props.settings,
                notificationRouteTo: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
      </div>

      <div class="muted notification-route-summary">
        ${routeLabel}
        ${routeTarget ? html` · destination <span class="mono">${routeTarget}</span>` : nothing}
      </div>

      ${
        props.settings.notificationRouteMode === "channel" && !routeTarget
          ? html`
              <div class="callout warn" style="margin-top: 12px">
                Set a destination before routed alerts can leave the dashboard.
              </div>
            `
          : nothing
      }
    </section>
  `;
}

function renderPreferenceCard(props: NotificationsViewProps) {
  return html`
    <section class="card notification-card">
      <div class="card-title">Events</div>

      ${NOTIFICATION_CATEGORY_ORDER.map((category) => {
        const definitions = NOTIFICATION_DEFINITIONS.filter((entry) => entry.category === category);
        const enabledCount = definitions.filter((definition) =>
          typeof props.settings.notificationEventPrefs?.[definition.code] === "boolean"
            ? Boolean(props.settings.notificationEventPrefs?.[definition.code])
            : definition.defaultRouted,
        ).length;
        return html`
          <details class="notification-pref-group">
            <summary class="notification-pref-summary">
              <span>${categoryLabel(category)}</span>
              <span class="muted">${enabledCount}/${definitions.length}</span>
            </summary>
            <div class="notification-pref-list">
              ${definitions.map((definition) => {
                const checked =
                  typeof props.settings.notificationEventPrefs?.[definition.code] === "boolean"
                    ? Boolean(props.settings.notificationEventPrefs?.[definition.code])
                    : definition.defaultRouted;
                return html`
                  <div class="notification-pref-row">
                    <div class="notification-pref-copy">
                      <div class="notification-pref-label">${definition.label}</div>
                      <div class="muted notification-pref-description">${definition.description}</div>
                    </div>
                    <label class="cfg-toggle" title=${checked ? "Enabled" : "Disabled"}>
                      <input
                        type="checkbox"
                        .checked=${checked}
                        @change=${(event: Event) =>
                          props.onSettingsChange({
                            ...props.settings,
                            notificationEventPrefs: {
                              ...props.settings.notificationEventPrefs,
                              [definition.code]: (event.target as HTMLInputElement).checked,
                            },
                          })}
                      />
                      <span class="cfg-toggle__track"></span>
                    </label>
                  </div>
                `;
              })}
            </div>
          </details>
        `;
      })}
    </section>
  `;
}

function renderHistoryCard(props: NotificationsViewProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Recent events</div>
          <div class="card-sub">Shared event history across mining, wallet, and Fased Network.</div>
        </div>
        <div class="muted">${props.events.length} stored</div>
      </div>

      ${
        props.events.length === 0
          ? html`
              <div class="empty-state" style="margin-top: 14px">No notifications yet.</div>
            `
          : html`
              <div style="display: grid; gap: 10px; margin-top: 14px; max-height: 720px; overflow: auto;">
                ${props.events.map((event) => {
                  const routeSummary = summarizeNotificationRoute(
                    event.routeStatus,
                    event.routeError,
                  );
                  const routeLabel = resolveNotificationRouteLabel(
                    props.snapshot,
                    event.routeChannel,
                    event.routeAccountId,
                  );
                  return html`
                    <div
                      style="border: 1px solid var(--border); border-radius: 16px; padding: 14px; display: grid; gap: 10px;"
                    >
                      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
                        <div style="min-width: 0;">
                          <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
                            <span class="status-pill ${
                              event.level === "error"
                                ? "danger"
                                : event.level === "warning"
                                  ? "warn"
                                  : event.level === "success"
                                    ? "ok"
                                    : ""
                            }">
                              ${event.level}
                            </span>
                            <span class="status-pill">${categoryLabel(event.category)}</span>
                            <span class="status-pill">${routeSummary}</span>
                          </div>
                          <div style="font-weight: 700; margin-top: 8px;">${event.title}</div>
                          <div style="margin-top: 6px;">${event.message}</div>
                        </div>
                        <button class="btn btn--ghost btn--sm" @click=${() => props.onDismiss(event.id)}>
                          Dismiss
                        </button>
                      </div>

                      <div class="row" style="justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap;">
                        <div class="muted">
                          ${formatRelativeTimestamp(new Date(event.createdAt).getTime())}
                          ${event.routeChannel ? html` · ${routeLabel}` : nothing}
                          ${event.routeTo ? html` · <span class="mono">${event.routeTo}</span>` : nothing}
                        </div>
                        ${
                          event.routedAt
                            ? html`<div class="muted">Last route attempt ${formatRelativeTimestamp(new Date(event.routedAt).getTime())}</div>`
                            : nothing
                        }
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
      }
    </section>
  `;
}

export function renderNotifications(props: NotificationsViewProps) {
  return html`
    <style>
      .notifications-layout {
        display: grid;
        gap: 16px;
        grid-template-columns: minmax(300px, 420px) minmax(0, 1fr);
        align-items: start;
      }

      .notification-card {
        border-radius: var(--radius-sm);
      }

      .notification-card__head,
      .notification-card__actions,
      .notification-route-status,
      .notification-title-row,
      .notification-pref-summary,
      .notification-pref-row {
        align-items: center;
        display: flex;
      }

      .notification-card__head {
        gap: 14px;
        justify-content: space-between;
      }

      .notification-card__actions {
        gap: 8px;
        justify-content: flex-end;
      }

      .notification-title-row {
        gap: 7px;
      }

      .notification-help {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-sm);
        color: var(--muted);
        cursor: help;
        display: inline-flex;
        flex: 0 0 auto;
        height: 22px;
        justify-content: center;
        position: relative;
        width: 22px;
      }

      .notification-help svg {
        fill: none;
        height: 16px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
        width: 16px;
      }

      .notification-help::after {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        color: var(--text-strong);
        content: attr(data-tooltip);
        font-size: 12px;
        font-weight: 520;
        left: 0;
        line-height: 1.45;
        opacity: 0;
        padding: 10px 12px;
        pointer-events: none;
        position: absolute;
        top: calc(100% + 8px);
        transform: translateY(-2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease;
        white-space: normal;
        width: min(340px, calc(100vw - 48px));
        z-index: 50;
      }

      .notification-help:hover,
      .notification-help:focus-visible {
        background: var(--bg-hover);
        color: var(--text-strong);
      }

      .notification-help:hover::after,
      .notification-help:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
      }

      .notification-test-button {
        min-width: 58px;
      }

      .notification-route-status {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        gap: 7px;
        white-space: nowrap;
      }

      .notification-status-dot {
        background: var(--muted);
        border-radius: var(--radius-full);
        height: 8px;
        width: 8px;
      }

      .notification-status-dot.ok {
        background: var(--ok);
      }

      .notification-status-dot.warn {
        background: var(--warn);
      }

      .notification-route-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin-top: 14px;
      }

      .notification-route-summary {
        margin-top: 12px;
      }

      .notification-pref-group {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        margin-top: 10px;
        overflow: hidden;
      }

      .notification-pref-summary {
        cursor: pointer;
        font-weight: 800;
        justify-content: space-between;
        list-style: none;
        min-height: 42px;
        padding: 0 12px;
      }

      .notification-pref-summary::-webkit-details-marker {
        display: none;
      }

      .notification-pref-group[open] .notification-pref-summary {
        border-bottom: 1px solid var(--border);
      }

      .notification-pref-list {
        display: grid;
      }

      .notification-pref-row {
        gap: 12px;
        justify-content: space-between;
        padding: 11px 12px;
      }

      .notification-pref-row + .notification-pref-row {
        border-top: 1px solid var(--border);
      }

      .notification-pref-copy {
        min-width: 0;
      }

      .notification-pref-label {
        color: var(--text-strong);
        font-weight: 700;
      }

      .notification-pref-description {
        line-height: 1.35;
        margin-top: 3px;
      }

      @media (max-width: 980px) {
        .notifications-layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
    <section class="notifications-layout">
      <div style="display: grid; gap: 18px;">
        ${renderRouteCard(props)}
        ${renderPreferenceCard(props)}
      </div>
      <div>${renderHistoryCard(props)}</div>
    </section>
  `;
}
