import { sourceRepairNodeIdForTool } from "./task-planner.js";
import type {
  CronJob,
  CronTaskGraphRepairPlan,
  CronRunPolicyTelemetry,
  CronRunStatus,
  CronTaskEvaluatorDecision,
  CronTaskPendingEscalation,
  CronTaskPendingCoordination,
  CronTaskRepairPolicy,
  CronTaskRepairStop,
  CronTaskRepairStopCode,
  CronTaskSourceRole,
} from "./types.js";

const HUMAN_ESCALATION_SIGNAL = "Needs deeper analysis: yes";
const HUMAN_NO_ESCALATION_SIGNAL = "Needs deeper analysis: no";

const DEFAULT_ESCALATION_SIGNALS = [
  HUMAN_ESCALATION_SIGNAL,
  "Escalation needed: yes",
  "Needs escalation: yes",
  "Follow-up needed: yes",
  "Deeper analysis needed: yes",
  "Escalate: yes",
  "FASED_ESCALATE:true",
  "FASED_ESCALATE: true",
  "ESCALATE:true",
  "ESCALATE: true",
  "escalate=true",
];
const MAX_GRAPH_REPAIRS_PER_DECISION = 4;
const MAX_GRAPH_REPAIRS_PER_TASK = 2;
const MAX_GRAPH_REPAIRS_PER_SOURCE = 1;
const MAX_GRAPH_REPAIRS_PER_SOURCE_ROLE = 2;

type TaskEvaluatorRepairResult = {
  graphRepair?: CronTaskGraphRepairPlan;
  graphRepairs?: CronTaskGraphRepairPlan[];
  decision: CronTaskEvaluatorDecision;
  clearPending?: boolean;
  pendingEscalation?: CronTaskPendingEscalation;
  pendingCoordination?: CronTaskPendingCoordination;
  disable?: { stopReason: string };
  refireSoon?: boolean;
  autoStopSourceNodeIds?: string[];
  state?: Partial<
    Pick<
      CronJob["state"],
      | "evaluatorConsecutiveNoSignalRuns"
      | "evaluatorLastSignal"
      | "evaluatorLastSignalAtMs"
      | "evaluatorSourceRetryRuns"
      | "evaluatorCoordinationRuns"
      | "lastGraphRepairStop"
    >
  >;
};

function repairPolicyForJob(job: CronJob): Required<CronTaskRepairPolicy> {
  const policy = job.executionPolicy?.repairPolicy;
  return {
    autoRetryReplacement: policy?.autoRetryReplacement !== false,
    autoStopOptionalSources: policy?.autoStopOptionalSources === true,
    maxAutoRepairsPerRun:
      typeof policy?.maxAutoRepairsPerRun === "number" &&
      Number.isFinite(policy.maxAutoRepairsPerRun)
        ? Math.max(1, Math.floor(policy.maxAutoRepairsPerRun))
        : 1,
    requireApprovalForPrimarySource: policy?.requireApprovalForPrimarySource !== false,
  };
}

