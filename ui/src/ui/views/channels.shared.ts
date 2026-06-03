import { html, nothing } from "lit";
import { formatAgentDisplayLabel } from "../agent-display.ts";
import type { ChannelAccountSnapshot, GatewayAgentRow } from "../types.ts";
import type { ChannelKey, ChannelsProps } from "./channels.types.ts";

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  const snapshot = props.snapshot;
  const channels = snapshot?.channels as Record<string, unknown> | null;
  if (!snapshot || !channels) {
    return false;
  }
  const channelStatus = channels[key] as Record<string, unknown> | undefined;
  const configured = typeof channelStatus?.configured === "boolean" && channelStatus.configured;
  const running = typeof channelStatus?.running === "boolean" && channelStatus.running;
  const connected = typeof channelStatus?.connected === "boolean" && channelStatus.connected;
  const accounts = snapshot.channelAccounts?.[key] ?? [];
  const accountActive = accounts.some(
    (account) => account.configured || account.running || account.connected,
  );
  return configured || running || connected || accountActive;
}

export function getChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number {
  return channelAccounts?.[key]?.length ?? 0;
}

export function renderChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
) {
  const count = getChannelAccountCount(key, channelAccounts);
  if (count < 2) {
    return nothing;
  }
  return html`<div class="account-count">Accounts (${count})</div>`;
}

export function channelRuntimeControlKey(channelId: string, accountId?: string) {
  return `${channelId}:${accountId ?? ""}`;
}

