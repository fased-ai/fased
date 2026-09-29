import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { validateWenMiningIntentCandidate } from "./wen-mining-intent.js";
import { bindWenMiningPreparation } from "./wen-mining-preparation-contract.js";
export async function prepareWenMiningWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
) {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw new Error("Invalid mining wallet");
  }
  const intent = validateWenMiningIntentCandidate(input);
  return bindWenMiningPreparation(
    await callLocalSocketSigner<unknown>(socketPath, {
      op: "v2.wenMining.prepare",
      walletId,
      request: intent,
    }),
    intent,
  );
}