function jobDomainText(job: CronJob): string {
  const payloadText = job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
  return [
    job.name,
    job.description,
    payloadText,
    job.executionPolicy?.objective,
    job.executionPolicy?.successCriteria,
    job.executionPolicy?.skillAction?.toolName,
    ...(job.executionPolicy?.allowedSkills ?? []),
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function sourceToolFromNodeId(
  nodeId: string | undefined,
): CronTaskGraphRepairPlan["toolName"] | undefined {
  if (!nodeId) {
    return undefined;
  }
  if (nodeId.includes("web-fetch")) {
    return "web_fetch";
  }
  if (nodeId.includes("gateway") || nodeId.includes("provider")) {
    return "gateway";
  }
  if (nodeId.includes("wallet")) {
    return "wallet";
  }
  if (nodeId.includes("mining")) {
    return "mining";
  }
  if (nodeId.includes("offers")) {
    return "offers";
  }
  if (nodeId.includes("web-search") || nodeId.includes("search")) {
    return "web_search";
  }
  return undefined;
}

function sourceRepairTool(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
}): CronTaskGraphRepairPlan["toolName"] {
  const text = jobDomainText(params.job);
  if (/https?:\/\/[^\s<>"')]+/i.test(text)) {
    return "web_fetch";
  }
  if (
    /\bproviders?\b|\bprovider health\b|\bmodel catalog\b|\bcatalog\b|\bmodel auth\b|\bauth profiles?\b|\bruntime auth\b|\bcredentials?\b|\bapi keys?\b|\bgateway\b/.test(
      text,
    )
  ) {
    return "gateway";
  }
  if (/\bwallets?\b|\bbalances?\b|\baddress\b|\bsigner\b|\btreasury\b/.test(text)) {
    return "wallet";
  }
  if (/\bmining\b|\bminers?\b|\bsat mining\b|\bhashrate\b|\bhash rate\b/.test(text)) {
    return "mining";
  }
  if (/\boffers?\b|\bmarketplace\b|\borders?\b|\brequests?\b|\bremote index\b/.test(text)) {
    return "offers";
  }
  if (
    /\bweb\b|\bsearch\b|\bsource\b|\bexternal\b|\blive\b|\bmarket\b|\brisk\b|\bnews\b|\bheadlines?\b|\bprices?\b|\bweather\b|\bbtc\b|\bsol\b/.test(
      text,
    )
  ) {
    return "web_search";
  }
  return sourceToolFromNodeId(params.policy?.sourceQuality?.bestSourceId) ?? "web_search";
}

function preferredLocalRepairTool(job: CronJob): CronTaskGraphRepairPlan["toolName"] | undefined {
  const text = jobDomainText(job);
  if (
    /\bproviders?\b|\bprovider health\b|\bmodel catalog\b|\bcatalog\b|\bmodel auth\b|\bauth profiles?\b|\bruntime auth\b|\bcredentials?\b|\bapi keys?\b|\bgateway\b/.test(
      text,
    )
  ) {
    return "gateway";
  }
  if (/\bwallets?\b|\bbalances?\b|\baddress\b|\bsigner\b|\btreasury\b/.test(text)) {
    return "wallet";
  }
  if (/\bmining\b|\bminers?\b|\bsat mining\b|\bhashrate\b|\bhash rate\b/.test(text)) {
    return "mining";
  }
  if (/\boffers?\b|\bmarketplace\b|\borders?\b|\brequests?\b|\bremote index\b/.test(text)) {
    return "offers";
  }
  return undefined;
}

function sourceRepairToolForSource(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  sourceNodeId: string;
}): CronTaskGraphRepairPlan["toolName"] {
  const sourceTool = sourceToolFromNodeId(params.sourceNodeId);
  const preferredLocalTool = preferredLocalRepairTool(params.job);
  if (sourceTool === "web_search" && preferredLocalTool) {
    return preferredLocalTool;
  }
  return sourceTool ?? sourceRepairTool({ job: params.job, policy: params.policy });
}

function validRepairSourceIds(values: string[] | undefined): string[] {
  const unique = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (
      !trimmed ||
      !trimmed.startsWith("source-fetch-") ||
      trimmed.startsWith("source-fetch-repair-")
    ) {
      continue;
    }
    unique.add(trimmed);
  }
  return [...unique];
}

type SourceQualityDetail = NonNullable<
  NonNullable<CronRunPolicyTelemetry["sourceQuality"]>["sources"]
>[number];

type SourceRepairIntent = {
  action: CronTaskGraphRepairPlan["action"];
  sourceNodeId: string;
  detail?: SourceQualityDetail;
};

function sourceQualityDetails(policy?: CronRunPolicyTelemetry): SourceQualityDetail[] {
  return policy?.sourceQuality?.sources ?? [];
}

function sourceQualityDetailById(
  policy: CronRunPolicyTelemetry | undefined,
  sourceNodeId: string,
): SourceQualityDetail | undefined {
  return sourceQualityDetails(policy).find((entry) => entry.id === sourceNodeId);
}

function sourceRoleForRepair(
  policy: CronRunPolicyTelemetry | undefined,
  repair: CronTaskGraphRepairPlan,
): CronTaskSourceRole | undefined {
  const sourceId = repair.replacesNodeId ?? repair.nodeId;
  return sourceQualityDetailById(policy, sourceId)?.role;
}

function repairSourceKey(repair: CronTaskGraphRepairPlan): string {
  return repair.replacesNodeId ?? repair.nodeId;
}

function badSourceIds(policy?: CronRunPolicyTelemetry): string[] {
  const quality = policy?.sourceQuality;
  const candidates = [
    ...validRepairSourceIds(quality?.unavailableSourceIds),
    ...validRepairSourceIds(quality?.lowQualitySourceIds),
    ...validRepairSourceIds(
      sourceQualityDetails(policy)
        .filter(
          (entry) =>
            entry.status !== "ok" ||
            (typeof entry.score === "number" && Number.isFinite(entry.score) && entry.score < 0.5),
        )
        .map((entry) => entry.id),
    ),
    ...(typeof quality?.bestScore === "number" && quality.bestScore < 0.5 && quality.bestSourceId
      ? validRepairSourceIds([quality.bestSourceId])
      : []),
  ];
  return [...new Set(candidates)];
}

function sourceRepairAction(
  detail: SourceQualityDetail | undefined,
): CronTaskGraphRepairPlan["action"] {
  if (!detail) {
    return "replace_source";
  }
  if (detail.optional === true || detail.role === "enrichment") {
    return "add_source";
  }
  return "replace_source";
}

function sourceRepairIntents(policy?: CronRunPolicyTelemetry): SourceRepairIntent[] {
  return badSourceIds(policy).map((sourceNodeId) => {
    const detail = sourceQualityDetailById(policy, sourceNodeId);
    return {
      action: sourceRepairAction(detail),
      sourceNodeId,
      detail,
    };
  });
}

