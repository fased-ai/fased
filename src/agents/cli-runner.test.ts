import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { buildCliEnvAuthLog, runCliAgent } from "./cli-runner.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";

const supervisorSpawnMock = vi.fn();

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => supervisorSpawnMock(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

type MockRunExit = {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

function createManagedRun(exit: MockRunExit, pid = 1234) {
  return {
    runId: "run-supervisor",
    pid,
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
    cancel: vi.fn(),
  };
}

describe("runCliAgent with process supervisor", () => {
  beforeEach(() => {
    supervisorSpawnMock.mockClear();
  });

  it("runs CLI through supervisor and returns payload", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.2-codex",
      timeoutMs: 1_000,
      runId: "run-1",
      cliSessionId: "thread-123",
    });

    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
      mode?: string;
      timeoutMs?: number;
      noOutputTimeoutMs?: number;
      replaceExistingScope?: boolean;
      scopeKey?: string;
    };
    expect(input.mode).toBe("child");
    expect(input.argv?.[0]).toBe("codex");
    expect(input.timeoutMs).toBe(1_000);
    expect(input.noOutputTimeoutMs).toBeGreaterThanOrEqual(1_000);
    expect(input.replaceExistingScope).toBe(true);
    expect(input.scopeKey).toContain("thread-123");
  });

  it("keeps CLI runs tool-disabled by default", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        stdout: JSON.stringify({ result: "ok" }),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-tools-disabled",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      argv?: string[];
    };
    expect(input.argv?.join("\n")).toContain("Tools are disabled in this session");
    expect(input.argv?.join("\n")).toContain("Do not call tools");
  });

  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-2",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("produced no output");
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runCliAgent({
        sessionId: "s1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-3",
        cliSessionId: "thread-123",
      }),
    ).rejects.toThrow("exceeded timeout");
  });

  it("falls back to per-agent workspace when workspaceDir is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-cli-runner-"));
    const fallbackWorkspace = path.join(tempDir, "workspace-main");
    await fs.mkdir(fallbackWorkspace, { recursive: true });
    const cfg = {
      agents: {
        defaults: {
          workspace: fallbackWorkspace,
        },
      },
    } satisfies FasedAgentConfig;

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runCliAgent({
        sessionId: "s1",
        sessionKey: "agent:main:subagent:missing-workspace",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: undefined as unknown as string,
        config: cfg,
        prompt: "hi",
        provider: "codex-cli",
        model: "gpt-5.2-codex",
        timeoutMs: 1_000,
        runId: "run-4",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as { cwd?: string };
    expect(input.cwd).toBe(path.resolve(fallbackWorkspace));
  });

  it("clears inherited Claude auth env while keeping configured backend env", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "host-api-key");
    vi.stubEnv("ANTHROPIC_API_TOKEN", "host-api-token");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example.com/v1");
    vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-evil: yes");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "host-oauth-token");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("NODE_OPTIONS", "--require=/tmp/evil.js");

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await runCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
                env: {
                  ANTHROPIC_BASE_URL: "https://configured.example.com/v1",
                  SAFE_KEEP: "ok",
                },
              },
            },
          },
        },
      } satisfies FasedAgentConfig,
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-env",
    });

    const input = supervisorSpawnMock.mock.calls[0]?.[0] as {
      env?: Record<string, string | undefined>;
    };
    expect(input.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(input.env?.ANTHROPIC_API_TOKEN).toBeUndefined();
    expect(input.env?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(input.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(input.env?.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(input.env?.NODE_OPTIONS).toBeUndefined();
    expect(input.env?.ANTHROPIC_BASE_URL).toBe("https://configured.example.com/v1");
    expect(input.env?.SAFE_KEEP).toBe("ok");
    expect(input.env?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBe("1");
  });

  it("formats CLI auth env diagnostics as key names without secret values", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-host");
    vi.stubEnv("ANTHROPIC_API_TOKEN", "token-host");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-host");

    const log = buildCliEnvAuthLog({
      ANTHROPIC_API_TOKEN: "token-child",
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      OPENAI_API_KEY: "sk-openai-child",
    });

    expect(log).toMatch(/host=.*ANTHROPIC_API_KEY/);
    expect(log).toMatch(/host=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/host=.*OPENAI_API_KEY/);
    expect(log).toMatch(/child=.*ANTHROPIC_API_TOKEN/);
    expect(log).toMatch(/child=.*CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST/);
    expect(log).toMatch(/child=.*OPENAI_API_KEY/);
    expect(log).toMatch(/cleared=.*ANTHROPIC_API_KEY/);
    expect(log).not.toContain("sk-ant-host");
    expect(log).not.toContain("token-child");
    expect(log).not.toContain("sk-openai-child");
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });
});
