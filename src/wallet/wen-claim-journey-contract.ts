export type WenClaimJourneyResult = {
  requestId: string;
  walletId: string;
  digest: string;
  outcome: string;
  recoveryRequired: boolean;
};
export function isWenClaimJourneyResult(input: unknown): input is WenClaimJourneyResult {
  const v = input as WenClaimJourneyResult;
  if (
    !v ||
    typeof v !== "object" ||
    Object.keys(v).length !== 5 ||
    typeof v.requestId !== "string" ||
    !/^[A-Za-z0-9_:.-]{8,128}$/.test(v.requestId) ||
    typeof v.walletId !== "string" ||
    v.walletId.length === 0 ||
    typeof v.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.digest) ||
    typeof v.outcome !== "string" ||
    v.outcome.length > 128 ||
    typeof v.recoveryRequired !== "boolean" ||
    (!v.recoveryRequired &&
      !["finalized-success", "finalized-failed", "cancelled"].includes(v.outcome))
  ) {
    return false;
  }
  return true;
}
export function bindWenClaimJourneyResult(
  input: unknown,
  requestId: string,
  walletId: string,
): WenClaimJourneyResult {
  if (
    !isWenClaimJourneyResult(input) ||
    input.requestId !== requestId ||
    input.walletId !== walletId
  ) {
    throw Error("Invalid claim journey response");
  }
  const v = input;
  return structuredClone(v);
}
