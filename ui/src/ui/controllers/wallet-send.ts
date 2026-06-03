export function resolveWalletSendApprovalOperation(params: {
  passkeyCount: number;
  executionMode: "manual" | "autonomous";
  custodyMode: "single-key" | "split-key-scaffold" | "split-key-active";
  unlockActive: boolean;
}): "wallet.send" | "wallet.custody-unlock" | null {
  if (params.executionMode !== "autonomous") {
    return null;
  }
  if (params.custodyMode === "split-key-active" && !params.unlockActive) {
    return "wallet.custody-unlock";
  }
  return params.passkeyCount > 0 ? "wallet.send" : null;
}
