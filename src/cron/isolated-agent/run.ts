import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { runCliAgent } from "../../agents/cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../../agents/cli-session.js";
import { lookupContextTokens } from "../../agents/context.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { createFasedAgentCodingTools } from "../../agents/pi-tools.js";
import type { AnyAgentTool } from "../../agents/pi-tools.types.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
} from "../../auto-reply/thinking.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { FasedAgentConfig } from "../../config/config.js";
import {
  resolveSessionTranscriptPath,
  setSessionRuntimeModel,
  updateSessionStore,
} from "../../config/sessions.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { logWarn } from "../../logger.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  buildSafeExternalPrompt,
  detectSuspiciousPatterns,
  getHookType,
  isExternalHookSession,
} from "../../security/external-content.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { resolveCronDeliveryPlan } from "../delivery.js";
import { adaptDeterministicSkillResult } from "../deterministic-result-adapters.js";
import type { CronGraphNodeHandlerResult, CronTaskGraphContextItem } from "../graph-context.js";
import { runCronTaskCoordinationNode } from "../task-coordination.js";
import { buildCheapCheckInstruction, buildEscalationInstruction } from "../task-evaluator.js";
import {
  plannerStrategyModelRole,
  resolveTaskModelRole,
  type CronTaskModelRoleSelection,
} from "../task-model-roles.js";
import type {
  CronJob,
  CronRunOutcome,
  CronRunPolicyTelemetry,
  CronRunTelemetry,
  CronTaskExecutionMode,
} from "../types.js";
import {
  dispatchCronDelivery,
  matchesMessagingToolDeliveryTarget,
  resolveCronDeliveryBestEffort,
} from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";
import {
  isHeartbeatOnlyResponse,
  pickLastDeliverablePayload,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromOutput,
  pickSummaryFromPayloads,
  resolveHeartbeatAckMaxChars,
} from "./helpers.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { resolveCronSession } from "./session.js";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

function resolveTaskExecutionMode(job: CronJob): Exclude<CronTaskExecutionMode, "auto"> {
  const policy = job.executionPolicy;
  if (policy?.executionMode === "skill-only") {
    return "skill-only";
  }
  if (policy?.executionMode === "no-model" || policy?.modelPolicy?.mode === "none") {
    return "no-model";
  }
  return "agent-turn";
}

type SourceVerificationSignal = {
  status: NonNullable<CronTaskGraphContextItem["verificationStatus"]>;
  conflictCount?: number;
  needsReview?: boolean;
  evaluatorSignal?: string;
  summary?: string;
  outputText?: string;
};

function resolveSourceQualityTelemetry(
  context: CronTaskGraphContextItem[] | undefined,
): NonNullable<CronRunPolicyTelemetry["sourceQuality"]> | undefined {
  const sources = (context ?? []).filter((entry) => entry.nodeId.startsWith("source-fetch"));
  if (sources.length === 0) {
    return undefined;
  }
  const scored = sources.filter(
    (entry): entry is CronTaskGraphContextItem & { sourceQualityScore: number } =>
      typeof entry.sourceQualityScore === "number" && Number.isFinite(entry.sourceQualityScore),
  );
  const best = scored.reduce<
    (CronTaskGraphContextItem & { sourceQualityScore: number }) | undefined
  >((current, entry) => {
    if (!current || entry.sourceQualityScore > current.sourceQualityScore) {
      return entry;
    }
    return current;
  }, undefined);
  const lowQuality = scored.filter(
    (entry) => entry.sourceQualityScore > 0 && entry.sourceQualityScore < 0.5,
  );
  const unavailable = sources.filter((entry) => entry.status !== "ok");
  return {
    bestSourceId: best?.nodeId,
    bestScore: best?.sourceQualityScore,
    lowQualityCount: lowQuality.length,
    lowQualitySourceIds: lowQuality.map((entry) => entry.nodeId),
    unavailableCount: unavailable.length,
    unavailableSourceIds: unavailable.map((entry) => entry.nodeId),
    sources: sources.map((entry) => ({
      id: entry.nodeId,
      trustedSourceId: entry.trustedSourceId,
      status: entry.status,
      role: entry.sourceRole,
      optional: entry.optional === true,
      required: entry.optional !== true,
      score: entry.sourceQualityScore,
    })),
  };
}

function resolveSourceVerificationSignal(
  context: CronTaskGraphContextItem[] | undefined,
): SourceVerificationSignal | undefined {
  const verification = (context ?? [])
    .filter((entry) => entry.nodeId === "source-verify" && entry.verificationStatus)
    .at(-1);
  if (!verification?.verificationStatus) {
    return undefined;
  }
  return {
    status: verification.verificationStatus,
    conflictCount: verification.sourceConflictCount,
    needsReview: verification.needsReview,
    evaluatorSignal: verification.evaluatorSignal,
    summary: verification.summary,
    outputText: verification.outputText,
  };
}

function resolveCoordinationTelemetry(
  context: CronTaskGraphContextItem[] | undefined,
): NonNullable<CronRunPolicyTelemetry["coordination"]> | undefined {
  const evidence = (context ?? [])
    .flatMap((entry) => entry.coordinationEvidence ?? [])
    .filter((entry) => entry.agentId && entry.agentId !== "none");
  if (evidence.length === 0) {
    return undefined;
  }
  const agents = Array.from(new Set(evidence.map((entry) => entry.agentId)));
  const completed = evidence.filter((entry) => entry.status === "completed").length;
  const needsApproval = evidence.filter((entry) => entry.status === "needs_approval").length;
  const failed = evidence.filter(
    (entry) => entry.status === "error" || entry.status === "forbidden",
  ).length;
  return {
    total: evidence.length,
    completed,
    needsApproval,
    failed,
    agents,
  };
}

function resolveTaskPolicyTelemetry(
  job: CronJob,
  effectiveExecutionMode: Exclude<CronTaskExecutionMode, "auto">,
  sourceVerification?: SourceVerificationSignal,
  sourceQuality?: NonNullable<CronRunPolicyTelemetry["sourceQuality"]>,
  coordination?: NonNullable<CronRunPolicyTelemetry["coordination"]>,
): CronRunPolicyTelemetry | undefined {
  const policy = job.executionPolicy;
  if (!policy) {
    return undefined;
  }
  return {
    objective: policy.objective,
    successCriteria: policy.successCriteria,
    requestedExecutionMode: policy.executionMode,
    effectiveExecutionMode,
    memoryScope: policy.memoryScope,
    skillScope: policy.skillScope,
    modelPolicyMode: policy.modelPolicy?.mode,
    modelOverride: policy.modelPolicy?.model,
    escalationModel: policy.modelPolicy?.escalationModel,
    budget: policy.budget,
    stop: policy.stop,
    planner: policy.planner,
    sourceVerificationStatus: sourceVerification?.status,
    sourceConflictCount: sourceVerification?.conflictCount,
    needsSourceReview: sourceVerification?.needsReview,
    escalatedBecause:
      sourceVerification?.status === "conflict_suspected" ? "source_conflict" : undefined,
    coordination,
    sourceQuality,
  };
}

function withResultSourceTelemetry(
  policy: CronRunPolicyTelemetry | undefined,
  result: Pick<CronRunPolicyTelemetry, "resultSource" | "resultAdapter" | "modelUsed">,
): CronRunPolicyTelemetry | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    ...policy,
    ...result,
  };
}

function withModelSourceTelemetry(
  policy: CronRunPolicyTelemetry | undefined,
  modelSource: string | undefined,
): CronRunPolicyTelemetry | undefined {
  if (!policy || !modelSource) {
    return policy;
  }
  return { ...policy, modelSource };
}

function withLoadedSkillsTelemetry(
  policy: CronRunPolicyTelemetry | undefined,
  skillsSnapshot: SkillSnapshot,
): CronRunPolicyTelemetry | undefined {
  if (!policy) {
    return undefined;
  }
  const skills = Array.isArray(skillsSnapshot.skills) ? skillsSnapshot.skills : [];
  const names = skills
    .map((skill) => skill.name.trim())
    .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index)
    .slice(0, 12);
  return {
    ...policy,
    skills: {
      count: skills.length,
      names,
      skillFilter: skillsSnapshot.skillFilter,
    },
  };
}

function resolveTaskModelOverride(job: CronJob): { model?: string; source?: "policy" | "payload" } {
  const policy = job.executionPolicy?.modelPolicy;
  const policyModel = policy?.model?.trim();
  if ((policy?.mode === "task-override" || policy?.mode === "auto") && policyModel) {
    return { model: policyModel, source: "policy" };
  }
  const payloadModel = job.payload.kind === "agentTurn" ? job.payload.model?.trim() : undefined;
  return payloadModel ? { model: payloadModel, source: "payload" } : {};
}

