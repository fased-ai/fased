import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenMiningStoredReview,
  validateWenMiningReviewPrepareRequest,
} from "./wen-mining-review-preparation-contract.js";
export async function prepareWenMiningReviewWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw Error("Invalid review wallet");
  }
  const request = validateWenMiningReviewPrepareRequest(input);
  const result = await callLocalSocketSigner<unknown>(socketPath, {
    op: "v2.wenMining.claim.review.prepare",
    walletId,
    request,
  });
  return bindWenMiningStoredReview(result, request, walletId);
}
