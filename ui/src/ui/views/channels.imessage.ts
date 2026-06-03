import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, IMessageStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderChannelRoutePanel, renderChannelRuntimeControls } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  imessageAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, imessage, imessageAccounts, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">iMessage</div>
      <div class="card-sub">macOS bridge status and channel configuration.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${imessage?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${imessage?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${imessage?.lastStartAt ? formatRelativeTimestamp(imessage.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${imessage?.lastProbeAt ? formatRelativeTimestamp(imessage.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${renderChannelRoutePanel({ props, channelId: "imessage", accounts: imessageAccounts })}

      ${
        imessage?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${imessage.lastError}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({
        channelId: "imessage",
        props,
        configured:
          imessage?.configured === true || imessageAccounts.some((account) => account.configured),
      })}
      ${renderChannelRuntimeControls({
        props,
        channelId: "imessage",
        running: imessage?.running,
        probe: true,
        probeStatus: imessage?.probe,
      })}
    </div>
  `;
}
