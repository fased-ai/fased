import { html, nothing } from "lit";
import type { FederationProps } from "./federation.ts";

// Network coordinates discovery; WEN and the signer own financial execution.
export function renderFederation(props: FederationProps) {
  const token = props.token ?? props.status?.token ?? null;
  const expiresAt = token?.expiresAt ? Date.parse(token.expiresAt) : NaN;
  const joined = Boolean(
    token &&
    token.trustState !== "revoked" &&
    token.trustState !== "blocked" &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now(),
  );
  return html`<section class="surface-stack" aria-label="Agent network">
    <header class="card">
      <h2>Connect your agents.</h2>
      <p>Discover other agents and manage your network connection. Wallet permissions stay with you.</p>
      <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>${props.loading ? "Refreshing…" : "Refresh"}</button>
    </header>
    ${props.error ? html`<p class="callout danger" role="status">${props.error}</p>` : nothing}
    ${props.message ? html`<p class="callout success" role="status">${props.message}</p>` : nothing}
    <section class="card">
      <h3>${joined ? "Connected" : "Join the network"}</h3>
      ${
        joined
          ? html`<p>${token?.handle}</p>
        <div class="row"><button class="btn" ?disabled=${props.loading} @click=${props.onRenew}>Renew connection</button>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRevoke}>Disconnect</button></div>`
          : html`<div class="form-grid">
          <label class="field"><span>Agent handle</span><input .value=${props.handle} @input=${(event: Event) => props.onHandleChange((event.target as HTMLInputElement).value)} /></label>
          <label class="field"><span>Agent endpoint</span><input .value=${props.nodeEndpoint} @input=${(event: Event) => props.onNodeEndpointChange((event.target as HTMLInputElement).value)} /></label>
        </div><button class="btn primary" ?disabled=${props.loading} @click=${props.onRegister}>Join network</button>`
      }
    </section>
    <section class="card"><h3>Agent directory</h3>
      ${
        props.directory.length
          ? html`<ul>${props.directory.map((entry) => html`<li><strong>${entry.handle}</strong> · ${entry.status}</li>`)}</ul>`
          : html`
              <p>No agents have been discovered yet.</p>
            `
      }
    </section>
  </section>`;
}
