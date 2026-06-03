import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronListParams,
  validateCronQueueControlParams,
  validateCronRepairParams,
  validateCronRemoveParams,
  validateCronRunDetailParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronSourcesListParams,
  validateCronSourcesRemoveParams,
  validateCronSourcesUpdateParams,
  validateCronUpdateParams,
} from "./index.js";

const minimalAddParams = {
  name: "daily-summary",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "tick" },
} as const;

describe("cron protocol validators", () => {
  it("accepts minimal add params", () => {
    expect(validateCronAddParams(minimalAddParams)).toBe(true);
  });

  it("accepts persisted task failure alert settings on add and update", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        failureAlert: {
          after: 2,
          cooldownMs: 300_000,
          channel: "telegram",
          to: "397848047",
          mode: "announce",
          accountId: "bot-main",
        },
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          failureAlert: false,
        },
      }),
    ).toBe(true);
  });

  it("accepts task execution policy metadata on add and update", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        executionPolicy: {
          triggerKind: "schedule",
          executionMode: "auto",
          memoryScope: "session-summary",
          skillScope: "selected",
          allowedSkills: ["web.search"],
          skillAction: {
            toolName: "$web_search",
            input: { query: "btc sol risk" },
          },
          modelPolicy: {
            mode: "task-override",
            model: "openrouter/test",
            thinking: "low",
            escalationModel: "openai/gpt-5.5",
          },
          coordination: {
            mode: "consult",
            agents: ["research", "support"],
            maxAgents: 2,
            requireApproval: true,
          },
          budget: {
            maxTokensPerRun: 1000,
            maxCostUsdPerRun: 0.05,
            maxRunsPerHour: 12,
          },
          repairPolicy: {
            autoRetryReplacement: true,
            autoStopOptionalSources: false,
            maxAutoRepairsPerRun: 1,
            requireApprovalForPrimarySource: true,
          },
          planner: {
            source: "heuristic",
            strategy: "strong-model",
            rationale: "test graph",
            confidence: "medium",
            graph: {
              version: 1,
              graphRevision: 2,
              parentRevision: 1,
              repairRevision: 1,
              entryNodeId: "source-fetch-web-search",
              terminalNodeIds: ["deliver"],
              nodes: [
                {
                  id: "source-fetch-web-search",
                  label: "Web search",
                  kind: "collect",
                  optional: false,
                  sourceRole: "primary",
                  sourcePriority: 1,
                  sourceFreshness: "live",
                  sourceExpectedOutputType: "market evidence",
                  sourceLabel: "web search",
                  usesTool: true,
                },
                {
                  id: "coordinate-agents",
                  label: "Consult Agents",
                  kind: "coordination",
                  dependsOn: ["source-fetch-web-search"],
                  usesModel: true,
                },
                {
                  id: "deliver",
                  label: "Deliver",
                  kind: "deliver",
                  dependsOn: ["coordinate-agents"],
                },
              ],
            },
          },
        },
      }),
    ).toBe(true);
    expect(validateCronUpdateParams({ id: "job-1", patch: { executionPolicy: null } })).toBe(true);
  });

  it("accepts graph repair task state on update", () => {
    expect(
      validateCronUpdateParams({
        id: "job-graph-repair",
        patch: {
          state: {
            lastRunStatus: "blocked",
            lastStatus: "blocked",
            stopReason: "needsSources:needs_user_source",
            graphRevision: 2,
            repairRevision: 1,
            graphRepairAttempts: 1,
            graphRepairSourceAttempts: {
              "source-fetch-web-search": 1,
            },
            graphRepairRoleAttempts: {
              primary: 1,
            },
            lastGraphRepairStop: {
              code: "needs_user_source",
              reason: "Add a trusted source before retrying.",
              atMs: 1_000,
              sourceNodeId: "source-fetch-web-search",
              sourceRole: "primary",
            },
            lastGraphRepair: {
              action: "replace_source",
              nodeId: "source-fetch-gateway",
              toolName: "gateway",
              reason: "Provider health should use gateway runtime status.",
              createdAtMs: 1_000,
              replacesNodeId: "source-fetch-web-search",
              graphRevision: 2,
              parentRevision: 1,
              repairRevision: 1,
              reusedNodeIds: ["model-analysis"],
              invalidatedNodeIds: ["source-fetch-web-search"],
              requeuedNodeIds: ["source-fetch-gateway"],
              applied: true,
            },
            lastGraphRepairReplay: {
              runId: "run-repair",
              parentRunId: "run-parent",
              graphRevision: 2,
              parentRevision: 1,
              repairRevision: 1,
              repairAttempt: 1,
              maxRepairAttempts: 2,
              repairedAtMs: 1_000,
              reusedNodeIds: ["model-analysis"],
              invalidatedNodeIds: ["source-fetch-web-search"],
              requeuedNodeIds: ["source-fetch-gateway"],
              reason: "replaced source",
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects add params when required scheduling fields are missing", () => {
    const { wakeMode: _wakeMode, ...withoutWakeMode } = minimalAddParams;
    expect(validateCronAddParams(withoutWakeMode)).toBe(false);
  });

  it("accepts update params for id and jobId selectors", () => {
    expect(validateCronUpdateParams({ id: "job-1", patch: { enabled: false } })).toBe(true);
    expect(validateCronUpdateParams({ jobId: "job-2", patch: { enabled: true } })).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-3",
        patch: {
          executionPolicy: {
            executionMode: "skill-only",
            skillScope: "selected",
            allowedSkills: ["wallet"],
            skillAction: {
              toolName: "$wallet_balance",
              input: { wallet: "default" },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("accepts remove params for id and jobId selectors", () => {
    expect(validateCronRemoveParams({ id: "job-1" })).toBe(true);
    expect(validateCronRemoveParams({ jobId: "job-2" })).toBe(true);
  });

  it("accepts run params mode for id and jobId selectors", () => {
    expect(validateCronRunParams({ id: "job-1", mode: "force" })).toBe(true);
    expect(validateCronRunParams({ jobId: "job-2", mode: "due" })).toBe(true);
  });

  it("accepts queue control params", () => {
    expect(validateCronQueueControlParams({ runId: "run-1" })).toBe(true);
    expect(validateCronQueueControlParams({ runId: "run-1", reason: "retry now" })).toBe(true);
    expect(validateCronQueueControlParams({})).toBe(false);
  });

  it("accepts task repair recovery params", () => {
    expect(validateCronRepairParams({ id: "job-1", action: "retry_replacement" })).toBe(true);
    expect(
      validateCronRepairParams({
        jobId: "job-2",
        action: "add_trusted_source",
        source: "https://example.com/report",
      }),
    ).toBe(true);
    expect(
      validateCronRepairParams({
        id: "job-3",
        action: "stop_source_path",
        sourceNodeId: "source-fetch-web-search",
      }),
    ).toBe(true);
    expect(validateCronRepairParams({ id: "job-4", action: "bad" })).toBe(false);
    expect(validateCronRepairParams({ action: "retry_replacement" })).toBe(false);
  });

  it("accepts trusted source memory params", () => {
    expect(
      validateCronSourcesListParams({
        includeInactive: true,
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:123",
        taskType: "market",
        query: "btc",
      }),
    ).toBe(true);
    expect(validateCronSourcesUpdateParams({ id: "trusted-1", active: false })).toBe(true);
    expect(validateCronSourcesRemoveParams({ id: "trusted-1" })).toBe(true);
    expect(validateCronSourcesUpdateParams({ id: "trusted-1" })).toBe(false);
    expect(validateCronSourcesRemoveParams({ id: "" })).toBe(false);
  });

  it("accepts list paging/filter/sort params", () => {
    expect(
      validateCronListParams({
        includeDisabled: true,
        limit: 50,
        offset: 0,
        query: "daily",
        enabled: "all",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      }),
    ).toBe(true);
    expect(validateCronListParams({ offset: -1 })).toBe(false);
  });

  it("enforces runs limit minimum for id and jobId selectors", () => {
    expect(validateCronRunsParams({ id: "job-1", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", limit: 0 })).toBe(false);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 0 })).toBe(false);
  });

  it("validates cron.runDetail params", () => {
    expect(validateCronRunDetailParams({ runId: "run-1" })).toBe(true);
    expect(validateCronRunDetailParams({ runId: "" })).toBe(false);
    expect(validateCronRunDetailParams({ runId: "run-1", extra: true })).toBe(false);
  });

  it("rejects cron.runs path traversal ids", () => {
    expect(validateCronRunsParams({ id: "../job-1" })).toBe(false);
    expect(validateCronRunsParams({ id: "nested/job-1" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "..\\job-2" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "nested\\job-2" })).toBe(false);
  });

  it("accepts runs paging/filter/sort params", () => {
    expect(
      validateCronRunsParams({
        id: "job-1",
        limit: 50,
        offset: 0,
        status: "error",
        query: "timeout",
        sortDir: "desc",
      }),
    ).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", offset: -1 })).toBe(false);
  });

  it("accepts all-scope runs with multi-select filters", () => {
    expect(
      validateCronRunsParams({
        scope: "all",
        limit: 25,
        statuses: ["ok", "error"],
        deliveryStatuses: ["delivered", "not-requested"],
        query: "fail",
        sortDir: "desc",
      }),
    ).toBe(true);
    expect(
      validateCronRunsParams({
        scope: "job",
        statuses: [],
      }),
    ).toBe(false);
  });
});
