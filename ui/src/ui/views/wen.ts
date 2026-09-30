import { html } from "lit";
import "../../styles/wen-desk.css";
import type { GatewayBrowserClient } from "../gateway.js";
import "./wen-review.js";
import "./wen-economy.js";
import "./wen-acquisition.js";

export function renderWen(props: { client: GatewayBrowserClient | null; connected: boolean }) {
  return html`<section class="wen-desk" aria-label="WEN desk">
    <header class="wen-desk__header">
      <div><span class="wen-desk__eyebrow">WEN · Strategy desk</span>
        <h2>Your next move.</h2>
        <p>Understand the economy, plan an acquisition and manage your approved operations.</p>
      </div>
      <span class="wen-desk__status">${props.connected ? "Connected" : "Offline"}</span>
    </header>
    ${
      props.client
        ? html`<div class="wen-desk__grid"><wen-economy-panel .client=${props.client} .connected=${props.connected}></wen-economy-panel>
          <wen-acquisition-panel .client=${props.client} .connected=${props.connected}></wen-acquisition-panel></div>
          <div class="wen-desk__operations"><wen-review-panel .client=${props.client} .connected=${props.connected}></wen-review-panel></div>`
        : html`
            <p role="status">Connect a WEN-enabled Fased instance to open your strategy desk.</p>
          `
    }
  </section>`;
}