function sourceRepairPlans(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  reason: string;
  nowMs: number;
}): CronTaskGraphRepairPlan[] {
  const intents = sourceRepairIntents(params.policy);
  if (intents.length > 0) {
    return intents.map((intent) => {
      const toolName =
        intent.action === "replace_source"
          ? sourceRepairToolForSource({
              job: params.job,
              policy: params.policy,
              sourceNodeId: intent.sourceNodeId,
            })
          : (preferredLocalRepairTool(params.job) ??
            sourceToolFromNodeId(intent.sourceNodeId) ??
            sourceRepairTool({
              job: params.job,
              policy: params.policy,
            }));
      const nodeId = sourceRepairNodeIdForTool(toolName, intent.sourceNodeId);
      const plan: CronTaskGraphRepairPlan = {
        action: intent.action,
        nodeId,
        toolName,
        reason: params.reason,
        createdAtMs: params.nowMs,
      };
      if (intent.action === "replace_source") {
        plan.replacesNodeId = intent.sourceNodeId;
      }
      return plan;
    });
  }

  const toolName = sourceRepairTool({ job: params.job, policy: params.policy });
  return [
    {
      action: "add_source",
      nodeId: sourceRepairNodeIdForTool(toolName),
      toolName,
      reason: params.reason,
      createdAtMs: params.nowMs,
    },
  ];
}

function requiredUnavailableSourceCount(policy?: CronRunPolicyTelemetry): number {
  return sourceQualityDetails(policy).filter((entry) => {
    if (entry.status === "ok") {
      return false;
    }
    if (entry.required === true || entry.optional === false) {
      return true;
    }
    return entry.role === "primary" || entry.role === "verification";
  }).length;
}

function optionalUnavailableSourceCount(policy?: CronRunPolicyTelemetry): number {
  return sourceQualityDetails(policy).filter((entry) => {
    if (entry.status === "ok") {
      return false;
    }
    return entry.optional === true || entry.role === "enrichment";
  }).length;
}

function optionalUnavailableSourceIds(policy?: CronRunPolicyTelemetry): string[] {
  return validRepairSourceIds(
    sourceQualityDetails(policy)
      .filter(
        (entry) =>
          entry.status !== "ok" && (entry.optional === true || entry.role === "enrichment"),
      )
      .map((entry) => entry.id),
  );
}

function hasSourceDetails(policy?: CronRunPolicyTelemetry): boolean {
  return sourceQualityDetails(policy).length > 0;
}

function sourceRepairFallbackPlan(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  reason: string;
  nowMs: number;
}): CronTaskGraphRepairPlan {
  const toolName = sourceRepairTool({ job: params.job, policy: params.policy });
  return {
    action: "add_source",
    nodeId: sourceRepairNodeIdForTool(toolName),
    toolName,
    reason: params.reason,
    createdAtMs: params.nowMs,
  };
}

function sourceRepairPlansForNoUsableSource(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  reason: string;
  nowMs: number;
}): CronTaskGraphRepairPlan[] {
  const intents = sourceRepairIntents(params.policy);
  if (intents.length > 0) {
    return intents.map((intent) => {
      const toolName = sourceRepairTool({
        job: params.job,
        policy: params.policy,
      });
      return {
        action: "add_source",
        nodeId: sourceRepairNodeIdForTool(toolName, intent.sourceNodeId),
        toolName,
        reason: params.reason,
        createdAtMs: params.nowMs,
      };
    });
  }
  return [sourceRepairFallbackPlan(params)];
}

function primaryRepair(repairs: CronTaskGraphRepairPlan[]): CronTaskGraphRepairPlan | undefined {
  return repairs[0];
}

function repairDecisionFields(repairs: CronTaskGraphRepairPlan[]): Pick<
  {
    graphRepair?: CronTaskGraphRepairPlan;
    graphRepairs?: CronTaskGraphRepairPlan[];
  },
  "graphRepair" | "graphRepairs"
> {
  return {
    graphRepair: primaryRepair(repairs),
    graphRepairs: repairs.length > 0 ? repairs : undefined,
  };
}

function repairSummary(repairs: CronTaskGraphRepairPlan[]): string {
  const replacements = repairs.filter((repair) => repair.action === "replace_source").length;
  const additions = repairs.length - replacements;
  return [
    replacements > 0
      ? `${replacements} source${replacements === 1 ? "" : "s"} will be replaced`
      : undefined,
    additions > 0 ? `${additions} source${additions === 1 ? "" : "s"} will be added` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

function sourceRepairDecision(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  reason: string;
  nowMs: number;
}): {
  graphRepair?: CronTaskGraphRepairPlan;
  graphRepairs?: CronTaskGraphRepairPlan[];
  summary: string;
} {
  const repairs = sourceRepairPlans(params);
  return {
    ...repairDecisionFields(repairs),
    summary: repairSummary(repairs) || "source graph will be repaired",
  };
}

function sourceRepairDecisionForNoUsableSource(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  reason: string;
  nowMs: number;
}): {
  graphRepair?: CronTaskGraphRepairPlan;
  graphRepairs?: CronTaskGraphRepairPlan[];
  summary: string;
} {
  const repairs = sourceRepairPlansForNoUsableSource(params);
  return {
    ...repairDecisionFields(repairs),
    summary: repairSummary(repairs) || "source graph will be repaired",
  };
}