function formatTaskModelSelectionSource(selection: CronTaskModelRoleSelection): string {
  return selection.label;
}

function buildSourceConflictReviewInstruction(signal: SourceVerificationSignal | undefined) {
  if (signal?.status !== "conflict_suspected") {
    return undefined;
  }
  const issueCount =
    typeof signal.conflictCount === "number" && Number.isFinite(signal.conflictCount)
      ? signal.conflictCount
      : undefined;
  return [
    `Source verification found conflicting evidence${issueCount ? ` (${issueCount} issue${issueCount === 1 ? "" : "s"})` : ""}.`,
    "Treat this as a review/escalation pass: compare the gathered sources explicitly, explain which source appears more reliable, call out uncertainty, and avoid presenting one side as settled fact.",
  ].join(" ");
}

function resolveTaskFallbacks(params: { job: CronJob; agentFallbacks?: string[] }) {
  const escalationModel = params.job.executionPolicy?.modelPolicy?.escalationModel?.trim();
  if (!escalationModel) {
    return params.agentFallbacks;
  }
  return [escalationModel, ...(params.agentFallbacks ?? [])];
}

function resolveTaskSkillFilterOverride(job: CronJob): string[] | undefined {
  const scope = job.executionPolicy?.skillScope;
  if (scope === "none") {
    return [];
  }
  if (scope === "selected") {
    return job.executionPolicy?.allowedSkills ?? [];
  }
  return undefined;
}

function resolveMemoryPolicyLine(job: CronJob): string | undefined {
  const scope = job.executionPolicy?.memoryScope;
  if (!scope) {
    return undefined;
  }
  if (scope === "none") {
    return "Do not retrieve memory or rely on prior context; use only this task input.";
  }
  if (scope === "session-summary") {
    return "Use only the compact session summary unless the task explicitly asks for more.";
  }
  if (scope === "pinned") {
    return "Use pinned memory only; avoid broad memory search.";
  }
  if (scope === "search") {
    return "Search memory only when it is needed for the task result.";
  }
  if (scope === "agent") {
    return "Use the Agent's normal memory policy.";
  }
  return undefined;
}

