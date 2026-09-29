import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenBondClaimReview,
  type BondClaimReviewExpectation,
} from "./wen-bond-claim-review-contract.js";
import {
  bindWenBondPurchaseReview,
  type BondPurchaseReviewExpectation,
} from "./wen-bond-purchase-review-contract.js";
import {
  bindWenCampaignReview,
  type CampaignReviewExpectation,
} from "./wen-campaign-review-contract.js";
import { validateWenCampaignReviewRequest } from "./wen-campaign-service-contract.js";
import {
  createWenCampaignSocketTransport,
  recoverWenCampaignSocket,
  type CampaignSocketProfile,
} from "./wen-campaign-socket-approval.js";
import { bindWenMarketReview, type MarketReviewExpectation } from "./wen-market-review-contract.js";

// Supplied by the protected host configuration, never by gateway parameters.
// This adapter cannot create signer admission or accept deployment identities.
export type CampaignGatewaySelection = {
  socket: CampaignSocketProfile;
  expected: CampaignReviewExpectation;
  draftSha256: string;
  artifactDigest: string;
};
export type MarketGatewaySelection = Omit<CampaignGatewaySelection, "expected"> & {
  expected: MarketReviewExpectation;
};
type Selection = Omit<CampaignGatewaySelection, "expected"> & {
  expected:
    | CampaignReviewExpectation
    | MarketReviewExpectation
    | BondPurchaseReviewExpectation
    | BondClaimReviewExpectation;
};
export function createWenCampaignGatewayProfile(
  read: () => Promise<Selection>,
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign",
) {
  const bindReview = (value: unknown, expected: Selection["expected"]) =>
    domain === "bond-claim"
      ? bindWenBondClaimReview(value, expected as BondClaimReviewExpectation)
      : domain === "bond"
        ? bindWenBondPurchaseReview(value, expected as BondPurchaseReviewExpectation)
        : domain === "market"
          ? bindWenMarketReview(value, expected as MarketReviewExpectation)
          : bindWenCampaignReview(value, expected as CampaignReviewExpectation);
  let controller = new AbortController();
  let active:
    | {
        selected: Selection;
        transport: Awaited<ReturnType<typeof createWenCampaignSocketTransport>>;
        proof?: { proofId: string };
        expiresAt?: string;
        attempted: boolean;
      }
    | undefined;
  const key = (s: Selection) =>
    JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  async function selection() {
    const s = structuredClone(await read());
    if (s.socket.walletId !== s.expected.walletId || !/^[a-f0-9]{64}$/.test(s.artifactDigest)) {
      throw Error("Invalid campaign host selection");
    }
    validateWenCampaignReviewRequest({
      requestId: s.expected.requestId,
      draftSha256: s.draftSha256,
    });
    return s;
  }
  async function guard(s: Selection, signal: AbortSignal) {
    signal.throwIfAborted();
    if (key(await selection()) !== key(s)) {
      throw Error("Campaign host selection changed");
    }
    signal.throwIfAborted();
  }
  function cancel() {
    controller.abort();
    controller = new AbortController();
    active = undefined;
  }
  return {
    cancelClaimApproval: cancel,
    async readCampaignSelection() {
      const signal = controller.signal;
      const selected = await selection();
      await guard(selected, signal);
      return JSON.parse(
        JSON.stringify(
          {
            expected: selected.expected,
            draftSha256: selected.draftSha256,
            artifactDigest: selected.artifactDigest,
          },
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      );
    },
    async prepareClaimApproval(input: unknown) {
      const signal = controller.signal;
      const s = await selection();
      const request = validateWenCampaignReviewRequest(input);
      if (request.requestId !== s.expected.requestId || request.draftSha256 !== s.draftSha256) {
        throw Error("Campaign draft mismatch");
      }
      await guard(s, signal);
      const review = await callLocalSocketSigner<unknown>(s.socket.socketPath, {
        op:
          domain === "bond-claim"
            ? "v2.wenBondClaim.review.prepare"
            : domain === "bond"
              ? "v2.wenBondPurchase.review.prepare"
              : domain === "market"
                ? "v2.wenMarket.review.prepare"
                : "v2.wenCampaign.review.prepare",
        walletId: s.socket.walletId,
        request,
      });
      await guard(s, signal);
      const bound = await bindReview(review, s.expected);
      if (bound.artifactDigest !== "sha256:" + s.artifactDigest) {
        throw Error("Campaign artifact mismatch");
      }
      return bound;
    },
    async beginClaimApproval(input: unknown) {
      cancel();
      const signal = controller.signal;
      const s = await selection();
      const review = await bindReview(input, s.expected);
      if (review.artifactDigest !== "sha256:" + s.artifactDigest) {
        throw Error("Campaign artifact mismatch");
      }
      await guard(s, signal);
      const transport = await createWenCampaignSocketTransport(
        review,
        s.expected,
        async () => {
          await guard(s, signal);
          return s.socket;
        },
        signal,
        domain,
      );
      const candidate = { selected: s, transport, attempted: false };
      active = candidate;
      return transport.begin({ requestId: s.expected.requestId });
    },
    async finishClaimApproval(challengeId: string, credential: unknown) {
      const current = active;
      const signal = controller.signal;
      if (!current) {
        throw Error("No campaign approval");
      }
      const result = await current.transport.finish({ challengeId, credential });
      await guard(current.selected, signal);
      if (active !== current) {
        throw Error("Campaign approval replaced");
      }
      current.proof = structuredClone(result.authorization.proof);
      current.expiresAt = result.expiresAt;
      return result;
    },
    async runClaimJourney(requestId: string, action: "execute" | "recover") {
      const signal = controller.signal;
      const s = await selection();
      if (requestId !== s.expected.requestId) {
        throw Error("Campaign request mismatch");
      }
      await guard(s, signal);
      if (action === "recover") {
        if (active) {
          active.attempted = true;
          active.proof = undefined;
        }
        const response = await recoverWenCampaignSocket(
          { requestId, walletId: s.socket.walletId, digest: s.artifactDigest },
          async () => {
            await guard(s, signal);
            return s.socket;
          },
          signal,
          domain,
        );
        return response.result;
      }
      const current = active;
      if (
        !current ||
        current.attempted ||
        !current.proof ||
        key(current.selected) !== key(s) ||
        !current.expiresAt ||
        Date.parse(current.expiresAt) <= Date.now()
      ) {
        throw Error("No executable campaign approval");
      }
      current.attempted = true;
      const proof = current.proof;
      current.proof = undefined;
      const response = await current.transport.journey({ requestId, action: "execute", proof });
      return response.result;
    },
  };
}

// Desk selects a protected Buy profile; ordinary application requests cannot
// replace its endpoint, limits, review digest or admission.
export function createWenMarketGatewayProfile(read: () => Promise<MarketGatewaySelection>) {
  return createWenCampaignGatewayProfile(read, "market");
}

export type BondPurchaseGatewaySelection = Omit<CampaignGatewaySelection, "expected"> & {
  expected: BondPurchaseReviewExpectation;
};
export function createWenBondPurchaseGatewayProfile(
  read: () => Promise<BondPurchaseGatewaySelection>,
) {
  return createWenCampaignGatewayProfile(read, "bond");
}

export type BondClaimGatewaySelection = Omit<CampaignGatewaySelection, "expected"> & {
  expected: BondClaimReviewExpectation;
};
export function createWenBondClaimGatewayProfile(read: () => Promise<BondClaimGatewaySelection>) {
  return createWenCampaignGatewayProfile(read, "bond-claim");
}
