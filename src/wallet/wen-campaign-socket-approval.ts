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
  bindWenCampaignAuthorizationBegin,
  bindWenCampaignAuthorizationFinish,
} from "./wen-campaign-authorization-contract.js";
import {
  bindWenCampaignReview,
  type CampaignReviewExpectation,
} from "./wen-campaign-review-contract.js";
import {
  readWenCampaignJourneyResult,
  validateWenCampaignJourneyRequest,
  type WenCampaignJourneyRequest,
} from "./wen-campaign-service-contract.js";
import { bindWenMarketReview, type MarketReviewExpectation } from "./wen-market-review-contract.js";

export type CampaignSocketProfile = { walletId: string; socketPath: string; revision: string };
async function bindSocketProfile(
  walletId: string,
  readProfile: () => Promise<CampaignSocketProfile>,
  signal: AbortSignal,
) {
  const selected = { ...(await readProfile()) };
  if (
    selected.walletId !== walletId ||
    !selected.socketPath.startsWith("/") ||
    !selected.revision
  ) {
    throw Error("Campaign approval profile mismatch");
  }
  async function guard() {
    signal.throwIfAborted();
    const current = await readProfile();
    signal.throwIfAborted();
    if (
      current.walletId !== selected.walletId ||
      current.socketPath !== selected.socketPath ||
      current.revision !== selected.revision
    ) {
      throw Error("Campaign approval profile changed");
    }
  }
  return { selected, guard };
}

// Transport uses protected signer services; it cannot install admission or bind a deployment.
// revision is host-owned and changes whenever the selected profile is replaced.
export async function createWenCampaignSocketTransport(
  input: unknown,
  expected:
    | CampaignReviewExpectation
    | MarketReviewExpectation
    | BondPurchaseReviewExpectation
    | BondClaimReviewExpectation,
  readProfile: () => Promise<CampaignSocketProfile>,
  signal: AbortSignal,
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign",
) {
  signal.throwIfAborted();
  const pins = structuredClone(expected);
  const bindReview = (v: unknown) =>
    domain === "bond-claim"
      ? bindWenBondClaimReview(v, pins as BondClaimReviewExpectation)
      : domain === "bond"
        ? bindWenBondPurchaseReview(v, pins as BondPurchaseReviewExpectation)
        : domain === "market"
          ? bindWenMarketReview(v, pins as MarketReviewExpectation)
          : bindWenCampaignReview(v, pins as CampaignReviewExpectation);
  const review = await bindReview(input);
  const { selected, guard } = await bindSocketProfile(review.walletId, readProfile, signal);
  let began = false,
    finished = false;
  let challenge: ReturnType<typeof bindWenCampaignAuthorizationBegin> | undefined;
  let executionAttempted = false;
  const identity = {
    requestId: review.requestId,
    walletId: review.walletId,
    digest: review.artifactDigest.slice(7),
  };
  return {
    async journey(input: WenCampaignJourneyRequest) {
      const request = validateWenCampaignJourneyRequest(input);
      if (request.requestId !== identity.requestId) {
        throw Error("Campaign request identity changed");
      }
      await guard();
      if (request.action === "execute") {
        if (executionAttempted) {
          throw Error("Campaign execution already attempted");
        }
        executionAttempted = true;
      } else {
        executionAttempted = true;
      }
      const result = await callLocalSocketSigner<unknown>(selected.socketPath, {
        op:
          domain === "bond-claim"
            ? "v2.wenBondClaim.journey"
            : domain === "bond"
              ? "v2.wenBondPurchase.journey"
              : domain === "market"
                ? "v2.wenMarket.journey"
                : "v2.wenCampaign.journey",
        walletId: selected.walletId,
        request,
      });
      await guard();
      return {
        ok: true as const,
        result: readWenCampaignJourneyResult({ ok: true, result }, identity),
      };
    },
    async begin(request: { requestId: string }) {
      if (began || request.requestId !== review.requestId) {
        throw Error("Invalid campaign approval begin");
      }
      began = true;
      await guard();
      await bindReview(review);
      await guard();
      const result = await callLocalSocketSigner<unknown>(selected.socketPath, {
        op: "v2.review.authorization.begin",
        walletId: selected.walletId,
        request: { requestId: review.requestId },
      });
      await guard();
      challenge = bindWenCampaignAuthorizationBegin(result, review);
      return structuredClone(challenge);
    },
    async finish(request: { challengeId: string; credential: unknown }) {
      if (finished || !challenge || request.challengeId !== challenge.challengeId) {
        throw Error("Invalid campaign approval finish");
      }
      finished = true;
      const credential = structuredClone(request.credential);
      const encoded = JSON.stringify(credential);
      if (!encoded || new TextEncoder().encode(encoded).length > 65536) {
        throw Error("Invalid campaign credential size");
      }
      await guard();
      bindWenCampaignAuthorizationBegin(challenge, review);
      const result = await callLocalSocketSigner<unknown>(selected.socketPath, {
        op: "v2.review.authorization.finish",
        walletId: selected.walletId,
        request: { challengeId: challenge.challengeId, credential },
      });
      await guard();
      return bindWenCampaignAuthorizationFinish(result, review);
    },
  };
}

// Compatibility for existing approval callers; one implementation owns transport.
export const createWenCampaignSocketApproval = createWenCampaignSocketTransport;

export async function recoverWenCampaignSocket(
  identity: { requestId: string; walletId: string; digest: string },
  readProfile: () => Promise<CampaignSocketProfile>,
  signal: AbortSignal,
  domain: "campaign" | "market" | "bond" | "bond-claim" = "campaign",
) {
  const saved = { ...identity };
  const request = validateWenCampaignJourneyRequest({
    requestId: saved.requestId,
    action: "recover",
  });
  if (!/^[a-f0-9]{64}$/.test(saved.digest)) {
    throw Error("Invalid campaign recovery digest");
  }
  const { selected, guard } = await bindSocketProfile(saved.walletId, readProfile, signal);
  await guard();
  const result = await callLocalSocketSigner<unknown>(selected.socketPath, {
    op:
      domain === "bond-claim"
        ? "v2.wenBondClaim.journey"
        : domain === "bond"
          ? "v2.wenBondPurchase.journey"
          : domain === "market"
            ? "v2.wenMarket.journey"
            : "v2.wenCampaign.journey",
    walletId: selected.walletId,
    request,
  });
  await guard();
  return { ok: true as const, result: readWenCampaignJourneyResult({ ok: true, result }, saved) };
}

// Buy shares the owner-approval, one-attempt and recovery transport; only its
// independently verified review and operation domain differ. Runtime stays gated.
export function createWenMarketSocketTransport(
  input: unknown,
  expected: MarketReviewExpectation,
  readProfile: () => Promise<CampaignSocketProfile>,
  signal: AbortSignal,
) {
  return createWenCampaignSocketTransport(input, expected, readProfile, signal, "market");
}
export function recoverWenMarketSocket(
  identity: { requestId: string; walletId: string; digest: string },
  readProfile: () => Promise<CampaignSocketProfile>,
  signal: AbortSignal,
) {
  return recoverWenCampaignSocket(identity, readProfile, signal, "market");
}