function compactPromptText(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function buildCompactCheapCheckPrompt(params: {
  job: CronJob;
  message: string;
  timeLine: string;
  deliveryRequested: boolean;
  memoryPolicyLine?: string;
  graphContext?: string;
  cheapCheckInstruction: string;
}): string {
  return [
    `[task:${params.job.id} ${params.job.name}] Cheap check`,
    `Input:\n${compactPromptText(params.message, 2_400)}`,
    params.timeLine,
    params.memoryPolicyLine ? `Memory: ${params.memoryPolicyLine}` : undefined,
    params.graphContext
      ? `Prepared context:\n${compactPromptText(params.graphContext, 4_000)}`
      : undefined,
    params.deliveryRequested
      ? "Delivery: return one plain-text summary; delivery happens automatically."
      : undefined,
    params.cheapCheckInstruction,
    "Do not perform deep analysis. Do not pull broad memory. Use only the task input and prepared context.",
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n\n")
    .trim();
}

function buildCompactEscalationPrompt(params: {
  job: CronJob;
  message: string;
  timeLine: string;
  deliveryRequested: boolean;
  memoryPolicyLine?: string;
  graphContext?: string;
  pendingEscalation: NonNullable<CronJob["state"]["pendingEscalation"]>;
}): string {
  return [
    `[task:${params.job.id} ${params.job.name}] Escalation follow-up`,
    "A cheap check requested stronger analysis. Use only the compact task input, evaluator cue, and prepared context below.",
    `Evaluator cue: ${params.pendingEscalation.signal ?? "unspecified"}`,
    `Evaluator reason: ${compactPromptText(params.pendingEscalation.reason, 700)}`,
    `Task input:\n${compactPromptText(params.message, 1_600)}`,
    params.timeLine,
    params.memoryPolicyLine ? `Memory: ${params.memoryPolicyLine}` : undefined,
    params.graphContext
      ? `Prepared context:\n${compactPromptText(params.graphContext, 2_400)}`
      : undefined,
    params.deliveryRequested
      ? "Delivery: return the final task result as plain text; delivery happens automatically."
      : undefined,
    "Keep the final response under 180 words unless the task explicitly asks for detailed analysis.",
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n\n")
    .trim();
}

function formatGraphContextForPrompt(context: CronTaskGraphContextItem[] | undefined): string {
  const hasSourceMerge = (context ?? []).some((entry) => entry.nodeId === "source-merge");
  const entries = (context ?? []).filter((entry) => {
    if (
      hasSourceMerge &&
      (entry.nodeId === "source-fetch" || entry.nodeId.startsWith("source-fetch-"))
    ) {
      return false;
    }
    return Boolean(entry.outputText?.trim() || entry.summary?.trim() || entry.error?.trim());
  });
  if (entries.length === 0) {
    return "";
  }
  return entries
    .map((entry) => {
      const label = entry.label?.trim() || entry.nodeId;
      const status = entry.status ? ` · ${entry.status}` : "";
      const tool = entry.toolName ? ` · ${entry.toolName}` : "";
      const quality =
        typeof entry.sourceQualityScore === "number"
          ? ` · quality ${entry.sourceQualityBand ?? "unknown"} ${entry.sourceQualityScore.toFixed(2)}${entry.sourceAuthority ? ` · ${entry.sourceAuthority}` : ""}`
          : "";
      const body = entry.outputText?.trim() || entry.summary?.trim() || entry.error?.trim() || "";
      const coordination =
        entry.coordinationEvidence && entry.coordinationEvidence.length > 0
          ? [
              "Task-room evidence:",
              ...entry.coordinationEvidence.map((evidence) => {
                const child = evidence.childSessionKey
                  ? ` · session ${evidence.childSessionKey}`
                  : "";
                const run = evidence.runId ? ` · run ${evidence.runId}` : "";
                const details =
                  evidence.outputText?.trim() ||
                  evidence.summary?.trim() ||
                  evidence.error?.trim() ||
                  "";
                return `- ${evidence.agentId}: ${evidence.status}${child}${run}${details ? `\n  ${details}` : ""}`;
              }),
            ].join("\n")
          : "";
      return `### ${label}${tool}${status}${quality}\n${[body, coordination].filter(Boolean).join("\n\n")}`;
    })
    .join("\n\n")
    .trim();
}

const MEMORY_SOURCE_TOOL_NAMES = ["memory_search", "memory_get", "sessions_history"];

function resolveTaskMemoryIsolation(job: CronJob): {
  disabledToolNames: string[];
  omitPriorMessages: boolean;
} {
  const scope = job.executionPolicy?.memoryScope;
  if (scope === "none") {
    return { disabledToolNames: MEMORY_SOURCE_TOOL_NAMES, omitPriorMessages: true };
  }
  if (scope === "session-summary") {
    return { disabledToolNames: MEMORY_SOURCE_TOOL_NAMES, omitPriorMessages: false };
  }
  if (scope === "pinned") {
    return { disabledToolNames: ["memory_search", "sessions_history"], omitPriorMessages: false };
  }
  return { disabledToolNames: [], omitPriorMessages: false };
}

function normalizeActionName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isSkillActionAllowed(job: CronJob, toolName: string): boolean {
  const scope = job.executionPolicy?.skillScope;
  if (scope === "none") {
    return false;
  }
  if (scope !== "selected") {
    return true;
  }
  const allowed = new Set((job.executionPolicy?.allowedSkills ?? []).map(normalizeActionName));
  return allowed.has(normalizeActionName(toolName));
}

function extractTextFromToolResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const type = (entry as { type?: unknown }).type;
        const text = (entry as { text?: unknown }).text;
        return type === "text" && typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  const details = (result as { details?: unknown }).details;
  if (details !== undefined) {
    return typeof details === "string" ? details : JSON.stringify(details, null, 2);
  }
  return "";
}

async function runDeterministicSkillAction(params: {
  job: CronJob;
  tools: AnyAgentTool[];
  abortSignal?: AbortSignal;
}): Promise<{ outputText: string; toolName: string; rawResult: unknown }> {
  const action = params.job.executionPolicy?.skillAction;
  const toolName = action?.toolName?.trim();
  if (!toolName) {
    throw new Error("Skill-only task requires executionPolicy.skillAction.toolName.");
  }
  if (!isSkillActionAllowed(params.job, toolName)) {
    throw new Error(`Skill-only tool is not allowed by this task policy: ${toolName}`);
  }
  const input = action?.input && typeof action.input === "object" ? action.input : {};
  return await runNamedToolAction({
    job: params.job,
    tools: params.tools,
    toolName,
    input,
    abortSignal: params.abortSignal,
    sourceLabel: "skill-only",
  });
}

async function runNamedToolAction(params: {
  job: CronJob;
  tools: AnyAgentTool[];
  toolName: string;
  input?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  sourceLabel: string;
}): Promise<{ outputText: string; toolName: string; rawResult: unknown }> {
  const tool = params.tools.find((candidate) => candidate.name === params.toolName);
  if (!tool) {
    throw new Error(
      `${params.sourceLabel} tool is not available for this task: ${params.toolName}`,
    );
  }
  const result = await tool.execute(
    `cron:${params.job.id}:${params.sourceLabel}`,
    (params.input ?? {}) as never,
    params.abortSignal,
  );
  const outputText = extractTextFromToolResult(result).trim();
  return {
    toolName: params.toolName,
    rawResult: result,
    outputText: outputText || `${params.toolName} completed.`,
  };
}

function normalizeGraphToolName(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/^\$/, "") ?? "";
}

function firstUrlFromText(value: string): string | undefined {
  const match = value.match(/https?:\/\/[^\s<>"')]+/i);
  return match?.[0];
}

function graphGatewayAction(message: string): string {
  const text = message.toLowerCase();
  return /\bcatalog\b|\bmodels?\b/.test(text) && !/\bauth|credential|sign.?in\b/.test(text)
    ? "models.catalog.status"
    : "models.auth.status";
}

function graphWalletAction(message: string): string {
  const text = message.toLowerCase();
  if (/\bassets?\b/.test(text)) {
    return "assets";
  }
  if (/\baddress\b/.test(text)) {
    return "address";
  }
  if (/\bbalances?\b/.test(text)) {
    return "balance";
  }
  if (/\blist\b|\bwallets?\b/.test(text)) {
    return "list";
  }
  return "status";
}

function graphMiningAction(message: string): string {
  const text = message.toLowerCase();
  if (/\breadiness\b/.test(text)) {
    return "readiness";
  }
  if (/\bhistory\b/.test(text)) {
    return "history";
  }
  if (/\bprofile\b/.test(text)) {
    return "profile";
  }
  return "status";
}

function graphOffersAction(message: string): string {
  const text = message.toLowerCase();
  if (/\borders?\b/.test(text)) {
    return "orders";
  }
  if (/\bpaid\b|\binvoices?\b|\breceipts?\b/.test(text)) {
    return "paid_invoices";
  }
  if (/\brequests?\b/.test(text)) {
    return "local_requests";
  }
  if (/\blocal\b/.test(text)) {
    return "local_offers";
  }
  return "search";
}

function graphToolInput(
  toolName: string,
  message: string,
  sourceOverride?: string,
): Record<string, unknown> {
  if (toolName === "web_fetch") {
    const sourceText = sourceOverride?.trim() || message;
    const url = firstUrlFromText(sourceText);
    return url
      ? { url, extractMode: "markdown", maxChars: 12_000 }
      : { url: sourceText, extractMode: "markdown", maxChars: 12_000 };
  }
  if (toolName === "web_search") {
    return { query: message, count: 5 };
  }
  if (toolName === "wallet") {
    return { action: graphWalletAction(message) };
  }
  if (toolName === "mining") {
    return { action: graphMiningAction(message) };
  }
  if (toolName === "gateway") {
    return { action: graphGatewayAction(message) };
  }
  if (toolName === "offers") {
    const action = graphOffersAction(message);
    return action === "search" ? { action, query: message.slice(0, 240) } : { action };
  }
  return {};
}

function chooseAllowedGraphTool(job: CronJob, candidates: string[]): string | undefined {
  const allowed = new Set((job.executionPolicy?.allowedSkills ?? []).map(normalizeGraphToolName));
  for (const candidate of candidates) {
    const normalized = normalizeGraphToolName(candidate);
    if (job.executionPolicy?.skillScope === "selected" && !allowed.has(normalized)) {
      continue;
    }
    if (isSkillActionAllowed(job, normalized)) {
      return normalized;
    }
  }
  return undefined;
}

function sourceFetchToolCandidates(message: string): string[] {
  const text = message.toLowerCase();
  const candidates = [
    firstUrlFromText(message) ? "web_fetch" : undefined,
    /\bgateway\b|\bproviders?\b|\bmodel auth\b|\bmodel catalog\b|\bapi credentials?\b/.test(text)
      ? "gateway"
      : undefined,
    /\bwallet\b|\bwallets?\b|\bbalances?\b|\baddress\b/.test(text) ? "wallet" : undefined,
    /\bmining\b|\bsat mining\b|\bminers?\b/.test(text) ? "mining" : undefined,
    /\boffers?\b|\bmarketplace\b|\borders?\b|\brequests?\b/.test(text) ? "offers" : undefined,
    /\bweb\b|\bsearch\b|\bsource\b|\bmarket\b|\brisk\b|\bnews\b|\bprice\b|\bweather\b|\blive\b/.test(
      text,
    )
      ? "web_search"
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(candidates)];
}

function sourceFetchToolForNodeId(nodeId: string): string | undefined {
  if (nodeId === "source-fetch-web-fetch") {
    return "web_fetch";
  }
  if (nodeId.startsWith("source-fetch-trusted-")) {
    return "web_fetch";
  }
  if (nodeId === "source-fetch-gateway") {
    return "gateway";
  }
  if (nodeId === "source-fetch-wallet") {
    return "wallet";
  }
  if (nodeId === "source-fetch-mining") {
    return "mining";
  }
  if (nodeId === "source-fetch-offers") {
    return "offers";
  }
  if (nodeId === "source-fetch-web-search") {
    return "web_search";
  }
  if (nodeId.startsWith("source-fetch-repair-web-fetch")) {
    return "web_fetch";
  }
  if (nodeId.startsWith("source-fetch-repair-gateway")) {
    return "gateway";
  }
  if (nodeId.startsWith("source-fetch-repair-wallet")) {
    return "wallet";
  }
  if (nodeId.startsWith("source-fetch-repair-mining")) {
    return "mining";
  }
  if (nodeId.startsWith("source-fetch-repair-offers")) {
    return "offers";
  }
  if (nodeId.startsWith("source-fetch-repair-web-search")) {
    return "web_search";
  }
  return undefined;
}

function isSourceFetchNodeId(nodeId: string): boolean {
  return nodeId === "source-fetch" || nodeId.startsWith("source-fetch-");
}

function toolPassToolCandidates(message: string, job: CronJob): string[] {
  const text = message.toLowerCase();
  const candidates = [
    /\bwallet\b/.test(text) ? "wallet" : undefined,
    /\bmining\b|\bsat mining\b|\bminers?\b/.test(text) ? "mining" : undefined,
    /\bgateway\b|\bproviders?\b|\bmodel auth\b|\bapi\b/.test(text) ? "gateway" : undefined,
    /\boffers?\b|\bmarketplace\b/.test(text) ? "offers" : undefined,
    firstUrlFromText(message) ? "web_fetch" : undefined,
    /\bweb\b|\bsearch\b|\bsource\b|\bmarket\b|\brisk\b|\bnews\b|\bprice\b/.test(text)
      ? "web_search"
      : undefined,
    ...(job.executionPolicy?.allowedSkills ?? []).map(normalizeGraphToolName),
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(candidates)];
}

function inferGraphToolAction(params: {
  job: CronJob;
  nodeId: string;
  message: string;
}): { toolName: string; input: Record<string, unknown> } | undefined {
  const graphNode = params.job.executionPolicy?.planner?.graph?.nodes.find(
    (node) => node.id === params.nodeId,
  );
  const sourceOverride = graphNode?.sourceUrl ?? graphNode?.sourceText;
  const explicit = params.job.executionPolicy?.skillAction;
  const explicitTool = normalizeGraphToolName(explicit?.toolName);
  if (explicitTool && !isSourceFetchNodeId(params.nodeId)) {
    return {
      toolName: explicitTool,
      input: explicit?.input && typeof explicit.input === "object" ? explicit.input : {},
    };
  }

  if (isSourceFetchNodeId(params.nodeId)) {
    const nodeTool = sourceFetchToolForNodeId(params.nodeId);
    if (nodeTool) {
      const toolName = chooseAllowedGraphTool(params.job, [nodeTool]);
      return toolName
        ? { toolName, input: graphToolInput(toolName, params.message, sourceOverride) }
        : undefined;
    }
    if (explicitTool === "web_search" || explicitTool === "web_fetch") {
      return {
        toolName: explicitTool,
        input:
          explicit?.input && typeof explicit.input === "object"
            ? explicit.input
            : graphToolInput(explicitTool, params.message, sourceOverride),
      };
    }
    const toolName = chooseAllowedGraphTool(params.job, sourceFetchToolCandidates(params.message));
    return toolName
      ? { toolName, input: graphToolInput(toolName, params.message, sourceOverride) }
      : undefined;
  }

  const candidates = toolPassToolCandidates(params.message, params.job);

  const toolName = chooseAllowedGraphTool(params.job, candidates);
  return toolName ? { toolName, input: graphToolInput(toolName, params.message) } : undefined;
}

function graphToolOutputAccessError(outputText: string): string | undefined {
  const text = outputText.trim();
  if (!text) {
    return undefined;
  }
  if (
    /missing [a-z0-9 /-]*(?:api key|access token|credential)/i.test(text) ||
    /(?:api key|access token|credential).{0,80}(?:missing|required)/i.test(text)
  ) {
    return (
      text
        .split("\n")
        .find((line) => line.trim())
        ?.trim() ?? text
    );
  }
  return undefined;
}

export async function runCronGraphDataNode(params: {
  cfg: FasedAgentConfig;
  job: CronJob;
  message: string;
  nodeId: string;
  nodeKind?: CronTaskGraphContextItem["nodeKind"];
  graphContext?: CronTaskGraphContextItem[];
  abortSignal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
}): Promise<CronGraphNodeHandlerResult> {
  const isFastTestEnv = process.env.FASED_TEST_FAST === "1";
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const requestedAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? params.agentId
      : typeof params.job.agentId === "string" && params.job.agentId.trim()
        ? params.job.agentId
        : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(params.cfg, normalizedRequested)
    : undefined;
  const { model: legacyOverrideModel, ...agentOverrideRest } = agentConfigOverride ?? {};
  const agentId = normalizedRequested ?? defaultAgentId;
  const overrideModel = normalizedRequested
    ? (resolveAgentEffectiveModelPrimary(params.cfg, normalizedRequested) ?? legacyOverrideModel)
    : legacyOverrideModel;
  const agentCfg: AgentDefaultsConfig = Object.assign(
    {},
    params.cfg.agents?.defaults,
    agentOverrideRest as Partial<AgentDefaultsConfig>,
  );
  const existingModel = agentCfg.model && typeof agentCfg.model === "object" ? agentCfg.model : {};
  if (typeof overrideModel === "string") {
    agentCfg.model = { ...existingModel, primary: overrideModel };
  } else if (overrideModel) {
    agentCfg.model = { ...existingModel, ...overrideModel };
  }
  const cfgWithAgentDefaults: FasedAgentConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };
  const baseSessionKey = (params.sessionKey.trim() || `cron:${params.job.id}`).trim();
  const agentSessionKey = resolveCronAgentSessionKey({ sessionKey: baseSessionKey, agentId });
  const workspaceDirRaw = resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = resolveAgentDir(params.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    sessionKey: params.job.sessionKey,
    accountId: deliveryPlan.accountId,
  });
  if (params.nodeKind === "coordination" || params.nodeId === "coordinate-agents") {
    return await runCronTaskCoordinationNode({
      job: params.job,
      message: params.message,
      nodeId: params.nodeId,
      agentId,
      agentSessionKey,
      graphContext: params.graphContext ?? [],
      resolvedDelivery,
      abortSignal: params.abortSignal,
    });
  }
  const memoryIsolation = resolveTaskMemoryIsolation(params.job);
  const tools = createFasedAgentCodingTools({
    agentId,
    sessionKey: agentSessionKey,
    agentDir,
    workspaceDir: workspace.dir,
    config: cfgWithAgentDefaults,
    messageProvider: resolvedDelivery.channel,
    agentAccountId: resolvedDelivery.accountId,
    modelProvider: resolvedDefault.provider,
    modelId: resolvedDefault.model,
    modelContextWindowTokens:
      agentCfg?.contextTokens ??
      lookupContextTokens(resolvedDefault.model) ??
      DEFAULT_CONTEXT_TOKENS,
    requireExplicitMessageTarget: true,
    disableMessageTool: true,
    disabledToolNames: memoryIsolation.disabledToolNames,
    senderIsOwner: true,
    abortSignal: params.abortSignal,
  });
  const action = inferGraphToolAction({
    job: params.job,
    nodeId: params.nodeId,
    message: params.message,
  });
  if (!action) {
    return {
      status: "skipped",
      summary: `No concrete handler matched graph node ${params.nodeId}.`,
    };
  }
  if (!isSkillActionAllowed(params.job, action.toolName)) {
    return {
      status: "skipped",
      summary: `Tool ${action.toolName} is not allowed by this task policy.`,
      toolName: action.toolName,
      toolInput: action.input,
    };
  }
  const result = await runNamedToolAction({
    job: params.job,
    tools,
    toolName: action.toolName,
    input: action.input,
    abortSignal: params.abortSignal,
    sourceLabel: `graph:${params.nodeId}`,
  });
  const adaptedResult = adaptDeterministicSkillResult({
    job: params.job,
    toolName: result.toolName,
    rawResult: result.rawResult,
    outputText: result.outputText,
  });
  const outputText = adaptedResult?.outputText ?? result.outputText;
  const accessError = graphToolOutputAccessError(outputText);
  if (accessError) {
    return {
      status: "error",
      error: accessError,
      summary: accessError,
      outputText,
      toolName: result.toolName,
      toolInput: action.input,
    };
  }
  return {
    status: "ok",
    summary: adaptedResult?.summary ?? pickSummaryFromOutput(outputText) ?? `${result.toolName} ok`,
    outputText,
    toolName: result.toolName,
    toolInput: action.input,
  };
}

export const __testing = {
  inferGraphToolAction,
  sourceFetchToolCandidates,
  toolPassToolCandidates,
  graphToolInput,
};

function resolveZeroBudgetError(job: CronJob): string | undefined {
  const budget = job.executionPolicy?.budget;
  if (!budget) {
    return undefined;
  }
  if (budget.maxTokensPerRun === 0) {
    return "Task token budget is 0; model execution was skipped.";
  }
  if (budget.maxCostUsdPerRun === 0) {
    return "Task cost budget is 0; model execution was skipped.";
  }
  return undefined;
}

function resolveTokenBudgetError(params: {
  job: CronJob;
  telemetry?: CronRunTelemetry;
}): string | undefined {
  const maxTokens = params.job.executionPolicy?.budget?.maxTokensPerRun;
  const totalTokens = params.telemetry?.usage?.total_tokens;
  if (
    typeof maxTokens !== "number" ||
    !Number.isFinite(maxTokens) ||
    typeof totalTokens !== "number" ||
    !Number.isFinite(totalTokens)
  ) {
    return undefined;
  }
  if (totalTokens <= maxTokens) {
    return undefined;
  }
  return `Task token budget exceeded: used ${totalTokens}, limit ${maxTokens}.`;
}

function resolveCostBudgetError(params: {
  cfg: FasedAgentConfig;
  job: CronJob;
  telemetry?: CronRunTelemetry;
}): string | undefined {
  const maxCostUsd = params.job.executionPolicy?.budget?.maxCostUsdPerRun;
  if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd)) {
    return undefined;
  }
  const usage = params.telemetry?.usage;
  if (!usage) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    config: params.cfg,
    provider: params.telemetry?.provider,
    model: params.telemetry?.model,
  });
  const estimatedCost = estimateUsageCost({
    cost,
    usage: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_tokens,
      cacheWrite: usage.cache_write_tokens,
    },
  });
  if (estimatedCost === undefined || estimatedCost <= maxCostUsd) {
    return undefined;
  }
  return `Task cost budget exceeded: estimated $${estimatedCost.toFixed(4)}, limit $${maxCostUsd.toFixed(4)}.`;
}

