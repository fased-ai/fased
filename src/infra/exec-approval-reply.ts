export function getExecApprovalApproverDmNoticeText(): string {
  return "Approver DMs are configured; an approval request was also sent to approvers.";
}

export function buildExecApprovalUnavailableReplyPayload(params: {
  warningText?: string;
  reason: "no-approval-route" | "initiating-platform-disabled" | "initiating-platform-unsupported";
  channel?: string;
  channelLabel?: string;
  accountId?: string;
  sentApproverDms?: boolean;
}): { text: string } {
  const channel = params.channelLabel ?? params.channel ?? "this surface";
  const reasonText =
    params.reason === "no-approval-route"
      ? "No approval route is available for this exec request."
      : params.reason === "initiating-platform-disabled"
        ? `${channel} exec approvals are disabled for this account.`
        : `${channel} does not support exec approvals.`;
  const lines = [
    params.warningText ?? "",
    "Approval required, but this request cannot be approved here.",
    reasonText,
    params.accountId ? `Account: ${params.accountId}` : undefined,
    params.sentApproverDms ? getExecApprovalApproverDmNoticeText() : undefined,
  ].filter((line): line is string => typeof line === "string" && line.length > 0);
  return { text: lines.join("\n") };
}
