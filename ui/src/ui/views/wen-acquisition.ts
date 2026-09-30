import { LitElement, html, nothing, type PropertyValues } from "lit";
type Handoff = {
  mode: "manual-owner-handoff";
  signingEnabled: false;
  url: string;
  request: { expiresAtMs: number };
};
export class WenAcquisitionPanel extends LitElement {
  static properties = {
    client: { attribute: false },
    connected: { type: Boolean },
    owner: { state: true },
    action: { state: true },
    netAtoms: { state: true },
    nonce: { state: true },
    handoff: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  client: { request<T>(method: string, params: unknown): Promise<T> } | null = null;
  connected = false;
  owner = "";
  action = "buy";
  netAtoms = "";
  nonce = "";
  handoff: Handoff | null = null;
  busy = false;
  error = "";
  private generation = 0;
  protected createRenderRoot() {
    return this;
  }
  protected willUpdate(changed: PropertyValues) {
    if (
      ["client", "connected", "owner", "action", "netAtoms", "nonce"].some((k) => changed.has(k))
    ) {
      this.generation++;
      this.handoff = null;
      this.error = "";
      this.busy = false;
    }
  }
  disconnectedCallback() {
    this.generation++;
    this.handoff = null;
    super.disconnectedCallback();
  }
  async prepare() {
    if (!this.connected || !this.client || this.busy) {
      return;
    }
    const client = this.client,
      generation = ++this.generation;
    this.busy = true;
    this.handoff = null;
    this.error = "";
    try {
      const result = await client.request<Handoff>("wen.acquisition.handoff", {
        owner: this.owner,
        action: this.action,
        netAtoms: this.netAtoms,
        ...(this.action === "bond" ? { nonce: this.nonce } : {}),
      });
      if (generation !== this.generation || client !== this.client || !this.connected) {
        return;
      }
      const url = new URL(result.url);
      if (
        result.mode !== "manual-owner-handoff" ||
        result.signingEnabled ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.pathname !== "/" ||
        url.search ||
        url.username ||
        url.password ||
        !url.hash.startsWith("#wen-request=") ||
        !Number.isSafeInteger(result.request.expiresAtMs) ||
        result.request.expiresAtMs <= Date.now()
      ) {
        throw Error("Invalid handoff");
      }
      this.handoff = result;
    } catch {
      if (generation === this.generation) {
        this.error = "Fresh WEN handoff unavailable. Check the owner, size and local WEN profile.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  render() {
    const handoff =
      this.handoff && Date.now() < this.handoff.request.expiresAtMs ? this.handoff : null;
    return html`<section class="wen-desk__card" aria-label="WEN acquisition handoff"><span class="wen-desk__eyebrow">02 · Plan</span><h3>Acquire a position</h3>
      <p>Plan a Buy or Bond purchase, then review the current terms and approve with your wallet in WEN.</p>
      <label>Owner public address <input .value=${this.owner} @input=${(e: Event) => {
        this.owner = (e.target as HTMLInputElement).value;
      }} /></label>
      <label>Product <select .value=${this.action} @change=${(e: Event) => {
        this.action = (e.target as HTMLSelectElement).value;
      }}><option value="buy">Buy</option><option value="bond">Bonds</option></select></label>
      <label>Quantity (base units) <input .value=${this.netAtoms} inputmode="numeric" @input=${(
        e: Event,
      ) => {
        this.netAtoms = (e.target as HTMLInputElement).value;
      }} /></label>
      ${
        this.action === "bond"
          ? html`<label>Bond offer number <input .value=${this.nonce} inputmode="numeric" @input=${(
              e: Event,
            ) => {
              this.nonce = (e.target as HTMLInputElement).value;
            }} /></label>`
          : nothing
      }
      <button ?disabled=${!this.connected || this.busy} @click=${() => void this.prepare()}>${this.busy ? "Checking…" : "Prepare request"}</button>
      <details class="wen-desk__details"><summary>How approval works</summary><p>This request cannot sign, spend or reserve a price. Quantity uses the asset’s smallest units; WEN verifies the connected wallet and shows the final terms before approval.</p></details>
      ${this.error ? html`<p role="status">${this.error}</p>` : nothing}
      ${
        handoff
          ? html`<a href=${handoff.url} target="_blank" rel="noopener noreferrer" @click=${(
              e: Event,
            ) => {
              if (Date.now() >= handoff.request.expiresAtMs) {
                e.preventDefault();
                this.handoff = null;
                this.error = "Request expired. Prepare again.";
              }
            }}>Review in WEN</a>`
          : nothing
      }
    </section>`;
  }
}
customElements.define("wen-acquisition-panel", WenAcquisitionPanel);
