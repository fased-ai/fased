import { callLocalSocketSigner } from "./providers/local-socket-signer-adapter.js";
import { validateWenBtcIntentCandidate } from "./wen-btc-intent.js";
import {
  bindWenBtcRoutePreview,
  type WenBtcRoutePreview,
} from "./wen-btc-route-preview-contract.js";
export async function previewWenBtcRouteWithSigner(
  socketPath: string,
  walletId: string,
  input: unknown,
): Promise<WenBtcRoutePreview> {
  if (!walletId.trim() || walletId !== walletId.trim()) {
    throw new Error("Invalid WEN route preview wallet");
  }
  const intent = validateWenBtcIntentCandidate(input);
  if (intent.operation !== "acquisition") {
    throw new Error("WEN route preview requires acquisition");
  }
  return bindWenBtcRoutePreview(
    await callLocalSocketSigner<unknown>(socketPath, {
      op: "v2.wenBtc.route.preview",
      walletId,
      request: intent,
    }),
    intent,
  );
}
