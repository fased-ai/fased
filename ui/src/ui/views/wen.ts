import { html } from "lit";
import "../../styles/wen-desk.css";
import type { GatewayBrowserClient } from "../gateway.js";
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
          <details class="wen-desk__operations" @toggle=${(event: Event) => {
            const details = event.target as HTMLDetailsElement;
            if (details.open) {
              const status = details.querySelector<HTMLElement>("[data-operation-load-status]");
              if (status) {
                status.textContent = "Loading operations…";
              }
              void import("./wen-review.js")
                .then(() => {
                  if (status) {
                    status.textContent = "";
                  }
                })
                .catch(() => {
                  if (status) {
                    status.textContent = "Operations could not load. Close and reopen to retry.";
                  }
                });
            }
          }}><summary>Manage approved operations</summary><p role="status" data-operation-load-status></p><wen-review-panel .client=${props.client} .connected=${props.connected}></wen-review-panel></details>`
        : html`
            <p role="status">Connect a WEN-enabled Fased instance to open your strategy desk.</p>
          `
    }
  </section>`;
}
