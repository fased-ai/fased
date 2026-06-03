import "../../cron/isolated-agent.mocks.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSkill } from "../../agents/skills.e2e-test-helpers.js";
import { runSubagentAnnounceFlow } from "../../agents/subagent-announce.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import {
  createCliDeps,
  mockAgentPayloads,
} from "../../cron/isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import { setupIsolatedAgentTurnMocks } from "../../cron/isolated-agent.test-setup.js";
import { getPendingCronRunLogWriteCountForTests } from "../../cron/run-log.js";
import { CronService } from "../../cron/service.js";
import type { CronEvent } from "../../cron/service.js";
import { loadCronStore } from "../../cron/store.js";
import saveSessionToMemory, {
  flushSessionMemoryWritesForTest,
} from "../../hooks/bundled/session-memory/handler.js";
import type { MsgContext } from "../templating.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const writeConfigFileMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

const { handleControlCommands } = await import("./commands-control.js");
const { handleSessionCommand } = await import("./commands-session.js");
const { initSessionState } = await import("./session.js");

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-channel-control-e2e-"));
  writeConfigFileMock.mockClear();
  setupIsolatedAgentTurnMocks();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function telegramCtx(body: string, sessionKey: string): Partial<MsgContext> {
  return {
    Body: body,
    CommandBody: body,
    BodyForCommands: body,
    RawBody: body,
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    From: "telegram:123",
    To: "telegram:123",
    OriginatingTo: "telegram:123",
    SessionKey: sessionKey,
    ChatType: "direct",
  };
}

function noopLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function withSkillScanningEnabled<T>(run: () => Promise<T>): Promise<T> {
  const previousFastTestEnv = process.env.FASED_TEST_FAST;
  delete process.env.FASED_TEST_FAST;
  try {
    return await run();
  } finally {
    if (previousFastTestEnv === undefined) {
      delete process.env.FASED_TEST_FAST;
    } else {
      process.env.FASED_TEST_FAST = previousFastTestEnv;
    }
  }
}

