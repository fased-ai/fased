import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import {
  validateWenWithdrawalIntent,
  isWenWithdrawalPreparation,
} from "./wen-withdrawal-preparation-contract.js";
export async function prepareWenWithdrawalWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw Error("Invalid withdrawal wallet");
  }
  const intent = validateWenWithdrawalIntent(input);
  const result = await callLocalSocketSigner<unknown>(socketPath, {
    op: "v2.wenWithdrawal.prepare",
    walletId,
    request: intent,
  });
  if (
    !isWenWithdrawalPreparation(result) ||
    result.descriptorSha256 !== intent.descriptorSha256 ||
    BigInt(result.slot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(result.slot) >= BigInt(intent.expiresSlot) ||
    BigInt(result.networkFeeLamports) > BigInt(intent.maxFeeLamports)
  ) {
    throw Error("Withdrawal preview binding mismatch");
  }
  return Object.freeze({ ...result });
}