export function buildCheapCheckInstruction(job: CronJob): string | undefined {
  const policy = job.executionPolicy;
  if (job.state.pendingEscalation || policy?.planner?.strategy !== "cheap-model") {
    return undefined;
  }
  if (policy.evaluator?.escalateOnSignal === false) {
    return undefined;
  }
  return [
    "Cheap check output rules:",
    `First line exactly \`${HUMAN_ESCALATION_SIGNAL}\` or \`${HUMAN_NO_ESCALATION_SIGNAL}\`.`,
    "Use yes only when this run needs a stronger follow-up.",
    "Keep the whole reply under 80 words.",
  ].join(" ");
}

export function buildEscalationInstruction(pending: CronTaskPendingEscalation): string {
  return [
    "Task evaluator escalation:",
    "The previous cheap check requested a stronger follow-up.",
    `Signal: ${pending.signal ?? "unspecified"}.`,
    `Reason: ${pending.reason}.`,
    "Run the deeper analysis now and return the final task result.",
  ].join(" ");
}

function normalize(value: string | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerMatchesLine(marker: string, line: string): boolean {
  const normalizedMarker = normalize(marker);
  if (!normalizedMarker) {
    return false;
  }
  const normalizedLine = normalize(
    line
      .replace(/^[\s>*\-•]+/, "")
      .replace(/^`+|`+$/g, "")
      .trim(),
  );
  if (!normalizedLine) {
    return false;
  }
  if (normalizedLine === normalizedMarker) {
    return true;
  }
  if (normalizedLine.startsWith(normalizedMarker)) {
    const next = normalizedLine.charAt(normalizedMarker.length);
    return !next || /[\s,.;:)\]}-]/.test(next);
  }
  const structured = /^(.+?)([:=])\s*true$/i.exec(normalizedMarker);
  if (structured?.[1] && structured[2]) {
    const flexible = new RegExp(
      `^${escapeRegExp(structured[1])}\\s*${structured[2]}\\s*true\\b`,
      "i",
    );
    return flexible.test(normalizedLine);
  }
  return false;
}

