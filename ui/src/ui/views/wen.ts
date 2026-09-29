import { html } from "lit";
import type { GatewayBrowserClient } from "../gateway.js";
import "./wen-review.js";
import "./wen-economy.js";
import "./wen-acquisition.js";

export function renderWen(props: { client: GatewayBrowserClient | null; connected: boolean }) {
  return html`<section aria-label="WEN desk">
    <h2>WEN Desk</h2>
    <p>Review owner-authorized WEN actions and reconcile their outcomes. WEN remains usable in its
      own app without Fased or a dedicated Mining wallet.</p>
    ${
      props.client
        ? html`<wen-economy-panel .client=${props.client} .connected=${props.connected}></wen-economy-panel>
          <wen-acquisition-panel .client=${props.client} .connected=${props.connected}></wen-acquisition-panel>
          <wen-review-panel .client=${props.client} .connected=${props.connected}></wen-review-panel>`
        : html`
            <p role="status">No WEN campaign adapter is configured on this Fased instance.</p>
          `
    }
  </section>`;
}