export type RunCronAgentTurnResult = {
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /**
   * `true` when the isolated run already delivered its output to the target
   * channel (via outbound payloads, the subagent announce flow, or a matching
   * messaging-tool send). Callers should skip posting a summary to the main
   * session to avoid duplicate
   * messages.  See: https://github.com/fased-ai/fased
   */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
} & CronRunOutcome &
  CronRunTelemetry;

export async function runCronIsolatedAgentTurn(params: {
  cfg: FasedAgentConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  sessionKey: string;
  agentId?: string;
  lane?: string;
  deferDelivery?: boolean;
  graphContext?: CronTaskGraphContextItem[];
}): Promise<RunCronAgentTurnResult> {
  params.job.state ??= {};
  const abortSignal = params.abortSignal ?? params.signal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => {
    const reason = abortSignal?.reason;
    return typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "cron: job execution timed out";
  };
  const isFastTestEnv = process.env.FASED_TEST_FAST === "1";
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const requestedAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? params.agentId
      : typeof params.job.agentId === "string" && params.job.agentId.trim()
        ? params.job.agentId
        : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(params.cfg, normalizedRequested)
    : undefined;
  const { model: legacyOverrideModel, ...agentOverrideRest } = agentConfigOverride ?? {};
  // Use the requested agentId even when there is no explicit agent config entry.
  // This ensures auth-profiles, workspace, and agentDir all resolve to the
  // correct per-agent paths (e.g. ~/.fased/agents/<agentId>/agent/).
  const agentId = normalizedRequested ?? defaultAgentId;
  const overrideModel = normalizedRequested
    ? (resolveAgentEffectiveModelPrimary(params.cfg, normalizedRequested) ?? legacyOverrideModel)
    : legacyOverrideModel;
  const agentCfg: AgentDefaultsConfig = Object.assign(
    {},
    params.cfg.agents?.defaults,
    agentOverrideRest as Partial<AgentDefaultsConfig>,
  );
  // Merge agent model override with defaults instead of replacing, so that
  // `fallbacks` from `agents.defaults.model` are preserved when the agent
  // (or its per-cron model pin) only specifies `primary`.
  const existingModel = agentCfg.model && typeof agentCfg.model === "object" ? agentCfg.model : {};
  if (typeof overrideModel === "string") {
    agentCfg.model = { ...existingModel, primary: overrideModel };
  } else if (overrideModel) {
    agentCfg.model = { ...existingModel, ...overrideModel };
  }
  const cfgWithAgentDefaults: FasedAgentConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };

  const baseSessionKey = (params.sessionKey?.trim() || `cron:${params.job.id}`).trim();
  const agentSessionKey = resolveCronAgentSessionKey({ sessionKey: baseSessionKey, agentId });

  const workspaceDirRaw = resolveAgentWorkspaceDir(params.cfg, agentId);
  const agentDir = resolveAgentDir(params.cfg, agentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const workspaceDir = workspace.dir;

  const resolvedDefault = resolveConfiguredModelRef({
    cfg: cfgWithAgentDefaults,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;
  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: cfgWithAgentDefaults });
    }
    return catalog;
  };
  const effectiveExecutionModeForPolicy = resolveTaskExecutionMode(params.job);
  const sourceVerification = resolveSourceVerificationSignal(params.graphContext);
  const sourceQuality = resolveSourceQualityTelemetry(params.graphContext);
  const coordinationTelemetry = resolveCoordinationTelemetry(params.graphContext);
  // Resolve model - prefer hooks.gmail.model for Gmail hooks.
  const isGmailHook = baseSessionKey.startsWith("hook:gmail:");
  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalog(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
      hooksGmailModelApplied = true;
    }
  }
  const modelOverrideResult = resolveTaskModelOverride(params.job);
  let modelSource = hooksGmailModelApplied ? "Gmail hook model" : "Agent default model";
  const requestedTaskRole = params.job.executionPolicy?.modelPolicy?.role;
  const requestedRoleSelection = requestedTaskRole
    ? resolveTaskModelRole({ cfg: params.cfg, agentId, role: requestedTaskRole })
    : undefined;
  const escalationSelection =
    resolveTaskModelRole({ cfg: params.cfg, agentId, role: "escalation" }) ??
    resolveTaskModelRole({ cfg: params.cfg, agentId, role: "strong" });
  const taskEscalationModel = params.job.executionPolicy?.modelPolicy?.escalationModel?.trim();
  const pendingEscalationModel = params.job.state.pendingEscalation
    ? taskEscalationModel || escalationSelection?.model
    : undefined;
  const sourceConflictEscalationModel =
    effectiveExecutionModeForPolicy === "agent-turn" &&
    sourceVerification?.status === "conflict_suspected"
      ? taskEscalationModel || escalationSelection?.model
      : undefined;
  const modelOverride =
    pendingEscalationModel ||
    sourceConflictEscalationModel ||
    modelOverrideResult.model?.trim() ||
    requestedRoleSelection?.model;
  const modelOverrideSource =
    pendingEscalationModel || sourceConflictEscalationModel || requestedRoleSelection
      ? "policy"
      : modelOverrideResult.source;
  const modelOverrideSourceLabel =
    pendingEscalationModel || sourceConflictEscalationModel
      ? taskEscalationModel
        ? "Task escalation model"
        : escalationSelection
          ? formatTaskModelSelectionSource(escalationSelection)
          : "Escalation model"
      : modelOverrideResult.source === "policy"
        ? "Task model override"
        : modelOverrideResult.source === "payload"
          ? "Task payload model"
          : requestedRoleSelection
            ? formatTaskModelSelectionSource(requestedRoleSelection)
            : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = resolveAllowedModelRef({
      cfg: cfgWithAgentDefaults,
      catalog: await loadCatalog(),
      raw: modelOverride,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      if (modelOverrideSource === "policy") {
        return {
          status: "error",
          error: resolvedOverride.error,
          policy: resolveTaskPolicyTelemetry(
            params.job,
            effectiveExecutionModeForPolicy,
            sourceVerification,
            sourceQuality,
            coordinationTelemetry,
          ),
        };
      }
      if (resolvedOverride.error.startsWith("model not allowed:")) {
        logWarn(
          `cron: payload.model '${modelOverride}' not allowed, falling back to agent defaults`,
        );
      } else {
        return {
          status: "error",
          error: resolvedOverride.error,
          policy: resolveTaskPolicyTelemetry(
            params.job,
            effectiveExecutionModeForPolicy,
            sourceVerification,
            sourceQuality,
            coordinationTelemetry,
          ),
        };
      }
    } else {
      provider = resolvedOverride.ref.provider;
      model = resolvedOverride.ref.model;
      modelSource = modelOverrideSourceLabel ?? modelSource;
    }
  }
  if (!modelOverride && !hooksGmailModelApplied) {
    const shouldUseStrongPlanner =
      Boolean(params.job.state.pendingEscalation) ||
      sourceVerification?.status === "conflict_suspected";
    const plannerStrategy = shouldUseStrongPlanner
      ? "strong-model"
      : params.job.executionPolicy?.planner?.strategy;
    const role = plannerStrategyModelRole(plannerStrategy);
    const taskModelSelection = role
      ? resolveTaskModelRole({ cfg: params.cfg, agentId, role })
      : undefined;
    if (taskModelSelection) {
      const resolvedPlannerModel = resolveAllowedModelRef({
        cfg: cfgWithAgentDefaults,
        catalog: await loadCatalog(),
        raw: taskModelSelection.model,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      if ("error" in resolvedPlannerModel) {
        return {
          status: "error",
          error: resolvedPlannerModel.error,
          policy: withModelSourceTelemetry(
            resolveTaskPolicyTelemetry(
              params.job,
              effectiveExecutionModeForPolicy,
              sourceVerification,
              sourceQuality,
              coordinationTelemetry,
            ),
            formatTaskModelSelectionSource(taskModelSelection),
          ),
        };
      } else {
        provider = resolvedPlannerModel.ref.provider;
        model = resolvedPlannerModel.ref.model;
        modelSource = formatTaskModelSelectionSource(taskModelSelection);
      }
    }
  }
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: agentSessionKey,
    agentId,
    nowMs: now,
    // Isolated cron runs must not carry prior turn context across executions.
    forceNew: params.job.sessionTarget === "isolated",
  });
  const runSessionId = cronSession.sessionEntry.sessionId;
  const runSessionKey = baseSessionKey.startsWith("cron:")
    ? `${agentSessionKey}:run:${runSessionId}`
    : agentSessionKey;
  const persistSessionEntry = async () => {
    if (isFastTestEnv) {
      return;
    }
    cronSession.store[agentSessionKey] = cronSession.sessionEntry;
    if (runSessionKey !== agentSessionKey) {
      cronSession.store[runSessionKey] = cronSession.sessionEntry;
    }
    await updateSessionStore(cronSession.storePath, (store) => {
      store[agentSessionKey] = cronSession.sessionEntry;
      if (runSessionKey !== agentSessionKey) {
        store[runSessionKey] = cronSession.sessionEntry;
      }
    });
  };
  const withRunSession = (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: runSessionKey,
  });
  if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
    const labelSuffix =
      typeof params.job.name === "string" && params.job.name.trim()
        ? params.job.name.trim()
        : params.job.id;
    cronSession.sessionEntry.label = `Cron: ${labelSuffix}`;
  }

  // Respect session model override — check session.modelOverride before falling
  // back to the default config model. This ensures /model changes are honoured
  // by cron and isolated agent runs.
  if (!modelOverride && !hooksGmailModelApplied) {
    const sessionModelOverride = cronSession.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      const sessionProviderOverride =
        cronSession.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = resolveAllowedModelRef({
        cfg: cfgWithAgentDefaults,
        catalog: await loadCatalog(),
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
        defaultProvider: resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
      });
      if (!("error" in resolvedSessionOverride)) {
        provider = resolvedSessionOverride.ref.provider;
        model = resolvedSessionOverride.ref.model;
      }
    }
  }

  // Resolve thinking level - job thinking > hooks.gmail.thinking > agent default
  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking)
    : undefined;
  const thinkOverride = normalizeThinkLevel(agentCfg?.thinkingDefault);
  const jobThink = normalizeThinkLevel(
    params.job.executionPolicy?.modelPolicy?.thinking ??
      (params.job.payload.kind === "agentTurn" ? params.job.payload.thinking : undefined) ??
      undefined,
  );
  let thinkLevel = jobThink ?? hooksGmailThinking ?? thinkOverride;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      catalog: await loadCatalog(),
    });
  }
  if (thinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    logWarn(
      `[cron:${params.job.id}] Thinking level "xhigh" is not supported for ${provider}/${model}; downgrading to "high".`,
    );
    thinkLevel = "high";
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      params.job.payload.kind === "agentTurn" ? params.job.payload.timeoutSeconds : undefined,
  });

  const agentPayload = params.job.payload.kind === "agentTurn" ? params.job.payload : null;
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const deliveryRequested = deliveryPlan.requested;

  const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    sessionKey: params.job.sessionKey,
    accountId: deliveryPlan.accountId,
  });

  const { formattedTime, timeLine } = resolveCronStyleNow(params.cfg, now);
  const base = `[cron:${params.job.id} ${params.job.name}] ${params.message}`.trim();
  const executionMode = effectiveExecutionModeForPolicy;
  const policyTelemetry = resolveTaskPolicyTelemetry(
    params.job,
    executionMode,
    sourceVerification,
    sourceQuality,
    coordinationTelemetry,
  );
  const policyTelemetryWithModel = withModelSourceTelemetry(policyTelemetry, modelSource);
  if (executionMode !== "no-model") {
    const budgetError = resolveZeroBudgetError(params.job);
    if (budgetError) {
      return withRunSession({
        status: "error",
        error: budgetError,
        policy: policyTelemetryWithModel,
      });
    }
  }
  if (executionMode === "no-model") {
    const directTextPolicyTelemetry = withResultSourceTelemetry(policyTelemetryWithModel, {
      resultSource: "direct-text",
      resultAdapter: "no-model",
      modelUsed: false,
    });
    cronSession.sessionEntry.systemSent = true;
    await persistSessionEntry();
    const runStartedAt = Date.now();
    const runEndedAt = runStartedAt;
    const outputText = params.message.trim() || params.job.name.trim() || `cron:${params.job.id}`;
    const summary = pickSummaryFromOutput(outputText) ?? outputText;
    const deliveryPayloads = outputText ? [{ text: outputText }] : [];
    if (params.deferDelivery) {
      return withRunSession({
        status: "ok",
        summary,
        outputText,
        delivered: false,
        deliveryAttempted: false,
        policy: directTextPolicyTelemetry,
      });
    }
    const deliveryResult = await dispatchCronDelivery({
      cfg: params.cfg,
      cfgWithAgentDefaults,
      deps: params.deps,
      job: params.job,
      agentId,
      agentSessionKey,
      runSessionId,
      runStartedAt,
      runEndedAt,
      timeoutMs,
      resolvedDelivery,
      deliveryRequested,
      skipHeartbeatDelivery: false,
      skipMessagingToolDelivery: false,
      deliveryBestEffort: resolveCronDeliveryBestEffort(params.job),
      deliveryPayloadHasStructuredContent: false,
      bypassAnnounceDelivery: true,
      deliveryPayloads,
      synthesizedText: outputText,
      summary,
      outputText,
      abortSignal,
      isAborted,
      abortReason,
      withRunSession,
    });
    if (deliveryResult.result) {
      return {
        ...deliveryResult.result,
        deliveryAttempted:
          deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
        policy: deliveryResult.result.policy ?? directTextPolicyTelemetry,
      };
    }
    return withRunSession({
      status: "ok",
      summary: deliveryResult.summary ?? summary,
      outputText: deliveryResult.outputText ?? outputText,
      delivered: deliveryResult.delivered,
      deliveryAttempted: deliveryResult.deliveryAttempted,
      policy: directTextPolicyTelemetry,
    });
  }

  // SECURITY: Wrap external hook content with security boundaries to prevent prompt injection
  // unless explicitly allowed via a dangerous config override.
  const isExternalHook = isExternalHookSession(baseSessionKey);
  const allowUnsafeExternalContent =
    agentPayload?.allowUnsafeExternalContent === true ||
    (isGmailHook && params.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
  let commandBody: string;

  if (isExternalHook) {
    // Log suspicious patterns for security monitoring
    const suspiciousPatterns = detectSuspiciousPatterns(params.message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }

  let cheapCheckTaskInput = params.message;
  if (shouldWrapExternal) {
    // Wrap external content with security boundaries
    const hookType = getHookType(baseSessionKey);
    const safeContent = buildSafeExternalPrompt({
      content: params.message,
      source: hookType,
      jobName: params.job.name,
      jobId: params.job.id,
      timestamp: formattedTime,
    });

    cheapCheckTaskInput = safeContent;
    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    // Internal/trusted source - use original format
    commandBody = `${base}\n${timeLine}`.trim();
  }
  const memoryPolicyLine = resolveMemoryPolicyLine(params.job);
  const graphContext = formatGraphContextForPrompt(params.graphContext);
  const sourceConflictInstruction = buildSourceConflictReviewInstruction(sourceVerification);
  const pendingEscalation = params.job.state.pendingEscalation;
  const cheapCheckInstruction = pendingEscalation
    ? undefined
    : buildCheapCheckInstruction(params.job);
  if (cheapCheckInstruction && !sourceConflictInstruction) {
    commandBody = buildCompactCheapCheckPrompt({
      job: params.job,
      message: cheapCheckTaskInput,
      timeLine,
      deliveryRequested,
      memoryPolicyLine,
      graphContext,
      cheapCheckInstruction,
    });
  } else if (pendingEscalation && !sourceConflictInstruction) {
    commandBody = buildCompactEscalationPrompt({
      job: params.job,
      message: cheapCheckTaskInput,
      timeLine,
      deliveryRequested,
      memoryPolicyLine,
      graphContext,
      pendingEscalation,
    });
  } else {
    if (deliveryRequested) {
      commandBody =
        `${commandBody}\n\nReturn your summary as plain text; it will be delivered automatically. If the task explicitly calls for messaging a specific external recipient, note who/where it should go instead of sending it yourself.`.trim();
    }
    if (memoryPolicyLine) {
      commandBody = `${commandBody}\n\nTask memory policy: ${memoryPolicyLine}`.trim();
    }
    if (graphContext) {
      commandBody =
        `${commandBody}\n\nTask graph context gathered before model analysis:\n${graphContext}`.trim();
    }
    if (sourceConflictInstruction) {
      commandBody = `${commandBody}\n\n${sourceConflictInstruction}`.trim();
    }
    if (pendingEscalation) {
      commandBody = `${commandBody}\n\n${buildEscalationInstruction(pendingEscalation)}`.trim();
    } else if (cheapCheckInstruction) {
      commandBody = `${commandBody}\n\n${cheapCheckInstruction}`.trim();
    }
  }

  const existingSkillsSnapshot = cronSession.sessionEntry.skillsSnapshot;
  const skillFilterOverride = resolveTaskSkillFilterOverride(params.job);
  const memoryIsolation = resolveTaskMemoryIsolation(params.job);
  const skillsSnapshot = resolveCronSkillsSnapshot({
    workspaceDir,
    config: cfgWithAgentDefaults,
    agentId,
    existingSnapshot: existingSkillsSnapshot,
    skillFilterOverride,
    isFastTestEnv,
  });
  const policyTelemetryWithSkills = withLoadedSkillsTelemetry(
    policyTelemetryWithModel,
    skillsSnapshot,
  );
  if (!isFastTestEnv && skillsSnapshot !== existingSkillsSnapshot) {
    cronSession.sessionEntry = {
      ...cronSession.sessionEntry,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    await persistSessionEntry();
  }

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  cronSession.sessionEntry.systemSent = true;
  await persistSessionEntry();

  if (executionMode === "skill-only") {
    const runStartedAt = Date.now();
    let runEndedAt = runStartedAt;
    try {
      const tools = createFasedAgentCodingTools({
        agentId,
        sessionKey: agentSessionKey,
        agentDir,
        workspaceDir,
        config: cfgWithAgentDefaults,
        messageProvider: resolvedDelivery.channel,
        agentAccountId: resolvedDelivery.accountId,
        modelProvider: provider,
        modelId: model,
        modelContextWindowTokens:
          agentCfg?.contextTokens ?? lookupContextTokens(model) ?? DEFAULT_CONTEXT_TOKENS,
        requireExplicitMessageTarget: true,
        disableMessageTool: deliveryRequested,
        disabledToolNames: memoryIsolation.disabledToolNames,
        senderIsOwner: true,
        abortSignal,
      });
      const skillResult = await runDeterministicSkillAction({
        job: params.job,
        tools,
        abortSignal,
      });
      runEndedAt = Date.now();
      const adaptedResult = adaptDeterministicSkillResult({
        job: params.job,
        toolName: skillResult.toolName,
        rawResult: skillResult.rawResult,
        outputText: skillResult.outputText,
      });
      const directToolPolicyTelemetry = withResultSourceTelemetry(policyTelemetryWithSkills, {
        resultSource: "direct-tool",
        resultAdapter: adaptedResult?.adapterId ?? `${skillResult.toolName}:raw`,
        modelUsed: false,
      });
      const outputText = adaptedResult?.outputText ?? skillResult.outputText;
      const summary = pickSummaryFromOutput(outputText) ?? outputText;
      const deliveryPayloads = outputText ? [{ text: outputText }] : [];
      if (params.deferDelivery) {
        return withRunSession({
          status: "ok",
          summary,
          outputText,
          delivered: false,
          deliveryAttempted: false,
          policy: directToolPolicyTelemetry,
        });
      }
      const deliveryResult = await dispatchCronDelivery({
        cfg: params.cfg,
        cfgWithAgentDefaults,
        deps: params.deps,
        job: params.job,
        agentId,
        agentSessionKey,
        runSessionId,
        runStartedAt,
        runEndedAt,
        timeoutMs,
        resolvedDelivery,
        deliveryRequested,
        skipHeartbeatDelivery: false,
        skipMessagingToolDelivery: false,
        deliveryBestEffort: resolveCronDeliveryBestEffort(params.job),
        deliveryPayloadHasStructuredContent: false,
        bypassAnnounceDelivery: adaptedResult?.directDelivery === true,
        deliveryPayloads,
        synthesizedText: outputText,
        summary,
        outputText,
        abortSignal,
        isAborted,
        abortReason,
        withRunSession,
      });
      if (deliveryResult.result) {
        return {
          ...deliveryResult.result,
          deliveryAttempted:
            deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
          policy: deliveryResult.result.policy ?? directToolPolicyTelemetry,
        };
      }
      return withRunSession({
        status: "ok",
        summary: deliveryResult.summary ?? summary,
        outputText: deliveryResult.outputText ?? outputText,
        delivered: deliveryResult.delivered,
        deliveryAttempted: deliveryResult.deliveryAttempted,
        policy: directToolPolicyTelemetry,
      });
    } catch (err) {
      runEndedAt = Date.now();
      return withRunSession({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        policy: policyTelemetryWithSkills,
      });
    }
  }

  // Resolve auth profile for the session, mirroring the inbound auto-reply path
  // (get-reply-run.ts). Without this, isolated cron sessions fall back to env-var
  // auth which may not match the configured auth-profiles, causing 401 errors.
  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg: cfgWithAgentDefaults,
    provider,
    agentDir,
    sessionEntry: cronSession.sessionEntry,
    sessionStore: cronSession.store,
    sessionKey: agentSessionKey,
    storePath: cronSession.storePath,
    isNewSession: cronSession.isNewSession && params.job.sessionTarget !== "isolated",
  });
  const authProfileIdSource = cronSession.sessionEntry.authProfileOverrideSource;

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = provider;
  let fallbackModel = model;
  const runStartedAt = Date.now();
  let runEndedAt = runStartedAt;
  try {
    const sessionFile = resolveSessionTranscriptPath(cronSession.sessionEntry.sessionId, agentId);
    const resolvedVerboseLevel =
      normalizeVerboseLevel(cronSession.sessionEntry.verboseLevel) ??
      normalizeVerboseLevel(agentCfg?.verboseDefault) ??
      "off";
    registerAgentRunContext(cronSession.sessionEntry.sessionId, {
      sessionKey: agentSessionKey,
      verboseLevel: resolvedVerboseLevel,
    });
    const messageChannel = resolvedDelivery.channel;
    const agentFallbacks = resolveAgentModelFallbacksOverride(params.cfg, agentId);
    const fallbacksOverride = resolveTaskFallbacks({ job: params.job, agentFallbacks });
    const fallbackResult = await runWithModelFallback({
      cfg: cfgWithAgentDefaults,
      provider,
      model,
      agentDir,
      fallbacksOverride,
      run: (providerOverride, modelOverride) => {
        if (abortSignal?.aborted) {
          throw new Error(abortReason());
        }
        if (isCliProvider(providerOverride, cfgWithAgentDefaults)) {
          const cliSessionId = getCliSessionId(cronSession.sessionEntry, providerOverride);
          return runCliAgent({
            sessionId: cronSession.sessionEntry.sessionId,
            sessionKey: agentSessionKey,
            agentId,
            sessionFile,
            workspaceDir,
            config: cfgWithAgentDefaults,
            prompt: commandBody,
            provider: providerOverride,
            model: modelOverride,
            thinkLevel,
            timeoutMs,
            runId: cronSession.sessionEntry.sessionId,
            cliSessionId,
          });
        }
        return runEmbeddedPiAgent({
          sessionId: cronSession.sessionEntry.sessionId,
          sessionKey: agentSessionKey,
          agentId,
          messageChannel,
          agentAccountId: resolvedDelivery.accountId,
          sessionFile,
          agentDir,
          workspaceDir,
          config: cfgWithAgentDefaults,
          skillsSnapshot,
          prompt: commandBody,
          lane: params.lane ?? "cron",
          provider: providerOverride,
          model: modelOverride,
          authProfileId,
          authProfileIdSource,
          thinkLevel,
          verboseLevel: resolvedVerboseLevel,
          timeoutMs,
          runId: cronSession.sessionEntry.sessionId,
          requireExplicitMessageTarget: true,
          disableMessageTool: deliveryRequested,
          disableTools: params.job.executionPolicy?.skillScope === "none",
          disabledToolNames: memoryIsolation.disabledToolNames,
          omitPriorMessages: memoryIsolation.omitPriorMessages,
          senderIsOwner: true,
          abortSignal,
        });
      },
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
    runEndedAt = Date.now();
  } catch (err) {
    return withRunSession({
      status: "error",
      error: String(err),
      policy: policyTelemetryWithSkills,
    });
  }

  if (isAborted()) {
    return withRunSession({
      status: "error",
      error: abortReason(),
      policy: policyTelemetryWithSkills,
    });
  }

  const payloads = runResult.payloads ?? [];
  const modelPolicyTelemetry = withResultSourceTelemetry(policyTelemetryWithSkills, {
    resultSource: "model",
    modelUsed: true,
  });

  // Update token+model fields in the session store.
  // Also collect best-effort telemetry for the cron run log.
  let telemetry: CronRunTelemetry | undefined;
  {
    const usage = runResult.meta?.agentMeta?.usage;
    const promptTokens = runResult.meta?.agentMeta?.promptTokens;
    const modelUsed = runResult.meta?.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed = runResult.meta?.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ?? lookupContextTokens(modelUsed) ?? DEFAULT_CONTEXT_TOKENS;

    setSessionRuntimeModel(cronSession.sessionEntry, {
      provider: providerUsed,
      model: modelUsed,
    });
    cronSession.sessionEntry.contextTokens = contextTokens;
    if (isCliProvider(providerUsed, cfgWithAgentDefaults)) {
      const cliSessionId = runResult.meta?.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(cronSession.sessionEntry, providerUsed, cliSessionId);
      }
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const totalTokens =
        deriveSessionTotalTokens({
          usage,
          contextTokens,
          promptTokens,
        }) ?? input;
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      cronSession.sessionEntry.totalTokens = totalTokens;
      cronSession.sessionEntry.totalTokensFresh = true;
      cronSession.sessionEntry.cacheRead = usage.cacheRead ?? 0;
      cronSession.sessionEntry.cacheWrite = usage.cacheWrite ?? 0;

      telemetry = {
        model: modelUsed,
        provider: providerUsed,
        policy: modelPolicyTelemetry,
        usage: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: totalTokens,
        },
      };
    } else {
      telemetry = {
        model: modelUsed,
        provider: providerUsed,
        policy: modelPolicyTelemetry,
      };
    }
    await persistSessionEntry();
  }

  if (isAborted()) {
    return withRunSession({ status: "error", error: abortReason(), ...telemetry });
  }
  const firstText = payloads[0]?.text ?? "";
  let summary = pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);
  let outputText = pickLastNonEmptyTextFromPayloads(payloads);
  let synthesizedText = outputText?.trim() || summary?.trim() || undefined;
  const deliveryPayload = pickLastDeliverablePayload(payloads);
  let deliveryPayloads =
    deliveryPayload !== undefined
      ? [deliveryPayload]
      : synthesizedText
        ? [{ text: synthesizedText }]
        : [];
  const deliveryPayloadHasStructuredContent =
    Boolean(deliveryPayload?.mediaUrl) ||
    (deliveryPayload?.mediaUrls?.length ?? 0) > 0 ||
    Object.keys(deliveryPayload?.channelData ?? {}).length > 0;
  const deliveryBestEffort = resolveCronDeliveryBestEffort(params.job);
  const hasErrorPayload = payloads.some((payload) => payload?.isError === true);
  const lastErrorPayloadText = [...payloads]
    .toReversed()
    .find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))
    ?.text?.trim();
  const embeddedRunError = hasErrorPayload
    ? (lastErrorPayloadText ?? "cron isolated run returned an error payload")
    : undefined;
  const budgetError =
    resolveTokenBudgetError({ job: params.job, telemetry }) ??
    resolveCostBudgetError({ cfg: cfgWithAgentDefaults, job: params.job, telemetry });
  if (budgetError) {
    return withRunSession({
      status: "error",
      error: budgetError,
      summary,
      outputText,
      ...telemetry,
    });
  }
  const resolveRunOutcome = (params?: { delivered?: boolean; deliveryAttempted?: boolean }) =>
    withRunSession({
      status: hasErrorPayload ? "error" : "ok",
      ...(hasErrorPayload
        ? { error: embeddedRunError ?? "cron isolated run returned an error payload" }
        : {}),
      summary,
      outputText,
      delivered: params?.delivered,
      deliveryAttempted: params?.deliveryAttempted,
      ...telemetry,
    });

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  const ackMaxChars = resolveHeartbeatAckMaxChars(agentCfg);
  const skipHeartbeatDelivery = deliveryRequested && isHeartbeatOnlyResponse(payloads, ackMaxChars);
  const skipMessagingToolDelivery =
    deliveryRequested &&
    runResult.didSendViaMessagingTool === true &&
    (runResult.messagingToolSentTargets ?? []).some((target) =>
      matchesMessagingToolDeliveryTarget(target, {
        channel: resolvedDelivery.channel,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
      }),
    );

  if (params.deferDelivery) {
    return resolveRunOutcome({
      delivered: skipMessagingToolDelivery,
      deliveryAttempted: skipMessagingToolDelivery,
    });
  }

  const deliveryResult = await dispatchCronDelivery({
    cfg: params.cfg,
    cfgWithAgentDefaults,
    deps: params.deps,
    job: params.job,
    agentId,
    agentSessionKey,
    runSessionId,
    runStartedAt,
    runEndedAt,
    timeoutMs,
    resolvedDelivery,
    deliveryRequested,
    skipHeartbeatDelivery,
    skipMessagingToolDelivery,
    deliveryBestEffort,
    deliveryPayloadHasStructuredContent,
    deliveryPayloads,
    synthesizedText,
    summary,
    outputText,
    telemetry,
    abortSignal,
    isAborted,
    abortReason,
    withRunSession,
  });
  if (deliveryResult.result) {
    const resultWithDeliveryMeta: RunCronAgentTurnResult = {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
      policy: deliveryResult.result.policy ?? telemetry?.policy,
    };
    if (!hasErrorPayload || deliveryResult.result.status !== "ok") {
      return resultWithDeliveryMeta;
    }
    return resolveRunOutcome({
      delivered: deliveryResult.result.delivered,
      deliveryAttempted: resultWithDeliveryMeta.deliveryAttempted,
    });
  }
  const delivered = deliveryResult.delivered;
  const deliveryAttempted = deliveryResult.deliveryAttempted;
  summary = deliveryResult.summary;
  outputText = deliveryResult.outputText;

  return resolveRunOutcome({ delivered, deliveryAttempted });
}

