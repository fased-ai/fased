import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  bindWenMiningClaimProposal,
  validateWenMiningClaimProposalRequest,
} from "./wen-mining-claim-proposal-contract.js";
// Refresh an admitted claim for review. This does not admit, approve or sign it.
export async function proposeWenMiningClaimWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw Error("Invalid claim proposal wallet");
  }
  const request = validateWenMiningClaimProposalRequest(input);
  const result = await callLocalSocketSigner<unknown>(socketPath, {
    op: "v2.wenMining.claim.propose",
    walletId,
    request,
  });
  return bindWenMiningClaimProposal(result, request);
}
