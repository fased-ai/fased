import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenMiningAuthorizationBegin,
  bindWenMiningAuthorizationFinish,
} from "./wen-mining-review-authorization-contract.js";
import {
  bindWenMiningStoredReview,
  isWenMiningStoredReview,
  validateWenMiningReviewPrepareRequest,
} from "./wen-mining-review-preparation-contract.js";

// Local approval session only. An opaque proof is not a signed transaction.
// The owner must cancel this session on wallet/profile/client replacement.
export async function beginWenMiningApproval(
  socketPath: string,
  walletId: string,
  input: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!walletId || walletId !== walletId.trim() || !isWenMiningStoredReview(input)) {
    throw Error("Invalid claim approval review");
  }
  const snapshot = structuredClone(input);
  const expected = await bindWenMiningStoredReview(
    snapshot,
    validateWenMiningReviewPrepareRequest({
      requestId: snapshot.requestId,
      intent: snapshot.semanticIntent.intent,
      reviewSha256: snapshot.semanticIntent.binding.ReviewSHA,
    }),
    walletId,
  );
  signal.throwIfAborted();
  const challenge = bindWenMiningAuthorizationBegin(
    await callLocalSocketSigner<unknown>(socketPath, {
      op: "v2.review.authorization.begin",
      walletId,
      request: { requestId: expected.requestId },
    }),
    expected,
  );
  signal.throwIfAborted();
  let used = false;
  return {
    // The browser receives its own copy; editing it cannot replace the retained challenge.
    challenge: structuredClone(challenge),
    async finish(credential: unknown) {
      signal.throwIfAborted();
      if (used) {
        throw Error("Claim approval session already finished or attempted");
      }
      bindWenMiningAuthorizationBegin(challenge, expected);
      const copy = structuredClone(credential);
      const encoded = JSON.stringify(copy);
      if (!encoded || new TextEncoder().encode(encoded).length > 65536) {
        throw Error("Invalid claim credential size");
      }
      // An uncertain response may already have consumed the challenge. Never resend it.
      used = true;
      const result = await callLocalSocketSigner<unknown>(socketPath, {
        op: "v2.review.authorization.finish",
        walletId,
        request: { challengeId: challenge.challengeId, credential: copy },
      });
      signal.throwIfAborted();
      return bindWenMiningAuthorizationFinish(result, expected);
    },
  };
}