export async function deliverCronIsolatedAgentTurnResult(params: {
  cfg: FasedAgentConfig;
  deps: CliDeps;
  job: CronJob;
  runId: string;
  result: CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
    };
  abortSignal?: AbortSignal;
  agentId?: string;
}): Promise<
  {
    delivered?: boolean;
    deliveryAttempted?: boolean;
  } & CronRunOutcome &
    CronRunTelemetry
> {
  const abortSignal = params.abortSignal;
  const isAborted = () => abortSignal?.aborted === true;
  const abortReason = () => {
    const reason = abortSignal?.reason;
    return typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "cron: delivery step timed out";
  };
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const requestedAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? params.agentId
      : typeof params.job.agentId === "string" && params.job.agentId.trim()
        ? params.job.agentId
        : undefined;
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const agentConfigOverride = normalizedRequested
    ? resolveAgentConfig(params.cfg, normalizedRequested)
    : undefined;
  const { model: legacyOverrideModel, ...agentOverrideRest } = agentConfigOverride ?? {};
  const agentId = normalizedRequested ?? defaultAgentId;
  const overrideModel = normalizedRequested
    ? (resolveAgentEffectiveModelPrimary(params.cfg, normalizedRequested) ?? legacyOverrideModel)
    : legacyOverrideModel;
  const agentCfg: AgentDefaultsConfig = Object.assign(
    {},
    params.cfg.agents?.defaults,
    agentOverrideRest as Partial<AgentDefaultsConfig>,
  );
  const existingModel = agentCfg.model && typeof agentCfg.model === "object" ? agentCfg.model : {};
  if (typeof overrideModel === "string") {
    agentCfg.model = { ...existingModel, primary: overrideModel };
  } else if (overrideModel) {
    agentCfg.model = { ...existingModel, ...overrideModel };
  }
  const cfgWithAgentDefaults: FasedAgentConfig = {
    ...params.cfg,
    agents: Object.assign({}, params.cfg.agents, { defaults: agentCfg }),
  };

  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const deliveryRequested = deliveryPlan.requested;
  const resultSessionKey = params.result.sessionKey?.trim();
  const baseSessionKey =
    resultSessionKey ||
    (params.job.sessionKey?.trim() || `cron:${params.job.id}:${params.runId}`).trim();
  const agentSessionKey = resolveCronAgentSessionKey({ sessionKey: baseSessionKey, agentId });
  const runSessionId = params.result.sessionId?.trim() || params.runId;
  const timeoutMs = resolveAgentTimeoutMs({
    cfg: cfgWithAgentDefaults,
    overrideSeconds:
      params.job.payload.kind === "agentTurn" ? params.job.payload.timeoutSeconds : undefined,
  });
  const resolvedDelivery = await resolveDeliveryTarget(cfgWithAgentDefaults, agentId, {
    channel: deliveryPlan.channel ?? "last",
    to: deliveryPlan.to,
    sessionKey: params.job.sessionKey,
    accountId: deliveryPlan.accountId,
  });
  const outputText = params.result.outputText?.trim() || params.result.summary?.trim();
  const summary = params.result.summary?.trim() || pickSummaryFromOutput(outputText) || outputText;
  const deliveryPayloads = outputText ? [{ text: outputText }] : [];
  const withRunSession = (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: runSessionId,
    sessionKey: agentSessionKey,
  });

  if (!deliveryRequested) {
    return withRunSession({
      status: params.result.status,
      error: params.result.error,
      summary,
      outputText,
      delivered: false,
      deliveryAttempted: false,
      model: params.result.model,
      provider: params.result.provider,
      usage: params.result.usage,
      policy: params.result.policy,
    });
  }

  const deliveryResult = await dispatchCronDelivery({
    cfg: params.cfg,
    cfgWithAgentDefaults,
    deps: params.deps,
    job: params.job,
    agentId,
    agentSessionKey,
    runSessionId,
    runStartedAt: Date.now(),
    runEndedAt: Date.now(),
    timeoutMs,
    resolvedDelivery,
    deliveryRequested,
    skipHeartbeatDelivery: false,
    skipMessagingToolDelivery: false,
    deliveryBestEffort: resolveCronDeliveryBestEffort(params.job),
    deliveryPayloadHasStructuredContent: false,
    bypassAnnounceDelivery:
      params.result.policy?.resultSource === "direct-tool" ||
      params.result.policy?.resultSource === "direct-text",
    deliveryPayloads,
    synthesizedText: outputText,
    summary,
    outputText,
    telemetry: {
      model: params.result.model,
      provider: params.result.provider,
      usage: params.result.usage,
      policy: params.result.policy,
    },
    abortSignal,
    isAborted,
    abortReason,
    withRunSession,
  });
  if (deliveryResult.result) {
    return {
      ...deliveryResult.result,
      deliveryAttempted:
        deliveryResult.result.deliveryAttempted ?? deliveryResult.deliveryAttempted,
    };
  }
  return withRunSession({
    status: params.result.status,
    error: params.result.error,
    summary: deliveryResult.summary ?? summary,
    outputText: deliveryResult.outputText ?? outputText,
    delivered: deliveryResult.delivered,
    deliveryAttempted: deliveryResult.deliveryAttempted,
    model: params.result.model,
    provider: params.result.provider,
    usage: params.result.usage,
    policy: params.result.policy,
  });
}