function findJsonSignal(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (record.FASED_ESCALATE === true || record.fased_escalate === true) {
      return HUMAN_ESCALATION_SIGNAL;
    }
    if (record.ESCALATE === true || record.escalate === true) {
      return HUMAN_ESCALATION_SIGNAL;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function findSignal(params: { markers?: string[]; summary?: string; outputText?: string }) {
  const text = [params.summary, params.outputText].filter(Boolean).join("\n").trim();
  if (!text) {
    return undefined;
  }
  const jsonSignal = findJsonSignal(text);
  if (jsonSignal) {
    return jsonSignal;
  }
  const markers = params.markers?.length ? params.markers : DEFAULT_ESCALATION_SIGNALS;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const marker = markers.find((entry) => markerMatchesLine(entry, line));
    if (marker) {
      return marker;
    }
  }
  return undefined;
}

function decision(params: Omit<CronTaskEvaluatorDecision, "source">): CronTaskEvaluatorDecision {
  return { source: "heuristic", ...params };
}

function nonNegativeInteger(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function evaluatorHistory(params: {
  job: CronJob;
  noSignalRuns?: number;
  maxEscalations?: number;
  lastSignal?: string;
  lastSignalAtMs?: number;
}): NonNullable<CronTaskEvaluatorDecision["history"]> {
  return {
    consecutiveNoSignalRuns:
      params.noSignalRuns ?? nonNegativeInteger(params.job.state.evaluatorConsecutiveNoSignalRuns),
    escalationRuns: nonNegativeInteger(params.job.state.evaluatorEscalationRuns),
    maxEscalations: params.maxEscalations,
    lastSignalAtMs: params.lastSignalAtMs ?? params.job.state.evaluatorLastSignalAtMs,
    lastSignal: params.lastSignal ?? params.job.state.evaluatorLastSignal,
    repairAttempts: nonNegativeInteger(params.job.state.graphRepairAttempts),
    maxRepairAttempts: MAX_GRAPH_REPAIRS_PER_TASK,
    coordinationRuns: nonNegativeInteger(params.job.state.evaluatorCoordinationRuns),
    maxCoordinationRuns:
      typeof params.job.executionPolicy?.coordination?.maxRounds === "number" &&
      Number.isFinite(params.job.executionPolicy.coordination.maxRounds)
        ? Math.max(1, Math.floor(params.job.executionPolicy.coordination.maxRounds))
        : undefined,
  };
}

function coordinationAgents(job: CronJob) {
  return Array.from(
    new Set((job.executionPolicy?.coordination?.agents ?? []).map((agent) => agent.trim())),
  ).filter(Boolean);
}

function maybeRequestAgentCoordination(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  nowMs: number;
  signal: string;
  reason: string;
}): TaskEvaluatorRepairResult | undefined {
  if ((params.policy?.coordination?.completed ?? 0) > 0) {
    return undefined;
  }
  const agents = coordinationAgents(params.job);
  if (agents.length === 0 || params.job.state.pendingCoordination) {
    return undefined;
  }
  const used = nonNegativeInteger(params.job.state.evaluatorCoordinationRuns);
  const max =
    typeof params.job.executionPolicy?.coordination?.maxRounds === "number" &&
    Number.isFinite(params.job.executionPolicy.coordination.maxRounds)
      ? Math.max(1, Math.floor(params.job.executionPolicy.coordination.maxRounds))
      : 1;
  if (used >= max) {
    return undefined;
  }
  return {
    decision: decision({
      action: "ask_agent",
      reason: params.reason,
      signal: params.signal,
      history: evaluatorHistory({ job: params.job }),
    }),
    pendingCoordination: {
      reason: params.reason,
      signal: params.signal,
      agents,
      mode: params.job.executionPolicy?.coordination?.mode ?? "consult",
      createdAtMs: params.nowMs,
      sourceRunAtMs: params.nowMs,
    },
  };
}

function repairStop(params: {
  code: CronTaskRepairStopCode;
  reason: string;
  nowMs: number;
  sourceNodeId?: string;
  sourceRole?: CronTaskSourceRole;
  limit?: number;
}): CronTaskRepairStop {
  return {
    code: params.code,
    reason: params.reason,
    atMs: params.nowMs,
    ...(params.sourceNodeId ? { sourceNodeId: params.sourceNodeId } : {}),
    ...(params.sourceRole ? { sourceRole: params.sourceRole } : {}),
    ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
  };
}

function repairStopResult(params: {
  job: CronJob;
  stop: CronTaskRepairStop;
  action?: CronTaskEvaluatorDecision["action"];
  stopReason?: string;
}): {
  decision: CronTaskEvaluatorDecision;
  disable: { stopReason: string };
  state: Partial<Pick<CronJob["state"], "lastGraphRepairStop">>;
} {
  return {
    decision: decision({
      action: params.action ?? "request_sources",
      reason: params.stop.reason,
      stopCode: params.stop.code,
      signal: params.stop.code,
      history: evaluatorHistory({ job: params.job }),
    }),
    disable: { stopReason: params.stopReason ?? `needsSources:${params.stop.code}` },
    state: { lastGraphRepairStop: params.stop },
  };
}

function repairSafetyStop(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  repairs: CronTaskGraphRepairPlan[];
  nowMs: number;
}): CronTaskRepairStop | undefined {
  if (params.repairs.length === 0) {
    return undefined;
  }
  const repairPolicy = repairPolicyForJob(params.job);
  const maxRepairsPerDecision = Math.min(
    MAX_GRAPH_REPAIRS_PER_DECISION,
    repairPolicy.maxAutoRepairsPerRun,
  );
  if (params.repairs.length > maxRepairsPerDecision) {
    return repairStop({
      code: "repair_limit_reached",
      reason: `Repair limit reached: ${params.repairs.length} source repairs were proposed in one run; maximum is ${maxRepairsPerDecision}.`,
      nowMs: params.nowMs,
      limit: maxRepairsPerDecision,
    });
  }
  if (!repairPolicy.autoRetryReplacement) {
    return repairStop({
      code: "needs_user_source",
      reason:
        "Automatic retry with replacement is disabled for this task. Review the source repair and retry manually.",
      nowMs: params.nowMs,
    });
  }
  const taskRepairAttempts = nonNegativeInteger(params.job.state.graphRepairAttempts);
  if (taskRepairAttempts >= MAX_GRAPH_REPAIRS_PER_TASK) {
    return repairStop({
      code: "repair_limit_reached",
      reason: `Repair limit reached: task already used ${taskRepairAttempts}/${MAX_GRAPH_REPAIRS_PER_TASK} graph repair attempts. Add a direct source, configure access, or change task policy.`,
      nowMs: params.nowMs,
      limit: MAX_GRAPH_REPAIRS_PER_TASK,
    });
  }
  for (const repair of params.repairs) {
    const sourceKey = repairSourceKey(repair);
    const role = sourceRoleForRepair(params.policy, repair);
    const primaryLike = role === "primary" || role === "verification";
    const deterministicReplacement = repair.toolName !== "web_search";
    if (
      repairPolicy.requireApprovalForPrimarySource &&
      repair.action === "replace_source" &&
      primaryLike &&
      !deterministicReplacement
    ) {
      return repairStop({
        code: "needs_user_source",
        reason: `Source ${sourceKey} is ${role}; replacing it with live search requires approval. Add a trusted source or retry manually.`,
        nowMs: params.nowMs,
        sourceNodeId: sourceKey,
        sourceRole: role,
      });
    }
    const sourceAttempts = nonNegativeInteger(
      params.job.state.graphRepairSourceAttempts?.[sourceKey],
    );
    if (repair.action === "replace_source" && sourceAttempts >= MAX_GRAPH_REPAIRS_PER_SOURCE) {
      return repairStop({
        code: "repair_limit_reached",
        reason: `Repair limit reached: source ${sourceKey} already failed after replacement. Add a direct source or configure access before retrying.`,
        nowMs: params.nowMs,
        sourceNodeId: sourceKey,
        sourceRole: sourceRoleForRepair(params.policy, repair),
        limit: MAX_GRAPH_REPAIRS_PER_SOURCE,
      });
    }
    if (role) {
      const roleAttempts = nonNegativeInteger(params.job.state.graphRepairRoleAttempts?.[role]);
      if (roleAttempts >= MAX_GRAPH_REPAIRS_PER_SOURCE_ROLE) {
        return repairStop({
          code: "repair_limit_reached",
          reason: `Repair limit reached: ${role} sources already used ${roleAttempts}/${MAX_GRAPH_REPAIRS_PER_SOURCE_ROLE} repair attempts.`,
          nowMs: params.nowMs,
          sourceNodeId: sourceKey,
          sourceRole: role,
          limit: MAX_GRAPH_REPAIRS_PER_SOURCE_ROLE,
        });
      }
    }
  }
  return undefined;
}

