import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";

const CRON_CLI_TEST_TIMEOUT_MS = 15_000;

type GatewayMock = (
  method: string,
  _opts: unknown,
  params?: unknown,
  _timeoutMs?: number,
) => Promise<unknown>;

const defaultGatewayMock: GatewayMock = async (
  method: string,
  _opts: unknown,
  params?: unknown,
  _timeoutMs?: number,
) => {
  if (method === "cron.status") {
    return { enabled: true };
  }
  return { ok: true, params };
};
const callGatewayFromCli = vi.fn<GatewayMock>(defaultGatewayMock);
const runTaskWorkerServiceInstall = vi.fn(async (_opts: unknown) => {});
const runTaskWorkerServiceStatus = vi.fn(async (_opts: unknown) => {});
const runTaskWorkerServiceStart = vi.fn(async (_opts: unknown) => {});
const runTaskWorkerServiceStop = vi.fn(async (_opts: unknown) => {});
const runTaskWorkerServiceRestart = vi.fn(async (_opts: unknown) => {});
const runTaskWorkerServiceUninstall = vi.fn(async (_opts: unknown) => {});

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      callGatewayFromCli(method, opts, params, extra as number | undefined),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  },
}));

vi.mock("./cron-cli/task-worker-service.js", () => ({
  runTaskWorkerServiceInstall: (opts: unknown) => runTaskWorkerServiceInstall(opts),
  runTaskWorkerServiceStatus: (opts: unknown) => runTaskWorkerServiceStatus(opts),
  runTaskWorkerServiceStart: (opts: unknown) => runTaskWorkerServiceStart(opts),
  runTaskWorkerServiceStop: (opts: unknown) => runTaskWorkerServiceStop(opts),
  runTaskWorkerServiceRestart: (opts: unknown) => runTaskWorkerServiceRestart(opts),
  runTaskWorkerServiceUninstall: (opts: unknown) => runTaskWorkerServiceUninstall(opts),
}));

const { registerCronCli, registerTaskCli } = await import("./cron-cli.js");
const { defaultRuntime } = await import("../runtime.js");

type CronUpdatePatch = {
  patch?: {
    schedule?: { kind?: string; expr?: string; tz?: string; staggerMs?: number };
    payload?: { message?: string; model?: string; thinking?: string };
    delivery?: { mode?: string; channel?: string; to?: string; bestEffort?: boolean };
  };
};

type CronAddParams = {
  schedule?: { kind?: string; staggerMs?: number };
  payload?: { model?: string; thinking?: string };
  delivery?: { mode?: string };
  deleteAfterRun?: boolean;
  agentId?: string;
  sessionTarget?: string;
  executionPolicy?: {
    executionMode?: string;
    skillAction?: { toolName?: string; input?: Record<string, unknown> };
    modelPolicy?: { mode?: string; model?: string };
  };
};

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerCronCli(program);
  return program;
}

function buildTaskProgram() {
  const program = new Command();
  program.exitOverride();
  registerTaskCli(program);
  return program;
}

function resetGatewayMock() {
  callGatewayFromCli.mockClear();
  callGatewayFromCli.mockImplementation(defaultGatewayMock);
  runTaskWorkerServiceInstall.mockClear();
  runTaskWorkerServiceStatus.mockClear();
  runTaskWorkerServiceStart.mockClear();
  runTaskWorkerServiceStop.mockClear();
  runTaskWorkerServiceRestart.mockClear();
  runTaskWorkerServiceUninstall.mockClear();
  vi.mocked(defaultRuntime.log).mockClear();
}

async function runCronCommand(args: string[]): Promise<void> {
  resetGatewayMock();
  const program = buildProgram();
  await program.parseAsync(args, { from: "user" });
}

async function runTaskCommand(args: string[]): Promise<void> {
  resetGatewayMock();
  const program = buildTaskProgram();
  await program.parseAsync(args, { from: "user" });
}

async function expectCronCommandExit(args: string[]): Promise<void> {
  await expect(runCronCommand(args)).rejects.toThrow("__exit__:1");
}

async function runCronEditAndGetPatch(editArgs: string[]): Promise<CronUpdatePatch> {
  await runCronCommand(["cron", "edit", "job-1", ...editArgs]);
  const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
  return (updateCall?.[2] ?? {}) as CronUpdatePatch;
}

async function runCronAddAndGetParams(addArgs: string[]): Promise<CronAddParams> {
  await runCronCommand(["cron", "add", ...addArgs]);
  const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
  return (addCall?.[2] ?? {}) as CronAddParams;
}

async function runCronSimpleAndGetUpdatePatch(
  command: "enable" | "disable",
): Promise<{ enabled?: boolean }> {
  await runCronCommand(["cron", command, "job-1"]);
  const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
  return ((updateCall?.[2] as { patch?: { enabled?: boolean } } | undefined)?.patch ?? {}) as {
    enabled?: boolean;
  };
}

