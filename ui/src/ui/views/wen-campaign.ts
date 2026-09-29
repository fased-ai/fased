import { LitElement, html, nothing, type PropertyValues } from "lit";
import {
  bindWenBondClaimReview,
  type BondClaimReviewExpectation,
} from "../../../../src/wallet/wen-bond-claim-review-contract.js";
import {
  bindWenBondPurchaseReview,
  type BondPurchaseReviewExpectation,
} from "../../../../src/wallet/wen-bond-purchase-review-contract.js";
import { campaignClaimNet } from "../../../../src/wallet/wen-campaign-review-contract.js";
import {
  bindWenCampaignReview,
  type CampaignReviewExpectation,
} from "../../../../src/wallet/wen-campaign-review-contract.js";
import {
  recoverWenCampaignSession,
  type CampaignRecoveryIdentity,
  type CampaignSessionTransport,
} from "../../../../src/wallet/wen-campaign-session.js";
import {
  bindWenMarketReview,
  type MarketReviewExpectation,
} from "../../../../src/wallet/wen-market-review-contract.js";
import { approveWenCampaign } from "../wen-campaign-approval.js";
import { loadCampaignGatewayHost } from "../wen-campaign-gateway-transport.js";

// Only the configured host may supply this capability. Browser storage contains
// recovery identifiers, never deployment admission, approval proofs or authority.
export type CampaignViewHost = {
  review: unknown;
  expected: CampaignReviewExpectation;
  transport: CampaignSessionTransport;
};
type ViewHost = Omit<CampaignViewHost, "expected"> & {
  expected:
    | CampaignReviewExpectation
    | MarketReviewExpectation
    | BondPurchaseReviewExpectation
    | BondClaimReviewExpectation;
};
export class WenCampaignPanel extends LitElement {
  static properties = {
    domain: { type: String },
    host: { attribute: false },
    client: { attribute: false },
    connected: { type: Boolean },
    busy: { state: true },
    status: { state: true },
    pending: { state: true },
    verified: { state: true },
  };
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign";
  client: { request<T>(method: string, params: unknown): Promise<T> } | null = null;
  connected = false;
  private hostController?: AbortController;
  host: ViewHost | null = null;
  busy = false;
  status = "Campaign execution is unavailable until the deployment and client are bound.";
  pending: CampaignRecoveryIdentity | null = null;
  verified: {
    host: ViewHost;
    review:
      | Awaited<ReturnType<typeof bindWenCampaignReview>>
      | Awaited<ReturnType<typeof bindWenMarketReview>>
      | Awaited<ReturnType<typeof bindWenBondPurchaseReview>>
      | Awaited<ReturnType<typeof bindWenBondClaimReview>>;
    expected:
      | CampaignReviewExpectation
      | MarketReviewExpectation
      | BondPurchaseReviewExpectation
      | BondClaimReviewExpectation;
  } | null = null;
  private controller?: AbortController;
  protected createRenderRoot() {
    return this;
  }
  protected willUpdate(changed: PropertyValues) {
    if (
      changed.has("domain") ||
      changed.has("client") ||
      (changed.has("connected") && !this.connected)
    ) {
      this.hostController?.abort();
      this.controller?.abort();
      this.host = null;
      this.verified = null;
      this.pending = null;
    }
    if (changed.has("host")) {
      this.controller?.abort();
      this.verified = null;
      this.pending = null;
    }
  }
  disconnectedCallback() {
    this.hostController?.abort();
    this.host = null;
    this.controller?.abort();
    super.disconnectedCallback();
  }
  async loadConfigured() {
    const client = this.client;
    if (!client || !this.connected || this.busy) {
      return;
    }
    this.hostController?.abort();
    const controller = new AbortController();
    this.hostController = controller;
    this.host = null;
    this.verified = null;
    this.busy = true;
    try {
      const host = await loadCampaignGatewayHost(
        client,
        controller.signal,
        sessionStorage,
        this.domain,
      );
      if (this.client !== client || !this.connected) {
        throw Error("Campaign connection changed");
      }
      controller.signal.throwIfAborted();
      this.host = host;
      this.status =
        "Configured campaign loaded. Review it before approval, or reconcile its retained request.";
    } catch {
      this.status =
        "Campaign unavailable or configuration changed. Retained requests are preserved.";
    } finally {
      this.busy = false;
    }
  }
  private key(host: ViewHost) {
    return `wen.${this.domain}.pending:${"pins" in host.expected ? ("Deployment" in host.expected.policy ? host.expected.policy.Deployment.Genesis : host.expected.policy.Successor.Genesis) : host.expected.genesis}:${host.expected.walletId}`;
  }
  private guard(host: ViewHost, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.host !== host) {
      throw Error("Campaign profile changed");
    }
  }
  private pin(host: ViewHost, signal?: AbortSignal) {
    const transport = host.transport,
      expected = structuredClone(host.expected),
      key = this.key(host);
    return {
      transport,
      expected,
      key,
      check: () => {
        this.guard(host, signal);
        if (
          host.transport !== transport ||
          this.expectedKey(host.expected) !== this.expectedKey(expected)
        ) {
          throw Error("Campaign profile changed");
        }
      },
    };
  }
  async refresh() {
    const host = this.host;
    if (!host || this.busy) {
      return;
    }
    this.busy = true;
    this.verified = null;
    try {
      const pin = this.pin(host);
      const expected = pin.expected;
      // Recovery stays available after the original review expires.
      const saved = sessionStorage.getItem(this.key(host));
      this.pending = null;
      if (saved !== null) {
        const v = JSON.parse(saved);
        if (
          !v ||
          Object.keys(v).toSorted().join(",") !== "digest,requestId,walletId" ||
          typeof v.requestId !== "string" ||
          !/^[A-Za-z0-9_:.-]{8,128}$/.test(v.requestId) ||
          v.walletId !== expected.walletId ||
          typeof v.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(v.digest)
        ) {
          throw Error("Invalid retained identity");
        }
        this.pending = { requestId: v.requestId, walletId: v.walletId, digest: v.digest };
        this.status = "An earlier request needs reconciliation. No new execution will be sent.";
        return;
      }
      const review =
        this.domain === "bond-claim"
          ? await bindWenBondClaimReview(host.review, expected as BondClaimReviewExpectation)
          : this.domain === "bond"
            ? await bindWenBondPurchaseReview(
                host.review,
                expected as BondPurchaseReviewExpectation,
              )
            : this.domain === "market"
              ? await bindWenMarketReview(host.review, expected as MarketReviewExpectation)
              : await bindWenCampaignReview(host.review, expected as CampaignReviewExpectation);
      pin.check();
      this.verified = { host, review, expected };
      this.status = "Review the operation and maximum debit before approving.";
    } catch {
      if (this.host === host) {
        this.status = "Review or saved recovery identity rejected. No execution was sent.";
      }
    } finally {
      this.busy = false;
    }
  }
  async approve() {
    const shown = this.verified,
      host = this.host;
    if (!host || this.busy || this.pending || !shown || shown.host !== host) {
      return;
    }
    this.busy = true;
    this.verified = null;
    const controller = new AbortController();
    this.controller = controller;
    const pin = this.pin(host, controller.signal);
    const guard = () => {
      pin.check();
      if (this.expectedKey(host.expected) !== this.expectedKey(shown.expected)) {
        throw Error("Campaign review profile changed");
      }
    };
    const transport: CampaignSessionTransport = {
      begin: async (request) => {
        guard();
        const r = await pin.transport.begin(request);
        guard();
        return r;
      },
      finish: async (request) => {
        guard();
        const r = await pin.transport.finish(request);
        guard();
        return r;
      },
      journey: async (request) => {
        guard();
        const r = await pin.transport.journey(request);
        guard();
        return r;
      },
    };
    try {
      const result = await approveWenCampaign(
        shown.review,
        shown.expected,
        transport,
        controller.signal,
        (identity) => {
          guard();
          sessionStorage.setItem(this.key(host), JSON.stringify(identity));
          this.pending = { ...identity };
        },
        this.domain,
      );
      guard();
      this.showResult(host, result);
    } catch {
      if (this.host === host) {
        this.status = this.pending
          ? "Outcome unresolved. Reconcile this request; do not submit again."
          : "Approval did not complete. No execution was sent by this view.";
      }
    } finally {
      this.controller = undefined;
      this.busy = false;
    }
  }
  async recover() {
    const host = this.host,
      pending = this.pending;
    if (!host || !pending || this.busy) {
      return;
    }
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    const pin = this.pin(host, controller.signal);
    try {
      pin.check();
      const result = await recoverWenCampaignSession(
        pin.transport,
        { ...pending },
        controller.signal,
      );
      pin.check();
      this.showResult(host, result);
    } catch {
      if (this.host === host) {
        this.status = "Recovery unresolved. Request retained; no execution was resent.";
      }
    } finally {
      this.controller = undefined;
      this.busy = false;
    }
  }
  private showResult(
    host: ViewHost,
    result: { outcome: string; recoveryRequired: boolean; requestId: string },
  ) {
    this.status = `${this.domain === "bond" ? "Bonds" : this.domain === "market" ? "Buy" : "Campaign"} ${result.outcome}. ${result.recoveryRequired ? "Reconciliation still required." : "Journal reconciled."} Request: ${result.requestId}.`;
    if (!result.recoveryRequired) {
      sessionStorage.removeItem(this.key(host));
      this.pending = null;
    }
  }
  private expectedKey(value: ViewHost["expected"]) {
    return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  render() {
    const r = this.verified?.host === this.host ? this.verified.review : null;
    const direct = r && "Snapshot" in r.semanticIntent ? r.semanticIntent : null;
    const owner = r && "Action" in r.semanticIntent ? r.semanticIntent : null;
    const buy = r && r.artifactKind === "wen-market-buy-v1" ? r.semanticIntent : null;
    const bond = r && r.artifactKind === "wen-bond-purchase-v2" ? r.semanticIntent : null;
    if (this.domain === "bond-claim") {
      const claim = r && r.artifactKind === "wen-bond-claim-v2" ? r.semanticIntent : null;
      return html`<section aria-label="Bond claims"><h3>Bond claims</h3><p role="status">${this.status}</p>
 <button ?disabled=${!this.client || !this.connected || this.busy} @click=${() => this.loadConfigured()}>Load configured claim</button>
 ${claim ? html`<p>Wallet ${r!.walletId}; economy ${claim.Pins.Sale}. Currently vested delivery ${claim.Binding.Snapshot.Claim.AvailableNet} raw token units; minimum accepted ${claim.Policy.MinimumNet}.</p><p>Network fee ${claim.Binding.Fee}; reserved fee allowance ${claim.MaxFee}; retained wallet SOL ${claim.RetainedLamports} lamports. No additional Bond purchase charge.</p><p>Accepted vesting governs delivery. The net minimum is checked before signing; the claim instruction carries the receipt nonce.</p>` : nothing}
 <button ?disabled=${!this.host || this.busy} @click=${() => this.refresh()}>Review claim</button>
 <button ?disabled=${!this.verified || this.busy || !!this.pending} @click=${() => this.approve()}>Approve claim with passkey</button>
 <button ?disabled=${!this.pending || this.busy} @click=${() => this.recover()}>Reconcile claim</button></section>`;
    }
    if (this.domain === "bond") {
      return html`<section aria-label="Bonds"><h3>Bonds</h3><p role="status">${this.status}</p>
 <button ?disabled=${!this.client || !this.connected || this.busy} @click=${() => this.loadConfigured()}>Load configured Bond</button>
 ${bond ? html`<p>Wallet ${r!.walletId}; economy ${bond.Pins.Bond.Sale}. Quoted purchase ${r!.amount} raw cash units; minimum net entitlement ${bond.Pins.MinimumNet} raw token units.</p><p>Network fee ${bond.Binding.Fee}; peak account rent ${bond.Binding.Snapshot.Rent}; recovery allowance ${bond.Limits.RecoveryBudget}; retained wallet SOL ${bond.Limits.RetainedLamports} lamports.</p><p>Purchase creates a vested token entitlement. Claim availability follows the accepted receipt. ${bond.Pins.Bond.Profile === "devnet-synthetic-fixture" ? "Synthetic Devnet assets and pricing; not live-market economics." : "Fresh signer validation is required."}</p>` : nothing}
 ${this.pending ? html`<p>Pending request ${this.pending.requestId}.</p>` : nothing}
 <button ?disabled=${!this.host || this.busy} @click=${() => this.refresh()}>Review Bond</button>
 <button ?disabled=${!this.verified || this.busy || !!this.pending} @click=${() => this.approve()}>Approve Bond with passkey</button>
 <button ?disabled=${!this.pending || this.busy} @click=${() => this.recover()}>Reconcile Bond</button></section>`;
    }
    if (this.domain === "market") {
      return html`<section aria-label="Buy"><h3>Buy</h3><p role="status">${this.status}</p>
        <button ?disabled=${!this.client || !this.connected || this.busy} @click=${() => this.loadConfigured()}>Load configured Buy</button>
        ${buy ? html`<p>Wallet ${r!.walletId}; economy ${buy.Pins.Economy}. Minimum net SAT ${buy.Limits.MinimumNet} raw units; maximum cash ${buy.Limits.MaxCash} raw units.</p><p>Quoted cash ${buy.Binding.Snapshot.Quote.InputCash}; quoted net SAT ${buy.Binding.Snapshot.Quote.QuotedNet}. Network fee ceiling ${buy.Binding.MaxFee} lamports; retained SOL ${buy.Binding.RetainedLamports} lamports.</p><p>${buy.Binding.Snapshot.SyntheticReference ? "Synthetic Devnet pricing; not live-market economics." : "Quote and custody require fresh signer validation."}</p>` : nothing}
        ${this.pending ? html`<p>Pending request ${this.pending.requestId} for ${this.pending.walletId}.</p>` : nothing}
        <button ?disabled=${!this.host || this.busy} @click=${() => this.refresh()}>Review Buy</button>
        <button ?disabled=${!this.verified || this.busy || !!this.pending} @click=${() => this.approve()}>Approve Buy with passkey</button>
        <button ?disabled=${!this.pending || this.busy} @click=${() => this.recover()}>Reconcile Buy</button>
      </section>`;
    }
    return html`<section aria-label="Campaign position actions"><h3>Campaign position actions</h3>
      <p role="status">${this.status}</p>
      <button ?disabled=${!this.client || !this.connected || this.busy} @click=${() => this.loadConfigured()}>Load configured campaign</button>
      ${r ? html`<p>Wallet ${r.walletId}; operation ${owner?.Action.Operation ?? "claim-stake"}; amount ${owner?.Action.Amount ?? 0} lamports; maximum debit ${r.amount} lamports.</p>` : nothing}
      ${owner?.Binding.Claim ? html`<p>Claim net SAT ${campaignClaimNet(owner.Binding.Claim)} raw units after transfer fees to ${owner.Binding.Claim.Destination.Address}. Network fee ceiling ${owner.Binding.MaxFee} lamports. Existing mining spending is not charged again.</p>` : nothing}
      ${owner?.Action.Policy ? html`<p>Future mining policy: maximum acquisition price ${owner.Action.Policy.MaxPrice}; daily spending limit ${owner.Action.Policy.Daily}; total spending limit ${owner.Action.Policy.Total} lamports. Expiry ${owner.Action.Policy.Expiry}; maximum wait ${owner.Action.Policy.MaxWait} seconds; purchases ${owner.Action.Policy.Enabled ? "enabled" : "disabled"}. Spent totals and historical claims are preserved.</p>` : nothing}
      ${owner?.Binding.Setup ? html`<p>Setup deposit ${owner?.Action.Amount ?? 0} lamports; recoverable account rent ${owner.Binding.Setup.Rent} lamports; network fee ceiling ${owner.Binding.MaxFee} lamports.</p><p>Daily spending limit ${owner.Binding.Setup.Setup.Terms.Daily}; total spending limit ${owner.Binding.Setup.Setup.Terms.Total} lamports. Maximum acquisition price ${owner.Binding.Setup.Setup.Terms.MaxPrice}; expiry ${owner.Binding.Setup.Setup.Terms.Expiry} (Unix seconds); maximum wait ${owner.Binding.Setup.Setup.Terms.MaxWait} seconds.</p>` : nothing}

      ${direct ? html`<p>Claim gross SAT ${direct.Snapshot.Result.Amounts.Gross} raw units; transfer fees ${direct.Snapshot.Result.Amounts.Fee}; net stake credit ${direct.Snapshot.Result.Amounts.Net} raw units. Pool custody ${direct.Claim.Destination}; staking position ${direct.Snapshot.History.Position?.Address}. Maximum SOL debit ${direct.MaximumDebit} lamports, including rent ${direct.Rent} and network fee ceiling ${direct.Intent.maxFeeLamports} lamports. Existing mining spending is not charged again.</p>` : nothing}
      ${this.pending ? html`<p>Pending request ${this.pending.requestId} for ${this.pending.walletId}.</p>` : nothing}
      <button ?disabled=${!this.host || this.busy} @click=${() => this.refresh()}>Review campaign action</button>
      <button ?disabled=${!this.host || this.busy || !r || !!this.pending} @click=${() => this.approve()}>Approve and execute once</button>
      <button ?disabled=${!this.host || this.busy || !this.pending} @click=${() => this.recover()}>Reconcile pending request</button>
    </section>`;
  }
}
if (globalThis.customElements && !customElements.get("wen-campaign-panel")) {
  customElements.define("wen-campaign-panel", WenCampaignPanel);
}
