import { LitElement, html, nothing, type PropertyValues } from "lit";

type Client = { request<T>(method: string, params: unknown): Promise<T> };
type Row =
  | { id: string; status: "unavailable"; value: null; reason: string }
  | {
      id: string;
      status: "reported";
      value: string;
      unit: string;
      evidence: string;
      source: string;
      scope: string;
      observedAtMs: number;
    };
type Snapshot = {
  signingEnabled: false;
  identity: { economy: string; program: string };
  slot: string;
  observedAtMs: number;
  expiresAtMs: number;
  rows: Row[];
};

export class WenEconomyPanel extends LitElement {
  static properties = {
    client: { attribute: false },
    connected: { type: Boolean },
    snapshot: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  client: Client | null = null;
  connected = false;
  snapshot: Snapshot | null = null;
  busy = false;
  error = "";
  private generation = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private clearExpiry() {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
    }
    this.expiryTimer = null;
  }
  private expireSnapshot = () => {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    this.clearExpiry();
    const now = Date.now();
    if (now < snapshot.observedAtMs || now >= snapshot.expiresAtMs) {
      this.snapshot = null;
      this.error = "WEN facts expired. Refresh before using them.";
    } else {
      this.expiryTimer = setTimeout(this.expireSnapshot, snapshot.expiresAtMs - now);
    }
  };
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.expireSnapshot);
  }

  protected createRenderRoot() {
    return this;
  }
  protected willUpdate(changed: PropertyValues) {
    if (changed.has("client") || (changed.has("connected") && !this.connected)) {
      this.generation++;
      this.clearExpiry();
      this.snapshot = null;
      this.error = "";
      this.busy = false;
    }
  }
  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.expireSnapshot);
    this.clearExpiry();
    this.generation++;
    this.snapshot = null;
    this.busy = false;
    super.disconnectedCallback();
  }
  async refresh() {
    if (!this.connected || !this.client || this.busy) {
      return;
    }
    const client = this.client,
      generation = ++this.generation;
    this.busy = true;
    this.clearExpiry();
    this.snapshot = null;
    this.error = "";
    try {
      const result = await client.request<Snapshot>("wen.economy.read", {});
      if (generation !== this.generation || client !== this.client || !this.connected) {
        return;
      }
      const now = Date.now();
      if (
        !Number.isSafeInteger(result?.observedAtMs) ||
        result.observedAtMs < 0 ||
        result.observedAtMs > now ||
        !Number.isSafeInteger(result?.expiresAtMs) ||
        result.expiresAtMs <= now ||
        result.expiresAtMs > result.observedAtMs + 60001 ||
        result?.signingEnabled ||
        !result.identity ||
        !/^(0|[1-9][0-9]*)$/.test(result.slot) ||
        !Array.isArray(result.rows) ||
        result.rows.some(
          (row) =>
            !row ||
            typeof row.id !== "string" ||
            (row.status === "reported"
              ? typeof row.value !== "string" ||
                ![row.unit, row.evidence, row.source, row.scope].every(
                  (value) => typeof value === "string" && value.length > 0,
                ) ||
                !Number.isSafeInteger(row.observedAtMs) ||
                row.observedAtMs < 0 ||
                row.observedAtMs > result.observedAtMs ||
                result.expiresAtMs > row.observedAtMs + 60001
              : row.status !== "unavailable" ||
                row.value !== null ||
                typeof row.reason !== "string"),
        )
      ) {
        throw Error("Invalid economy read");
      }
      this.snapshot = result;
      this.expiryTimer = setTimeout(this.expireSnapshot, result.expiresAtMs - now);
    } catch {
      if (generation === this.generation) {
        this.error = "Verified WEN economy read unavailable.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  render() {
    return html`<section class="wen-desk__card" aria-label="WEN economy read">
      <span class="wen-desk__eyebrow">01 · Understand</span><h3>Economy</h3>
      <p>Current facts for your decisions. This view cannot sign or spend.</p>
      <button type="button" ?disabled=${!this.connected || this.busy} @click=${() => void this.refresh()}>
        ${this.busy ? "Reading…" : "Refresh facts"}
      </button>
      ${this.error ? html`<p role="status">${this.error}</p>` : nothing}
      ${
        this.snapshot
          ? html`<p class="wen-desk__meta">${this.snapshot.identity.economy} · updated ${new Date(this.snapshot.observedAtMs).toLocaleTimeString()}</p>
        <dl class="wen-desk__facts">${this.snapshot.rows.map(
          (row) => html`<div>
          <dt>${row.id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase())}</dt>
          <dd>${
            row.status === "reported"
              ? html`${row.value} ${row.unit}<details><summary>Source details</summary><small>${row.evidence} · ${row.source} · ${row.scope} · ${new Date(row.observedAtMs).toISOString()} · finalized slot ${this.snapshot?.slot}</small></details>`
              : `Unavailable: ${row.reason}`
          }</dd>
        </div>`,
        )}</dl>`
          : html`<p class="wen-desk__empty">${this.connected ? "Refresh to see the latest economy facts." : "Connect your instance to read the economy."}</p>`
      }
    </section>`;
  }
}

customElements.define("wen-economy-panel", WenEconomyPanel);

declare global {
  interface HTMLElementTagNameMap {
    "wen-economy-panel": WenEconomyPanel;
  }
}
