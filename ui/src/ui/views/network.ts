import { LitElement, html, nothing } from "lit";
import type {
  FederationToken,
  FederationStatus,
  FederationDirectoryEntry,
} from "../federation-api.ts";
export type FederationProps = {
  loading: boolean;
  error: string | null;
  message: string | null;
  token: FederationToken | null;
  status: FederationStatus | null;
  directory: FederationDirectoryEntry[];
  handle: string;
  nodeEndpoint: string;
  onRefresh: () => void;
  onRenew: () => void;
  onRevoke: () => void;
  onRegister: () => void;
  onHandleChange: (value: string) => void;
  onNodeEndpointChange: (value: string) => void;
};

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
          ? html`<fased-agent-directory .entries=${props.directory}></fased-agent-directory>`
          : html`
              <p>No agents have been discovered yet.</p>
            `
      }
    </section>
  </section>`;
}

// Bound the rendered directory regardless of the server response size.
export class AgentDirectory extends LitElement {
  static properties = {
    entries: { attribute: false },
    query: { state: true },
    page: { state: true },
  };
  entries: FederationProps["directory"] = [];
  query = "";
  page = 0;
  protected createRenderRoot() {
    return this;
  }
  render() {
    const query = this.query.trim().toLowerCase();
    const entries = this.entries.filter(
      (entry) => !query || entry.handle.toLowerCase().includes(query),
    );
    const pages = Math.max(1, Math.ceil(entries.length / 25));
    const page = Math.min(this.page, pages - 1);
    return html`
      <label class="field"><span>Find an agent</span><input type="search" .value=${this.query}
        @input=${(event: Event) => {
          this.query = (event.target as HTMLInputElement).value;
          this.page = 0;
        }} /></label>
      <p role="status">${entries.length} agents · Page ${page + 1} of ${pages}</p>
      <ul>${entries.slice(page * 25, (page + 1) * 25).map((entry) => html`<li><strong>${entry.handle}</strong> · ${entry.status}</li>`)}</ul>
      ${
        entries.length === 0
          ? html`
              <p>No matching agents.</p>
            `
          : nothing
      }
      <div class="row"><button class="btn" ?disabled=${page === 0} @click=${() => {
        this.page = page - 1;
      }}>Previous</button>
        <button class="btn" ?disabled=${page + 1 >= pages} @click=${() => {
          this.page = page + 1;
        }}>Next</button></div>`;
  }
}
customElements.define("fased-agent-directory", AgentDirectory);