async function waitForCronRunLogWrites() {
  for (let index = 0; index < 50; index += 1) {
    if (getPendingCronRunLogWriteCountForTests() === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("fake channel command/control flow", () => {
  it("smokes Provider -> Agent -> Skill -> Chat -> Task -> Memory -> Channel delivery", async () => {
    await withSkillScanningEnabled(async () => {
      const sessionStorePath = path.join(tempDir, "sessions.json");
      const cronStorePath = path.join(tempDir, "cron", "jobs.json");
      const workspaceDir = path.join(tempDir, "workspace-flow");
      const sessionFile = path.join(workspaceDir, "sessions", "flow-session.jsonl");
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            type: "message",
            message: { role: "user", content: "Remember the composite flow smoke fact." },
          }),
          JSON.stringify({
            type: "message",
            message: { role: "assistant", content: "I will use it for the next task." },
          }),
        ].join("\n"),
        "utf-8",
      );
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "market-smoke"),
        name: "Market smoke",
        description: "Answers matching market smoke tasks.",
        metadata: '{"fased":{"skillKey":"market-smoke"}}',
        body: "# Market smoke\nUse this for composite flow smoke checks.\n",
      });

      const cfg = {
        commands: { text: true },
        session: { store: sessionStorePath },
        cron: { store: cronStorePath },
        channels: { telegram: { botToken: "tok" } },
        hooks: {
          internal: {
            entries: {
              "session-memory": { enabled: true, messages: 5 },
            },
          },
        },
        agents: {
          list: [
            {
              id: "flow",
              name: "Flow",
              default: true,
              workspace: workspaceDir,
              model: {
                primary: "openrouter/main-agent",
                fallbacks: ["openrouter/fallback-agent"],
              },
              taskModels: {
                cheapCheck: "openrouter/cheap-agent",
                escalation: "openai/strong-agent",
              },
              skills: ["market-smoke"],
            },
          ],
        },
      } satisfies FasedAgentConfig;
      const channelKey = "agent:flow:telegram:direct:123";

      const chatState = await initSessionState({
        ctx: telegramCtx("Use the market smoke skill in this chat.", channelKey) as MsgContext,
        cfg,
        commandAuthorized: true,
      });
      expect(chatState.sessionKey).toBe(channelKey);
      expect(chatState.sessionCtx.Provider).toBe("telegram");
      expect(chatState.sessionCtx.Body).toBe("Use the market smoke skill in this chat.");

      await saveSessionToMemory({
        type: "command",
        action: "reset",
        timestamp: new Date("2026-05-18T01:00:00.000Z"),
        sessionKey: channelKey,
        messages: [],
        context: {
          cfg,
          commandSource: "webchat",
          previousSessionEntry: {
            sessionId: "flow-session",
            sessionFile,
          },
        },
      });
      await flushSessionMemoryWritesForTest();
      const memoryFiles = await fs.readdir(path.join(workspaceDir, "memory"));
      expect(memoryFiles).toHaveLength(1);
      const memoryText = await fs.readFile(
        path.join(workspaceDir, "memory", memoryFiles[0] ?? ""),
        "utf-8",
      );
      expect(memoryText).toContain("Remember the composite flow smoke fact.");

      const taskCommand =
        "/task new every 1h Composite flow: Use the market smoke skill and remembered flow fact. --mode agent-turn --memory search";
      const taskState = await initSessionState({
        ctx: telegramCtx(taskCommand, channelKey) as MsgContext,
        cfg,
        commandAuthorized: true,
      });
      const taskParams = buildCommandTestParams(
        taskCommand,
        cfg,
        telegramCtx(taskCommand, channelKey),
      );
      taskParams.agentId = "flow";
      taskParams.sessionKey = taskState.sessionKey;

      const taskResult = await handleControlCommands(taskParams, true);

      expect(taskResult?.reply?.text).toContain('Created task "Composite flow"');
      const createdStore = await loadCronStore(cronStorePath);
      const job = createdStore.jobs[0];
      expect(job).toMatchObject({
        agentId: "flow",
        sessionKey: channelKey,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
        executionPolicy: {
          memoryScope: "search",
          skillScope: "agent-default",
          modelPolicy: { mode: "auto" },
        },
      });
      expect(job?.id).toBeTruthy();

      mockAgentPayloads([{ type: "text", text: "Needs deeper analysis: no\nComposite flow ok." }], {
        meta: {
          durationMs: 5,
          agentMeta: {
            sessionId: "flow-run",
            provider: "openrouter",
            model: "openrouter/main-agent",
          },
        },
      });
      const deps = createCliDeps();
      const cronEvents: CronEvent[] = [];
      const runIsolatedAgentJob = vi.fn(
        async (params: {
          job: NonNullable<typeof job>;
          message: string;
          abortSignal?: AbortSignal;
        }) =>
          await runCronIsolatedAgentTurn({
            cfg,
            deps,
            job: params.job,
            message: params.message,
            abortSignal: params.abortSignal,
            sessionKey: params.job.sessionKey ?? channelKey,
            agentId: params.job.agentId,
            lane: "cron",
          }),
      );
      const cron = new CronService({
        nowMs: () => Date.parse("2026-05-18T01:05:00.000Z"),
        log: noopLogger(),
        storePath: cronStorePath,
        cronEnabled: true,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeatNow: vi.fn(),
        runIsolatedAgentJob,
        onEvent: (evt) => cronEvents.push(evt),
      });

      const runResult = await cron.run(job.id, "force");
      await waitForCronRunLogWrites();

      expect(runResult).toEqual({ ok: true, ran: true });
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      const finishedEvent = cronEvents.find(
        (evt) => evt.action === "finished" && evt.jobId === job.id,
      );
      expect(finishedEvent).toMatchObject({
        status: "ok",
        delivered: true,
        deliveryStatus: "delivered",
        sessionKey: channelKey,
        policy: {
          requestedExecutionMode: "agent-turn",
          effectiveExecutionMode: "agent-turn",
          memoryScope: "search",
          modelUsed: true,
          modelSource: "Agent default model",
          skills: {
            count: 1,
            names: ["Market smoke"],
            skillFilter: ["market-smoke"],
          },
        },
      });
      const lastParams = buildCommandTestParams(
        `/task last ${job.id}`,
        cfg,
        telegramCtx(`/task last ${job.id}`, channelKey),
      );
      lastParams.agentId = "flow";
      lastParams.sessionKey = channelKey;

      const lastResult = await handleControlCommands(lastParams, true);

      expect(lastResult?.reply?.text).toContain("Latest run: Composite flow");
      expect(lastResult?.reply?.text).toContain("Source: model openrouter/main-agent");
      expect(lastResult?.reply?.text).toContain("Model source: Agent default model");
      expect(lastResult?.reply?.text).toContain(
        "Skills: Inherited from Agent · 1 loaded · Market smoke",
      );
      expect(lastResult?.reply?.text).toContain("Delivery: delivery sent");
    });
  });

  it("switches agent, creates a named channel session, routes turns, and manages its task", async () => {
    const sessionStorePath = path.join(tempDir, "sessions.json");
    const cronStorePath = path.join(tempDir, "cron", "jobs.json");
    const cfg = {
      commands: { text: true },
      session: { store: sessionStorePath },
      cron: { store: cronStorePath },
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "research", name: "Research" },
        ],
      },
    } satisfies FasedAgentConfig;

    const mainChannelKey = "agent:main:telegram:direct:123";
    const researchChannelKey = "agent:research:telegram:direct:123";

    const agentListParams = buildCommandTestParams(
      "/agent list",
      cfg,
      telegramCtx("/agent list", mainChannelKey),
    );
    agentListParams.agentId = "main";

    const agentListResult = await handleControlCommands(agentListParams, true);

    expect(agentListResult?.reply?.text).toContain("Agents");
    expect(agentListResult?.reply?.text).toContain("* Assistant (main)");
    expect(agentListResult?.reply?.text).toContain("- Research (research)");

    const switchParams = buildCommandTestParams(
      "/agent switch Research",
      cfg,
      telegramCtx("/agent switch Research", mainChannelKey),
    );
    switchParams.agentId = "main";

    const switchResult = await handleControlCommands(switchParams, true);

    expect(switchResult?.reply?.text).toContain("Agent switched to Research");
    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
    const writtenConfig = writeConfigFileMock.mock.calls[0]?.[0] as FasedAgentConfig | undefined;
    expect(writtenConfig?.bindings).toEqual([
      {
        agentId: "research",
        comment: "Set from /agent switch.",
        match: { channel: "telegram", peer: { kind: "direct", id: "123" } },
      },
    ]);

    const sessionCommandState = await initSessionState({
      ctx: telegramCtx("/session new Market watch", researchChannelKey) as MsgContext,
      cfg,
      commandAuthorized: true,
    });
    const createParams = buildCommandTestParams(
      "/session new Market watch",
      cfg,
      telegramCtx("/session new Market watch", researchChannelKey),
    );
    createParams.agentId = "research";
    createParams.sessionKey = sessionCommandState.sessionKey;
    createParams.storePath = sessionCommandState.storePath;
    createParams.sessionStore = sessionCommandState.sessionStore;
    createParams.sessionEntry = sessionCommandState.sessionEntry;

    const createResult = await handleSessionCommand(createParams, true);

    expect(createResult?.reply?.text).toContain('Created session "Market watch"');
    const afterCreate = loadSessionStore(sessionStorePath, { skipCache: true });
    const activeSessionKey = afterCreate[researchChannelKey]?.activeSessionKey;
    expect(activeSessionKey).toBe(`${researchChannelKey}:chat:market-watch`);
    expect(afterCreate[activeSessionKey!]?.baseSessionKey).toBe(researchChannelKey);

    const sessionListParams = buildCommandTestParams(
      "/session list",
      cfg,
      telegramCtx("/session list", researchChannelKey),
    );
    sessionListParams.agentId = "research";
    sessionListParams.sessionKey = researchChannelKey;
    sessionListParams.storePath = sessionStorePath;
    sessionListParams.sessionStore = loadSessionStore(sessionStorePath, { skipCache: true });
    sessionListParams.sessionEntry = sessionListParams.sessionStore[researchChannelKey];

    const sessionListResult = await handleSessionCommand(sessionListParams, true);

    expect(sessionListResult?.reply?.text).toContain("Sessions");
    expect(sessionListResult?.reply?.text).toContain("Market watch");
    expect(sessionListResult?.reply?.text).toContain("active");

    const switchMainParams = buildCommandTestParams(
      "/session switch main",
      cfg,
      telegramCtx("/session switch main", researchChannelKey),
    );
    switchMainParams.agentId = "research";
    switchMainParams.sessionKey = researchChannelKey;
    switchMainParams.storePath = sessionStorePath;
    switchMainParams.sessionStore = loadSessionStore(sessionStorePath, { skipCache: true });
    switchMainParams.sessionEntry = switchMainParams.sessionStore[researchChannelKey];

    const switchMainResult = await handleSessionCommand(switchMainParams, true);

    expect(switchMainResult?.reply?.text).toContain("Switched back to Main");
    const afterSwitchMain = loadSessionStore(sessionStorePath, { skipCache: true });
    expect(afterSwitchMain[researchChannelKey]?.activeSessionKey).toBeUndefined();

    const switchNamedParams = buildCommandTestParams(
      "/session switch Market watch",
      cfg,
      telegramCtx("/session switch Market watch", researchChannelKey),
    );
    switchNamedParams.agentId = "research";
    switchNamedParams.sessionKey = researchChannelKey;
    switchNamedParams.storePath = sessionStorePath;
    switchNamedParams.sessionStore = loadSessionStore(sessionStorePath, { skipCache: true });
    switchNamedParams.sessionEntry = switchNamedParams.sessionStore[researchChannelKey];

    const switchNamedResult = await handleSessionCommand(switchNamedParams, true);

    expect(switchNamedResult?.reply?.text).toContain('Switched to session "Market watch"');
    const afterSwitchNamed = loadSessionStore(sessionStorePath, { skipCache: true });
    expect(afterSwitchNamed[researchChannelKey]?.activeSessionKey).toBe(activeSessionKey);

    const normalTurnState = await initSessionState({
      ctx: telegramCtx("summarize market risk", researchChannelKey) as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(normalTurnState.sessionKey).toBe(activeSessionKey);
    expect(normalTurnState.sessionEntry.displayName).toBe("Market watch");

    const taskCommand =
      '/task new every 1h Market watch: check market risk --mode skill-only --memory none --skills wallet --tool wallet --input {"action":"balance"} --model openrouter/cheap --escalate openai/strong --max-tokens 500 --max-cost 0.01 --max-runs-hour 12';
    const taskNewState = await initSessionState({
      ctx: telegramCtx(taskCommand, researchChannelKey) as MsgContext,
      cfg,
      commandAuthorized: true,
    });
    expect(taskNewState.sessionKey).toBe(activeSessionKey);

    const taskNewParams = buildCommandTestParams(
      taskCommand,
      cfg,
      telegramCtx(taskCommand, researchChannelKey),
    );
    taskNewParams.agentId = "research";
    taskNewParams.sessionKey = taskNewState.sessionKey;

    const taskNewResult = await handleControlCommands(taskNewParams, true);

    expect(taskNewResult?.reply?.text).toContain('Created task "Market watch"');
    const afterTaskCreate = await loadCronStore(cronStorePath);
    expect(afterTaskCreate.jobs).toHaveLength(1);
    const [createdJob] = afterTaskCreate.jobs;
    expect(createdJob).toMatchObject({
      agentId: "research",
      sessionKey: activeSessionKey,
      name: "Market watch",
      schedule: { kind: "every", everyMs: 3_600_000 },
      payload: { kind: "agentTurn", message: "check market risk" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      executionPolicy: {
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
        budget: {
          maxTokensPerRun: 500,
          maxCostUsdPerRun: 0.01,
          maxRunsPerHour: 12,
        },
      },
    });

    const taskListParams = buildCommandTestParams(
      "/task list",
      cfg,
      telegramCtx("/task list", researchChannelKey),
    );
    taskListParams.agentId = "research";
    taskListParams.sessionKey = taskNewState.sessionKey;

    const taskListResult = await handleControlCommands(taskListParams, true);

    expect(taskListResult?.reply?.text).toContain(createdJob?.id);
    expect(taskListResult?.reply?.text).not.toContain("job-other-agent");

    const cancelParams = buildCommandTestParams(
      `/task cancel ${createdJob?.id}`,
      cfg,
      telegramCtx(`/task cancel ${createdJob?.id}`, researchChannelKey),
    );
    cancelParams.agentId = "research";
    cancelParams.sessionKey = taskNewState.sessionKey;

    const cancelResult = await handleControlCommands(cancelParams, true);

    expect(cancelResult?.reply?.text).toContain(`Canceled task ${createdJob?.id}`);
    const afterCancel = await loadCronStore(cronStorePath);
    expect(afterCancel.jobs).toEqual([]);
  });

  it("force-runs a named channel-session task and announces back to the originating channel", async () => {
    const sessionStorePath = path.join(tempDir, "sessions.json");
    const cronStorePath = path.join(tempDir, "cron", "jobs.json");
    const cfg = {
      commands: { text: true },
      session: {
        store: sessionStorePath,
        mainKey: "main",
        dmScope: "per-channel-peer",
      },
      cron: { store: cronStorePath },
      channels: { telegram: { botToken: "tok" } },
      agents: {
        list: [
          { id: "main", name: "Assistant", default: true },
          { id: "research", name: "Research" },
        ],
      },
    } satisfies FasedAgentConfig;
    const researchChannelKey = "agent:research:telegram:direct:123";

    const createSessionState = await initSessionState({
      ctx: telegramCtx("/session new Delivery check", researchChannelKey) as MsgContext,
      cfg,
      commandAuthorized: true,
    });
    const createSessionParams = buildCommandTestParams(
      "/session new Delivery check",
      cfg,
      telegramCtx("/session new Delivery check", researchChannelKey),
    );
    createSessionParams.agentId = "research";
    createSessionParams.sessionKey = createSessionState.sessionKey;
    createSessionParams.storePath = createSessionState.storePath;
    createSessionParams.sessionStore = createSessionState.sessionStore;
    createSessionParams.sessionEntry = createSessionState.sessionEntry;

    const createSessionResult = await handleSessionCommand(createSessionParams, true);

    expect(createSessionResult?.reply?.text).toContain('Created session "Delivery check"');
    const activeSessionKey = loadSessionStore(sessionStorePath, {
      skipCache: true,
    })[researchChannelKey]?.activeSessionKey;
    expect(activeSessionKey).toBe(`${researchChannelKey}:chat:delivery-check`);

    const taskCommand =
      "/task new every 1h Delivery check: report delivery heartbeat --mode no-model --memory none";
    const taskState = await initSessionState({
      ctx: telegramCtx(taskCommand, researchChannelKey) as MsgContext,
      cfg,
      commandAuthorized: true,
    });
    expect(taskState.sessionKey).toBe(activeSessionKey);

    const taskParams = buildCommandTestParams(
      taskCommand,
      cfg,
      telegramCtx(taskCommand, researchChannelKey),
    );
    taskParams.agentId = "research";
    taskParams.sessionKey = taskState.sessionKey;

    const taskResult = await handleControlCommands(taskParams, true);

    expect(taskResult?.reply?.text).toContain('Created task "Delivery check"');
    const taskStore = await loadCronStore(cronStorePath);
    const job = taskStore.jobs[0];
    expect(job).toMatchObject({
      agentId: "research",
      sessionKey: activeSessionKey,
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      executionPolicy: {
        triggerKind: "schedule",
        executionMode: "no-model",
        memoryScope: "none",
        modelPolicy: { mode: "none" },
      },
    });
    expect(job?.id).toBeTruthy();

    const deps = createCliDeps();
    const cronEvents: CronEvent[] = [];
    const runIsolatedAgentJob = vi.fn(
      async (params: {
        job: NonNullable<typeof job>;
        message: string;
        abortSignal?: AbortSignal;
      }) => {
        expect(params.job.agentId).toBe("research");
        expect(params.job.sessionKey).toBe(activeSessionKey);
        expect(params.job.executionPolicy).toMatchObject({
          executionMode: "no-model",
          memoryScope: "none",
          modelPolicy: { mode: "none" },
        });
        expect(params.message).toBe("report delivery heartbeat");
        return await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job: params.job,
          message: params.message,
          abortSignal: params.abortSignal,
          sessionKey: params.job.sessionKey ?? activeSessionKey!,
          agentId: params.job.agentId,
          lane: "cron",
        });
      },
    );
    const cron = new CronService({
      nowMs: () => Date.parse("2026-05-12T12:00:00.000Z"),
      log: noopLogger(),
      storePath: cronStorePath,
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      onEvent: (evt) => cronEvents.push(evt),
    });

    const runResult = await cron.run(job.id, "force");

    expect(runResult).toEqual({ ok: true, ran: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.sendMessageTelegram).mock.calls[0]).toMatchObject([
      "123",
      "report delivery heartbeat",
      { verbose: false, textMode: "html" },
    ]);

    const finishedEvent = cronEvents.find(
      (evt) => evt.action === "finished" && evt.jobId === job.id,
    );
    expect(finishedEvent).toMatchObject({
      status: "ok",
      delivered: true,
      deliveryStatus: "delivered",
      sessionKey: activeSessionKey,
      policy: {
        requestedExecutionMode: "no-model",
        effectiveExecutionMode: "no-model",
        memoryScope: "none",
        modelPolicyMode: "none",
      },
    });

    const afterRun = await loadCronStore(cronStorePath);
    expect(afterRun.jobs[0]?.state.lastRunStatus).toBe("ok");
    expect(afterRun.jobs[0]?.state.lastDeliveryStatus).toBe("delivered");
  });
});
