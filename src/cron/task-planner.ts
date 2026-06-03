import { mergeTrustedSources, trustedSourceUrl } from "./trusted-sources.js";
import type {
  CronTaskExecutionPolicy,
  CronTaskGraphRepairPlan,
  CronTaskPlannerDecision,
  CronTaskPlannerStrategy,
  CronTaskSkillAction,
  CronTaskTrustedSource,
  CronTaskWorkflowGraph,
  CronTaskWorkflowGraphNode,
  CronTaskWorkflowStep,
} from "./types.js";

type TaskPlannerInput = {
  name?: string;
  message?: string;
  policy?: CronTaskExecutionPolicy;
  trustedSources?: CronTaskTrustedSource[];
};

type PlannedTaskPolicy = CronTaskExecutionPolicy & { planner: CronTaskPlannerDecision };

const CHEAP_MODEL_HINTS = [
  "nano",
  "mini",
  "small",
  "lite",
  "flash",
  "haiku",
  "fast",
  "qwen3-coder-flash",
];

const STRONG_MODEL_HINTS = [
  "pro",
  "max",
  "opus",
  "sonnet",
  "gpt-5.5",
  "glm-4.6",
  "glm-5",
  "gemini-3",
  "deepseek-r1",
  "kimi-k2",
  "coder",
  "reasoning",
];

const DEFAULT_ESCALATION_SIGNAL_INCLUDES = ["Needs deeper analysis: yes"];

export const SOURCE_REPAIR_NODE_IDS: Record<CronTaskGraphRepairPlan["toolName"], string> = {
  web_fetch: "source-fetch-repair-web-fetch",
  gateway: "source-fetch-repair-gateway",
  wallet: "source-fetch-repair-wallet",
  mining: "source-fetch-repair-mining",
  offers: "source-fetch-repair-offers",
  web_search: "source-fetch-repair-web-search",
};
export const SOURCE_REPAIR_WEB_SEARCH_NODE_ID = SOURCE_REPAIR_NODE_IDS.web_search;

function repairNodeSuffix(value: string): string {
  return value
    .replace(/^source-fetch-/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48);
}

export function sourceRepairNodeIdForTool(
  toolName: CronTaskGraphRepairPlan["toolName"],
  replacesNodeId?: string,
): string {
  const baseNodeId = SOURCE_REPAIR_NODE_IDS[toolName];
  if (!replacesNodeId?.trim()) {
    return baseNodeId;
  }
  const suffix = repairNodeSuffix(replacesNodeId);
  return suffix ? `${baseNodeId}-for-${suffix}` : baseNodeId;
}

function clonePolicy(policy: CronTaskExecutionPolicy | undefined): CronTaskExecutionPolicy {
  return {
    ...policy,
    allowedSkills: policy?.allowedSkills ? [...policy.allowedSkills] : undefined,
    skillAction: policy?.skillAction
      ? {
          ...policy.skillAction,
          input: policy.skillAction.input ? { ...policy.skillAction.input } : undefined,
        }
      : undefined,
    modelPolicy: policy?.modelPolicy ? { ...policy.modelPolicy } : undefined,
    coordination: policy?.coordination
      ? {
          ...policy.coordination,
          agents: policy.coordination.agents ? [...policy.coordination.agents] : undefined,
        }
      : undefined,
    budget: policy?.budget ? { ...policy.budget } : undefined,
    evaluator: policy?.evaluator
      ? {
          ...policy.evaluator,
          signalIncludes: policy.evaluator.signalIncludes
            ? [...policy.evaluator.signalIncludes]
            : undefined,
        }
      : undefined,
    repairPolicy: policy?.repairPolicy ? { ...policy.repairPolicy } : undefined,
    stop: policy?.stop
      ? {
          ...policy.stop,
          outputIncludes: policy.stop.outputIncludes ? [...policy.stop.outputIncludes] : undefined,
        }
      : undefined,
    trustedSources: policy?.trustedSources
      ? policy.trustedSources.map((source) => ({ ...source }))
      : undefined,
    planner: policy?.planner
      ? {
          ...policy.planner,
          signals: policy.planner.signals ? [...policy.planner.signals] : undefined,
          graph: policy.planner.graph
            ? {
                ...policy.planner.graph,
                terminalNodeIds: [...policy.planner.graph.terminalNodeIds],
                nodes: policy.planner.graph.nodes.map((node) => ({
                  ...node,
                  dependsOn: node.dependsOn ? [...node.dependsOn] : undefined,
                  checkpointKeys: node.checkpointKeys ? [...node.checkpointKeys] : undefined,
                })),
              }
            : undefined,
          steps: policy.planner.steps
            ? policy.planner.steps.map((step) => ({
                ...step,
                checkpointKeys: step.checkpointKeys ? [...step.checkpointKeys] : undefined,
                substeps: step.substeps
                  ? step.substeps.map((substep) => ({
                      ...substep,
                      checkpointKeys: substep.checkpointKeys
                        ? [...substep.checkpointKeys]
                        : undefined,
                    }))
                  : undefined,
              }))
            : undefined,
        }
      : undefined,
  };
}

