import { describe, expect, it } from "vitest";
import {
  SOURCE_REPAIR_NODE_IDS,
  SOURCE_REPAIR_WEB_SEARCH_NODE_ID,
  applySourceGraphRepairToPolicy,
  choosePlannerModelRef,
  planTaskExecutionPolicy,
  stopSourcePathInPolicy,
  withTaskCoordinationRequest,
} from "./task-planner.js";

describe("planTaskExecutionPolicy", () => {
  it("turns direct reminders into no-model tasks", () => {
    const policy = planTaskExecutionPolicy({
      name: "Hydrate",
      message: "Remind me to drink water",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "no-model",
      memoryScope: "none",
      skillScope: "none",
      modelPolicy: { mode: "none" },
      planner: { strategy: "no-model", confidence: "high" },
    });
  });

  it("turns safe wallet status prompts into deterministic skill-only tasks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Check @wallet balance every hour",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "skill-only",
      memoryScope: "none",
      skillScope: "selected",
      allowedSkills: ["wallet"],
      skillAction: { toolName: "wallet", input: { action: "balance" } },
      modelPolicy: { mode: "none" },
      planner: { strategy: "skill-only", signals: ["wallet"] },
    });
  });

  it("turns natural mining status prompts into deterministic skill-only tasks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Check SAT mining status every 15 minutes and send here",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "skill-only",
      memoryScope: "none",
      skillScope: "selected",
      allowedSkills: ["mining"],
      skillAction: { toolName: "mining", input: { action: "status" } },
      modelPolicy: { mode: "none" },
      planner: { strategy: "skill-only", signals: ["mining"] },
    });
  });

  it("keeps AOM mining strategy tasks local to mining state and tool access", () => {
    const policy = planTaskExecutionPolicy({
      message:
        "AOM task: use @mining to analyze live net SOL cost, strategy, score, and benchmark, then set strategy only. Do not use wallet or payment tools. Do not call set_commit. No live web search.",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "agent-turn",
      memoryScope: "none",
      skillScope: "selected",
      allowedSkills: ["mining"],
      modelPolicy: { mode: "auto" },
      planner: { strategy: "strong-model", confidence: "high", signals: ["mining-strategy"] },
    });
    const nodeIds = policy.planner?.graph?.nodes.map((node) => node.id) ?? [];
    expect(nodeIds).toContain("source-fetch-mining");
    expect(nodeIds).not.toContain("source-fetch-web-search");
  });

  it("turns provider health prompts into gateway auth status tasks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Check provider health every hour",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "skill-only",
      allowedSkills: ["gateway"],
      skillAction: { toolName: "gateway", input: { action: "models.auth.status" } },
      modelPolicy: { mode: "none" },
      planner: { strategy: "skill-only", signals: ["gateway"] },
    });
  });

  it("materializes coordination intent as a task graph node", () => {
    const policy = planTaskExecutionPolicy({
      message: "Analyze architecture options and report",
      policy: {
        executionMode: "auto",
        coordination: {
          mode: "consult",
          agents: ["research", "support"],
          maxAgents: 2,
          requireApproval: false,
        },
      },
    });

    const graph = policy.planner?.graph;
    const coordinationNode = graph?.nodes.find((node) => node.id === "coordinate-agents");
    expect(coordinationNode).toMatchObject({
      kind: "coordination",
      label: "Consult Agents",
      dependsOn: ["model-analysis"],
      checkpointKeys: ["coordinationEvidence", "taskRoomEvidence", "approval"],
    });
    expect(graph?.nodes.find((node) => node.id === "validation")?.dependsOn).toEqual([
      "coordinate-agents",
    ]);
  });

  it("injects a coordination graph node into an existing task policy", () => {
    const base = planTaskExecutionPolicy({
      message: "Check provider health and send here",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    const policy = withTaskCoordinationRequest({
      policy: base,
      message: "Check provider health and send here",
      agents: ["research"],
      mode: "consult",
      requireApproval: true,
    });

    expect(policy.coordination).toMatchObject({
      mode: "consult",
      agents: ["research"],
      requireApproval: true,
    });
    expect(policy.planner?.graph?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "coordinate-agents" })]),
    );
  });

  it("turns model catalog prompts into gateway catalog status tasks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Check model catalog status every morning",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "skill-only",
      allowedSkills: ["gateway"],
      skillAction: { toolName: "gateway", input: { action: "models.catalog.status" } },
      planner: { strategy: "skill-only", signals: ["gateway"] },
    });
  });

  it("turns offers lookup prompts into deterministic skill-only tasks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Check offers in the marketplace every day",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "skill-only",
      allowedSkills: ["offers"],
      skillAction: { toolName: "offers", input: { action: "search" } },
      planner: { strategy: "skill-only", signals: ["offers"] },
    });
  });

  it("does not override explicit user task choices", () => {
    const policy = planTaskExecutionPolicy({
      message: "Remind me to check X",
      policy: {
        executionMode: "agent-turn",
        modelPolicy: { mode: "task-override", model: "openrouter/custom" },
      },
    });

    expect(policy).toEqual({
      executionMode: "agent-turn",
      modelPolicy: { mode: "task-override", model: "openrouter/custom" },
    });
  });

  it("replans policies that were previously auto-planned", () => {
    const policy = planTaskExecutionPolicy({
      message: "Research the issue",
      policy: {
        executionMode: "no-model",
        modelPolicy: { mode: "none" },
        planner: {
          source: "heuristic",
          strategy: "no-model",
          rationale: "old",
        },
      },
    });

    expect(policy).toMatchObject({
      executionMode: "agent-turn",
      modelPolicy: { mode: "auto" },
      planner: { strategy: "strong-model" },
    });
  });

  it("preserves explicit manual cheap-check evaluator policy", () => {
    const policy = planTaskExecutionPolicy({
      message: "Research the issue",
      policy: {
        executionMode: "auto",
        modelPolicy: { mode: "task-override", model: "openrouter/cheap" },
        evaluator: {
          escalateOnSignal: true,
          signalIncludes: ["ALERT"],
          maxEscalations: 2,
        },
        planner: {
          source: "heuristic",
          strategy: "cheap-model",
          rationale: "Manual cheap-check evaluator settings.",
          signals: ["manual-evaluator"],
        },
      },
    });

    expect(policy).toMatchObject({
      executionMode: "agent-turn",
      modelPolicy: { mode: "task-override", model: "openrouter/cheap" },
      evaluator: {
        escalateOnSignal: true,
        signalIncludes: ["ALERT"],
        maxEscalations: 2,
      },
      planner: { strategy: "cheap-model", signals: ["manual-evaluator"] },
    });
  });

  it("classifies deep work as a strong model task", () => {
    const policy = planTaskExecutionPolicy({
      message: "Research the issue and design an implementation plan",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "agent-turn",
      memoryScope: "search",
      modelPolicy: { mode: "auto" },
      planner: { strategy: "strong-model" },
    });
  });

  it("turns natural cheap-first escalation wording into evaluator policy", () => {
    const policy = planTaskExecutionPolicy({
      name: "Market watch",
      message:
        "Monitor market risk with a cheap check first and escalate if deeper analysis is needed.",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy).toMatchObject({
      executionMode: "agent-turn",
      memoryScope: "none",
      skillScope: "selected",
      allowedSkills: ["web_search"],
      modelPolicy: { mode: "auto" },
      evaluator: {
        escalateOnSignal: true,
        signalIncludes: ["Needs deeper analysis: yes"],
        maxEscalations: 1,
      },
      planner: { strategy: "cheap-model", confidence: "high", signals: ["natural-escalation"] },
    });
    expect(policy.planner?.steps?.map((step) => step.id)).toEqual([
      "collect",
      "analyze",
      "evaluate",
      "deliver",
    ]);
    expect(policy.planner?.steps?.find((step) => step.id === "analyze")).toMatchObject({
      usesModel: true,
      retryable: true,
    });
    expect(
      policy.planner?.steps
        ?.find((step) => step.id === "analyze")
        ?.substeps?.map((substep) => substep.id),
    ).toEqual(["plan-analysis", "execute-tool-or-model", "synthesize"]);
    expect(policy.planner?.graph).toMatchObject({
      version: 1,
      entryNodeId: "collect-data",
      terminalNodeIds: ["deliver"],
    });
    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toEqual([
      "collect-data",
      "source-fetch-web-search",
      "source-merge",
      "model-analysis",
      "validation",
      "synthesize",
      "deliver",
    ]);
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-fetch-web-search"),
    ).toMatchObject({
      kind: "tool",
      sourceRole: "primary",
      sourcePriority: 20,
      sourceFreshness: "live",
      sourceExpectedOutputType: "search-results",
      usesTool: true,
    });
  });

  it("creates compact deterministic graphs for skill-only tasks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Check mining status every 15 minutes",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toEqual([
      "collect-data",
      "tool-pass",
      "validation",
      "deliver",
    ]);
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "tool-pass")).toMatchObject({
      kind: "tool",
      usesTool: true,
    });
  });

  it("omits source and tool nodes for plain model tasks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Draft a concise status update",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toEqual([
      "collect-data",
      "model-analysis",
      "validation",
      "synthesize",
      "deliver",
    ]);
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "model-analysis")).toMatchObject(
      {
        dependsOn: ["collect-data"],
        usesModel: true,
      },
    );
  });

  it("adds source fetch for model tasks with explicit URLs", () => {
    const policy = planTaskExecutionPolicy({
      message: "Summarize https://example.com/report and explain the impact",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toContain("source-fetch-web-fetch");
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-fetch-web-fetch"),
    ).toMatchObject({
      sourceRole: "primary",
      sourcePriority: 10,
      sourceFreshness: "static",
      sourceExpectedOutputType: "document",
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "model-analysis")).toMatchObject(
      {
        dependsOn: ["source-merge"],
      },
    );
  });

  it("adds both source fetch and tool pass when model task asks for live source tool context", () => {
    const policy = planTaskExecutionPolicy({
      message: "Analyze live market risk with approved tool context",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toEqual([
      "collect-data",
      "source-fetch-web-search",
      "source-merge",
      "tool-pass",
      "model-analysis",
      "validation",
      "synthesize",
      "deliver",
    ]);
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-merge")).toMatchObject({
      dependsOn: ["source-fetch-web-search"],
      kind: "synthesize",
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "tool-pass")).toMatchObject({
      dependsOn: ["source-merge"],
      kind: "tool",
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "model-analysis")).toMatchObject(
      {
        dependsOn: ["tool-pass"],
        usesTool: true,
        usesModel: true,
      },
    );
  });

  it("fans out multiple source fetch nodes before a shared tool/model pass", () => {
    const policy = planTaskExecutionPolicy({
      message: "Analyze https://example.com/report with market context and approved tool context",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toEqual([
      "collect-data",
      "source-fetch-web-fetch",
      "source-fetch-web-search",
      "source-merge",
      "tool-pass",
      "model-analysis",
      "validation",
      "synthesize",
      "deliver",
    ]);
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-fetch-web-search"),
    ).toMatchObject({
      optional: true,
      sourceRole: "enrichment",
      sourcePriority: 80,
      sourceFreshness: "live",
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-merge")).toMatchObject({
      dependsOn: ["source-fetch-web-fetch", "source-fetch-web-search"],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "tool-pass")).toMatchObject({
      dependsOn: ["source-merge"],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "model-analysis")).toMatchObject(
      {
        dependsOn: ["tool-pass"],
      },
    );
  });

  it("prefers saved trusted source URLs before generic live search", () => {
    const policy = planTaskExecutionPolicy({
      message: "Check BTC and SOL market risk",
      trustedSources: [
        {
          id: "trusted-market-report",
          source: "https://example.com/market-risk",
          kind: "url",
          createdAtMs: 1,
          taskType: "market",
        },
      ],
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.trustedSources?.[0]?.source).toBe("https://example.com/market-risk");
    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toEqual([
      "collect-data",
      "source-fetch-trusted-market-report",
      "source-fetch-web-search",
      "source-merge",
      "model-analysis",
      "validation",
      "synthesize",
      "deliver",
    ]);
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-fetch-trusted-market-report"),
    ).toMatchObject({
      label: "Trusted source",
      sourceRole: "primary",
      sourcePriority: 5,
      sourceFreshness: "static",
      sourceUrl: "https://example.com/market-risk",
      trustedSourceId: "trusted-market-report",
    });
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-fetch-web-search"),
    ).toMatchObject({
      optional: true,
      sourceRole: "enrichment",
      sourcePriority: 80,
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-merge")).toMatchObject({
      dependsOn: ["source-fetch-trusted-market-report", "source-fetch-web-search"],
    });
  });

  it("keeps explicit live search required even when another primary source exists", () => {
    const policy = planTaskExecutionPolicy({
      message: "Search news about https://example.com/report and analyze the latest impact",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-fetch-web-search"),
    ).toMatchObject({
      optional: false,
      sourceRole: "primary",
      sourcePriority: 20,
      sourceFreshness: "live",
      sourceExpectedOutputType: "search-results",
    });
  });

  it("marks cross-check live sources as verification sources", () => {
    const policy = planTaskExecutionPolicy({
      message: "Verify https://example.com/report against live market sources",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toEqual([
      "collect-data",
      "source-fetch-web-fetch",
      "source-fetch-web-search",
      "source-merge",
      "source-verify",
      "model-analysis",
      "validation",
      "synthesize",
      "deliver",
    ]);
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-fetch-web-search"),
    ).toMatchObject({
      optional: false,
      sourceRole: "verification",
      sourcePriority: 40,
      sourceFreshness: "live",
      sourceExpectedOutputType: "search-results",
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-verify")).toMatchObject({
      kind: "validation",
      dependsOn: ["source-merge"],
      checkpointKeys: ["verificationStatus", "conflicts", "needsReview"],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "model-analysis")).toMatchObject(
      {
        dependsOn: ["source-verify"],
      },
    );
  });

  it("adds a repair source node and routes analysis through source verification", () => {
    const policy = planTaskExecutionPolicy({
      message: "Analyze https://example.com/report",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    expect(policy.planner?.graph?.nodes.map((node) => node.id)).not.toContain(
      SOURCE_REPAIR_WEB_SEARCH_NODE_ID,
    );
    const repair = applySourceGraphRepairToPolicy(policy, {
      action: "add_source",
      nodeId: SOURCE_REPAIR_WEB_SEARCH_NODE_ID,
      toolName: "web_search",
      reason: "Weak source quality with unavailable sources.",
      createdAtMs: 1,
    });

    expect(repair).toMatchObject({ applied: true });
    expect(policy.planner?.signals).toContain("graph-repair:source-quality");
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === SOURCE_REPAIR_WEB_SEARCH_NODE_ID),
    ).toMatchObject({
      kind: "tool",
      sourceRole: "verification",
      sourceFreshness: "live",
      sourceExpectedOutputType: "search-results",
      dependsOn: ["collect-data"],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-merge")).toMatchObject({
      dependsOn: ["source-fetch-web-fetch", SOURCE_REPAIR_WEB_SEARCH_NODE_ID],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-verify")).toMatchObject({
      dependsOn: ["source-merge"],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "model-analysis")).toMatchObject(
      {
        dependsOn: ["source-verify"],
      },
    );
  });

  it("adds provider repair sources as runtime catalog checks", () => {
    const policy = planTaskExecutionPolicy({
      message: "Summarize https://example.com/report and explain the impact",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    const repair = applySourceGraphRepairToPolicy(policy, {
      action: "add_source",
      nodeId: SOURCE_REPAIR_NODE_IDS.gateway,
      toolName: "gateway",
      reason: "Weak provider source quality.",
      createdAtMs: 1,
    });

    expect(repair).toMatchObject({ applied: true });
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === SOURCE_REPAIR_NODE_IDS.gateway),
    ).toMatchObject({
      label: "Repair provider catalog",
      sourceFreshness: "runtime",
      sourceExpectedOutputType: "provider-status",
      dependsOn: ["collect-data"],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-merge")).toMatchObject({
      dependsOn: ["source-fetch-web-fetch", SOURCE_REPAIR_NODE_IDS.gateway],
    });
  });

  it("replaces bad source nodes with repair nodes when requested", () => {
    const policy = planTaskExecutionPolicy({
      message: "Analyze live market risk with approved tool context",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    const repair = applySourceGraphRepairToPolicy(policy, {
      action: "replace_source",
      nodeId: SOURCE_REPAIR_NODE_IDS.gateway,
      toolName: "gateway",
      reason: "Provider runtime source is better than generic live search.",
      createdAtMs: 1,
      replacesNodeId: "source-fetch-web-search",
    });

    expect(repair).toMatchObject({
      applied: true,
      reason: `replaced source-fetch-web-search with ${SOURCE_REPAIR_NODE_IDS.gateway}`,
    });
    expect(policy.planner?.graph?.nodes.map((node) => node.id)).not.toContain(
      "source-fetch-web-search",
    );
    expect(policy.planner?.graph?.nodes.map((node) => node.id)).toContain(
      SOURCE_REPAIR_NODE_IDS.gateway,
    );
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "source-merge")).toMatchObject({
      dependsOn: [SOURCE_REPAIR_NODE_IDS.gateway],
    });
    expect(policy.planner?.graph?.nodes.find((node) => node.id === "tool-pass")).toMatchObject({
      dependsOn: ["source-verify"],
    });
  });

  it("stops a source path and removes downstream dependencies", () => {
    const policy = planTaskExecutionPolicy({
      message: "Analyze live market risk with approved tool context",
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    });

    const stopped = stopSourcePathInPolicy(policy, "source-fetch-web-search");

    expect(stopped).toMatchObject({
      applied: true,
      graphRevision: 2,
      parentRevision: 1,
      repairRevision: 1,
      reason: "stopped source path source-fetch-web-search",
    });
    expect(policy.planner?.signals).toContain(
      "graph-repair:source-stopped:source-fetch-web-search",
    );
    expect(policy.planner?.graph?.nodes.map((node) => node.id)).not.toContain(
      "source-fetch-web-search",
    );
    expect(
      policy.planner?.graph?.nodes.find((node) => node.id === "source-merge")?.dependsOn,
    ).toBeUndefined();
    expect(policy.planner?.graph).toMatchObject({
      graphRevision: 2,
      parentRevision: 1,
      repairRevision: 1,
    });
  });
});

describe("choosePlannerModelRef", () => {
  it("picks cheaper-looking candidates only from the Agent model list", () => {
    expect(
      choosePlannerModelRef({
        strategy: "cheap-model",
        candidates: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
      }),
    ).toBe("openai/gpt-5.4-mini");
  });

  it("does not treat auto routers as cheap models", () => {
    expect(
      choosePlannerModelRef({
        strategy: "cheap-model",
        candidates: ["openrouter/auto"],
      }),
    ).toBeUndefined();
  });

  it("uses the primary model as strong fallback when no obvious strong hint exists", () => {
    expect(
      choosePlannerModelRef({
        strategy: "strong-model",
        candidates: ["openrouter/custom-model", "openai/gpt-5.4-mini"],
      }),
    ).toBe("openrouter/custom-model");
  });
});
