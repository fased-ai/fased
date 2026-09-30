import "./wen-campaign.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { bindWenClaimJourneyResult } from "../../../../src/wallet/wen-claim-journey-contract.js";
import {
  bindWenMiningClaimProposal,
  validateWenMiningClaimProposalRequest,
  isWenMiningClaimProposal,
} from "../../../../src/wallet/wen-mining-claim-proposal-contract.js";
import { approveWenClaim } from "../wen-claim-approval.js";

type Client = { request<T>(method: string, params: unknown): Promise<T> };
export type ReviewRow = {
  entry: string;
  status: string;
  draftJson?: string;
  wallet?: string;
  owner?: string;
  program?: string;
  economy?: string;
  operation?: string;
  gross?: string;
  net?: string;
  fee?: string;
  expires?: string;
};
export function reviewRows(value: unknown): ReviewRow[] {
  const v = value as {
    ok?: boolean;
    mode?: string;
    signingEnabled?: boolean;
    payload?: { signingEnabled?: boolean; items?: unknown[] };
  };
  if (
    v?.ok !== true ||
    v.mode !== "local-candidate-only" ||
    v.signingEnabled !== false ||
    v.payload?.signingEnabled !== false ||
    !Array.isArray(v.payload.items) ||
    v.payload.items.length > 10
  ) {
    throw Error("Invalid unsigned review response");
  }
  return v.payload.items.map((item) => {
    const row = item as {
      entry?: string;
      status?: string;
      reviewDraft?: {
        descriptor?: string;
        review?: { walletId?: string; walletPublicKey?: string; intent?: Record<string, unknown> };
      };
    };
    if (typeof row.entry !== "string") {
      throw Error("Invalid review entry");
    }
    if (row.status === "readback-rejected") {
      return { entry: row.entry, status: "Readback rejected; retry required" };
    }
    const intent = row.reviewDraft?.review?.intent;
    const review = row.reviewDraft?.review;
    if (
      row.status !== "requires-review" ||
      !intent ||
      typeof row.reviewDraft?.descriptor !== "string" ||
      [review?.walletId, review?.walletPublicKey, intent.programId, intent.economy].some(
        (value) => typeof value !== "string" || !value,
      ) ||
      !["sol", "sat"].includes(String(intent.operation)) ||
      ["expectedGross", "minimumReceived", "maxFeeLamports", "expiresSlot"].some(
        (key) => typeof intent[key] !== "string" || !/^(0|[1-9][0-9]*)$/.test(intent[key]),
      )
    ) {
      throw Error("Invalid review amounts");
    }
    const draftJson = JSON.stringify(row.reviewDraft);
    if (new TextEncoder().encode(draftJson).length > 65536) {
      throw Error("Review export exceeds signer input limit");
    }
    return {
      entry: row.entry,
      status: "Unsigned review",
      draftJson,
      wallet: review!.walletId,
      owner: review!.walletPublicKey,
      program: intent.programId as string,
      economy: intent.economy as string,
      operation: String(intent.operation),
      gross: intent.expectedGross as string,
      net: intent.minimumReceived as string,
      fee: intent.maxFeeLamports as string,
      expires: intent.expiresSlot as string,
    };
  });
}

