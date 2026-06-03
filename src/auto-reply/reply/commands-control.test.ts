import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../../config/sessions.js";
import { appendCronRunLog, resolveCronRunLogPath } from "../../cron/run-log.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const writeConfigFileMock = vi.hoisted(() => vi.fn());
const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

const { handleControlCommands } = await import("./commands-control.js");
const { handleSessionCommand } = await import("./commands-session.js");

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-control-commands-"));
  writeConfigFileMock.mockClear();
  callGatewayMock.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tempDir, { recursive: true, force: true });
});

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-main",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeCronJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    agentId: "research",
    sessionKey: "agent:research:telegram:direct:123",
    name: "Market watch",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "check markets" },
    delivery: { mode: "announce", channel: "telegram", to: "123" },
    state: {},
    ...overrides,
  };
}

describe("channel command control", () => {
  it("writes a per-peer route binding when /agent switch runs in a channel", async () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "research", name: "Research" },
        ],
      },
      commands: { text: true },
    } satisfies FasedAgentConfig;
    const params = buildCommandTestParams("/agent switch Research", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      From: "telegram:123",
      To: "telegram:123",
      SessionKey: "agent:main:main",
      ChatType: "direct",
    });
    params.agentId = "main";

    const result = await handleControlCommands(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Agent switched to Research");
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const written = writeConfigFileMock.mock.calls[0]?.[0] as FasedAgentConfig;
    expect(written.bindings).toEqual([
      {
        agentId: "research",
        comment: "Set from /agent switch.",
        match: { channel: "telegram", peer: { kind: "direct", id: "123" } },
      },
    ]);
  });

  it("accepts the Assistant display name for the default main Agent", async () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "research", name: "Research" },
        ],
      },
      commands: { text: true },
    } satisfies FasedAgentConfig;
    const params = buildCommandTestParams("/agent switch Assistant", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      From: "telegram:123",
      To: "telegram:123",
      SessionKey: "agent:research:telegram:direct:123",
      ChatType: "direct",
    });
    params.agentId = "research";

    const result = await handleControlCommands(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Agent switched to Assistant");
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const written = writeConfigFileMock.mock.calls[0]?.[0] as FasedAgentConfig;
    expect(written.bindings).toEqual([
      {
        agentId: "main",
        comment: "Set from /agent switch.",
        match: { channel: "telegram", peer: { kind: "direct", id: "123" } },
      },
    ]);
  });

  it("creates, lists, and switches named sessions for the current channel route", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    const baseKey = "agent:main:telegram:direct:123";
    await saveSessionStore(storePath, {
      [baseKey]: makeSessionEntry({
        sessionId: "session-base",
        chatType: "direct",
        lastChannel: "telegram",
        lastTo: "123",
      }),
    });
    const cfg = { commands: { text: true } } satisfies FasedAgentConfig;

    const createParams = buildCommandTestParams("/session new Market Watch", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: baseKey,
    });
    createParams.storePath = storePath;
    createParams.sessionKey = baseKey;
    createParams.sessionStore = loadSessionStore(storePath, { skipCache: true });
    createParams.sessionEntry = createParams.sessionStore[baseKey];

    const createResult = await handleSessionCommand(createParams, true);

    expect(createResult?.reply?.text).toContain('Created session "Market Watch"');
    const afterCreate = loadSessionStore(storePath, { skipCache: true });
    const activeKey = afterCreate[baseKey]?.activeSessionKey;
    expect(activeKey).toBeTruthy();
    expect(afterCreate[activeKey!]?.baseSessionKey).toBe(baseKey);
    expect(afterCreate[activeKey!]?.displayName).toBe("Market Watch");

    const listParams = buildCommandTestParams("/session list", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: baseKey,
    });
    listParams.storePath = storePath;
    listParams.sessionKey = baseKey;
    listParams.sessionStore = loadSessionStore(storePath, { skipCache: true });
    listParams.sessionEntry = listParams.sessionStore[baseKey];

    const listResult = await handleSessionCommand(listParams, true);
    expect(listResult?.reply?.text).toContain("Market Watch");
    expect(listResult?.reply?.text).toContain("active");

    const switchParams = buildCommandTestParams("/session switch main", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: baseKey,
    });
    switchParams.storePath = storePath;
    switchParams.sessionKey = baseKey;
    switchParams.sessionStore = loadSessionStore(storePath, { skipCache: true });
    switchParams.sessionEntry = switchParams.sessionStore[baseKey];

    const switchResult = await handleSessionCommand(switchParams, true);
    expect(switchResult?.reply?.text).toContain("Switched back to Main");
    const afterSwitch = loadSessionStore(storePath, { skipCache: true });
    expect(afterSwitch[baseKey]?.activeSessionKey).toBeUndefined();
  });

  it("lists session tasks and cancels tasks owned by the current Agent", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000 - 757_000);
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({
          id: "job-session",
          sessionKey: "agent:research:telegram:direct:123",
          delivery: { mode: "announce", channel: "telegram", to: "123" },
          executionPolicy: {
            triggerKind: "schedule",
            executionMode: "agent-turn",
            memoryScope: "session-summary",
            skillScope: "agent-default",
            modelPolicy: { mode: "auto", escalationModel: "openrouter/strong" },
            coordination: {
              mode: "consult",
              agents: ["support"],
              maxAgents: 1,
              requireApproval: true,
            },
            planner: {
              source: "heuristic",
              strategy: "cheap-model",
              rationale: "cheap",
              signals: ["natural-escalation"],
            },
            evaluator: { escalateOnSignal: true, signalIncludes: ["Needs deeper analysis: yes"] },
          },
          state: {
            nextRunAtMs: 1_800_000_000_000,
            lastRunStatus: "ok",
            lastDeliveryStatus: "delivered",
            lastEvaluatorDecision: {
              source: "heuristic",
              action: "escalate",
              reason: "Matched escalation cue.",
              signal: "Needs deeper analysis: yes",
            },
          },
        }),
        makeCronJob({
          id: "job-disabled",
          sessionKey: "agent:research:telegram:direct:123",
          enabled: false,
          state: {
            lastRunStatus: "blocked",
            needsAccess: {
              code: "missing_credential",
              service: "task_access",
              reason: "Task requires a missing credential or access token.",
              setupPath: "/services",
              source: "run-output",
              detectedAtMs: 1_800_000_000_000,
            },
          },
        }),
        makeCronJob({ id: "job-agent", sessionKey: "agent:research:main" }),
        makeCronJob({ id: "job-other", agentId: "support", sessionKey: "agent:support:main" }),
      ],
    });
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const params = buildCommandTestParams("/task list", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    });
    params.agentId = "research";
    params.sessionKey = "agent:research:telegram:direct:123";

    const listResult = await handleControlCommands(params, true);
    expect(listResult?.reply?.text).toContain("job-session");
    expect(listResult?.reply?.text).toContain("cheap check");
    expect(listResult?.reply?.text).toContain("telegram -> 123");
    expect(listResult?.reply?.text).toContain("active");
    expect(listResult?.reply?.text).toContain("next in 12m 37s");
    expect(listResult?.reply?.text).not.toContain("757s");
    expect(listResult?.reply?.text).not.toContain("job-disabled");
    expect(listResult?.reply?.text).not.toContain("job-agent");

    const showParams = buildCommandTestParams("/task show job-session", cfg, {
      SessionKey: "agent:research:telegram:direct:123",
    });
    showParams.agentId = "research";
    showParams.sessionKey = "agent:research:telegram:direct:123";
    const showResult = await handleControlCommands(showParams, true);
    expect(showResult?.reply?.text).toContain("Task: Market watch");
    expect(showResult?.reply?.text).toContain("Policy: cheap check");
    expect(showResult?.reply?.text).toContain("Model: auto · escalation openrouter/strong");
    expect(showResult?.reply?.text).toContain(
      "Coordination: consult support · max 1 · approval required",
    );
    expect(showResult?.reply?.text).toContain("Delivery: telegram -> 123");

    const listAllParams = buildCommandTestParams("/task list all", cfg, {
      SessionKey: "agent:research:telegram:direct:123",
    });
    listAllParams.agentId = "research";
    listAllParams.sessionKey = "agent:research:telegram:direct:123";
    const listAllResult = await handleControlCommands(listAllParams, true);
    expect(listAllResult?.reply?.text).toContain("Active");
    expect(listAllResult?.reply?.text).toContain("Inactive");
    expect(listAllResult?.reply?.text).toContain("job-agent");
    expect(listAllResult?.reply?.text).toContain("job-disabled");
    expect(listAllResult?.reply?.text).toContain("needs access");
    expect(String(listAllResult?.reply?.text).indexOf("Active")).toBeLessThan(
      String(listAllResult?.reply?.text).indexOf("Inactive"),
    );

    const cancelParams = buildCommandTestParams("/task cancel job-agent", cfg, {
      SessionKey: "agent:research:telegram:direct:123",
    });
    cancelParams.agentId = "research";
    cancelParams.sessionKey = "agent:research:telegram:direct:123";
    const cancelResult = await handleControlCommands(cancelParams, true);
    expect(cancelResult?.reply?.text).toContain("Canceled task job-agent");
    const afterCancel = await loadCronStore(cronPath);
    expect(afterCancel.jobs.map((job) => job.id)).toEqual([
      "job-session",
      "job-disabled",
      "job-other",
    ]);
  });

  it("force-runs a task owned by the current Agent through the gateway", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({ id: "job-session", sessionKey: "agent:research:telegram:direct:123" }),
        makeCronJob({ id: "job-other", agentId: "support", sessionKey: "agent:support:main" }),
      ],
    });
    callGatewayMock.mockResolvedValueOnce({ ok: true, ran: true });
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
      gateway: { mode: "local", auth: { token: "config-token" } },
    } satisfies FasedAgentConfig;
    const params = buildCommandTestParams("/task run job-session", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    });
    params.agentId = "research";
    params.sessionKey = "agent:research:telegram:direct:123";

    const runResult = await handleControlCommands(params, true);

    expect(runResult?.reply?.text).toContain("Ran task job-session");
    expect(runResult?.reply?.text).toContain("Use /task show job-session for details");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.run",
        token: "config-token",
        params: { id: "job-session", mode: "force" },
        timeoutMs: 120_000,
      }),
    );

    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValueOnce({ ok: true, ran: true });
    const shellStyleParams = buildCommandTestParams("fased task run job-session", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    });
    shellStyleParams.agentId = "research";
    shellStyleParams.sessionKey = "agent:research:telegram:direct:123";

    const shellStyleResult = await handleControlCommands(shellStyleParams, true);

    expect(shellStyleResult?.reply?.text).toContain("Ran task job-session");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.run",
        token: "config-token",
        params: { id: "job-session", mode: "force" },
        timeoutMs: 120_000,
      }),
    );

    const blockedParams = buildCommandTestParams("/task run job-other", cfg, {
      SessionKey: "agent:research:telegram:direct:123",
    });
    blockedParams.agentId = "research";
    blockedParams.sessionKey = "agent:research:telegram:direct:123";

    const blockedResult = await handleControlCommands(blockedParams, true);

    expect(blockedResult?.reply?.text).toContain("belongs to another Agent/session");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("approves coordination for a task owned by the current Agent and runs it", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({
          id: "job-session",
          sessionKey: "agent:research:telegram:direct:123",
          executionPolicy: {
            coordination: {
              mode: "consult",
              agents: ["support"],
              requireApproval: true,
            },
          },
        }),
        makeCronJob({ id: "job-other", agentId: "support", sessionKey: "agent:support:main" }),
      ],
    });
    callGatewayMock.mockResolvedValueOnce(makeCronJob({ id: "job-session" }));
    callGatewayMock.mockResolvedValueOnce({ ok: true, ran: true });
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
      gateway: { mode: "local", auth: { token: "config-token" } },
    } satisfies FasedAgentConfig;
    const params = buildCommandTestParams("/task approve job-session", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    });
    params.agentId = "research";
    params.sessionKey = "agent:research:telegram:direct:123";

    const result = await handleControlCommands(params, true);

    expect(result?.reply?.text).toContain("Approved coordination for task job-session");
    expect(result?.reply?.text).toContain("Use /task last job-session");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "cron.update",
        token: "config-token",
        params: {
          id: "job-session",
          patch: { state: { coordinationApprovedAtMs: 1_800_000_000_000 } },
        },
        timeoutMs: 30_000,
      }),
    );
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "cron.run",
        token: "config-token",
        params: { id: "job-session", mode: "force" },
        timeoutMs: 120_000,
      }),
    );

    const blockedParams = buildCommandTestParams("/task approve job-other", cfg, {
      SessionKey: "agent:research:telegram:direct:123",
    });
    blockedParams.agentId = "research";
    blockedParams.sessionKey = "agent:research:telegram:direct:123";

    const blockedResult = await handleControlCommands(blockedParams, true);

    expect(blockedResult?.reply?.text).toContain("belongs to another Agent/session");
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("asks selected Agents for task-room evidence from a channel task", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({
          id: "job-session",
          sessionKey: "agent:research:telegram:direct:123",
          payload: { kind: "agentTurn", message: "Check sources" },
          executionPolicy: { executionMode: "agent-turn" },
        }),
      ],
    });
    callGatewayMock.mockResolvedValueOnce(makeCronJob({ id: "job-session" }));
    callGatewayMock.mockResolvedValueOnce({ ok: true, ran: true });
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
      gateway: { mode: "local", auth: { token: "config-token" } },
    } satisfies FasedAgentConfig;
    const params = buildCommandTestParams("/task ask job-session --agent support", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    });
    params.agentId = "research";
    params.sessionKey = "agent:research:telegram:direct:123";

    const result = await handleControlCommands(params, true);

    vi.useRealTimers();
    expect(result?.reply?.text).toContain("Queued Agent evidence and started a run");
    expect(result?.reply?.text).toContain("Agents: support");
    const updateParams = callGatewayMock.mock.calls[0]?.[0].params as {
      patch?: {
        executionPolicy?: { coordination?: unknown; planner?: { graph?: { nodes?: unknown[] } } };
        state?: unknown;
      };
    };
    expect(updateParams).toMatchObject({
      id: "job-session",
      patch: {
        executionPolicy: {
          coordination: { mode: "consult", agents: ["support"], requireApproval: true },
        },
        state: {
          pendingCoordination: { agents: ["support"], signal: "manual_agent_request" },
          coordinationApprovedAtMs: 1_800_000_000_000,
        },
      },
    });
    expect(updateParams.patch?.executionPolicy?.planner?.graph?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "coordinate-agents" })]),
    );
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "cron.run",
        token: "config-token",
        params: { id: "job-session", mode: "force" },
        timeoutMs: 120_000,
      }),
    );
  });

  it("shows recent task runs and latest run details for the current Agent", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({
          id: "job-session",
          sessionKey: "agent:research:telegram:direct:123",
          state: {
            lastRunCheckpoint: { runId: "run-session-2" },
            evaluatorLastSignal: "Needs deeper analysis: yes",
            lastGraphRepairs: [
              {
                action: "replace_source",
                nodeId: "source-fetch-repair-gateway-for-web-search",
                toolName: "gateway",
                reason: "Weak source quality with unavailable sources.",
                createdAtMs: 1_800_000_000_000 - 9_000,
                replacesNodeId: "source-fetch-web-search",
                applied: true,
                applyReason:
                  "replaced source-fetch-web-search with source-fetch-repair-gateway-for-web-search",
              },
            ],
          },
        }),
        makeCronJob({ id: "job-other", agentId: "support", sessionKey: "agent:support:main" }),
      ],
    });
    const logPath = resolveCronRunLogPath({ storePath: cronPath, jobId: "job-session" });
    await appendCronRunLog(logPath, {
      ts: 1_800_000_000_000 - 60_000,
      jobId: "job-session",
      action: "finished",
      status: "ok",
      deliveryStatus: "delivered",
      durationMs: 2_500,
      summary: "mining ok",
      sessionId: "run-session-1",
      sessionKey: "agent:research:cron:job-session:run:run-session-1",
      policy: {
        requestedExecutionMode: "auto",
        effectiveExecutionMode: "skill-only",
        resultSource: "direct-tool",
        resultAdapter: "mining-status",
        modelUsed: false,
        planner: {
          source: "heuristic",
          strategy: "skill-only",
          rationale: "mining status can run without a model",
        },
      },
    });
    await appendCronRunLog(logPath, {
      ts: 1_800_000_000_000 - 20_000,
      jobId: "job-session",
      action: "finished",
      status: "ok",
      deliveryStatus: "delivered",
      durationMs: 1_500,
      summary: "Needs deeper analysis: yes",
      sessionId: "run-session-escalate",
      sessionKey: "agent:research:cron:job-session:run:run-session-escalate",
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      model: "openrouter/cheap",
      policy: {
        requestedExecutionMode: "agent-turn",
        effectiveExecutionMode: "agent-turn",
        resultSource: "model",
        modelUsed: true,
        modelSource: "Agent cheap/check role",
        evaluator: {
          source: "heuristic",
          action: "escalate",
          reason: "Escalation cue found.",
          signal: "Needs deeper analysis: yes",
        },
        runCheckpoint: {
          runId: "run-session-escalate",
          phase: "finished",
        },
      },
    });
    await appendCronRunLog(logPath, {
      ts: 1_800_000_000_000 - 10_000,
      jobId: "job-session",
      action: "finished",
      status: "ok",
      deliveryStatus: "delivered",
      durationMs: 1_250,
      summary: "provider ok",
      sessionId: "run-session-2",
      sessionKey: "agent:research:cron:job-session:run:run-session-2",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      model: "openrouter/auto",
      policy: {
        requestedExecutionMode: "agent-turn",
        effectiveExecutionMode: "agent-turn",
        resultSource: "model",
        modelUsed: true,
        modelOverride: "openrouter/auto",
        modelSource: "Agent escalation role",
        skillScope: "selected",
        skills: {
          count: 2,
          names: ["Wallet", "Mining"],
          skillFilter: ["wallet", "mining"],
        },
        evaluator: {
          source: "heuristic",
          action: "none",
          reason: "Escalation follow-up completed.",
        },
        runCheckpoint: {
          runId: "run-session-2",
          phase: "finished",
        },
      },
    });
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const baseCtx = {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    };
    const runsParams = buildCommandTestParams("/task runs job-session", cfg, baseCtx);
    runsParams.agentId = "research";
    runsParams.sessionKey = "agent:research:telegram:direct:123";

    const runsResult = await handleControlCommands(runsParams, true);

    expect(runsResult?.reply?.text).toContain("Runs: Market watch");
    expect(runsResult?.reply?.text).toContain("model openrouter/auto");
    expect(runsResult?.reply?.text).toContain("direct tool mining-status");
    expect(runsResult?.reply?.text).toContain("delivery sent");

    const lastParams = buildCommandTestParams("/task last job-session", cfg, baseCtx);
    lastParams.agentId = "research";
    lastParams.sessionKey = "agent:research:telegram:direct:123";

    const lastResult = await handleControlCommands(lastParams, true);

    expect(lastResult?.reply?.text).toContain("Latest run: Market watch");
    expect(lastResult?.reply?.text).toContain("Source: model openrouter/auto");
    expect(lastResult?.reply?.text).toContain("Usage: tokens 15 total");
    expect(lastResult?.reply?.text).toContain(
      "Skills: Narrow selected · 2 loaded · Wallet, Mining",
    );
    expect(lastResult?.reply?.text).toContain("Evaluator: none");
    expect(lastResult?.reply?.text).toContain(
      'Escalation: follow-up completed · trigger run run-session-escalate · cue "Needs deeper analysis: yes"',
    );
    expect(lastResult?.reply?.text).toContain(
      "Cheap pass: model openrouter/cheap · Agent cheap/check role · 110 tok · 100 in · 10 out",
    );
    expect(lastResult?.reply?.text).toContain(
      "Escalation pass: model openrouter/auto · Agent escalation role · 15 tok · 10 in · 5 out",
    );
    expect(lastResult?.reply?.text).toContain("Source repair:");
    expect(lastResult?.reply?.text).toContain(
      "replace source-fetch-web-search -> source-fetch-repair-gateway-for-web-search · gateway · applied",
    );
    expect(lastResult?.reply?.text).toContain(
      "Transcript: /chat?session=agent%3Aresearch%3Acron%3Ajob-session%3Arun%3Arun-session-2",
    );

    const blockedParams = buildCommandTestParams("/task last job-other", cfg, baseCtx);
    blockedParams.agentId = "research";
    blockedParams.sessionKey = "agent:research:telegram:direct:123";

    const blockedResult = await handleControlCommands(blockedParams, true);

    expect(blockedResult?.reply?.text).toContain("belongs to another Agent/session");
  });

  it("shows retry hints for failed task runs and controls scoped queue runs", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({ id: "job-session", sessionKey: "agent:research:telegram:direct:123" }),
        makeCronJob({ id: "job-other", agentId: "support", sessionKey: "agent:support:main" }),
      ],
    });
    const queuePath = path.join(tempDir, "cron", "task-runs", "queue.json");
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(
      queuePath,
      JSON.stringify({
        version: 1,
        runs: [
          {
            runId: "run-blocked",
            jobId: "job-session",
            jobName: "Market watch",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 1,
            queuedAtMs: 1,
            steps: [
              { id: "execute", status: "blocked", attempt: 1, maxAttempts: 2, createdAtMs: 1 },
            ],
          },
          {
            runId: "run-other",
            jobId: "job-other",
            jobName: "Other task",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 1,
            queuedAtMs: 1,
            steps: [
              { id: "execute", status: "blocked", attempt: 1, maxAttempts: 2, createdAtMs: 1 },
            ],
          },
        ],
      }),
      "utf-8",
    );
    const logPath = resolveCronRunLogPath({ storePath: cronPath, jobId: "job-session" });
    await appendCronRunLog(logPath, {
      ts: Date.now(),
      jobId: "job-session",
      action: "finished",
      status: "blocked",
      error: "Missing API key",
      policy: {
        runCheckpoint: {
          runId: "run-blocked",
          phase: "finished",
          trigger: "manual",
          attempt: 1,
        },
      },
    });
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const baseCtx = {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    };
    const runsParams = buildCommandTestParams("/task runs job-session", cfg, baseCtx);
    runsParams.agentId = "research";
    runsParams.sessionKey = "agent:research:telegram:direct:123";

    const runsResult = await handleControlCommands(runsParams, true);

    expect(runsResult?.reply?.text).toContain("retry with /task retry-run run-blocked");

    const lastParams = buildCommandTestParams("/task last job-session", cfg, baseCtx);
    lastParams.agentId = "research";
    lastParams.sessionKey = "agent:research:telegram:direct:123";

    const lastResult = await handleControlCommands(lastParams, true);

    expect(lastResult?.reply?.text).toContain("Run: run-blocked");
    expect(lastResult?.reply?.text).toContain("Recovery: retry with /task retry-run run-blocked");

    const showRunParams = buildCommandTestParams("/task run-show run-blocked", cfg, baseCtx);
    showRunParams.agentId = "research";
    showRunParams.sessionKey = "agent:research:telegram:direct:123";

    const showRunResult = await handleControlCommands(showRunParams, true);

    expect(showRunResult?.reply?.text).toContain("Run: run-blocked");
    expect(showRunResult?.reply?.text).toContain("Task: Market watch (job-session)");
    expect(showRunResult?.reply?.text).toContain("Status: blocked");
    expect(showRunResult?.reply?.text).toContain("execute: blocked");
    expect(showRunResult?.reply?.text).toContain("Retry run");
    expect(showRunResult?.reply?.text).toContain("Actions:");
    expect(showRunResult?.reply?.text).toContain("/task retry-run run-blocked");

    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const retryParams = buildCommandTestParams("/task retry-run run-blocked", cfg, baseCtx);
    retryParams.agentId = "research";
    retryParams.sessionKey = "agent:research:telegram:direct:123";

    const retryResult = await handleControlCommands(retryParams, true);

    expect(retryResult?.reply?.text).toContain("Queued retry for run run-blocked");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.queue.retry",
        params: { runId: "run-blocked", reason: "channel /task retry" },
      }),
    );

    const otherParams = buildCommandTestParams("/task retry-run run-other", cfg, baseCtx);
    otherParams.agentId = "research";
    otherParams.sessionKey = "agent:research:telegram:direct:123";

    const otherResult = await handleControlCommands(otherParams, true);

    expect(otherResult?.reply?.text).toContain("belongs to another Agent/session");
  });

  it("pauses and resumes a task owned by the current Agent through the gateway", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({ id: "job-session", sessionKey: "agent:research:telegram:direct:123" }),
        makeCronJob({ id: "job-other", agentId: "support", sessionKey: "agent:support:main" }),
      ],
    });
    callGatewayMock
      .mockResolvedValueOnce(makeCronJob({ id: "job-session", enabled: false }))
      .mockResolvedValueOnce(
        makeCronJob({
          id: "job-session",
          enabled: false,
          state: {
            lastStatus: "blocked",
            lastRunStatus: "blocked",
            stopReason: "needsAccess:missing_brave_api_key",
            needsAccess: {
              code: "missing_brave_api_key",
              service: "web_search",
              reason: "Missing Brave Search API key for web_search.",
              setupCommand: "fased configure --section web",
              source: "preflight",
              detectedAtMs: 123,
            },
          },
        }),
      );
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
      gateway: { mode: "local", auth: { token: "config-token" } },
    } satisfies FasedAgentConfig;
    const pauseParams = buildCommandTestParams("/task pause job-session", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    });
    pauseParams.agentId = "research";
    pauseParams.sessionKey = "agent:research:telegram:direct:123";

    const pauseResult = await handleControlCommands(pauseParams, true);

    expect(pauseResult?.reply?.text).toContain("Paused task job-session");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "cron.update",
        token: "config-token",
        params: { id: "job-session", patch: { enabled: false } },
        timeoutMs: 30_000,
      }),
    );

    const resumeParams = buildCommandTestParams("/task resume job-session", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:research:telegram:direct:123",
    });
    resumeParams.agentId = "research";
    resumeParams.sessionKey = "agent:research:telegram:direct:123";

    const resumeResult = await handleControlCommands(resumeParams, true);

    expect(resumeResult?.reply?.text).toContain(
      "Task job-session still needs access: Missing Brave Search API key for web_search.",
    );
    expect(resumeResult?.reply?.text).toContain("fased configure --section web");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "cron.update",
        token: "config-token",
        params: { id: "job-session", patch: { enabled: true } },
        timeoutMs: 30_000,
      }),
    );

    const blockedParams = buildCommandTestParams("/task pause job-other", cfg, {
      SessionKey: "agent:research:telegram:direct:123",
    });
    blockedParams.agentId = "research";
    blockedParams.sessionKey = "agent:research:telegram:direct:123";

    const blockedResult = await handleControlCommands(blockedParams, true);

    expect(blockedResult?.reply?.text).toContain("belongs to another Agent/session");
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("repairs a task source path through the gateway", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({
          id: "job-session",
          sessionKey: "agent:research:telegram:direct:123",
          enabled: false,
          state: {
            lastStatus: "blocked",
            lastRunStatus: "blocked",
            stopReason: "needsSources:needs_user_source",
            lastGraphRepairStop: {
              code: "needs_user_source",
              reason: "Need a trusted source before retrying.",
              sourceNodeId: "source-fetch-web-search",
              atMs: 123,
            },
          },
        }),
      ],
    });
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      action: "add_trusted_source",
      message: "Trusted source added. Task will retry from the updated source context.",
      job: makeCronJob({ id: "job-session" }),
    });
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
      gateway: { mode: "local", auth: { token: "config-token" } },
    } satisfies FasedAgentConfig;
    const params = buildCommandTestParams(
      "/task repair job-session add-source https://example.com/report",
      cfg,
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: "agent:research:telegram:direct:123",
      },
    );
    params.agentId = "research";
    params.sessionKey = "agent:research:telegram:direct:123";

    const result = await handleControlCommands(params, true);

    expect(result?.reply?.text).toContain("Trusted source added");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.repair",
        token: "config-token",
        params: {
          id: "job-session",
          action: "add_trusted_source",
          source: "https://example.com/report",
          sourceNodeId: undefined,
        },
        timeoutMs: 30_000,
      }),
    );
  });

  it("edits a task owned by the current Agent through the gateway", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({
          id: "job-session",
          sessionKey: "agent:research:telegram:direct:123",
          executionPolicy: {
            triggerKind: "schedule",
            executionMode: "agent-turn",
            memoryScope: "session-summary",
            skillScope: "agent-default",
            modelPolicy: { mode: "agent-default" },
          },
        }),
        makeCronJob({ id: "job-other", agentId: "support", sessionKey: "agent:support:main" }),
      ],
    });
    callGatewayMock.mockResolvedValueOnce(makeCronJob({ id: "job-session" }));
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
      gateway: { mode: "local", auth: { token: "config-token" } },
    } satisfies FasedAgentConfig;
    const params = buildCommandTestParams(
      "/task edit job-session every 2h Wallet pulse: check wallet --mode no-model --memory none --delivery none --max-runs-hour 2 --auto-repair false --max-auto-repairs 1",
      cfg,
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: "agent:research:telegram:direct:123",
      },
    );
    params.agentId = "research";
    params.sessionKey = "agent:research:telegram:direct:123";

    const editResult = await handleControlCommands(params, true);

    expect(editResult?.reply?.text).toContain("Updated task job-session");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "cron.update",
        token: "config-token",
        params: {
          id: "job-session",
          patch: expect.objectContaining({
            name: "Wallet pulse",
            schedule: { kind: "every", everyMs: 7_200_000, anchorMs: expect.any(Number) },
            payload: { kind: "agentTurn", message: "check wallet" },
            delivery: { mode: "none" },
            executionPolicy: expect.objectContaining({
              executionMode: "no-model",
              memoryScope: "none",
              modelPolicy: { mode: "none" },
              budget: { maxRunsPerHour: 2 },
              repairPolicy: {
                autoRetryReplacement: false,
                maxAutoRepairsPerRun: 1,
              },
            }),
          }),
        },
        timeoutMs: 30_000,
      }),
    );

    const blockedParams = buildCommandTestParams("/task edit job-other renamed prompt", cfg, {
      SessionKey: "agent:research:telegram:direct:123",
    });
    blockedParams.agentId = "research";
    blockedParams.sessionKey = "agent:research:telegram:direct:123";

    const blockedResult = await handleControlCommands(blockedParams, true);

    expect(blockedResult?.reply?.text).toContain("belongs to another Agent/session");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("accepts natural task edits from any channel command surface", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    await saveCronStore(cronPath, {
      version: 1,
      jobs: [
        makeCronJob({
          id: "job-session",
          agentId: "research",
          sessionKey: "agent:research:slack:channel:C123",
          executionPolicy: {
            triggerKind: "schedule",
            executionMode: "agent-turn",
            memoryScope: "session-summary",
            skillScope: "agent-default",
            modelPolicy: { mode: "agent-default" },
          },
        }),
      ],
    });
    callGatewayMock.mockResolvedValue(makeCronJob({ id: "job-session" }));
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
      gateway: { mode: "local", auth: { token: "config-token" } },
    } satisfies FasedAgentConfig;

    const scheduleParams = buildCommandTestParams("/task edit job-session every 30m", cfg, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
      SessionKey: "agent:research:slack:channel:C123",
    });
    scheduleParams.agentId = "research";
    scheduleParams.sessionKey = "agent:research:slack:channel:C123";

    const scheduleResult = await handleControlCommands(scheduleParams, true);

    expect(scheduleResult?.reply?.text).toContain("Updated task job-session: schedule");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "cron.update",
        params: {
          id: "job-session",
          patch: { schedule: { kind: "every", everyMs: 1_800_000, anchorMs: expect.any(Number) } },
        },
      }),
    );

    const deliveryParams = buildCommandTestParams("/task edit job-session send here", cfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "987654",
      SessionKey: "agent:research:discord:channel:987654",
    });
    deliveryParams.agentId = "research";
    deliveryParams.sessionKey = "agent:research:discord:channel:987654";

    const deliveryResult = await handleControlCommands(deliveryParams, true);

    expect(deliveryResult?.reply?.text).toContain("Updated task job-session: delivery");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "cron.update",
        params: {
          id: "job-session",
          patch: { delivery: { mode: "announce", channel: "discord", to: "987654" } },
        },
      }),
    );

    const cheapParams = buildCommandTestParams("/task edit job-session use cheap check", cfg, {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      SessionKey: "agent:research:slack:channel:C123",
    });
    cheapParams.agentId = "research";
    cheapParams.sessionKey = "agent:research:slack:channel:C123";

    const cheapResult = await handleControlCommands(cheapParams, true);

    expect(cheapResult?.reply?.text).toContain("Updated task job-session: policy");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "cron.update",
        params: {
          id: "job-session",
          patch: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              executionMode: "agent-turn",
              modelPolicy: { mode: "auto" },
              evaluator: {
                escalateOnSignal: true,
                signalIncludes: ["Needs deeper analysis: yes"],
                maxEscalations: 1,
              },
              planner: expect.objectContaining({
                strategy: "cheap-model",
                signals: ["manual-evaluator"],
              }),
            }),
          }),
        },
      }),
    );

    const stopParams = buildCommandTestParams("/task edit job-session stop after success", cfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      SessionKey: "agent:research:discord:channel:987654",
    });
    stopParams.agentId = "research";
    stopParams.sessionKey = "agent:research:discord:channel:987654";

    const stopResult = await handleControlCommands(stopParams, true);

    expect(stopResult?.reply?.text).toContain("Updated task job-session: stop rule");
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        method: "cron.update",
        params: {
          id: "job-session",
          patch: expect.objectContaining({
            executionPolicy: expect.objectContaining({
              stop: { onSuccess: true },
            }),
          }),
        },
      }),
    );
  });

  it("creates a WebChat task scoped to the current Agent session", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const sessionKey = "agent:research:webchat:direct:local-1";
    const params = buildCommandTestParams(
      '/task new every 1h Market watch: check market risk and report --objective "watch market risk" --success "risk report delivered" --mode skill-only --memory none --skills wallet --tool wallet --input {"action":"balance"} --model openrouter/cheap --escalate openai/strong --coordinate consult --ask-agent support,research --max-coordination-agents 2 --coordination-approval true --max-tokens 500 --max-cost 0.01 --max-runs-hour 12 --stop-text done,complete --max-successes 2 --max-total-runs 10 --auto-repair false --auto-stop-optional true --max-auto-repairs 2 --primary-source-approval false',
      cfg,
      {
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        SessionKey: sessionKey,
      },
    );
    params.agentId = "research";
    params.sessionKey = sessionKey;

    const createResult = await handleControlCommands(params, true);

    expect(createResult?.reply?.text).toContain('Created task "Market watch"');
    const store = await loadCronStore(cronPath);
    expect(store.jobs).toHaveLength(1);
    const [job] = store.jobs;
    expect(job).toMatchObject({
      agentId: "research",
      sessionKey,
      name: "Market watch",
      enabled: true,
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "check market risk and report" },
      executionPolicy: {
        objective: "watch market risk",
        successCriteria: "risk report delivered",
        triggerKind: "schedule",
        executionMode: "skill-only",
        memoryScope: "none",
        skillScope: "selected",
        allowedSkills: ["wallet"],
        skillAction: {
          toolName: "wallet",
          input: { action: "balance" },
        },
        modelPolicy: {
          mode: "task-override",
          model: "openrouter/cheap",
          escalationModel: "openai/strong",
        },
        coordination: {
          mode: "consult",
          agents: ["support", "research"],
          maxAgents: 2,
          requireApproval: true,
        },
        budget: {
          maxTokensPerRun: 500,
          maxCostUsdPerRun: 0.01,
          maxRunsPerHour: 12,
        },
        stop: {
          outputIncludes: ["done", "complete"],
          maxSuccessfulRuns: 2,
          maxTotalRuns: 10,
        },
        repairPolicy: {
          autoRetryReplacement: false,
          autoStopOptionalSources: true,
          maxAutoRepairsPerRun: 2,
          requireApprovalForPrimarySource: false,
        },
      },
    });
    expect(job?.schedule).toMatchObject({ kind: "every", everyMs: 3_600_000 });
    expect(job?.delivery).toBeUndefined();

    const listParams = buildCommandTestParams("/task list", cfg, { SessionKey: sessionKey });
    listParams.agentId = "research";
    listParams.sessionKey = sessionKey;
    const listResult = await handleControlCommands(listParams, true);
    expect(listResult?.reply?.text).toContain(job?.id);
  });

  it("creates a natural-language cheap-check escalation task without raw policy flags", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const sessionKey = "agent:main:telegram:direct:123:chat:market-watch";
    const params = buildCommandTestParams(
      "/task new every 1h Market watch: Monitor market risk with a cheap check first and escalate if deeper analysis is needed.",
      cfg,
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        From: "telegram:123",
        To: "telegram:123",
        SessionKey: sessionKey,
      },
    );
    params.agentId = "main";
    params.sessionKey = sessionKey;

    const createResult = await handleControlCommands(params, true);

    expect(createResult?.reply?.text).toContain('Created task "Market watch"');
    expect(createResult?.reply?.text).toContain("plan cheap-model");
    const store = await loadCronStore(cronPath);
    expect(store.jobs).toHaveLength(1);
    const [job] = store.jobs;
    expect(job).toMatchObject({
      agentId: "main",
      sessionKey,
      name: "Market watch",
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      executionPolicy: {
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
        planner: {
          strategy: "cheap-model",
          signals: ["natural-escalation"],
        },
      },
    });
  });

  it("creates a natural task from a word duration and inferred title", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const sessionKey = "agent:main:telegram:direct:123:chat:market-watch";
    const params = buildCommandTestParams(
      "/task new every 10 minutes Check market risk for BTC and SOL. Use a cheap check first. If anything needs deeper analysis, escalate to a stronger model. Send the result back here.",
      cfg,
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        From: "telegram:123",
        To: "telegram:123",
        SessionKey: sessionKey,
      },
    );
    params.agentId = "main";
    params.sessionKey = sessionKey;

    const createResult = await handleControlCommands(params, true);

    expect(createResult?.reply?.text).toContain('Created task "Check market risk"');
    const store = await loadCronStore(cronPath);
    expect(store.jobs).toHaveLength(1);
    const [job] = store.jobs;
    expect(job).toMatchObject({
      agentId: "main",
      sessionKey,
      name: "Check market risk",
      payload: {
        kind: "agentTurn",
        message:
          "Check market risk for BTC and SOL. Use a cheap check first. If anything needs deeper analysis, escalate to a stronger model. Send the result back here.",
      },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      executionPolicy: {
        executionMode: "agent-turn",
        modelPolicy: { mode: "auto" },
        evaluator: {
          escalateOnSignal: true,
          signalIncludes: ["Needs deeper analysis: yes"],
          maxEscalations: 1,
        },
        planner: {
          strategy: "cheap-model",
        },
      },
    });
    expect(job?.schedule).toMatchObject({ kind: "every", everyMs: 600_000 });
  });

  it("creates a task when the interval appears inside natural wording", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const sessionKey = "agent:main:telegram:direct:123:chat:market-watch";
    const params = buildCommandTestParams(
      "/task new remind me every hour to check @wallet balance and send it here",
      cfg,
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        From: "telegram:123",
        To: "telegram:123",
        SessionKey: sessionKey,
      },
    );
    params.agentId = "main";
    params.sessionKey = sessionKey;

    const createResult = await handleControlCommands(params, true);

    expect(createResult?.reply?.text).toContain('Created task "check @wallet balance"');
    const store = await loadCronStore(cronPath);
    expect(store.jobs).toHaveLength(1);
    const [job] = store.jobs;
    expect(job).toMatchObject({
      name: "check @wallet balance",
      payload: {
        kind: "agentTurn",
        message: "check @wallet balance and send it here",
      },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      executionPolicy: {
        executionMode: "skill-only",
        allowedSkills: ["wallet"],
        skillAction: { toolName: "wallet", input: { action: "balance" } },
        modelPolicy: { mode: "none" },
        planner: { strategy: "skill-only" },
      },
    });
    expect(job?.schedule).toMatchObject({ kind: "every", everyMs: 3_600_000 });
  });

  it("creates a natural task with a trailing interval word from a non-Telegram channel", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const sessionKey = "agent:ops:discord:channel:987654";
    const params = buildCommandTestParams("/task new check provider health hourly", cfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "987654",
      SessionKey: sessionKey,
    });
    params.agentId = "ops";
    params.sessionKey = sessionKey;

    const createResult = await handleControlCommands(params, true);

    expect(createResult?.reply?.text).toContain('Created task "check provider health"');
    expect(createResult?.reply?.text).toContain("plan skill-only");
    const store = await loadCronStore(cronPath);
    expect(store.jobs).toHaveLength(1);
    const [job] = store.jobs;
    expect(job).toMatchObject({
      agentId: "ops",
      sessionKey,
      name: "check provider health",
      delivery: { mode: "announce", channel: "discord", to: "987654" },
      executionPolicy: {
        executionMode: "skill-only",
        allowedSkills: ["gateway"],
        skillAction: { toolName: "gateway", input: { action: "models.auth.status" } },
        modelPolicy: { mode: "none" },
        planner: { strategy: "skill-only" },
      },
    });
    expect(job?.schedule).toMatchObject({ kind: "every", everyMs: 3_600_000 });
  });

  it.each([
    {
      command: "/task new every 15m Mining pulse: check mining status and send here",
      title: "Mining pulse",
      everyMs: 900_000,
      toolName: "mining",
      input: { action: "status" },
    },
    {
      command: "/task new every 1h Provider health: check provider health and send here",
      title: "Provider health",
      everyMs: 3_600_000,
      toolName: "gateway",
      input: { action: "models.auth.status" },
    },
    {
      command: "/task new every 1d Offers pulse: check offers in the marketplace and send here",
      title: "Offers pulse",
      everyMs: 86_400_000,
      toolName: "offers",
      input: { action: "search" },
    },
  ])(
    "creates a natural direct-tool task for $title through /task new",
    async ({ command, title, everyMs, toolName, input }) => {
      const cronPath = path.join(tempDir, "cron", "jobs.json");
      const cfg = {
        commands: { text: true },
        cron: { store: cronPath },
      } satisfies FasedAgentConfig;
      const sessionKey = "agent:main:telegram:direct:123:chat:ops";
      const params = buildCommandTestParams(command, cfg, {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        From: "telegram:123",
        To: "telegram:123",
        SessionKey: sessionKey,
      });
      params.agentId = "main";
      params.sessionKey = sessionKey;

      const createResult = await handleControlCommands(params, true);

      expect(createResult?.reply?.text).toContain(`Created task "${title}"`);
      expect(createResult?.reply?.text).toContain("plan skill-only");
      const store = await loadCronStore(cronPath);
      expect(store.jobs).toHaveLength(1);
      const [job] = store.jobs;
      expect(job).toMatchObject({
        agentId: "main",
        sessionKey,
        name: title,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
        executionPolicy: {
          executionMode: "skill-only",
          memoryScope: "none",
          skillScope: "selected",
          allowedSkills: [toolName],
          skillAction: { toolName, input },
          modelPolicy: { mode: "none" },
          planner: { strategy: "skill-only", signals: [toolName] },
        },
      });
      expect(job?.schedule).toMatchObject({ kind: "every", everyMs });
    },
  );

  it("creates multiple direct-tool tasks from pasted /task new lines", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    const cfg = {
      commands: { text: true },
      cron: { store: cronPath },
    } satisfies FasedAgentConfig;
    const sessionKey = "agent:main:telegram:direct:123:chat:ops";
    const params = buildCommandTestParams(
      [
        "/task new every 15m Mining pulse: check mining status and send here",
        "/task new every 1h Provider health: check provider health and send here",
        "/task new every 1d Offers pulse: check offers in the marketplace and send here",
      ].join("\n"),
      cfg,
      {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        From: "telegram:123",
        To: "telegram:123",
        SessionKey: sessionKey,
      },
    );
    params.agentId = "main";
    params.sessionKey = sessionKey;

    const createResult = await handleControlCommands(params, true);

    expect(createResult?.reply?.text).toContain("Created tasks");
    expect(createResult?.reply?.text).toContain("Mining pulse");
    expect(createResult?.reply?.text).toContain("Provider health");
    expect(createResult?.reply?.text).toContain("Offers pulse");
    const store = await loadCronStore(cronPath);
    expect(store.jobs.map((job) => job.name)).toEqual([
      "Mining pulse",
      "Provider health",
      "Offers pulse",
    ]);
    expect(store.jobs.map((job) => job.executionPolicy?.skillAction?.toolName)).toEqual([
      "mining",
      "gateway",
      "offers",
    ]);
    expect(store.jobs.map((job) => job.executionPolicy?.planner?.strategy)).toEqual([
      "skill-only",
      "skill-only",
      "skill-only",
    ]);
  });

  it("keeps natural reminders no-model when extracting embedded intervals", async () => {
    const cronPath = path.join(tempDir, "cron", "jobs.json");
    const cfg = { commands: { text: true }, cron: { store: cronPath } } satisfies FasedAgentConfig;
    const params = buildCommandTestParams("/task new remind me every hour to stand up", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      From: "telegram:123",
      To: "telegram:123",
    });

    const createResult = await handleControlCommands(params, true);

    expect(createResult?.reply?.text).toContain('Created task "remind me to stand up"');
    const store = await loadCronStore(cronPath);
    const [job] = store.jobs;
    expect(job).toMatchObject({
      payload: { kind: "agentTurn", message: "remind me to stand up" },
      executionPolicy: {
        executionMode: "no-model",
        modelPolicy: { mode: "none" },
        planner: { strategy: "no-model" },
      },
    });
  });
});