function sourceRepairDecisionResult(params: {
  job: CronJob;
  policy?: CronRunPolicyTelemetry;
  repair: {
    graphRepair?: CronTaskGraphRepairPlan;
    graphRepairs?: CronTaskGraphRepairPlan[];
    summary: string;
  };
  nowMs: number;
  reason: string;
  state?: Partial<Pick<CronJob["state"], "evaluatorSourceRetryRuns">>;
}):
  | {
      graphRepair?: CronTaskGraphRepairPlan;
      graphRepairs?: CronTaskGraphRepairPlan[];
      decision: CronTaskEvaluatorDecision;
      refireSoon: true;
      state?: Partial<Pick<CronJob["state"], "evaluatorSourceRetryRuns">>;
    }
  | {
      decision: CronTaskEvaluatorDecision;
      disable: { stopReason: string };
      state: Partial<Pick<CronJob["state"], "lastGraphRepairStop">>;
    } {
  const repairs =
    params.repair.graphRepairs ?? (params.repair.graphRepair ? [params.repair.graphRepair] : []);
  const stop = repairSafetyStop({
    job: params.job,
    policy: params.policy,
    repairs,
    nowMs: params.nowMs,
  });
  if (stop) {
    return repairStopResult({ job: params.job, stop, action: "request_sources" });
  }
  return {
    graphRepair: params.repair.graphRepair,
    graphRepairs: params.repair.graphRepairs,
    decision: decision({
      action: "retry_sources",
      reason: params.reason,
      history: evaluatorHistory({ job: params.job }),
    }),
    refireSoon: true,
    state: params.state,
  };
}

