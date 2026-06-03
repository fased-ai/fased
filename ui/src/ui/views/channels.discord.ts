import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, DiscordStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderChannelRoutePanel, renderChannelRuntimeControls } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  discordAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, discord, discordAccounts, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Discord</div>
      <div class="card-sub">Bot status and channel configuration.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${discord?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${discord?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${discord?.lastStartAt ? formatRelativeTimestamp(discord.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${discord?.lastProbeAt ? formatRelativeTimestamp(discord.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${renderChannelRoutePanel({ props, channelId: "discord", accounts: discordAccounts })}

      ${
        discord?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${discord.lastError}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({
        channelId: "discord",
        props,
        configured:
          discord?.configured === true || discordAccounts.some((account) => account.configured),
      })}
      ${renderChannelRuntimeControls({
        props,
        channelId: "discord",
        running: discord?.running,
        probe: true,
        probeStatus: discord?.probe,
      })}
    </div>
  `;
}
