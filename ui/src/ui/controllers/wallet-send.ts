export function resolveWalletSendApprovalOperation(params: {
  passkeyCount: number;
  executionMode: "manual" | "autonomous";
}): "wallet.send" | null {
  if (params.executionMode !== "autonomous") {
    return null;
  }
  return params.passkeyCount > 0 ? "wallet.send" : null;
}