function sourceQualityDecision(params: {
  job: CronJob;
  result: {
    status: CronRunStatus;
    policy?: CronRunPolicyTelemetry;
  };
  nowMs: number;
}): TaskEvaluatorRepairResult | undefined {
  const { job, result } = params;
  const policy = result.policy;
  if (result.status !== "ok" || !policy) {
    return undefined;
  }

  if (policy.sourceVerificationStatus === "conflict_suspected") {
    if (!policy.escalatedBecause) {
      const coordinationRequest = maybeRequestAgentCoordination({
        job,
        policy,
        nowMs: params.nowMs,
        signal: "source_conflict",
        reason:
          "Source conflict detected; ask selected Agents for task-room evidence before stopping for source review.",
      });
      if (coordinationRequest) {
        return coordinationRequest;
      }
      const stop = repairStop({
        code: "conflicting_sources",
        reason:
          "Conflicting sources need user review before the task can continue. Add a trusted source or change task policy.",
        nowMs: params.nowMs,
      });
      return repairStopResult({
        job,
        stop,
        action: "request_sources",
        stopReason: "needsSources:conflicting_sources",
      });
    }
    return {
      decision: decision({
        action: "escalate",
        reason: policy.escalatedBecause
          ? "Source conflict detected; analysis used the source-conflict escalation path."
          : "Source conflict detected; stronger review or more source evidence is required.",
        signal: "source_conflict",
        history: evaluatorHistory({ job }),
      }),
    };
  }

  const quality = policy.sourceQuality;
  if (!quality) {
    return undefined;
  }
  const bestScore =
    typeof quality.bestScore === "number" && Number.isFinite(quality.bestScore)
      ? quality.bestScore
      : undefined;
  const unavailableCount =
    typeof quality.unavailableCount === "number" && Number.isFinite(quality.unavailableCount)
      ? Math.max(0, Math.floor(quality.unavailableCount))
      : 0;

  if (bestScore === undefined && unavailableCount > 0) {
    const retryRuns =
      typeof job.state.evaluatorSourceRetryRuns === "number" &&
      Number.isFinite(job.state.evaluatorSourceRetryRuns)
        ? Math.max(0, Math.floor(job.state.evaluatorSourceRetryRuns))
        : 0;
    const onlyOptionalUnavailable =
      hasSourceDetails(policy) &&
      requiredUnavailableSourceCount(policy) === 0 &&
      optionalUnavailableSourceCount(policy) > 0;
    if (onlyOptionalUnavailable && retryRuns < 1) {
      const repair = sourceRepairDecisionForNoUsableSource({
        job,
        policy,
        reason: "Only optional source evidence was unavailable.",
        nowMs: params.nowMs,
      });
      return sourceRepairDecisionResult({
        job,
        policy,
        repair,
        nowMs: params.nowMs,
        reason: `Only optional source evidence was unavailable; ${repair.summary} before model work continues.`,
        state: { evaluatorSourceRetryRuns: retryRuns + 1 },
      });
    }
    if (onlyOptionalUnavailable) {
      const sourceNodeIds = optionalUnavailableSourceIds(policy);
      if (repairPolicyForJob(job).autoStopOptionalSources && sourceNodeIds.length > 0) {
        return {
          autoStopSourceNodeIds: sourceNodeIds,
          decision: decision({
            action: "retry_sources",
            reason:
              "Only optional source evidence remains unavailable; stopping optional source paths and retrying.",
            history: evaluatorHistory({ job }),
          }),
          refireSoon: true,
        };
      }
      return {
        decision: decision({
          action: "none",
          reason:
            "Only optional source evidence remains unavailable after repair; skipping optional source.",
          history: evaluatorHistory({ job }),
        }),
      };
    }
    const stop = repairStop({
      code: "source_access_missing",
      reason:
        "Required source evidence is unavailable. Configure the missing source access or provide a direct source.",
      nowMs: params.nowMs,
    });
    const coordinationRequest = maybeRequestAgentCoordination({
      job,
      policy,
      nowMs: params.nowMs,
      signal: "source_access_missing",
      reason:
        "Required source evidence is unavailable; ask selected Agents if they can provide task-room evidence or confirm the missing access.",
    });
    if (coordinationRequest) {
      return coordinationRequest;
    }
    return {
      ...repairStopResult({
        job,
        stop,
        action: "needs_access",
        stopReason: "needsSources:source_access_missing",
      }),
    };
  }

  const insufficient =
    policy.sourceVerificationStatus === "insufficient_evidence" && (bestScore ?? 0) < 0.5;
  const weakWithUnavailable = bestScore !== undefined && bestScore < 0.5 && unavailableCount > 0;
  if (weakWithUnavailable) {
    const retryRuns =
      typeof job.state.evaluatorSourceRetryRuns === "number" &&
      Number.isFinite(job.state.evaluatorSourceRetryRuns)
        ? Math.max(0, Math.floor(job.state.evaluatorSourceRetryRuns))
        : 0;
    if (retryRuns < 1) {
      const repair = sourceRepairDecision({
        job,
        policy,
        reason: "Weak source quality with unavailable sources.",
        nowMs: params.nowMs,
      });
      return sourceRepairDecisionResult({
        job,
        policy,
        repair,
        nowMs: params.nowMs,
        reason: `Source quality is weak (${bestScore.toFixed(2)}) and ${unavailableCount} source${unavailableCount === 1 ? "" : "s"} were unavailable; ${repair.summary} before model work continues.`,
        state: { evaluatorSourceRetryRuns: retryRuns + 1 },
      });
    }
  }

  if (insufficient || (bestScore !== undefined && bestScore < 0.35)) {
    const repair = sourceRepairDecision({
      job,
      policy,
      reason: "Insufficient source quality needs another domain source.",
      nowMs: params.nowMs,
    });
    const repairs = repair.graphRepairs ?? (repair.graphRepair ? [repair.graphRepair] : []);
    const safetyStop = repairSafetyStop({ job, policy, repairs, nowMs: params.nowMs });
    if (safetyStop) {
      return repairStopResult({ job, stop: safetyStop, action: "request_sources" });
    }
    const stop = repairStop({
      code: "needs_user_source",
      reason:
        bestScore !== undefined
          ? `Source quality is too low (${bestScore.toFixed(2)}); ${repair.summary}. Add a direct source, configure source access, or change task policy.`
          : `Source verification had insufficient evidence; ${repair.summary}. Add a direct source, configure source access, or change task policy.`,
      nowMs: params.nowMs,
    });
    const coordinationRequest = maybeRequestAgentCoordination({
      job,
      policy,
      nowMs: params.nowMs,
      signal: "low_source_quality",
      reason:
        "Source quality is too low; ask selected Agents for task-room evidence before requiring a user-supplied source.",
    });
    if (coordinationRequest) {
      return coordinationRequest;
    }
    return {
      graphRepair: repair.graphRepair,
      graphRepairs: repair.graphRepairs,
      decision: decision({
        action: "request_sources",
        reason: stop.reason,
        stopCode: stop.code,
        history: evaluatorHistory({ job }),
      }),
      disable: { stopReason: "needsSources:needs_user_source" },
      state: { lastGraphRepairStop: stop },
    };
  }

  return undefined;
}