function mockCronEditJobLookup(schedule: unknown): void {
  callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params?: unknown) => {
      if (method === "cron.status") {
        return { enabled: true };
      }
      if (method === "cron.list") {
        return {
          ok: true,
          params: {},
          jobs: [{ id: "job-1", schedule }],
        };
      }
      return { ok: true, params };
    },
  );
}

function getGatewayCallParams<T>(method: string): T {
  const call = callGatewayFromCli.mock.calls.find((entry) => entry[0] === method);
  return (call?.[2] ?? {}) as T;
}

async function runCronEditWithScheduleLookup(
  schedule: unknown,
  editArgs: string[],
): Promise<CronUpdatePatch> {
  resetGatewayMock();
  mockCronEditJobLookup(schedule);
  const program = buildProgram();
  await program.parseAsync(["cron", "edit", "job-1", ...editArgs], { from: "user" });
  return getGatewayCallParams<CronUpdatePatch>("cron.update");
}

async function expectCronEditWithScheduleLookupExit(
  schedule: unknown,
  editArgs: string[],
): Promise<void> {
  resetGatewayMock();
  mockCronEditJobLookup(schedule);
  const program = buildProgram();
  await expect(
    program.parseAsync(["cron", "edit", "job-1", ...editArgs], { from: "user" }),
  ).rejects.toThrow("__exit__:1");
}