export function renderChannelRuntimeControls(params: {
  props: ChannelsProps;
  channelId: string;
  accountId?: string;
  running?: boolean | null;
  probe?: boolean;
  probeStatus?: unknown;
}) {
  const { props, channelId, accountId, running } = params;
  const busy = Boolean(props.channelRuntimeBusy[channelRuntimeControlKey(channelId, accountId)]);
  const disabled = busy || !props.connected;

  return html`
    <div class="row" style="margin-top: 12px;">
      <button
        class="btn primary"
        ?disabled=${disabled || running === true}
        @click=${() => props.onChannelStart(channelId, accountId)}
      >
        ${busy ? "Working..." : "Start"}
      </button>
      <button
        class="btn"
        ?disabled=${disabled || running === false}
        @click=${() => props.onChannelStop(channelId, accountId)}
      >
        Stop
      </button>
      ${
        params.probe
          ? html`
              <button
                class="btn channel-probe-button"
                ?disabled=${!props.connected}
                @click=${() => props.onRefresh(true)}
                title=${probeTitle(params.probeStatus)}
              >
                ${renderProbeButtonDot(params.probeStatus)}
                Probe
              </button>
            `
          : nothing
      }
    </div>
  `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function probeDetail(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const parts = [
    value.ok === true ? "ok" : "failed",
    typeof value.status === "string" || typeof value.status === "number"
      ? String(value.status)
      : "",
    typeof value.error === "string" ? value.error : "",
  ].filter((part) => part.trim().length > 0);
  return parts.join(" · ");
}

function probeTitle(probe: unknown): string {
  const detail = probeDetail(probe);
  return detail ? `Probe ${detail}` : "Probe channel";
}

function renderProbeButtonDot(probe: unknown) {
  if (!isRecord(probe)) {
    return nothing;
  }
  const ok = probe.ok === true;
  return html`
    <span class="channel-probe-button__dot ${ok ? "ok" : "danger"}" aria-hidden="true"></span>
  `;
}

function configBindings(props: ChannelsProps): Array<Record<string, unknown>> {
  const bindings = props.configForm?.bindings;
  if (!Array.isArray(bindings)) {
    return [];
  }
  return bindings.filter(isRecord);
}

function normalizeAccountId(accountId?: string): string {
  return accountId?.trim() ?? "";
}

function isSimpleChannelRouteBinding(
  binding: Record<string, unknown>,
  channelId: string,
  accountId?: string,
): boolean {
  const match = binding.match;
  if (!isRecord(match) || match.channel !== channelId) {
    return false;
  }
  const bindingAccountId = typeof match.accountId === "string" ? match.accountId : "";
  if (bindingAccountId !== normalizeAccountId(accountId)) {
    return false;
  }
  return !("peer" in match || "guildId" in match || "teamId" in match || "roles" in match);
}

function isSpecificChannelRouteBinding(
  binding: Record<string, unknown>,
  channelId: string,
): binding is Record<string, unknown> & { match: Record<string, unknown> } {
  const match = binding.match;
  if (!isRecord(match) || match.channel !== channelId) {
    return false;
  }
  return "peer" in match || "guildId" in match || "teamId" in match || "roles" in match;
}

function findRouteAgentId(props: ChannelsProps, channelId: string, accountId?: string): string {
  const binding = configBindings(props).find((entry) =>
    isSimpleChannelRouteBinding(entry, channelId, accountId),
  );
  if (typeof binding?.agentId === "string" && binding.agentId.trim()) {
    return binding.agentId;
  }
  return props.agentsList?.defaultId ?? props.agentsList?.mainKey ?? "main";
}

function patchRouteAgent(
  props: ChannelsProps,
  channelId: string,
  accountId: string | undefined,
  agentId: string,
) {
  if (!props.configForm) {
    return;
  }
  const nextBindings = configBindings(props).filter(
    (entry) => !isSimpleChannelRouteBinding(entry, channelId, accountId),
  );
  const match: Record<string, unknown> = { channel: channelId };
  if (accountId) {
    match.accountId = accountId;
  }
  nextBindings.push({ agentId, match });
  props.onConfigPatch(["bindings"], nextBindings);
}

function formatAgentLabel(agent: GatewayAgentRow): string {
  return formatAgentDisplayLabel(agent);
}

function formatAgentIdLabel(props: ChannelsProps, agentId: string): string {
  const agent = (props.agentsList?.agents ?? []).find((entry) => entry.id === agentId);
  return agent ? formatAgentLabel(agent) : formatAgentDisplayLabel({ id: agentId });
}

function agentOptions(props: ChannelsProps): GatewayAgentRow[] {
  const agents = props.agentsList?.agents ?? [];
  if (agents.length > 0) {
    return agents;
  }
  const fallback = props.agentsList?.defaultId ?? props.agentsList?.mainKey ?? "main";
  return [{ id: fallback }];
}

function routeTestId(channelId: string, accountId?: string): string {
  const normalized = accountId?.trim() || "default";
  return `channel-route-${channelId}-${normalized.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function routeTargets(accounts: ChannelAccountSnapshot[]) {
  if (accounts.length === 0) {
    return [{ accountId: undefined, label: "Default route", detail: "channel account" }];
  }
  return accounts.map((account) => ({
    accountId: account.accountId,
    label: account.name || account.accountId,
    detail:
      account.name && account.name !== account.accountId ? account.accountId : "account route",
  }));
}

function accountLabel(accounts: ChannelAccountSnapshot[], accountId: string | null) {
  if (!accountId) {
    return { label: "Channel default", detail: "default route" };
  }
  const account = accounts.find((entry) => entry.accountId === accountId);
  return {
    label: account?.name?.trim() || accountId,
    detail: accountId,
  };
}

function formatPeerDetail(match: Record<string, unknown>): string[] {
  const details: string[] = [];
  const peer = match.peer;
  if (isRecord(peer) && typeof peer.kind === "string" && typeof peer.id === "string") {
    details.push(`${peer.kind} ${peer.id}`);
  }
  if (typeof match.guildId === "string" && match.guildId.trim()) {
    details.push(`guild ${match.guildId}`);
  }
  if (typeof match.teamId === "string" && match.teamId.trim()) {
    details.push(`team ${match.teamId}`);
  }
  if (Array.isArray(match.roles) && match.roles.length > 0) {
    const roles = match.roles
      .filter((role): role is string => typeof role === "string" && role.trim().length > 0)
      .slice(0, 3);
    details.push(
      roles.length > 0
        ? `roles ${roles.join(", ")}`
        : `${match.roles.length} role${match.roles.length === 1 ? "" : "s"}`,
    );
  }
  return details;
}

function specificRouteSummaries(params: {
  props: ChannelsProps;
  channelId: string;
  accounts: ChannelAccountSnapshot[];
}) {
  return configBindings(params.props)
    .filter((binding) => isSpecificChannelRouteBinding(binding, params.channelId))
    .map((binding, index) => {
      const agentId =
        typeof binding.agentId === "string" && binding.agentId.trim()
          ? binding.agentId
          : (params.props.agentsList?.defaultId ?? params.props.agentsList?.mainKey ?? "main");
      const accountId =
        typeof binding.match.accountId === "string" && binding.match.accountId.trim()
          ? binding.match.accountId
          : null;
      const account = accountLabel(params.accounts, accountId);
      const details = [account.detail, ...formatPeerDetail(binding.match)].filter(Boolean);
      return {
        key: `${params.channelId}-${accountId ?? "default"}-${index}`,
        label: `${account.label} -> ${formatAgentIdLabel(params.props, agentId)}`,
        detail: details.join(" · "),
      };
    });
}

export function renderChannelRoutePanel(params: {
  props: ChannelsProps;
  channelId: string;
  accounts?: ChannelAccountSnapshot[];
}) {
  const { props, channelId } = params;
  const accounts = params.accounts ?? [];
  const options = agentOptions(props);
  const disabled = props.configSaving || !props.configForm || options.length === 0;
  const specificRoutes = specificRouteSummaries({ props, channelId, accounts });

  return html`
    <div class="channel-route-panel">
      <div class="channel-route-header">
        <div>
          <div class="channel-route-title">Route to Agent</div>
          <div class="channel-route-sub">
            One default Agent per channel account. Specific routes can override chats, topics,
            threads, guilds, or peers.
          </div>
        </div>
        <button
          class="btn"
          data-test-id="channel-routes-save"
          ?disabled=${props.configSaving || !props.configFormDirty}
          @click=${() => props.onConfigSave()}
        >
          ${props.configSaving ? "Saving..." : "Save routing"}
        </button>
      </div>
      <div class="channel-route-grid">
        <div class="channel-route-block">
          <div class="channel-route-list">
            <div class="channel-route-section-title">Default route</div>
            ${routeTargets(accounts).map((target) => {
              const selected = findRouteAgentId(props, channelId, target.accountId);
              return html`
                <label class="channel-route-row">
                  <span>
                    <span class="channel-route-label">${target.label}</span>
                    <span class="channel-route-detail">${target.detail}</span>
                  </span>
                  <select
                    data-test-id=${routeTestId(channelId, target.accountId)}
                    .value=${selected}
                    ?disabled=${disabled}
                    @change=${(event: Event) => {
                      const value = (event.currentTarget as HTMLSelectElement).value;
                      patchRouteAgent(props, channelId, target.accountId, value);
                    }}
                  >
                    ${options.map(
                      (agent) => html`
                        <option value=${agent.id} ?selected=${agent.id === selected}>
                          ${formatAgentLabel(agent)}
                        </option>
                      `,
                    )}
                  </select>
                </label>
              `;
            })}
          </div>
        </div>
        ${
          specificRoutes.length > 0
            ? html`
                <div class="channel-route-block channel-route-specific">
                  <div class="channel-route-section-title">Specific routes</div>
                  <div class="channel-route-specific-list">
                    ${specificRoutes.map(
                      (route) => html`
                        <div class="channel-route-specific-row" data-route-key=${route.key}>
                          <span>
                            <span class="channel-route-label">${route.label}</span>
                            <span class="channel-route-detail">${route.detail}</span>
                          </span>
                          <span class="channel-route-agent">Advanced</span>
                        </div>
                      `,
                    )}
                  </div>
                </div>
              `
            : nothing
        }
      </div>
      <div class="channel-route-note">
        Edit topic, thread, guild, or peer-specific routes in Advanced Config bindings.
      </div>
    </div>
  `;
}