function normalizeText(params: TaskPlannerInput) {
  return [params.name, params.policy?.objective, params.policy?.successCriteria, params.message]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function isMiningSourceTask(text: string): boolean {
  return /(?:^|\s)@?mining\b|\bsat mining\b|\bminers?\b|\baom\b/.test(text);
}

function isMiningStrategyTask(text: string): boolean {
  return (
    isMiningSourceTask(text) &&
    hasAny(text, [
      /\bstrategy\b/,
      /\ballocation\b/,
      /\bscore\b/,
      /\bbenchmark\b/,
      /\bperformance rebate\b/,
      /\bnet sol cost\b/,
      /\bskill\b/,
      /\baom\b/,
    ])
  );
}

function forbidsExternalSearch(text: string): boolean {
  return hasAny(text, [
    /\b(?:do not|don't|dont|never|no|without) (?:use |call |run |add )?(?:live )?(?:web )?search\b/,
    /\b(?:do not|don't|dont|never|no|without) (?:use |call |run |add )?(?:external|remote|online|internet) sources?\b/,
  ]);
}

function asksForExternalSearch(text: string): boolean {
  if (forbidsExternalSearch(text)) {
    return false;
  }
  return hasAny(text, [
    /\bweb\b/,
    /\binternet\b/,
    /\bonline\b/,
    /\bexternal\b/,
    /\bremote\b/,
    /\bsearch\b/,
    /\bfind (?:online|on the web|sources?)\b/,
    /\bnews\b/,
    /\bheadlines?\b/,
    /\bprice\b/,
    /\bweather\b/,
    /\bbtc\b/,
    /\bmarket (?:news|price|data|source|sources)\b/,
  ]);
}

function firstUrlFromText(value: string): string | undefined {
  const match = value.match(/https?:\/\/[^\s<>"')]+/i);
  return match?.[0];
}

function urlsFromText(value: string): Set<string> {
  return new Set(
    Array.from(value.matchAll(/https?:\/\/[^\s<>"')]+/gi), (match) => match[0].toLowerCase()),
  );
}

function decision(params: {
  strategy: CronTaskPlannerStrategy;
  rationale: string;
  confidence?: CronTaskPlannerDecision["confidence"];
  signals?: string[];
  steps?: CronTaskWorkflowStep[];
  graph?: CronTaskWorkflowGraph;
}): CronTaskPlannerDecision {
  return {
    source: "heuristic",
    strategy: params.strategy,
    rationale: params.rationale,
    confidence: params.confidence,
    signals: params.signals,
    steps: params.steps,
    graph: params.graph,
  };
}

function planned(
  policy: CronTaskExecutionPolicy,
  planner: CronTaskPlannerDecision,
): PlannedTaskPolicy {
  return { ...policy, planner };
}

function workflowSteps(kind: "no-model" | "skill-only" | "model"): CronTaskWorkflowStep[] {
  if (kind === "no-model") {
    return [
      {
        id: "deliver",
        label: "Deliver",
        description: "Send the prepared task text to the selected delivery target.",
        retryable: true,
        checkpointKeys: ["outputText", "deliveryTarget"],
      },
    ];
  }
  if (kind === "skill-only") {
    return [
      {
        id: "collect",
        label: "Collect",
        description: "Resolve deterministic tool input and task routing.",
        usesTool: true,
        retryable: true,
        checkpointKeys: ["toolName", "toolInput"],
      },
      {
        id: "deliver",
        label: "Deliver",
        description: "Deliver the direct tool result without a model call.",
        retryable: true,
        checkpointKeys: ["outputText", "deliveryTarget"],
      },
    ];
  }
  return [
    {
      id: "collect",
      label: "Collect",
      description: "Collect context, policy, routing, and allowed tools for the run.",
      usesTool: true,
      retryable: true,
      checkpointKeys: ["memoryScope", "skillScope", "deliveryTarget"],
    },
    {
      id: "analyze",
      label: "Analyze",
      description:
        "Plan analysis, run the model/tool executor, and synthesize a replayable result checkpoint.",
      usesModel: true,
      usesTool: true,
      retryable: true,
      checkpointKeys: ["summary", "outputText", "model", "provider"],
      substeps: [
        {
          id: "plan-analysis",
          label: "Plan analysis",
          description:
            "Freeze the model, memory, skill, budget, evaluator, and delivery plan before expensive work starts.",
          retryable: true,
          checkpointKeys: ["modelPolicy", "memoryScope", "skillScope", "deliveryTarget"],
        },
        {
          id: "execute-tool-or-model",
          label: "Execute tool/model",
          description: "Run the selected deterministic tool or model-backed Agent turn.",
          usesModel: true,
          usesTool: true,
          retryable: true,
          checkpointKeys: ["summary", "outputText", "model", "provider"],
        },
        {
          id: "synthesize",
          label: "Synthesize",
          description: "Normalize the execution checkpoint for evaluator and delivery replay.",
          retryable: true,
          checkpointKeys: ["summary", "outputText", "resultStatus"],
        },
      ],
    },
    {
      id: "evaluate",
      label: "Evaluate",
      description: "Apply evaluator, budget, stop, and escalation policy to the result.",
      retryable: false,
      checkpointKeys: ["resultStatus", "evaluator", "planner"],
    },
    {
      id: "deliver",
      label: "Deliver",
      description: "Deliver the saved result checkpoint without rerunning analysis.",
      retryable: true,
      checkpointKeys: ["delivered", "deliveryAttempted", "deliveryTarget"],
    },
  ];
}

type SourceFetchGraphSpec = Pick<
  CronTaskWorkflowGraphNode,
  | "id"
  | "label"
  | "description"
  | "checkpointKeys"
  | "optional"
  | "sourceRole"
  | "sourcePriority"
  | "sourceFreshness"
  | "sourceExpectedOutputType"
  | "sourceUrl"
  | "sourceText"
  | "trustedSourceId"
  | "sourceLabel"
> & {
  toolName: string;
};

function normalizePlannerToolName(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/^\$/, "") ?? "";
}

function isPolicyToolAllowed(
  policy: CronTaskExecutionPolicy | undefined,
  toolName: string,
): boolean {
  const scope = policy?.skillScope;
  if (scope === "none") {
    return false;
  }
  if (scope !== "selected") {
    return true;
  }
  const allowed = new Set((policy?.allowedSkills ?? []).map(normalizePlannerToolName));
  return allowed.has(normalizePlannerToolName(toolName));
}

function sourceFetchGraphSpecs(
  text: string,
  policy: CronTaskExecutionPolicy | undefined,
): SourceFetchGraphSpec[] {
  const specs: SourceFetchGraphSpec[] = [];
  const add = (spec: SourceFetchGraphSpec) => {
    if (
      isPolicyToolAllowed(policy, spec.toolName) &&
      !specs.some((entry) => entry.id === spec.id)
    ) {
      specs.push(spec);
    }
  };
  const explicitUrls = urlsFromText(text);

  if (firstUrlFromText(text)) {
    add({
      id: "source-fetch-web-fetch",
      label: "Fetch URL",
      toolName: "web_fetch",
      description: "Fetch the explicit URL before model analysis.",
      sourceRole: "primary",
      sourcePriority: 10,
      sourceFreshness: "static",
      sourceExpectedOutputType: "document",
      checkpointKeys: ["sourceUrl", "sourceOutput"],
    });
  }

  if (
    /\bgateway\b|\bproviders?\b|\bmodel auth\b|\bmodel catalog\b|\bapi credentials?\b/.test(text)
  ) {
    add({
      id: "source-fetch-gateway",
      label: "Provider status",
      toolName: "gateway",
      description: "Read provider/auth/catalog state before model analysis.",
      sourceRole: "primary",
      sourcePriority: 20,
      sourceFreshness: "runtime",
      sourceExpectedOutputType: "provider-status",
      checkpointKeys: ["providerStatus", "sourceOutput"],
    });
  }

  if (/\bwallet\b|\bwallets?\b|\bbalances?\b|\baddress\b/.test(text)) {
    add({
      id: "source-fetch-wallet",
      label: "Wallet state",
      toolName: "wallet",
      description: "Read wallet state before model analysis.",
      sourceRole: "primary",
      sourcePriority: 20,
      sourceFreshness: "runtime",
      sourceExpectedOutputType: "wallet-state",
      checkpointKeys: ["walletState", "sourceOutput"],
    });
  }

  if (isMiningSourceTask(text)) {
    add({
      id: "source-fetch-mining",
      label: "Mining state",
      toolName: "mining",
      description: "Read mining state before model analysis.",
      sourceRole: "primary",
      sourcePriority: 20,
      sourceFreshness: "runtime",
      sourceExpectedOutputType: "mining-state",
      checkpointKeys: ["miningState", "sourceOutput"],
    });
  }

  if (/\boffers?\b|\bmarketplace\b|\borders?\b|\brequests?\b/.test(text)) {
    add({
      id: "source-fetch-offers",
      label: "Offers state",
      toolName: "offers",
      description: "Read offers and marketplace state before model analysis.",
      sourceRole: "primary",
      sourcePriority: 20,
      sourceFreshness: "runtime",
      sourceExpectedOutputType: "offers-state",
      checkpointKeys: ["offersState", "sourceOutput"],
    });
  }

  for (const source of (policy?.trustedSources ?? []).filter((entry) => entry.active !== false)) {
    const url = trustedSourceUrl(source);
    if (!url || explicitUrls.has(url.toLowerCase())) {
      continue;
    }
    const hasPrimarySource = specs.some((spec) => spec.sourceRole === "primary");
    add({
      id: `source-fetch-trusted-${source.id.replace(/^trusted-/, "").slice(0, 48)}`,
      label: "Trusted source",
      toolName: "web_fetch",
      description: "Fetch a saved trusted source before model analysis.",
      sourceRole: hasPrimarySource ? "verification" : "primary",
      sourcePriority: hasPrimarySource ? 15 : 5,
      sourceFreshness: "static",
      sourceExpectedOutputType: "document",
      sourceUrl: url,
      sourceText: source.source,
      trustedSourceId: source.id,
      sourceLabel: source.label,
      checkpointKeys: ["trustedSource", "sourceUrl", "sourceOutput"],
    });
  }

  const hasPrimarySource = specs.some((spec) => spec.sourceRole === "primary");
  const asksForVerification =
    /\bverify\b|\bconfirm\b|\bcross.?check\b|\bdouble.?check\b|\bvalidate\b/.test(text);
  const asksForExplicitSearch = /\bsearch\b|\bfind\b|\bnews\b|\bheadlines?\b|\bweather\b/.test(
    text,
  );
  const localMiningSourceOnly =
    specs.some((spec) => spec.id === "source-fetch-mining") && !asksForExternalSearch(text);

  if (
    !localMiningSourceOnly &&
    /\bweb\b|\bsearch\b|\bsource\b|\bmarket\b|\bbtc\b|\bsol\b|\brisk\b|\bnews\b|\bheadline|\bprice\b|\bweather\b|\blive\b|\bavailability\b|\bexternal\b|\bremote\b/.test(
      text,
    )
  ) {
    add({
      id: "source-fetch-web-search",
      label: "Live search",
      toolName: "web_search",
      description: "Search live external sources before model analysis.",
      sourceRole: hasPrimarySource
        ? asksForVerification
          ? "verification"
          : asksForExplicitSearch
            ? "primary"
            : "enrichment"
        : "primary",
      sourcePriority: hasPrimarySource
        ? asksForVerification
          ? 40
          : asksForExplicitSearch
            ? 20
            : 80
        : 20,
      sourceFreshness: "live",
      sourceExpectedOutputType: "search-results",
      optional: hasPrimarySource && !asksForVerification && !asksForExplicitSearch,
      checkpointKeys: ["searchQuery", "sourceOutput"],
    });
  }

  return specs;
}

function uniquePlannerSkills(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizePlannerToolName(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function cheapCheckToolScope(
  text: string,
  policy: CronTaskExecutionPolicy | undefined,
): Pick<CronTaskExecutionPolicy, "skillScope" | "allowedSkills"> {
  if (policy?.skillScope === "none") {
    return {
      skillScope: "none",
      allowedSkills: policy.allowedSkills ? [...policy.allowedSkills] : undefined,
    };
  }
  if (policy?.allowedSkills?.length) {
    return {
      skillScope: policy.skillScope ?? "selected",
      allowedSkills: uniquePlannerSkills(policy.allowedSkills),
    };
  }
  if (policy?.skillScope === "selected") {
    return {
      skillScope: policy.skillScope,
      allowedSkills: policy.allowedSkills ? [...policy.allowedSkills] : undefined,
    };
  }
  if (policy?.skillAction?.toolName) {
    return {
      skillScope: "selected",
      allowedSkills: [normalizePlannerToolName(policy.skillAction.toolName)],
    };
  }
  const inferredTools = uniquePlannerSkills(
    sourceFetchGraphSpecs(text, { ...policy, skillScope: undefined, allowedSkills: undefined }).map(
      (spec) => spec.toolName,
    ),
  );
  if (inferredTools.length === 0) {
    return { skillScope: "none" };
  }
  return { skillScope: "selected", allowedSkills: inferredTools };
}

function cheapCheckMemoryScope(
  policy: CronTaskExecutionPolicy | undefined,
): CronTaskExecutionPolicy["memoryScope"] {
  if (policy?.memoryScope === "pinned" || policy?.memoryScope === "search") {
    return policy.memoryScope;
  }
  return "none";
}

function needsToolPassNode(text: string, policy: CronTaskExecutionPolicy | undefined) {
  return (
    Boolean(policy?.skillAction?.toolName) ||
    hasAny(text, [
      /\btool\b/,
      /\bskill\b/,
      /\bservice\b/,
      /\bapi\b/,
      /\bwallet\b/,
      /\bmining\b/,
      /\bprovider\b/,
      /\bgateway\b/,
      /\boffers?\b/,
      /\bmarketplace\b/,
    ])
  );
}

function coordinationGraphNode(
  policy: CronTaskExecutionPolicy | undefined,
  dependsOn: string[],
): CronTaskWorkflowGraphNode | undefined {
  const mode = policy?.coordination?.mode;
  if (!mode || mode === "none") {
    return undefined;
  }
  const agents = policy?.coordination?.agents?.filter((agent) => agent.trim());
  if (!agents || agents.length === 0) {
    return undefined;
  }
  return {
    id: "coordinate-agents",
    label: mode === "parallel" ? "Coordinate Agents" : "Consult Agents",
    kind: "coordination",
    description:
      mode === "parallel"
        ? "Spawn approved local Agents beside the owner Agent and record task-room evidence."
        : "Consult approved local Agents and record their task-room evidence.",
    dependsOn,
    usesModel: true,
    retryable: true,
    checkpointKeys: ["coordinationEvidence", "taskRoomEvidence", "approval"],
  };
}

function cloneWorkflowGraph(graph: CronTaskWorkflowGraph): CronTaskWorkflowGraph {
  return {
    ...graph,
    terminalNodeIds: [...graph.terminalNodeIds],
    nodes: graph.nodes.map((node) => ({
      ...node,
      dependsOn: node.dependsOn ? [...node.dependsOn] : undefined,
      checkpointKeys: node.checkpointKeys ? [...node.checkpointKeys] : undefined,
    })),
  };
}

function inferWorkflowGraphKind(
  policy: CronTaskExecutionPolicy,
): "no-model" | "skill-only" | "model" {
  if (policy.executionMode === "no-model" || policy.modelPolicy?.mode === "none") {
    return "no-model";
  }
  if (policy.executionMode === "skill-only" || policy.skillAction) {
    return "skill-only";
  }
  return "model";
}

function strategyForWorkflowGraphKind(kind: "no-model" | "skill-only" | "model") {
  if (kind === "no-model") {
    return "no-model" as const;
  }
  if (kind === "skill-only") {
    return "skill-only" as const;
  }
  return "agent-default" as const;
}

function ensureCoordinationNodeInGraph(
  graph: CronTaskWorkflowGraph,
  policy: CronTaskExecutionPolicy,
): CronTaskWorkflowGraph {
  if (graph.nodes.some((node) => node.id === "coordinate-agents")) {
    return graph;
  }
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const deliverIndex = nodes.findIndex((node) => node.kind === "deliver");
  const anchorNode =
    deliverIndex >= 0
      ? nodes[deliverIndex]
      : (nodes.find((node) => graph.terminalNodeIds.includes(node.id)) ?? nodes[nodes.length - 1]);
  const dependsOn =
    anchorNode?.dependsOn && anchorNode.dependsOn.length > 0
      ? [...anchorNode.dependsOn]
      : anchorNode
        ? [anchorNode.id]
        : [graph.entryNodeId];
  const coordination = coordinationGraphNode(policy, dependsOn);
  if (!coordination) {
    return graph;
  }
  if (deliverIndex >= 0) {
    nodes[deliverIndex] = {
      ...nodes[deliverIndex],
      dependsOn: [coordination.id],
    };
    nodes.splice(deliverIndex, 0, coordination);
  } else {
    nodes.push(coordination);
  }
  return {
    ...graph,
    nodes,
  };
}

export function withTaskCoordinationRequest(params: {
  policy?: CronTaskExecutionPolicy;
  message: string;
  agents: string[];
  mode?: "consult" | "parallel";
  requireApproval?: boolean;
}): CronTaskExecutionPolicy {
  const policy = clonePolicy(params.policy);
  const requestedAgents = Array.from(
    new Set(params.agents.map((agent) => agent.trim()).filter(Boolean)),
  );
  const existingAgents = policy.coordination?.agents ?? [];
  const agents = Array.from(new Set([...existingAgents, ...requestedAgents]));
  const mode = params.mode ?? policy.coordination?.mode ?? "consult";
  policy.coordination = {
    ...policy.coordination,
    mode,
    agents,
    requireApproval: params.requireApproval ?? policy.coordination?.requireApproval ?? true,
  };

  const kind = inferWorkflowGraphKind(policy);
  const graph = policy.planner?.graph
    ? cloneWorkflowGraph(policy.planner.graph)
    : buildWorkflowGraph({
        kind,
        text: params.message,
        policy,
        skillAction: policy.skillAction,
      });
  policy.planner = {
    source: "heuristic",
    strategy: policy.planner?.strategy ?? strategyForWorkflowGraphKind(kind),
    rationale: policy.planner?.rationale ?? "Manual Agent coordination request.",
    confidence: policy.planner?.confidence ?? "medium",
    signals: Array.from(new Set([...(policy.planner?.signals ?? []), "manual-agent-request"])),
    steps: policy.planner?.steps ?? workflowSteps(kind),
    graph: ensureCoordinationNodeInGraph(graph, policy),
  };
  return policy;
}

function buildWorkflowGraph(params: {
  kind: "no-model" | "skill-only" | "model";
  text: string;
  policy?: CronTaskExecutionPolicy;
  skillAction?: CronTaskSkillAction;
}): CronTaskWorkflowGraph {
  if (params.kind === "no-model") {
    const nodes: CronTaskWorkflowGraphNode[] = [
      {
        id: "prepare-message",
        label: "Prepare message",
        kind: "synthesize",
        description: "Use the stored task text directly without model or tool work.",
        retryable: true,
        checkpointKeys: ["outputText"],
      },
    ];
    const coordination = coordinationGraphNode(params.policy, ["prepare-message"]);
    if (coordination) {
      nodes.push(coordination);
    }
    nodes.push({
      id: "deliver",
      label: "Deliver",
      kind: "deliver",
      description: "Send the prepared message to the selected delivery target.",
      dependsOn: [coordination?.id ?? "prepare-message"],
      retryable: true,
      checkpointKeys: ["deliveryTarget", "delivered"],
    });
    return {
      version: 1,
      entryNodeId: "prepare-message",
      terminalNodeIds: ["deliver"],
      nodes,
    };
  }

  if (params.kind === "skill-only") {
    const toolLabel = params.skillAction?.toolName
      ? `${params.skillAction.toolName} pass`
      : "Tool pass";
    const nodes: CronTaskWorkflowGraphNode[] = [
      {
        id: "collect-data",
        label: "Collect data",
        kind: "collect",
        description: "Resolve session, delivery target, and deterministic tool input.",
        retryable: true,
        checkpointKeys: ["deliveryTarget", "toolInput"],
      },
      {
        id: "tool-pass",
        label: toolLabel,
        kind: "tool",
        description: params.skillAction?.toolName
          ? `Run the selected ${params.skillAction.toolName} tool without model inference.`
          : "Run the selected deterministic tool without model inference.",
        dependsOn: ["collect-data"],
        usesTool: true,
        retryable: true,
        checkpointKeys: ["toolName", "toolInput", "outputText"],
      },
    ];
    const coordination = coordinationGraphNode(params.policy, ["tool-pass"]);
    if (coordination) {
      nodes.push(coordination);
    }
    nodes.push(
      {
        id: "validation",
        label: "Validation",
        kind: "validation",
        description: "Validate the direct tool result before delivery.",
        dependsOn: [coordination?.id ?? "tool-pass"],
        retryable: true,
        checkpointKeys: ["resultStatus", "error"],
      },
      {
        id: "deliver",
        label: "Deliver",
        kind: "deliver",
        description: "Deliver the validated direct tool result.",
        dependsOn: ["validation"],
        retryable: true,
        checkpointKeys: ["deliveryTarget", "delivered"],
      },
    );
    return {
      version: 1,
      entryNodeId: "collect-data",
      terminalNodeIds: ["deliver"],
      nodes,
    };
  }

  const nodes: CronTaskWorkflowGraphNode[] = [
    {
      id: "collect-data",
      label: "Collect data",
      kind: "collect",
      description: "Collect policy, memory scope, allowed skills, and routing context.",
      retryable: true,
      checkpointKeys: ["memoryScope", "skillScope", "deliveryTarget"],
    },
  ];
  const sourceSpecs = sourceFetchGraphSpecs(params.text, params.policy);
  let contextNodeIds = ["collect-data"];

  for (const spec of sourceSpecs) {
    nodes.push({
      id: spec.id,
      label: spec.label,
      kind: "tool",
      description: spec.description,
      dependsOn: ["collect-data"],
      optional: spec.optional,
      sourceRole: spec.sourceRole,
      sourcePriority: spec.sourcePriority,
      sourceFreshness: spec.sourceFreshness,
      sourceExpectedOutputType: spec.sourceExpectedOutputType,
      sourceUrl: spec.sourceUrl,
      sourceText: spec.sourceText,
      trustedSourceId: spec.trustedSourceId,
      sourceLabel: spec.sourceLabel,
      usesTool: true,
      retryable: true,
      checkpointKeys: spec.checkpointKeys,
    });
  }
  if (sourceSpecs.length > 0) {
    const sourceNodeIds = sourceSpecs.map((spec) => spec.id);
    nodes.push({
      id: "source-merge",
      label: "Source merge",
      kind: "synthesize",
      description: "Normalize source fetch outputs into a single source bundle.",
      dependsOn: sourceNodeIds,
      retryable: true,
      checkpointKeys: ["sourceBundle", "sourceStatus", "sourceOutput"],
    });
    contextNodeIds = ["source-merge"];
    if (sourceSpecs.some((spec) => spec.sourceRole === "verification")) {
      nodes.push({
        id: "source-verify",
        label: "Source verification",
        kind: "validation",
        description: "Compare primary and verification source outputs before analysis.",
        dependsOn: ["source-merge"],
        retryable: false,
        checkpointKeys: ["verificationStatus", "conflicts", "needsReview"],
      });
      contextNodeIds = ["source-verify"];
    }
  }

  if (needsToolPassNode(params.text, params.policy)) {
    nodes.push({
      id: "tool-pass",
      label: "Tool pass",
      kind: "tool",
      description: "Run approved deterministic tools to gather supporting facts before analysis.",
      dependsOn: contextNodeIds,
      usesTool: true,
      retryable: true,
      checkpointKeys: ["allowedSkills", "toolInput", "toolOutput"],
    });
    contextNodeIds = ["tool-pass"];
  }

  nodes.push({
    id: "model-analysis",
    label: "Model analysis",
    kind: "model",
    description: "Run the selected model-backed Agent turn against the collected context.",
    dependsOn: contextNodeIds,
    usesModel: true,
    usesTool: sourceSpecs.length > 0 || needsToolPassNode(params.text, params.policy),
    retryable: true,
    checkpointKeys: ["summary", "outputText", "model", "provider"],
  });
  const coordination = coordinationGraphNode(params.policy, ["model-analysis"]);
  if (coordination) {
    nodes.push(coordination);
  }

  nodes.push(
    {
      id: "validation",
      label: "Validation",
      kind: "validation",
      description: "Apply evaluator, budget, stop, and escalation policy.",
      dependsOn: [coordination?.id ?? "model-analysis"],
      retryable: true,
      checkpointKeys: ["resultStatus", "evaluator", "planner"],
    },
    {
      id: "synthesize",
      label: "Synthesize",
      kind: "synthesize",
      description: "Normalize the result checkpoint for run history and delivery replay.",
      dependsOn: ["validation"],
      retryable: true,
      checkpointKeys: ["summary", "outputText", "resultStatus"],
    },
    {
      id: "deliver",
      label: "Deliver",
      kind: "deliver",
      description: "Deliver the synthesized result to the selected channel or session.",
      dependsOn: ["synthesize"],
      retryable: true,
      checkpointKeys: ["deliveryTarget", "delivered"],
    },
  );

  return {
    version: 1,
    entryNodeId: "collect-data",
    terminalNodeIds: ["deliver"],
    nodes,
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] | undefined {
  const unique = [...new Set(values.filter((entry): entry is string => Boolean(entry)))];
  return unique.length > 0 ? unique : undefined;
}

function repairSourceNode(repair: CronTaskGraphRepairPlan): CronTaskWorkflowGraphNode {
  const sourceExpectedOutputType =
    repair.toolName === "web_fetch"
      ? "document"
      : repair.toolName === "gateway"
        ? "provider-status"
        : repair.toolName === "wallet"
          ? "wallet-state"
          : repair.toolName === "mining"
            ? "mining-state"
            : repair.toolName === "offers"
              ? "offers-state"
              : "search-results";
  const label =
    repair.toolName === "web_fetch"
      ? "Repair URL fetch"
      : repair.toolName === "gateway"
        ? "Repair provider catalog"
        : repair.toolName === "wallet"
          ? "Repair wallet state"
          : repair.toolName === "mining"
            ? "Repair mining state"
            : repair.toolName === "offers"
              ? "Repair offers state"
              : "Repair live search";
  return {
    id: repair.nodeId,
    label,
    kind: "tool",
    description: `Dynamic source repair: ${repair.reason}`,
    dependsOn: ["collect-data"],
    optional: false,
    sourceRole: "verification",
    sourcePriority: 30,
    sourceFreshness:
      repair.toolName === "web_search"
        ? "live"
        : repair.toolName === "web_fetch"
          ? "static"
          : "runtime",
    sourceExpectedOutputType,
    usesTool: true,
    retryable: true,
    checkpointKeys: ["sourceRepair", "sourceOutput"],
  };
}

function redirectDependenciesToVerification(graph: CronTaskWorkflowGraph) {
  for (const node of graph.nodes) {
    if (node.id === "source-verify") {
      continue;
    }
    if (node.dependsOn?.includes("source-merge")) {
      node.dependsOn = uniqueStrings(
        node.dependsOn.map((dependency) =>
          dependency === "source-merge" ? "source-verify" : dependency,
        ),
      );
    }
  }
}

function replaceGraphDependency(
  graph: CronTaskWorkflowGraph,
  fromNodeId: string,
  toNodeId: string,
) {
  for (const node of graph.nodes) {
    if (!node.dependsOn?.includes(fromNodeId)) {
      continue;
    }
    node.dependsOn = uniqueStrings(
      node.dependsOn.map((dependency) => (dependency === fromNodeId ? toNodeId : dependency)),
    );
  }
}

function removeGraphSourceNode(graph: CronTaskWorkflowGraph, nodeId: string): boolean {
  if (!nodeId.startsWith("source-fetch-")) {
    return false;
  }
  const index = graph.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) {
    return false;
  }
  graph.nodes.splice(index, 1);
  return true;
}

function removeGraphDependency(graph: CronTaskWorkflowGraph, nodeId: string) {
  for (const node of graph.nodes) {
    if (!node.dependsOn?.includes(nodeId)) {
      continue;
    }
    node.dependsOn = uniqueStrings(node.dependsOn.filter((dependency) => dependency !== nodeId));
  }
}

function incrementGraphRepairRevision(graph: CronTaskWorkflowGraph) {
  const parentRevision =
    typeof graph.graphRevision === "number" && Number.isFinite(graph.graphRevision)
      ? Math.max(1, Math.floor(graph.graphRevision))
      : 1;
  const repairRevision =
    typeof graph.repairRevision === "number" && Number.isFinite(graph.repairRevision)
      ? Math.max(0, Math.floor(graph.repairRevision)) + 1
      : 1;
  const graphRevision = parentRevision + 1;
  graph.parentRevision = parentRevision;
  graph.repairRevision = repairRevision;
  graph.graphRevision = graphRevision;
  return { graphRevision, parentRevision, repairRevision };
}

export function stopSourcePathInPolicy(
  policy: CronTaskExecutionPolicy | undefined,
  sourceNodeId: string,
): {
  applied: boolean;
  reason: string;
  graphRevision?: number;
  parentRevision?: number;
  repairRevision?: number;
} {
  const planner = policy?.planner;
  const graph = planner?.graph;
  if (!graph) {
    return { applied: false, reason: "task has no workflow graph" };
  }
  const nodeId = sourceNodeId.trim();
  if (!nodeId.startsWith("source-fetch-")) {
    return { applied: false, reason: "source path must be a source-fetch graph node" };
  }
  const sourceNode = graph.nodes.find((node) => node.id === nodeId);
  if (!sourceNode) {
    return { applied: false, reason: `source path ${nodeId} is not present in the graph` };
  }
  removeGraphDependency(graph, nodeId);
  const removed = removeGraphSourceNode(graph, nodeId);
  if (!removed) {
    return { applied: false, reason: `source path ${nodeId} could not be removed` };
  }
  planner.signals = uniqueStrings([
    ...(planner.signals ?? []),
    `graph-repair:source-stopped:${nodeId}`,
  ]);
  const revisions = incrementGraphRepairRevision(graph);
  return {
    applied: true,
    ...revisions,
    reason: `stopped source path ${nodeId}`,
  };
}

export function applySourceGraphRepairToPolicy(
  policy: CronTaskExecutionPolicy | undefined,
  repair: CronTaskGraphRepairPlan,
): {
  applied: boolean;
  reason: string;
  graphRevision?: number;
  parentRevision?: number;
  repairRevision?: number;
} {
  const planner = policy?.planner;
  const graph = planner?.graph;
  if (!graph) {
    return { applied: false, reason: "task has no workflow graph" };
  }
  const sourceMerge = graph.nodes.find((node) => node.id === "source-merge");
  if (!sourceMerge) {
    return { applied: false, reason: "task graph has no source merge node" };
  }

  if (!graph.nodes.some((node) => node.id === repair.nodeId)) {
    const sourceMergeIndex = graph.nodes.findIndex((node) => node.id === "source-merge");
    graph.nodes.splice(Math.max(1, sourceMergeIndex), 0, repairSourceNode(repair));
  }
  let replaced = false;
  if (repair.action === "replace_source" && repair.replacesNodeId) {
    const replacingExistingNode = graph.nodes.some((node) => node.id === repair.replacesNodeId);
    replaceGraphDependency(graph, repair.replacesNodeId, repair.nodeId);
    if (!sourceMerge.dependsOn?.includes(repair.nodeId)) {
      sourceMerge.dependsOn = uniqueStrings([...(sourceMerge.dependsOn ?? []), repair.nodeId]);
    }
    replaced = replacingExistingNode && removeGraphSourceNode(graph, repair.replacesNodeId);
  } else {
    sourceMerge.dependsOn = uniqueStrings([...(sourceMerge.dependsOn ?? []), repair.nodeId]);
  }

  let sourceVerify = graph.nodes.find((node) => node.id === "source-verify");
  if (!sourceVerify) {
    const sourceMergeIndex = graph.nodes.findIndex((node) => node.id === "source-merge");
    sourceVerify = {
      id: "source-verify",
      label: "Source verification",
      kind: "validation",
      description: "Compare primary, verification, and repaired source outputs before analysis.",
      dependsOn: ["source-merge"],
      retryable: false,
      checkpointKeys: ["verificationStatus", "conflicts", "needsReview"],
    };
    graph.nodes.splice(sourceMergeIndex + 1, 0, sourceVerify);
    redirectDependenciesToVerification(graph);
  } else {
    sourceVerify.dependsOn = uniqueStrings([...(sourceVerify.dependsOn ?? []), "source-merge"]);
  }

  planner.signals = uniqueStrings([...(planner.signals ?? []), "graph-repair:source-quality"]);
  const { graphRevision, parentRevision, repairRevision } = incrementGraphRepairRevision(graph);
  if (repair.action === "replace_source" && repair.replacesNodeId) {
    return {
      applied: true,
      graphRevision,
      parentRevision,
      repairRevision,
      reason: replaced
        ? `replaced ${repair.replacesNodeId} with ${repair.nodeId}`
        : `added ${repair.nodeId}; source ${repair.replacesNodeId} was not present`,
    };
  }
  return {
    applied: true,
    graphRevision,
    parentRevision,
    repairRevision,
    reason: `added ${repair.nodeId}`,
  };
}

function canPlan(policy: CronTaskExecutionPolicy | undefined) {
  const alreadyPlanned = policy?.planner?.source === "heuristic";
  const mode = policy?.executionMode;
  if (!alreadyPlanned && mode && mode !== "auto") {
    return false;
  }
  if (!alreadyPlanned && policy?.skillAction) {
    return false;
  }
  const modelMode = policy?.modelPolicy?.mode;
  if (!alreadyPlanned && modelMode && modelMode !== "auto" && modelMode !== "agent-default") {
    return false;
  }
  if (!alreadyPlanned && policy?.modelPolicy?.model?.trim()) {
    return false;
  }
  return true;
}

function isDirectReminder(text: string) {
  const reminder = hasAny(text, [
    /\bremind me\b/,
    /\breminder\b/,
    /\bping me\b/,
    /\bnotify me\b/,
    /\bsend (?:me |this )?(?:a )?(?:message|note|reminder)\b/,
  ]);
  const needsWork = hasAny(text, [
    /\bresearch\b/,
    /\banaly[sz]e\b/,
    /\bsummar[yi][sz]e\b/,
    /\bcompare\b/,
    /\bwrite\b/,
    /\bdraft\b/,
    /\bcheck\b/,
    /\bmonitor\b/,
    /\bstatus\b/,
    /\bsearch\b/,
    /\bfind\b/,
  ]);
  return reminder && !needsWork;
}

function walletAction(text: string): CronTaskSkillAction | undefined {
  if (!/(?:^|\s)@?wallet\b/.test(text)) {
    return undefined;
  }
  const asksToSendResult =
    /\bsend (?:it|this|that|the result|the update|the report|me|back)\b/.test(text);
  if (
    /\b(?:transfer|swap|prepare|pay|buy|sell)\b/.test(text) ||
    (/\bsend\b/.test(text) && !asksToSendResult)
  ) {
    return undefined;
  }
  const action = /\bassets?\b/.test(text)
    ? "assets"
    : /\baddress\b/.test(text)
      ? "address"
      : /\blist\b/.test(text)
        ? "list"
        : /\ball\b/.test(text) && /\bbalances?\b/.test(text)
          ? "balances"
          : /\bbalances?\b/.test(text)
            ? "balance"
            : "status";
  return { toolName: "wallet", input: { action } };
}

function miningAction(text: string): CronTaskSkillAction | undefined {
  if (!/(?:^|\s)@?mining\b|\bsat mining\b|\bminers?\b/.test(text)) {
    return undefined;
  }
  if (
    /\b(?:start|stop|claim|withdraw|deposit|fund|commit|set|update|clear|resolve|finalize|submit)\b/.test(
      text,
    )
  ) {
    return undefined;
  }
  const action = /\breadiness\b/.test(text)
    ? "readiness"
    : /\bhistory\b/.test(text)
      ? "history"
      : /\bprofile\b/.test(text)
        ? "profile"
        : "status";
  return { toolName: "mining", input: { action } };
}

function providerHealthAction(text: string): CronTaskSkillAction | undefined {
  const providerIntent = hasAny(text, [
    /\bproviders?\b/,
    /\bmodel auth\b/,
    /\bmodel catalog\b/,
    /\bauth status\b/,
    /\bcatalog status\b/,
    /\bgateway health\b/,
  ]);
  if (!providerIntent) {
    return undefined;
  }
  if (/\b(?:restart|patch|apply|configure|update|delete|clear|rotate)\b/.test(text)) {
    return undefined;
  }
  const action =
    /\bcatalog\b|\bmodels?\b/.test(text) && !/\bauth|credential|sign.?in\b/.test(text)
      ? "models.catalog.status"
      : "models.auth.status";
  return { toolName: "gateway", input: { action } };
}

function offersAction(text: string): CronTaskSkillAction | undefined {
  if (!/(?:^|\s)@?offers?\b|\bmarketplace\b/.test(text)) {
    return undefined;
  }
  if (/\b(?:create|draft|publish|buy|pay|enable|delete|cancel)\b/.test(text)) {
    return undefined;
  }
  const action = /\borders?\b/.test(text)
    ? "orders"
    : /\bpaid\b|\binvoices?\b|\breceipts?\b/.test(text)
      ? "paid_invoices"
      : /\brequests?\b/.test(text)
        ? "local_requests"
        : /\blocal\b/.test(text)
          ? "local_offers"
          : "search";
  return {
    toolName: "offers",
    input: action === "search" ? { action, query: text.slice(0, 240) } : { action },
  };
}

function chooseSkillAction(text: string): CronTaskSkillAction | undefined {
  return (
    walletAction(text) ?? miningAction(text) ?? providerHealthAction(text) ?? offersAction(text)
  );
}

function isStrongReasoningTask(text: string) {
  return hasAny(text, [
    /\bdeep\b/,
    /\bresearch\b/,
    /\banaly[sz]e\b/,
    /\bcompare\b/,
    /\bstrategy\b/,
    /\barchitecture\b/,
    /\bdebug\b/,
    /\broot cause\b/,
    /\bsecurity\b/,
    /\bdesign\b/,
    /\bdecide\b/,
    /\bplan\b/,
    /\bimplement\b/,
    /\bcode\b/,
    /\bwrite\b/,
    /\bdraft\b/,
  ]);
}

function isCheapModelTask(text: string) {
  return hasAny(text, [
    /\bcheck\b/,
    /\bmonitor\b/,
    /\bwatch\b/,
    /\bstatus\b/,
    /\bfetch\b/,
    /\bheadline/,
    /\bprice\b/,
    /\bavailability\b/,
    /\bquick\b/,
    /\bsimple\b/,
  ]);
}

function isNaturalCheapEscalationTask(text: string) {
  return (
    hasAny(text, [
      /\bcheap(?:er)? (?:check|model|pass|run) first\b/,
      /\bquick (?:check|pass|scan) first\b/,
      /\blightweight (?:check|pass|scan) first\b/,
      /\bstart (?:cheap|small|light|quick)\b/,
      /\b(?:escalate|follow up|deep(?:er)? dive|strong(?:er)? model) if (?:needed|necessary|anything changes)\b/,
      /\b(?:escalate|follow up) only (?:if|when)\b/,
    ]) ||
    (hasAny(text, [/\bcheap(?:er)?\b/, /\bquick\b/, /\blightweight\b/]) &&
      hasAny(text, [/\bescalat/, /\bstrong(?:er)?\b/, /\bdeep(?:er)?\b/, /\bfollow up\b/]))
  );
}

export function planTaskExecutionPolicy(input: TaskPlannerInput): CronTaskExecutionPolicy {
  const policy = clonePolicy(input.policy);
  const trustedSources = mergeTrustedSources(policy.trustedSources, input.trustedSources);
  if (trustedSources) {
    policy.trustedSources = trustedSources;
  }
  if (!canPlan(policy)) {
    return policy;
  }
  const text = normalizeText(input);
  if (
    policy.planner?.strategy === "cheap-model" &&
    policy.planner.signals?.includes("manual-evaluator")
  ) {
    const toolScope = cheapCheckToolScope(text, policy);
    const plannedPolicy: CronTaskExecutionPolicy = {
      ...policy,
      executionMode: "agent-turn",
      memoryScope: cheapCheckMemoryScope(policy),
      skillScope: toolScope.skillScope,
      allowedSkills: toolScope.allowedSkills,
      modelPolicy: {
        ...policy.modelPolicy,
        mode: policy.modelPolicy?.model?.trim() ? "task-override" : "auto",
      },
      evaluator: {
        ...policy.evaluator,
        escalateOnSignal: policy.evaluator?.escalateOnSignal !== false,
        signalIncludes: policy.evaluator?.signalIncludes ?? DEFAULT_ESCALATION_SIGNAL_INCLUDES,
        maxEscalations: policy.evaluator?.maxEscalations ?? 1,
      },
    };
    const planner = {
      ...policy.planner,
      steps: policy.planner.steps ?? workflowSteps("model"),
      graph:
        policy.planner.graph ??
        buildWorkflowGraph({
          kind: "model",
          text,
          policy: plannedPolicy,
        }),
    };
    return planned(plannedPolicy, planner);
  }

  if (isDirectReminder(text)) {
    return planned(
      {
        ...policy,
        executionMode: "no-model",
        memoryScope: "none",
        skillScope: "none",
        modelPolicy: { mode: "none" },
        evaluator: undefined,
      },
      decision({
        strategy: "no-model",
        rationale: "Direct reminder/delivery text can run without invoking a model.",
        confidence: "high",
        signals: ["reminder"],
        steps: workflowSteps("no-model"),
        graph: buildWorkflowGraph({ kind: "no-model", text, policy }),
      }),
    );
  }

  if (isMiningStrategyTask(text)) {
    const plannedPolicy: CronTaskExecutionPolicy = {
      ...policy,
      executionMode: "agent-turn",
      memoryScope: policy.memoryScope ?? "none",
      skillScope: "selected",
      allowedSkills: ["mining"],
      modelPolicy: { ...policy.modelPolicy, mode: "auto" },
      evaluator: undefined,
    };
    return planned(
      plannedPolicy,
      decision({
        strategy: "strong-model",
        rationale:
          "SAT mining strategy tasks should use local mining state and the mining tool, without unrelated web search or broad memory.",
        confidence: "high",
        signals: ["mining-strategy"],
        steps: workflowSteps("model"),
        graph: buildWorkflowGraph({ kind: "model", text, policy: plannedPolicy }),
      }),
    );
  }

  const skillAction = chooseSkillAction(text);
  if (skillAction) {
    return planned(
      {
        ...policy,
        executionMode: "skill-only",
        memoryScope: "none",
        skillScope: "selected",
        allowedSkills: [skillAction.toolName],
        skillAction,
        modelPolicy: { mode: "none" },
        evaluator: undefined,
      },
      decision({
        strategy: "skill-only",
        rationale: `Read-only ${skillAction.toolName} status can run through a deterministic tool call.`,
        confidence: "high",
        signals: [skillAction.toolName],
        steps: workflowSteps("skill-only"),
        graph: buildWorkflowGraph({ kind: "skill-only", text, policy, skillAction }),
      }),
    );
  }

  if (isNaturalCheapEscalationTask(text)) {
    const toolScope = cheapCheckToolScope(text, policy);
    const plannedPolicy: CronTaskExecutionPolicy = {
      ...policy,
      executionMode: "agent-turn",
      memoryScope: cheapCheckMemoryScope(policy),
      skillScope: toolScope.skillScope,
      allowedSkills: toolScope.allowedSkills,
      modelPolicy: { ...policy.modelPolicy, mode: "auto" },
      evaluator: {
        ...policy.evaluator,
        escalateOnSignal: true,
        signalIncludes: policy.evaluator?.signalIncludes ?? DEFAULT_ESCALATION_SIGNAL_INCLUDES,
        maxEscalations: policy.evaluator?.maxEscalations ?? 1,
      },
    };
    return planned(
      plannedPolicy,
      decision({
        strategy: "cheap-model",
        rationale: "Task asks for a lightweight first pass with escalation only when needed.",
        confidence: "high",
        signals: ["natural-escalation"],
        steps: workflowSteps("model"),
        graph: buildWorkflowGraph({ kind: "model", text, policy: plannedPolicy }),
      }),
    );
  }

  if (isStrongReasoningTask(text)) {
    return planned(
      {
        ...policy,
        executionMode: "agent-turn",
        memoryScope: policy.memoryScope ?? "search",
        skillScope: policy.skillScope ?? "agent-default",
        modelPolicy: { ...policy.modelPolicy, mode: "auto" },
        evaluator: undefined,
      },
      decision({
        strategy: "strong-model",
        rationale: "Task asks for research, analysis, planning, coding, or synthesis.",
        confidence: "medium",
        signals: ["reasoning"],
        steps: workflowSteps("model"),
        graph: buildWorkflowGraph({ kind: "model", text, policy }),
      }),
    );
  }

  if (isCheapModelTask(text)) {
    const toolScope = cheapCheckToolScope(text, policy);
    const plannedPolicy: CronTaskExecutionPolicy = {
      ...policy,
      executionMode: "agent-turn",
      memoryScope: cheapCheckMemoryScope(policy),
      skillScope: toolScope.skillScope,
      allowedSkills: toolScope.allowedSkills,
      modelPolicy: { ...policy.modelPolicy, mode: "auto" },
      evaluator: {
        ...policy.evaluator,
        escalateOnSignal: true,
        signalIncludes: policy.evaluator?.signalIncludes ?? DEFAULT_ESCALATION_SIGNAL_INCLUDES,
        maxEscalations: policy.evaluator?.maxEscalations ?? 1,
      },
    };
    return planned(
      plannedPolicy,
      decision({
        strategy: "cheap-model",
        rationale: "Task looks like a lightweight check or monitor loop.",
        confidence: "medium",
        signals: ["monitor"],
        steps: workflowSteps("model"),
        graph: buildWorkflowGraph({ kind: "model", text, policy: plannedPolicy }),
      }),
    );
  }

  return planned(
    {
      ...policy,
      executionMode: "agent-turn",
      memoryScope: policy.memoryScope ?? "session-summary",
      skillScope: policy.skillScope ?? "agent-default",
      modelPolicy: { ...policy.modelPolicy, mode: "agent-default" },
      evaluator: undefined,
    },
    decision({
      strategy: "agent-default",
      rationale: "No deterministic shortcut matched; use the Agent default model and tools.",
      confidence: "low",
      signals: ["default"],
      steps: workflowSteps("model"),
      graph: buildWorkflowGraph({ kind: "model", text, policy }),
    }),
  );
}

function normalizeRef(ref: string) {
  return ref.trim().toLowerCase();
}

function matchesAnyHint(ref: string, hints: readonly string[]) {
  const value = normalizeRef(ref);
  return hints.some((hint) => value.includes(hint));
}

function modelNameFromRef(ref: string): string {
  const parts = normalizeRef(ref).split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : (parts[0] ?? "");
}

function isAutoModelRef(ref: string): boolean {
  const modelName = modelNameFromRef(ref);
  return modelName === "auto" || modelName.endsWith("/auto");
}

export function choosePlannerModelRef(params: {
  strategy?: CronTaskPlannerStrategy;
  candidates: string[];
}): string | undefined {
  const candidates = Array.from(
    new Set(params.candidates.map((entry) => entry.trim()).filter(Boolean)),
  );
  if (candidates.length === 0) {
    return undefined;
  }
  if (params.strategy === "cheap-model") {
    const explicitCheap = candidates.find(
      (ref) => !isAutoModelRef(ref) && matchesAnyHint(ref, CHEAP_MODEL_HINTS),
    );
    if (explicitCheap) {
      return explicitCheap;
    }
    return undefined;
  }
  if (params.strategy === "strong-model") {
    return candidates.find((ref) => matchesAnyHint(ref, STRONG_MODEL_HINTS)) ?? candidates[0];
  }
  return undefined;
}
