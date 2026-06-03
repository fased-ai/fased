import type { EmbeddedPiRunResult } from "../../agents/pi-embedded-runner/types.js";

export type StrictAgenticExecutionMode = "off" | "warn" | "enforce";

export type StrictAgenticRuntimePolicy = {
  /**
   * Public Fased policy is warning-only for now. Enforcement remains internal
   * contract state until chat/channel/cron retry semantics are product-defined.
   */
  mode?: "off" | "warn";
};

export type StrictAgenticClassification = "fulfilled" | "planned_without_action" | "empty";

export type StrictAgenticReason =
  | "user_visible_payload"
  | "error_payload"
  | "messaging_tool_sent"
  | "cron_added"
  | "pending_tool_call"
  | "empty_result";

export type StrictAgenticDecisionAction = "accept" | "warn" | "retry_or_fail";

export type StrictAgenticPayload = NonNullable<EmbeddedPiRunResult["payloads"]>[number] & {
  isReasoning?: boolean;
};

export type StrictAgenticRunInput = Pick<
  EmbeddedPiRunResult,
  "didSendViaMessagingTool" | "meta" | "successfulCronAdds"
> & {
  payloads?: StrictAgenticPayload[];
};

export type StrictAgenticRunClassification = {
  classification: StrictAgenticClassification;
  reason: StrictAgenticReason;
  hasUserVisiblePayload: boolean;
  hasWorkflowAction: boolean;
  hasPendingToolCall: boolean;
};

export type StrictAgenticRunDecision = StrictAgenticRunClassification & {
  mode: StrictAgenticExecutionMode;
  action: StrictAgenticDecisionAction;
  ok: boolean;
};

export const STRICT_AGENTIC_MODE_ENV = "FASED_STRICT_AGENTIC_MODE";

function hasRenderablePayload(payload: StrictAgenticPayload): boolean {
  if (payload.isReasoning) {
    return false;
  }
  if ((payload.text ?? "").trim()) {
    return true;
  }
  if ((payload.mediaUrl ?? "").trim()) {
    return true;
  }
  return Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((url) => url.trim());
}

function hasErrorPayload(payload: StrictAgenticPayload): boolean {
  return payload.isError === true && hasRenderablePayload(payload);
}

function hasPendingToolCall(result: StrictAgenticRunInput): boolean {
  return (
    result.meta.stopReason === "tool_calls" ||
    result.meta.stopReason === "toolUse" ||
    Boolean(result.meta.pendingToolCalls?.length)
  );
}

export function classifyStrictAgenticRun(
  result: StrictAgenticRunInput,
): StrictAgenticRunClassification {
  const payloads = result.payloads ?? [];
  const hasWorkflowAction =
    result.didSendViaMessagingTool === true || (result.successfulCronAdds ?? 0) > 0;
  const errorPayload = payloads.some(hasErrorPayload);
  const hasUserVisiblePayload = payloads.some(hasRenderablePayload);
  const pendingToolCall = hasPendingToolCall(result);

  if (hasWorkflowAction) {
    return {
      classification: "fulfilled",
      reason: result.didSendViaMessagingTool === true ? "messaging_tool_sent" : "cron_added",
      hasUserVisiblePayload,
      hasWorkflowAction,
      hasPendingToolCall: pendingToolCall,
    };
  }

  if (errorPayload) {
    return {
      classification: "fulfilled",
      reason: "error_payload",
      hasUserVisiblePayload,
      hasWorkflowAction,
      hasPendingToolCall: pendingToolCall,
    };
  }

  if (hasUserVisiblePayload) {
    return {
      classification: "fulfilled",
      reason: "user_visible_payload",
      hasUserVisiblePayload,
      hasWorkflowAction,
      hasPendingToolCall: pendingToolCall,
    };
  }

  if (pendingToolCall) {
    return {
      classification: "planned_without_action",
      reason: "pending_tool_call",
      hasUserVisiblePayload,
      hasWorkflowAction,
      hasPendingToolCall: true,
    };
  }

  return {
    classification: "empty",
    reason: "empty_result",
    hasUserVisiblePayload,
    hasWorkflowAction,
    hasPendingToolCall: false,
  };
}

export function resolveStrictAgenticRunDecision(params: {
  result: StrictAgenticRunInput;
  mode?: StrictAgenticExecutionMode;
}): StrictAgenticRunDecision {
  const mode = params.mode ?? "off";
  const classification = classifyStrictAgenticRun(params.result);
  const action: StrictAgenticDecisionAction =
    classification.classification === "fulfilled"
      ? "accept"
      : mode === "enforce"
        ? "retry_or_fail"
        : mode === "warn"
          ? "warn"
          : "accept";

  return {
    ...classification,
    mode,
    action,
    ok: action !== "retry_or_fail",
  };
}

export function resolveStrictAgenticRuntimeMode(
  env: Partial<Record<typeof STRICT_AGENTIC_MODE_ENV, string | undefined>> = process.env,
  policy?: StrictAgenticRuntimePolicy | null,
): StrictAgenticExecutionMode {
  if (policy?.mode === "warn") {
    return "warn";
  }
  if (policy?.mode === "off") {
    return "off";
  }
  const raw = env[STRICT_AGENTIC_MODE_ENV]?.trim().toLowerCase();
  if (raw === "warn" || raw === "warning" || raw === "1" || raw === "true") {
    return "warn";
  }
  return "off";
}

export function formatStrictAgenticAuditLine(params: {
  decision: StrictAgenticRunDecision;
  runId: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
}): string {
  const parts = [
    "[agent:strict-agentic]",
    `mode=${params.decision.mode}`,
    `classification=${params.decision.classification}`,
    `reason=${params.decision.reason}`,
    `action=${params.decision.action}`,
    `run=${params.runId}`,
  ];
  if (params.sessionKey) {
    parts.push(`session=${params.sessionKey}`);
  }
  if (params.provider) {
    parts.push(`provider=${params.provider}`);
  }
  if (params.model) {
    parts.push(`model=${params.model}`);
  }
  return parts.join(" ");
}