export function evaluateTaskRunForEscalation(params: {
  job: CronJob;
  result: {
    status: CronRunStatus;
    summary?: string;
    outputText?: string;
    policy?: CronRunPolicyTelemetry;
  };
  nowMs: number;
}): TaskEvaluatorRepairResult | undefined {
  const { job, result } = params;
  const pending = job.state.pendingEscalation;
  if (pending) {
    return {
      decision: decision({
        action: "none",
        reason: "Escalation follow-up completed.",
        signal: pending.signal,
        history: evaluatorHistory({ job }),
      }),
      clearPending: true,
    };
  }

  const sourceDecision = sourceQualityDecision(params);
  if (sourceDecision) {
    return sourceDecision;
  }

  const coordination = result.policy?.coordination;
  if (coordination && coordination.total > 0) {
    if (coordination.needsApproval > 0) {
      return {
        decision: decision({
          action: "needs_access",
          reason: `Coordination is waiting for approval before ${coordination.needsApproval} Agent${coordination.needsApproval === 1 ? "" : "s"} can be consulted.`,
          signal: "coordination_needs_approval",
          history: evaluatorHistory({ job }),
        }),
      };
    }
    if (coordination.failed > 0 && coordination.completed === 0) {
      return {
        decision: decision({
          action: "stop",
          reason: `No selected coordination Agent completed successfully (${coordination.failed} failed).`,
          signal: "coordination_failed",
          history: evaluatorHistory({ job }),
        }),
      };
    }
    if (coordination.completed > 0) {
      return {
        decision: decision({
          action: "none",
          reason: `Task-room evidence from ${coordination.completed} Agent${coordination.completed === 1 ? "" : "s"} was included in validation and synthesis.`,
          signal: "coordination_ready",
          history: evaluatorHistory({ job }),
        }),
      };
    }
  }

  const policy = job.executionPolicy;
  if (policy?.planner?.strategy !== "cheap-model" || policy.evaluator?.escalateOnSignal === false) {
    return undefined;
  }
  if (result.status !== "ok") {
    return {
      decision: decision({
        action: "none",
        reason: "Run did not finish successfully.",
        history: evaluatorHistory({ job }),
      }),
    };
  }

  const maxEscalations =
    typeof policy.evaluator?.maxEscalations === "number" &&
    Number.isFinite(policy.evaluator.maxEscalations)
      ? Math.max(0, Math.floor(policy.evaluator.maxEscalations))
      : 1;
  const usedEscalations =
    typeof job.state.evaluatorEscalationRuns === "number" &&
    Number.isFinite(job.state.evaluatorEscalationRuns)
      ? Math.max(0, Math.floor(job.state.evaluatorEscalationRuns))
      : 0;

  const signal = findSignal({
    markers: policy.evaluator?.signalIncludes,
    summary: result.summary,
    outputText: result.outputText,
  });
  if (!signal) {
    const noSignalRuns = nonNegativeInteger(job.state.evaluatorConsecutiveNoSignalRuns) + 1;
    return {
      decision: decision({
        action: "none",
        reason:
          noSignalRuns === 1
            ? "No escalation cue found."
            : `No escalation cue found (${noSignalRuns} stable cheap checks).`,
        history: evaluatorHistory({ job, noSignalRuns, maxEscalations }),
      }),
      state: { evaluatorConsecutiveNoSignalRuns: noSignalRuns },
    };
  }

  const reason = `Matched escalation cue "${signal}".`;
  const signalState = {
    evaluatorConsecutiveNoSignalRuns: 0,
    evaluatorLastSignal: signal,
    evaluatorLastSignalAtMs: params.nowMs,
  };
  if (usedEscalations >= maxEscalations) {
    return {
      decision: decision({
        action: "none",
        reason: `${reason} Escalation cap reached (${usedEscalations}/${maxEscalations}).`,
        signal,
        history: evaluatorHistory({
          job,
          noSignalRuns: 0,
          maxEscalations,
          lastSignal: signal,
          lastSignalAtMs: params.nowMs,
        }),
      }),
      state: signalState,
    };
  }

  return {
    decision: decision({
      action: "escalate",
      reason,
      signal,
      history: evaluatorHistory({
        job,
        noSignalRuns: 0,
        maxEscalations,
        lastSignal: signal,
        lastSignalAtMs: params.nowMs,
      }),
    }),
    pendingEscalation: {
      reason,
      signal,
      createdAtMs: params.nowMs,
      sourceRunAtMs: params.nowMs,
    },
    state: signalState,
  };
}
