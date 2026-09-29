import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { validateWenBtcIntentCandidate } from "./wen-btc-intent.js";
import { bindWenBtcPreparation, type WenBtcPreparation } from "./wen-btc-preparation-contract.js";
// Returns a simulated unsigned preview. No signing or broadcast fallback.
export async function prepareWenBtcWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
): Promise<WenBtcPreparation> {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw new Error("Invalid WEN BTC preparation wallet");
  }
  const intent = validateWenBtcIntentCandidate(input);
  return bindWenBtcPreparation(
    await callLocalSocketSigner<unknown>(socketPath, {
      op: "v2.wenBtc.prepare",
      walletId,
      request: intent,
    }),
    intent,
  );
}
