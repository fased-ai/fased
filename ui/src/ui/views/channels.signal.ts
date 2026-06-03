import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, SignalStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import { renderChannelRoutePanel, renderChannelRuntimeControls } from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  signalAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, signal, signalAccounts, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Signal</div>
      <div class="card-sub">signal-cli status and channel configuration.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${signal?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${signal?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Base URL</span>
          <span>${signal?.baseUrl ?? "n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${signal?.lastStartAt ? formatRelativeTimestamp(signal.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${signal?.lastProbeAt ? formatRelativeTimestamp(signal.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${renderChannelRoutePanel({ props, channelId: "signal", accounts: signalAccounts })}

      ${
        signal?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">
            ${signal.lastError}
          </div>`
          : nothing
      }

      ${renderChannelConfigSection({
        channelId: "signal",
        props,
        configured:
          signal?.configured === true || signalAccounts.some((account) => account.configured),
      })}
      ${renderChannelRuntimeControls({
        props,
        channelId: "signal",
        running: signal?.running,
        probe: true,
        probeStatus: signal?.probe,
      })}
    </div>
  `;
}