export class WenReviewPanel extends LitElement {
  static properties = {
    client: { attribute: false },
    connected: { type: Boolean },
    rows: { state: true },
    busy: { state: true },
    error: { state: true },
    nextCursor: { state: true },
    page: { state: true },
    admissionHash: { state: true },
    admitted: { state: true },
    approvalStatus: { state: true },
    pendingClaim: { state: true },
  };
  client: Client | null = null;
  connected = false;
  rows: ReviewRow[] | null = null;
  busy = false;
  error = "";
  nextCursor = "";
  page = 0;
  admissionHash = "";
  admitted: { row: ReviewRow; observedSlot: number; expiresSlot: string } | null = null;
  pendingClaim: { requestId: string; walletId: string } | null = null;
  approvalStatus = "";
  private approvalController?: AbortController;
  private approvalInput?: { requestId: string; intent: unknown; reviewSha256: string };
  private generation = 0;
  private displayClient: Client | null = null;
  protected createRenderRoot() {
    return this;
  }
  protected willUpdate(changed: PropertyValues) {
    if (this.connected && !this.pendingClaim) {
      try {
        const saved = JSON.parse(sessionStorage.getItem("wen.pending-claim") || "null");
        if (
          saved &&
          typeof saved.walletId === "string" &&
          typeof saved.requestId === "string" &&
          /^[a-zA-Z0-9_:.-]{8,128}$/.test(saved.requestId)
        ) {
          this.pendingClaim = saved;
        }
      } catch {
        /* No execution without a writable recovery record. */
      }
    }
    if (changed.has("client") || (changed.has("connected") && !this.connected)) {
      this.approvalController?.abort();
      this.approvalStatus = "";
      this.approvalInput = undefined;
      this.generation++;
      this.rows = null;
      this.admitted = null;
      this.admissionHash = "";
      this.nextCursor = "";
      this.page = 0;
      this.error = "";
    }
  }
  disconnectedCallback() {
    this.approvalController?.abort();
    this.generation++;
    this.rows = null;
    this.admitted = null;
    this.approvalInput = undefined;
    this.approvalStatus = "";
    this.admissionHash = "";
    this.nextCursor = "";
    this.page = 0;
    super.disconnectedCallback();
  }
  async refresh(cursor = "") {
    if (!this.connected || !this.client || this.busy) {
      return;
    }
    const client = this.client;
    if (cursor && (cursor !== this.nextCursor || this.page >= 100)) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.rows = null;
    this.admitted = null;
    this.approvalInput = undefined;
    this.approvalStatus = "";
    this.admissionHash = "";
    this.nextCursor = "";
    this.error = "";
    try {
      const result = await client.request<{
        payload: { nextCursor: string; scanComplete: boolean };
      }>("wen.mining.review.refresh", cursor ? { cursor } : {});
      if (generation !== this.generation || client !== this.client || !this.connected) {
        return;
      }
      const rows = reviewRows(result);
      const next = result.payload.nextCursor;
      if (
        typeof result.payload.scanComplete !== "boolean" ||
        typeof next !== "string" ||
        (result.payload.scanComplete
          ? next !== ""
          : !/^(admission\.json|admission-[a-f0-9]{64}\.json)$/.test(next)) ||
        (cursor && next && next <= cursor)
      ) {
        throw Error("Invalid review pagination");
      }
      this.rows = rows;
      this.displayClient = client;
      this.nextCursor = next;
      this.page = cursor ? this.page + 1 : 1;
    } catch {
      if (generation === this.generation) {
        this.error =
          "Review unavailable. An active local candidate profile and admin access are required.";
      }
    } finally {
      this.busy = false;
    }
  }
  async refreshAdmitted(row: ReviewRow) {
    if (
      !this.connected ||
      !this.client ||
      this.busy ||
      this.client !== this.displayClient ||
      !this.rows?.includes(row) ||
      !row.draftJson
    ) {
      return;
    }
    const hash = this.admissionHash;
    this.admitted = null;
    this.error = "";
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      this.error = "Enter the review hash from the signer admission receipt.";
      return;
    }
    const client = this.client,
      generation = ++this.generation;
    const base = JSON.parse(row.draftJson).review.intent;
    this.busy = true;
    try {
      const result = await client.request<{
        ok: unknown;
        mode: string;
        signingEnabled: unknown;
        payload: unknown;
      }>("wen.mining.claim.refresh", { base, reviewSha256: hash });
      if (
        generation !== this.generation ||
        client !== this.client ||
        !this.connected ||
        hash !== this.admissionHash
      ) {
        return;
      }
      if (
        result.ok !== true ||
        result.mode !== "local-candidate-only" ||
        result.signingEnabled !== false ||
        !isWenMiningClaimProposal(result.payload)
      ) {
        throw Error("Invalid refresh");
      }
      const proposal = bindWenMiningClaimProposal(
        result.payload,
        validateWenMiningClaimProposalRequest({
          base,
          reviewSha256: hash,
          minFinalizedSlot: result.payload.intent.minFinalizedSlot,
          expiresSlot: result.payload.intent.expiresSlot,
        }),
      );
      this.approvalInput = {
        requestId: "wen-" + crypto.randomUUID(),
        intent: structuredClone(proposal.intent),
        reviewSha256: hash,
      };
      this.admitted = {
        row,
        observedSlot: proposal.observedSlot,
        expiresSlot: proposal.intent.expiresSlot,
      };
    } catch {
      if (generation === this.generation) {
        this.error =
          "Admitted claim refresh rejected. Check the receipt and current profile; no claim was submitted.";
      }
    } finally {
      this.busy = false;
    }
  }
  async approveClaim() {
    if (
      !this.connected ||
      !this.client ||
      this.client !== this.displayClient ||
      this.busy ||
      !this.admitted?.row.wallet ||
      !this.approvalInput ||
      this.pendingClaim
    ) {
      return;
    }
    const client = this.client,
      generation = this.generation;
    const controller = new AbortController();
    this.approvalController = controller;
    this.busy = true;
    this.error = "";
    this.approvalStatus = "";
    try {
      const result = await approveWenClaim(
        client,
        this.admitted.row.wallet,
        this.approvalInput,
        controller.signal,
        () => {
          const pending = {
            requestId: this.approvalInput!.requestId,
            walletId: this.admitted!.row.wallet!,
          };
          sessionStorage.setItem("wen.pending-claim", JSON.stringify(pending));
          this.pendingClaim = pending;
        },
      );
      if (!result.recoveryRequired) {
        sessionStorage.removeItem("wen.pending-claim");
        this.pendingClaim = null;
      }
      if (generation === this.generation && client === this.client && this.connected) {
        this.approvalStatus = `Claim ${result.outcome || "outcome unknown"}. ${result.recoveryRequired ? "Recovery is required; do not submit again." : "Journal reconciled."} Request: ${result.requestId}.`;
      }
    } catch {
      if (generation === this.generation && this.connected) {
        this.error =
          "Claim approval or execution is unresolved. Reconcile the request before another attempt.";
      }
    } finally {
      this.approvalInput = undefined;
      this.approvalController = undefined;
      this.busy = false;
    }
  }
  async recoverClaim() {
    if (!this.connected || !this.client || this.busy || !this.pendingClaim) {
      return;
    }
    const client = this.client,
      pending = this.pendingClaim;
    this.busy = true;
    try {
      const response = await client.request<{
        ok: unknown;
        mode: unknown;
        signingEnabled: unknown;
        payload: unknown;
      }>("wen.mining.approval.recover", { requestId: pending.requestId });
      if (!this.connected || this.client !== client) {
        return;
      }
      if (
        response.ok !== true ||
        response.mode !== "local-candidate-only" ||
        response.signingEnabled !== false
      ) {
        throw Error("Invalid recovery");
      }
      const result = bindWenClaimJourneyResult(
        response.payload,
        pending.requestId,
        pending.walletId,
      );
      this.approvalStatus = `Claim ${result.outcome || "unresolved"}; recovery ${result.recoveryRequired ? "still required" : "complete"}.`;
      if (!result.recoveryRequired) {
        sessionStorage.removeItem("wen.pending-claim");
        this.pendingClaim = null;
      }
    } catch {
      this.error = "Recovery unresolved. Keep the request record; no transaction was resent.";
    } finally {
      this.busy = false;
    }
  }
  exportReview(row: ReviewRow) {
    if (
      !this.connected ||
      this.busy ||
      this.client !== this.displayClient ||
      !this.rows?.includes(row) ||
      !row.draftJson
    ) {
      return;
    }
    const url = URL.createObjectURL(new Blob([row.draftJson], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "wen-claim-review.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  render() {
    return html`<section class="card" aria-label="WEN candidate reviews">
      <h3>WEN candidate reviews</h3>
      <p>Uses the configured local candidate wallet. Refresh reads current claim data; it does not sign or submit a claim.</p>
      <button ?disabled=${!this.connected || this.busy} @click=${() => this.refresh()}>${this.busy ? "Refreshing…" : "Refresh unsigned reviews"}</button>
      <label>Admission review hash <input aria-label="Admission review hash" maxlength="64" .value=${this.admissionHash} ?disabled=${this.busy} @input=${(
        event: Event,
      ) => {
        this.admissionHash = (event.target as HTMLInputElement).value;
        this.admitted = null;
      }} /></label>
      ${this.admitted ? html`<p role="status">Admitted ${this.admitted.row.operation?.toUpperCase()} claim refreshed at slot ${this.admitted.observedSlot}. Gross: ${this.admitted.row.gross}; minimum received: ${this.admitted.row.net}; maximum fee: ${this.admitted.row.fee} lamports; expiry slot: ${this.admitted.expiresSlot}. Unsigned; approval and submission are still required.</p>` : nothing}
      ${this.admitted && this.approvalInput && !this.pendingClaim ? html`<button ?disabled=${this.busy || !this.connected} @click=${() => this.approveClaim()}>Approve and submit claim with passkey</button>` : nothing}
      ${this.pendingClaim ? html`<p>Pending claim ${this.pendingClaim.requestId} for ${this.pendingClaim.walletId}.</p><button ?disabled=${this.busy || !this.connected} @click=${() => this.recoverClaim()}>Reconcile pending claim</button>` : nothing}
      ${this.approvalStatus ? html`<p role="status">${this.approvalStatus}</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.nextCursor ? html`<button ?disabled=${!this.connected || this.busy || this.page >= 100} @click=${() => this.refresh(this.nextCursor)}>Next review page</button>` : nothing}
      ${
        this.connected && this.rows
          ? html`<p>Page ${this.page}. Amounts are base units, not profit. Claims require separate review and submission.</p>
        ${
          this.rows.length === 0
            ? html`
                <p>No review entries on this page.</p>
              `
            : this.rows.map(
                (row) => html`<article><p>${row.entry}: ${row.status}</p>
        ${row.operation ? html`<p>Wallet: ${row.wallet} (${row.owner}). Program: ${row.program}. Economy: ${row.economy}.</p>` : nothing}
        ${row.operation ? html`<p>${row.operation.toUpperCase()} gross: ${row.gross}; minimum received: ${row.net}; maximum fee: ${row.fee} lamports; expiry slot: ${row.expires}.</p><p>Export is an unsigned snapshot for local signer review. It does not install a review or approve a claim.</p><button ?disabled=${this.busy} @click=${() => this.exportReview(row)}>Export review JSON</button><button ?disabled=${this.busy || !/^[a-f0-9]{64}$/.test(this.admissionHash)} @click=${() => this.refreshAdmitted(row)}>Refresh admitted claim</button>` : nothing}</article>`,
              )
        }`
          : nothing
      }
      <wen-campaign-panel .client=${this.client} .connected=${this.connected}></wen-campaign-panel>
      <wen-campaign-panel .domain=${"market"} .client=${this.client} .connected=${this.connected}></wen-campaign-panel>
 <wen-campaign-panel .domain=${"bond-claim"} .client=${this.client} .connected=${this.connected}></wen-campaign-panel>
 <wen-campaign-panel .domain=${"bond"} .client=${this.client} .connected=${this.connected}></wen-campaign-panel>
    </section>`;
  }
}
if (globalThis.customElements && !customElements.get("wen-review-panel")) {
  customElements.define("wen-review-panel", WenReviewPanel);
}