describe("cron cli", () => {
  it("registers task as the user-facing scheduler command", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.status") {
        return { enabled: true };
      }
      return { ok: true };
    });

    await runTaskCommand(["task", "list"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.list",
      expect.anything(),
      { includeDisabled: false },
      undefined,
    );
  });

  it("accepts --force on task run as a compatibility no-op", async () => {
    await runTaskCommand(["task", "run", "job-1", "--force"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.run",
      expect.anything(),
      { id: "job-1", mode: "force" },
      undefined,
    );
  });

  it("keeps --due as the opt-in due-only task run mode", async () => {
    await runTaskCommand(["task", "run", "job-1", "--due"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.run",
      expect.anything(),
      { id: "job-1", mode: "due" },
      undefined,
    );
  });

  it("approves task coordination and runs the task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    await runTaskCommand(["task", "approve", "job-1"]);
    vi.useRealTimers();

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.anything(),
      {
        id: "job-1",
        patch: { state: { coordinationApprovedAtMs: 1_800_000_000_000 } },
      },
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.run",
      expect.anything(),
      { id: "job-1", mode: "force" },
      undefined,
    );
  });

  it("asks selected Agents for task-room evidence and runs the task", async () => {
    resetGatewayMock();
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const job = {
      id: "job-1",
      name: "Research task",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", intervalMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "agent-turn",
      payload: { kind: "agentTurn", message: "Check market risk" },
      executionPolicy: { executionMode: "agent-turn" },
      state: {},
    } as unknown as CronJob;
    callGatewayFromCli.mockImplementation(async (method, _opts, params) => {
      if (method === "cron.list") {
        return { jobs: [job] };
      }
      return defaultGatewayMock(method, _opts, params);
    });
    const program = buildTaskProgram();
    await program.parseAsync(["task", "ask", "job-1", "--agent", "research"], {
      from: "user",
    });
    vi.useRealTimers();

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    expect(updateCall?.[2]).toMatchObject({
      id: "job-1",
      patch: {
        executionPolicy: {
          coordination: {
            mode: "consult",
            agents: ["research"],
            requireApproval: true,
          },
        },
        state: {
          pendingCoordination: {
            agents: ["research"],
            signal: "manual_agent_request",
          },
          coordinationApprovedAtMs: 1_800_000_000_000,
        },
      },
    });
    expect(
      (
        updateCall?.[2] as {
          patch?: { executionPolicy?: { planner?: { graph?: { nodes?: unknown[] } } } };
        }
      )?.patch?.executionPolicy?.planner?.graph?.nodes ?? [],
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: "coordinate-agents" })]));
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.run",
      expect.anything(),
      { id: "job-1", mode: "force" },
      undefined,
    );
  });

  it.each([
    {
      args: ["task", "cancel-run", "run-1", "--reason", "operator stop"],
      method: "cron.queue.cancel",
      params: { runId: "run-1", reason: "operator stop" },
    },
    {
      args: ["task", "retry-run", "run-2"],
      method: "cron.queue.retry",
      params: { runId: "run-2", reason: undefined },
    },
    {
      args: ["task", "clear-stale", "run-3", "--reason", "lease expired"],
      method: "cron.queue.clearStale",
      params: { runId: "run-3", reason: "lease expired" },
    },
  ])("controls task queue run with $method", async ({ args, method, params }) => {
    await runTaskCommand(args);

    expect(callGatewayFromCli).toHaveBeenCalledWith(method, expect.anything(), params, undefined);
  });

  it("lists, shows, and cancels workflow runs from the task CLI", async () => {
    resetGatewayMock();
    const flow = {
      flowId: "flow:workflow:run-1",
      syncMode: "workflow",
      revision: 0,
      status: "running",
      goal: "Release workflow",
      notifyPolicy: "done_only",
      agentId: "main",
      taskIds: ["CLI:run-1"],
      currentTaskId: "CLI:run-1",
      currentStep: "Prepare",
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_010_000,
    };
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "tasks.flow.list") {
          return {
            generatedAt: 1_800_000_020_000,
            total: 1,
            flows: [flow],
            summary: { total: 1, active: 1, terminal: 0, blocked: 0, byStatus: { running: 1 } },
          };
        }
        if (method === "tasks.flow.detail") {
          return {
            flow,
            tasks: [{ taskId: "CLI:run-1", status: "running", task: "Release workflow" }],
          };
        }
        if (method === "tasks.flow.cancel") {
          return { ok: true, flow: { ...flow, status: "cancelled" } };
        }
        return defaultGatewayMock(method, _opts, params);
      },
    );

    const program = buildTaskProgram();
    await program.parseAsync(["task", "flow", "list", "--agent", "main"], { from: "user" });
    await program.parseAsync(["task", "flow", "show", "flow:workflow:run-1"], { from: "user" });
    await program.parseAsync(
      ["task", "flow", "cancel", "flow:workflow:run-1", "--reason", "operator stop"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "tasks.flow.list",
      expect.anything(),
      { agentId: "main", status: "all", limit: 50 },
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "tasks.flow.detail",
      expect.anything(),
      { flowId: "flow:workflow:run-1" },
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "tasks.flow.cancel",
      expect.anything(),
      { flowId: "flow:workflow:run-1", reason: "operator stop" },
      undefined,
    );
    expect(vi.mocked(defaultRuntime.log).mock.calls.flat().join("\n")).toContain(
      "Release workflow",
    );
  });

  it("previews and runs structured workflow graph files from the task CLI", async () => {
    resetGatewayMock();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-cli-workflow-"));
    const file = path.join(tempDir, "workflow.json");
    await writeFile(
      file,
      JSON.stringify({
        name: "CLI graph",
        graph: {
          nodes: [
            { id: "start", type: "start", label: "Start" },
            { id: "end", type: "end", label: "Done" },
          ],
          edges: [{ from: "start", to: "end" }],
        },
      }),
      "utf8",
    );
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "tasks.workflow.graph.preview") {
          return {
            ok: true,
            name: "CLI graph",
            task: "CLI graph",
            notifyPolicy: "done_only",
            graph: (params as { graph?: unknown }).graph,
            warnings: [],
          };
        }
        if (method === "tasks.workflow.graph.run") {
          return { ok: true, task: { taskId: "CLI:graph-run", status: "succeeded" } };
        }
        return defaultGatewayMock(method, _opts, params);
      },
    );

    try {
      const program = buildTaskProgram();
      await program.parseAsync(["task", "workflow", "preview", "--file", file, "--agent", "main"], {
        from: "user",
      });
      await program.parseAsync(["task", "workflow", "run", "--file", file, "--agent", "main"], {
        from: "user",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "tasks.workflow.graph.preview",
      expect.anything(),
      expect.objectContaining({ agentId: "main", name: "CLI graph" }),
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "tasks.workflow.graph.run",
      expect.anything(),
      expect.objectContaining({ agentId: "main", name: "CLI graph" }),
      undefined,
    );
  });

  it("repairs task source recovery from the task CLI", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.repair") {
          return {
            ok: true,
            action: "add_trusted_source",
            message: "Trusted source added. Task will retry from the updated source context.",
            job: { id: "job-1" },
          };
        }
        return defaultGatewayMock(method, _opts, params);
      },
    );

    const program = buildTaskProgram();
    await program.parseAsync(
      ["task", "repair", "job-1", "add-source", "https://example.com/report"],
      { from: "user" },
    );

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.repair",
      expect.anything(),
      {
        id: "job-1",
        action: "add_trusted_source",
        source: "https://example.com/report",
      },
      undefined,
    );
    expect(vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0]).toContain("Trusted source added");
  });

  it("passes stop-source repair through the task CLI", async () => {
    await runTaskCommand(["task", "repair", "job-1", "stop-source", "source-fetch-web-search"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.repair",
      expect.anything(),
      {
        id: "job-1",
        action: "stop_source_path",
        sourceNodeId: "source-fetch-web-search",
      },
      undefined,
    );
  });

  it("lists and controls trusted task sources from the task CLI", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.sources.list") {
          return {
            sources: [
              {
                id: "trusted-report",
                source: "https://example.com/report",
                kind: "url",
                taskType: "market",
                active: true,
                createdAtMs: 1,
                lastQualityScore: 0.91,
                lastQualityBand: "high",
                successCount: 2,
                failureCount: 0,
              },
            ],
            total: 1,
          };
        }
        if (method === "cron.sources.update") {
          return {
            ok: true,
            source: { id: "trusted-report", source: "https://example.com/report", kind: "url" },
          };
        }
        if (method === "cron.sources.remove") {
          return { ok: true, id: "trusted-report", removed: true };
        }
        if (method === "cron.repair") {
          return {
            ok: true,
            action: "add_trusted_source",
            message: "Trusted source added.",
            job: { id: "job-1" },
          };
        }
        return defaultGatewayMock(method, _opts, params);
      },
    );

    await buildTaskProgram().parseAsync(
      ["task", "sources", "list", "--all", "--task-type", "market"],
      {
        from: "user",
      },
    );
    await buildTaskProgram().parseAsync(
      ["task", "sources", "add", "job-1", "https://example.com/report"],
      {
        from: "user",
      },
    );
    await buildTaskProgram().parseAsync(["task", "sources", "disable", "trusted-report"], {
      from: "user",
    });
    await buildTaskProgram().parseAsync(["task", "sources", "forget", "trusted-report"], {
      from: "user",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.sources.list",
      expect.anything(),
      { includeInactive: true, taskType: "market" },
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.repair",
      expect.anything(),
      {
        id: "job-1",
        action: "add_trusted_source",
        source: "https://example.com/report",
      },
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.sources.update",
      expect.anything(),
      { id: "trusted-report", active: false },
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.sources.remove",
      expect.anything(),
      { id: "trusted-report" },
      undefined,
    );
    expect(
      vi
        .mocked(defaultRuntime.log)
        .mock.calls.map((call) => call[0])
        .join("\n"),
    ).toContain("Trusted task sources");
  });

  it("shows one task queue run detail", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.runDetail") {
        return {
          runId: "run-1",
          jobId: "task-1",
          jobName: "Provider health",
          status: "ok",
          leaseExpired: false,
          controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
          stepDetails: [
            {
              id: "execute",
              status: "ok",
              attempt: 1,
              maxAttempts: 2,
              retryPolicy: {
                maxAttempts: 2,
                retryDelayMs: 1000,
                backoffMultiplier: 2,
                retryOn: "error-or-lease-expired",
              },
              resume: {
                resumable: true,
                checkpointKeys: ["sessionKey"],
                reason: "Step completed; checkpoint retained for audit.",
                updatedAtMs: 2,
              },
              checkpoint: { sessionKey: "agent:main:cron:task-1:run:run-1" },
              createdAtMs: 1,
              leaseExpired: false,
              control: {
                available: false,
                label: "Step complete",
                reason: "This step completed successfully.",
              },
            },
          ],
          execution: {
            source: "direct-tool",
            adapter: "gateway:provider-health",
            modelUsed: false,
            deliveryStatus: "delivered",
            summary: "Provider health ok",
          },
          recommendedRepairActions: [
            {
              action: "configure_source",
              label: "Configure source",
              reason: "Provider auth is missing.",
              priority: "primary",
              setupPath: "/providers",
            },
          ],
        };
      }
      return defaultGatewayMock(method, undefined);
    });
    const program = buildTaskProgram();
    await program.parseAsync(["task", "run-show", "run-1"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.runDetail",
      expect.anything(),
      { runId: "run-1" },
      undefined,
    );
    const output = vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0] ?? "";
    expect(output).toContain("Provider health");
    expect(output).toContain("execute: ok");
    expect(output).toContain("retry error-or-lease-expired");
    expect(output).toContain("resumable");
    expect(output).toContain("Step complete");
    expect(output).toContain("Recommended repair");
    expect(output).toContain("fased task repair task-1 configure");
  });

  it("shows latest task run through run detail when available", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.runs") {
        return {
          entries: [
            {
              ts: Date.now(),
              jobId: "task-1",
              action: "finished",
              status: "ok",
              deliveryStatus: "delivered",
              summary: "Provider health ok",
              policy: {
                resultSource: "direct-tool",
                resultAdapter: "gateway:provider-health",
                modelUsed: false,
                runCheckpoint: { runId: "run-1", phase: "finished", trigger: "manual" },
              },
            },
          ],
        };
      }
      if (method === "cron.runDetail") {
        return {
          runId: "run-1",
          jobId: "task-1",
          jobName: "Provider health",
          status: "ok",
          leaseExpired: false,
          controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
          stepDetails: [],
          execution: {
            source: "direct-tool",
            adapter: "gateway:provider-health",
            modelUsed: false,
            deliveryStatus: "delivered",
            summary: "Provider health ok",
          },
        };
      }
      return defaultGatewayMock(method, undefined);
    });
    const program = buildTaskProgram();
    await program.parseAsync(["task", "last", "task-1"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.runs",
      expect.anything(),
      { id: "task-1", limit: 3 },
      undefined,
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.runDetail",
      expect.anything(),
      { runId: "run-1" },
      undefined,
    );
    const output = vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0] ?? "";
    expect(output).toContain("Run: run-1");
    expect(output).toContain("Provider health");
    expect(output).toContain("direct tool gateway:provider-health");
  });

  it("shows latest task run from the log when queue detail is unavailable", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.runs") {
        return {
          entries: [
            {
              ts: 1_700_000_010_000,
              jobId: "task-1",
              action: "finished",
              status: "ok",
              deliveryStatus: "delivered",
              durationMs: 1200,
              summary: "Mining status ok",
              sessionKey: "agent:main:cron:task-1:run:run-1",
              policy: {
                resultSource: "direct-tool",
                resultAdapter: "mining:status",
                modelUsed: false,
                skillScope: "selected",
                skills: {
                  count: 1,
                  names: ["Mining"],
                  skillFilter: ["mining"],
                },
                evaluator: {
                  source: "heuristic",
                  action: "none",
                  reason: "Escalation follow-up completed.",
                },
              },
            },
            {
              ts: 1_700_000_000_000,
              jobId: "task-1",
              action: "finished",
              status: "ok",
              deliveryStatus: "delivered",
              summary: "Needs deeper analysis: yes",
              policy: {
                evaluator: {
                  source: "heuristic",
                  action: "escalate",
                  reason: "Escalation cue found.",
                  signal: "Needs deeper analysis: yes",
                },
                runCheckpoint: {
                  runId: "run-escalated",
                  phase: "finished",
                },
              },
            },
          ],
        };
      }
      return defaultGatewayMock(method, undefined);
    });
    const program = buildTaskProgram();
    await program.parseAsync(["task", "last", "task-1"], { from: "user" });

    const output = vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0] ?? "";
    expect(output).toContain("Latest run: task-1");
    expect(output).toContain("Source: direct tool mining:status");
    expect(output).toContain("Delivery: delivered");
    expect(output).toContain("Skills: Narrow selected · 1 loaded · Mining");
    expect(output).toContain(
      'Escalation: follow-up completed · trigger run run-escalated · cue "Needs deeper analysis: yes"',
    );
    expect(output).toContain(
      "Transcript: /chat?session=agent%3Amain%3Acron%3Atask-1%3Arun%3Arun-1",
    );
  });

  it("keeps cron queue controls as compatibility aliases", async () => {
    await runCronCommand(["cron", "retry-run", "run-legacy"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.queue.retry",
      expect.anything(),
      { runId: "run-legacy", reason: undefined },
      undefined,
    );
  });

  it("registers managed task worker service install", async () => {
    await runTaskCommand([
      "task",
      "worker",
      "install",
      "--name",
      "alpha",
      "--worker-id",
      "worker-alpha",
      "--max-runs",
      "2",
      "--poll-ms",
      "500",
      "--force",
    ]);

    expect(runTaskWorkerServiceInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "alpha",
        workerId: "worker-alpha",
        maxRuns: "2",
        pollMs: "500",
        force: true,
      }),
    );
  });

  it("registers managed task worker service status", async () => {
    await runTaskCommand(["task", "worker", "status", "--name", "alpha"]);

    expect(runTaskWorkerServiceStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "alpha",
      }),
    );
  });

  it("prints task queue health in task status", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.status") {
        return {
          enabled: true,
          storePath: "/tmp/fased-cron/jobs.json",
          jobs: 3,
          nextWakeAtMs: Date.now() + 60_000,
          queue: {
            path: "/tmp/fased-cron/task-runs/queue.json",
            total: 2,
            queued: 1,
            running: 1,
            terminal: 0,
            cancelRequested: 0,
            expiredLeases: 0,
            byStatus: {
              queued: 1,
              running: 1,
              ok: 0,
              error: 0,
              skipped: 0,
              blocked: 0,
              canceled: 0,
              recovered: 0,
            },
            workers: [
              {
                workerId: "worker-a",
                running: 1,
                expired: 0,
                runIds: ["run-1"],
                nextLeaseExpiresAtMs: Date.now() + 30_000,
              },
            ],
            activeRuns: [
              {
                runId: "run-1",
                jobId: "job-1",
                jobName: "Provider health",
                status: "running",
                stepId: "execute",
                attempt: 1,
                maxAttempts: 2,
                leaseOwner: "worker-a",
                leaseExpired: false,
                queuedAtMs: Date.now(),
                updatedAtMs: Date.now(),
              },
            ],
            recentRuns: [],
          },
        };
      }
      return { ok: true };
    });

    const program = buildTaskProgram();
    await program.parseAsync(["task", "status"], { from: "user" });

    const output = vi
      .mocked(defaultRuntime.log)
      .mock.calls.map(([line]) => String(line))
      .join("\n");
    expect(output).toContain("Queue");
    expect(output).toContain("1 queued");
    expect(output).toContain("worker-a");
    expect(output).toContain("Provider health");
  });

  it("runs a temporary no-model task smoke and cleans it up", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.add") {
          return { id: "smoke-no-model", ...(params as Record<string, unknown>), state: {} };
        }
        if (method === "cron.run") {
          return { ok: true, ran: true };
        }
        if (method === "cron.list") {
          return {
            jobs: [
              {
                id: "smoke-no-model",
                name: "Task smoke no-model abc",
                enabled: true,
                state: {
                  lastRunStatus: "ok",
                  lastDeliveryStatus: "not-requested",
                  lastRunSessionKey: "agent:main:task-smoke:abc:run:1",
                },
              },
            ],
          };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: true };
        }
        if (method === "cron.status") {
          return { enabled: true };
        }
        return { ok: true };
      },
    );

    const program = buildTaskProgram();
    await program.parseAsync(["task", "smoke", "--agent", "main"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        agentId: "main",
        sessionTarget: "isolated",
        delivery: { mode: "none" },
        executionPolicy: expect.objectContaining({
          executionMode: "no-model",
          modelPolicy: { mode: "none" },
        }),
      }),
      { progress: false },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.run",
      expect.anything(),
      { id: "smoke-no-model", mode: "force" },
      { progress: false },
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.remove",
      expect.anything(),
      { id: "smoke-no-model" },
      { progress: false },
    );
  });

  it("smokes task repair recommendations and recovery actions", async () => {
    let created = 0;
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.add") {
          created += 1;
          return {
            id: `smoke-${created}`,
            ...(params as Record<string, unknown>),
            state: {},
          };
        }
        if (method === "cron.update") {
          const updateParams = params as {
            id: string;
            patch?: { state?: Record<string, unknown> };
          };
          return { id: updateParams.id, state: updateParams.patch?.state ?? {} };
        }
        if (method === "cron.run") {
          return { ok: true, ran: true };
        }
        if (method === "cron.runDetail") {
          return {
            runId: (params as { runId?: string })?.runId,
            recommendedRepairActions: [
              {
                action: "retry_replacement",
                label: "Retry with replacement",
                reason: "Repair smoke.",
                priority: "primary",
              },
            ],
          };
        }
        if (method === "cron.repair") {
          const repairParams = params as { id: string; action: string };
          return {
            ok: true,
            action: repairParams.action,
            job: { id: repairParams.id, state: {} },
            message: `${repairParams.action} ok`,
            setupPath: "/services",
          };
        }
        if (method === "cron.list") {
          return { jobs: [] };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: true };
        }
        if (method === "cron.status") {
          return { enabled: true };
        }
        return { ok: true };
      },
    );

    const program = buildTaskProgram();
    await program.parseAsync(["task", "smoke", "--repair"], { from: "user" });

    const repairCalls = callGatewayFromCli.mock.calls.filter((call) => call[0] === "cron.repair");
    expect(repairCalls.map((call) => (call[2] as { action: string }).action)).toEqual([
      "configure_source",
      "add_trusted_source",
      "retry_replacement",
      "stop_source_path",
    ]);
    expect(
      callGatewayFromCli.mock.calls.filter((call) => call[0] === "cron.runDetail"),
    ).toHaveLength(4);
    expect(callGatewayFromCli.mock.calls.filter((call) => call[0] === "cron.update")).toHaveLength(
      4,
    );
    expect(callGatewayFromCli.mock.calls.filter((call) => call[0] === "cron.remove")).toHaveLength(
      5,
    );
    const output = vi
      .mocked(defaultRuntime.log)
      .mock.calls.map(([line]) => String(line))
      .join("\n");
    expect(output).toContain("repairs configure_source ok");
    expect(output).toContain("repairs stop_source_path ok");
  });

  it("adds optional skill, model, and delivery smoke probes", async () => {
    let created = 0;
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.add") {
          created += 1;
          return {
            id: `smoke-${created}`,
            ...(params as Record<string, unknown>),
            state: {},
          };
        }
        if (method === "cron.run") {
          return { ok: true, ran: true };
        }
        if (method === "cron.list") {
          return { jobs: [] };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: true };
        }
        if (method === "cron.status") {
          return { enabled: true };
        }
        return { ok: true };
      },
    );

    const program = buildTaskProgram();
    await program.parseAsync(
      [
        "task",
        "smoke",
        "--channel",
        "telegram",
        "--to",
        "123",
        "--skill",
        "wallet",
        "--input",
        '{"action":"balance"}',
        "--model",
        "openrouter/test-model",
        "--keep",
      ],
      { from: "user" },
    );

    const addParams = callGatewayFromCli.mock.calls
      .filter((call) => call[0] === "cron.add")
      .map((call) => call[2] as CronAddParams);
    expect(addParams).toHaveLength(3);
    expect(addParams[0]).toMatchObject({
      delivery: { mode: "announce" },
      executionPolicy: { executionMode: "no-model" },
    });
    expect(addParams[1]).toMatchObject({
      executionPolicy: {
        executionMode: "skill-only",
        skillAction: { toolName: "wallet", input: { action: "balance" } },
      },
    });
    expect(addParams[2]).toMatchObject({
      executionPolicy: {
        executionMode: "agent-turn",
        modelPolicy: { mode: "task-override", model: "openrouter/test-model" },
      },
    });
    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "cron.remove")).toBe(false);
  });

  it("fails smoke when a task run ends in error and prints lastError", async () => {
    resetGatewayMock();
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "cron.add") {
          return { id: "smoke-model", ...(params as Record<string, unknown>), state: {} };
        }
        if (method === "cron.run") {
          return { ok: true, ran: true };
        }
        if (method === "cron.list") {
          return {
            jobs: [
              {
                id: "smoke-model",
                name: "Task smoke model abc",
                enabled: true,
                state: {
                  lastRunStatus: "error",
                  lastError: "model not allowed: openrouter/test-model",
                  lastDeliveryStatus: "unknown",
                },
              },
            ],
          };
        }
        if (method === "cron.remove") {
          return { ok: true, removed: true };
        }
        if (method === "cron.status") {
          return { enabled: true };
        }
        return { ok: true };
      },
    );

    const program = buildTaskProgram();
    await expect(
      program.parseAsync(["task", "smoke", "--model", "openrouter/test-model"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    const { defaultRuntime } = await import("../runtime.js");
    expect(vi.mocked(defaultRuntime.log).mock.calls.join("\n")).toContain(
      "last error model not allowed: openrouter/test-model",
    );
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.remove",
      expect.anything(),
      { id: "smoke-model" },
      { progress: false },
    );
  });

  it("trims model and thinking on cron add", { timeout: CRON_CLI_TEST_TIMEOUT_MS }, async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Daily",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hello",
      "--model",
      "  opus  ",
      "--thinking",
      "  low  ",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as {
      payload?: { model?: string; thinking?: string };
    };

    expect(params?.payload?.model).toBe("opus");
    expect(params?.payload?.thinking).toBe("low");
  });

  it("defaults isolated cron add to announce delivery", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Daily",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hello",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { delivery?: { mode?: string } };

    expect(params?.delivery?.mode).toBe("announce");
  });

  it("infers sessionTarget from payload when --session is omitted", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Main reminder",
      "--cron",
      "* * * * *",
      "--system-event",
      "hi",
    ]);

    let addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    let params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("main");
    expect(params?.payload?.kind).toBe("systemEvent");

    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Isolated task",
      "--cron",
      "* * * * *",
      "--message",
      "hello",
    ]);

    addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    params = addCall?.[2] as { sessionTarget?: string; payload?: { kind?: string } };
    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.payload?.kind).toBe("agentTurn");
  });

  it("supports --keep-after-run on cron add", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Keep me",
      "--at",
      "20m",
      "--session",
      "main",
      "--system-event",
      "hello",
      "--keep-after-run",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { deleteAfterRun?: boolean };
    expect(params?.deleteAfterRun).toBe(false);
  });

  it.each([
    { command: "enable" as const, expectedEnabled: true },
    { command: "disable" as const, expectedEnabled: false },
  ])("cron $command sets enabled=$expectedEnabled patch", async ({ command, expectedEnabled }) => {
    const patch = await runCronSimpleAndGetUpdatePatch(command);
    expect(patch.enabled).toBe(expectedEnabled);
  });

  it("sends agent id on cron add", async () => {
    await runCronCommand([
      "cron",
      "add",
      "--name",
      "Agent pinned",
      "--cron",
      "* * * * *",
      "--session",
      "isolated",
      "--message",
      "hi",
      "--agent",
      "ops",
    ]);

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { agentId?: string };
    expect(params?.agentId).toBe("ops");
  });

  it.each([
    {
      label: "omits empty model and thinking",
      args: ["--message", "hello", "--model", "   ", "--thinking", "  "],
      expectedModel: undefined,
      expectedThinking: undefined,
    },
    {
      label: "trims model and thinking",
      args: ["--message", "hello", "--model", "  opus  ", "--thinking", "  high  "],
      expectedModel: "opus",
      expectedThinking: "high",
    },
  ])("cron edit $label", async ({ args, expectedModel, expectedThinking }) => {
    const patch = await runCronEditAndGetPatch(args);
    expect(patch?.patch?.payload?.model).toBe(expectedModel);
    expect(patch?.patch?.payload?.thinking).toBe(expectedThinking);
  });

  it("sets and clears agent id on cron edit", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--agent", " Ops ", "--message", "hello"]);

    const patch = getGatewayCallParams<{ patch?: { agentId?: unknown } }>("cron.update");
    expect(patch?.patch?.agentId).toBe("ops");

    await runCronCommand(["cron", "edit", "job-2", "--clear-agent"]);
    const clearPatch = getGatewayCallParams<{ patch?: { agentId?: unknown } }>("cron.update");
    expect(clearPatch?.patch?.agentId).toBeNull();
  });

  it("allows model/thinking updates without --message", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--model", "opus", "--thinking", "low"]);

    const patch = getGatewayCallParams<{
      patch?: { payload?: { kind?: string; model?: string; thinking?: string } };
    }>("cron.update");

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("low");
  });

  it("updates delivery settings without requiring --message", async () => {
    await runCronCommand([
      "cron",
      "edit",
      "job-1",
      "--deliver",
      "--channel",
      "telegram",
      "--to",
      "19098680",
    ]);

    const patch = getGatewayCallParams<{
      patch?: {
        payload?: { kind?: string; message?: string };
        delivery?: { mode?: string; channel?: string; to?: string };
      };
    }>("cron.update");

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
    expect(patch?.patch?.payload?.message).toBeUndefined();
  });

  it("supports --no-deliver on cron edit", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--no-deliver"]);

    const patch = getGatewayCallParams<{
      patch?: { payload?: { kind?: string }; delivery?: { mode?: string } };
    }>("cron.update");

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.delivery?.mode).toBe("none");
  });

  it("does not include undefined delivery fields when updating message", async () => {
    // Update message without delivery flags - should NOT include undefined delivery fields
    await runCronCommand(["cron", "edit", "job-1", "--message", "Updated message"]);

    const patch = getGatewayCallParams<{
      patch?: {
        payload?: {
          message?: string;
          deliver?: boolean;
          channel?: string;
          to?: string;
          bestEffortDeliver?: boolean;
        };
        delivery?: unknown;
      };
    }>("cron.update");

    // Should include the new message
    expect(patch?.patch?.payload?.message).toBe("Updated message");

    // Should NOT include delivery fields at all (to preserve existing values)
    expect(patch?.patch?.payload).not.toHaveProperty("deliver");
    expect(patch?.patch?.payload).not.toHaveProperty("channel");
    expect(patch?.patch?.payload).not.toHaveProperty("to");
    expect(patch?.patch?.payload).not.toHaveProperty("bestEffortDeliver");
    expect(patch?.patch).not.toHaveProperty("delivery");
  });

  it("includes delivery fields when explicitly provided with message", async () => {
    const patch = await runCronEditAndGetPatch([
      "--message",
      "Updated message",
      "--deliver",
      "--channel",
      "telegram",
      "--to",
      "19098680",
    ]);

    // Should include everything
    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.channel).toBe("telegram");
    expect(patch?.patch?.delivery?.to).toBe("19098680");
  });

  it.each([
    { flag: "--best-effort-deliver", expectedBestEffort: true },
    { flag: "--no-best-effort-deliver", expectedBestEffort: false },
  ])("applies $flag on cron edit message updates", async ({ flag, expectedBestEffort }) => {
    const patch = await runCronEditAndGetPatch(["--message", "Updated message", flag]);
    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.delivery?.mode).toBe("announce");
    expect(patch?.patch?.delivery?.bestEffort).toBe(expectedBestEffort);
  });

  it("sets explicit stagger for cron add", async () => {
    const params = await runCronAddAndGetParams([
      "--name",
      "staggered",
      "--cron",
      "0 * * * *",
      "--stagger",
      "45s",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
    expect(params?.schedule?.kind).toBe("cron");
    expect(params?.schedule?.staggerMs).toBe(45_000);
  });

  it("sets exact cron mode on add", async () => {
    const params = await runCronAddAndGetParams([
      "--name",
      "exact",
      "--cron",
      "0 * * * *",
      "--exact",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
    expect(params?.schedule?.kind).toBe("cron");
    expect(params?.schedule?.staggerMs).toBe(0);
  });

  it("rejects --stagger with --exact on add", async () => {
    await expectCronCommandExit([
      "cron",
      "add",
      "--name",
      "invalid",
      "--cron",
      "0 * * * *",
      "--stagger",
      "1m",
      "--exact",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
  });

  it("rejects --stagger when schedule is not cron", async () => {
    await expectCronCommandExit([
      "cron",
      "add",
      "--name",
      "invalid",
      "--every",
      "10m",
      "--stagger",
      "30s",
      "--session",
      "main",
      "--system-event",
      "tick",
    ]);
  });

  it("sets explicit stagger for cron edit", async () => {
    await runCronCommand(["cron", "edit", "job-1", "--cron", "0 * * * *", "--stagger", "30s"]);

    const patch = getGatewayCallParams<{
      patch?: { schedule?: { kind?: string; staggerMs?: number } };
    }>("cron.update");
    expect(patch?.patch?.schedule?.kind).toBe("cron");
    expect(patch?.patch?.schedule?.staggerMs).toBe(30_000);
  });

  it("applies --exact to existing scheduled task without requiring --cron on edit", async () => {
    const patch = await runCronEditWithScheduleLookup(
      { kind: "cron", expr: "0 */2 * * *", tz: "UTC", staggerMs: 300_000 },
      ["--exact"],
    );
    expect(patch?.patch?.schedule).toEqual({
      kind: "cron",
      expr: "0 */2 * * *",
      tz: "UTC",
      staggerMs: 0,
    });
  });

  it("rejects --exact on edit when existing job is not cron", async () => {
    await expectCronEditWithScheduleLookupExit({ kind: "every", everyMs: 60_000 }, ["--exact"]);
  });
});
