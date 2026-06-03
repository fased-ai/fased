import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { UpdateCheckResult } from "../../infra/update-check.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";

// Capture the sentinel payload written during update.run
let capturedPayload: RestartSentinelPayload | undefined;

const runGatewayUpdateMock = vi.fn<() => Promise<UpdateRunResult>>();
const checkUpdateStatusMock =
  vi.fn<
    (params: {
      root: string | null;
      timeoutMs?: number;
      fetchGit?: boolean;
      includeRegistry?: boolean;
    }) => Promise<UpdateCheckResult>
  >();

const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({ update: {} }),
  readConfigFileSnapshot: async () => ({
    exists: true,
    valid: true,
    config: { update: { channel: "beta" } },
    issues: [],
    warnings: [],
  }),
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: (sessionKey: string | undefined) => {
    if (!sessionKey) {
      return { deliveryContext: undefined, threadId: undefined };
    }
    // Simulate a threaded Slack session
    if (sessionKey.includes(":thread:")) {
      return {
        deliveryContext: { channel: "slack", to: "slack:C0123ABC", accountId: "workspace-1" },
        threadId: "1234567890.123456",
      };
    }
    return {
      deliveryContext: { channel: "webchat", to: "webchat:user-123", accountId: "default" },
      threadId: undefined,
    };
  },
}));

vi.mock("../../infra/fased-root.js", () => ({
  resolveFasedAgentPackageRoot: async () => "/tmp/fased",
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    writeRestartSentinel: async (payload: RestartSentinelPayload) => {
      capturedPayload = payload;
      return "/tmp/sentinel.json";
    },
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../infra/update-channels.js", () => ({
  normalizeUpdateChannel: (value?: string | null) => (value === "beta" ? "beta" : undefined),
  resolveUpdateChannelDisplay: (params: { configChannel?: string | null }) => ({
    channel: params.configChannel ?? "dev",
    source: params.configChannel ? "config" : "default",
    label: params.configChannel ? `${params.configChannel} (config)` : "dev (default)",
  }),
}));

vi.mock("../../infra/update-check.js", () => ({
  checkUpdateStatus: checkUpdateStatusMock,
  compareSemverStrings: (a: string | null, b: string | null) => {
    if (!a || !b || a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  },
}));

vi.mock("../../infra/update-runner.js", () => ({
  runGatewayUpdate: runGatewayUpdateMock,
}));

vi.mock("../protocol/index.js", () => ({
  validateUpdateRunParams: () => true,
  validateUpdateStatusParams: () => true,
}));

vi.mock("./restart-request.js", () => ({
  parseRestartRequestParams: (params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    note: params.note,
    restartDelayMs: undefined,
  }),
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

beforeEach(() => {
  capturedPayload = undefined;
  runGatewayUpdateMock.mockClear();
  runGatewayUpdateMock.mockResolvedValue({
    status: "ok",
    mode: "npm",
    steps: [],
    durationMs: 100,
  });
  checkUpdateStatusMock.mockClear();
  checkUpdateStatusMock.mockResolvedValue({
    root: "/tmp/fased",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/tmp/fased",
      sha: "abc123",
      tag: null,
      branch: "main",
      upstream: "origin/main",
      dirty: false,
      ahead: 0,
      behind: 2,
      fetchOk: null,
    },
    deps: {
      manager: "pnpm",
      status: "ok",
      lockfilePath: "/tmp/fased/pnpm-lock.yaml",
      markerPath: "/tmp/fased/node_modules/.modules.yaml",
    },
  });
  scheduleGatewaySigusr1RestartMock.mockClear();
  scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
});

async function invokeUpdateRun(
  params: Record<string, unknown>,
  respond: ((ok: boolean, response?: unknown) => void) | undefined = undefined,
) {
  const { updateHandlers } = await import("./update.js");
  const onRespond = respond ?? (() => {});
  await updateHandlers["update.run"]({
    params,
    respond: onRespond as never,
  } as never);
}

async function invokeUpdateStatus(
  params: Record<string, unknown>,
  respond: ((ok: boolean, response?: unknown) => void) | undefined = undefined,
) {
  const { updateHandlers } = await import("./update.js");
  const onRespond = respond ?? (() => {});
  await updateHandlers["update.status"]({
    params,
    respond: onRespond as never,
  } as never);
}

describe("update.status", () => {
  it("returns read-only status without running update or scheduling restart", async () => {
    let payload:
      | {
          ok: boolean;
          update: UpdateCheckResult;
          channel: { channel: string; source: string; label: string; config: string | null };
          probes: { fetchGit: boolean; includeRegistry: boolean; timeoutMs: number };
          availability: { available: boolean; hasGitUpdate: boolean; gitBehind: number | null };
          summary: string;
        }
      | undefined;

    await invokeUpdateStatus(
      { timeoutMs: 10, fetchGit: true, includeRegistry: true },
      (_ok, response) => {
        payload = response as typeof payload;
      },
    );

    expect(checkUpdateStatusMock).toHaveBeenCalledWith({
      root: "/tmp/fased",
      timeoutMs: 1000,
      fetchGit: true,
      includeRegistry: true,
    });
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(capturedPayload).toBeUndefined();
    expect(payload?.ok).toBe(true);
    expect(payload?.update.installKind).toBe("git");
    expect(payload?.channel).toEqual({
      channel: "beta",
      source: "config",
      label: "beta (config)",
      config: "beta",
    });
    expect(payload?.probes).toEqual({
      fetchGit: true,
      includeRegistry: true,
      timeoutMs: 1000,
    });
    expect(payload?.availability).toMatchObject({
      available: true,
      hasGitUpdate: true,
      gitBehind: 2,
    });
    expect(payload?.summary).toContain("behind 2");
  });

  it("defaults to local-only probes", async () => {
    await invokeUpdateStatus({});

    expect(checkUpdateStatusMock).toHaveBeenCalledWith({
      root: "/tmp/fased",
      timeoutMs: 3500,
      fetchGit: false,
      includeRegistry: false,
    });
  });
});

describe("update.run sentinel deliveryContext", () => {
  it("includes deliveryContext in sentinel payload when sessionKey is provided", async () => {
    capturedPayload = undefined;

    let responded = false;
    await invokeUpdateRun({ sessionKey: "agent:main:webchat:dm:user-123" }, () => {
      responded = true;
    });

    expect(responded).toBe(true);
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toEqual({
      channel: "webchat",
      to: "webchat:user-123",
      accountId: "default",
    });
  });

  it("omits deliveryContext when no sessionKey is provided", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({});

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toBeUndefined();
    expect(capturedPayload!.threadId).toBeUndefined();
  });

  it("includes threadId in sentinel payload for threaded sessions", async () => {
    capturedPayload = undefined;

    await invokeUpdateRun({ sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456" });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.deliveryContext).toEqual({
      channel: "slack",
      to: "slack:C0123ABC",
      accountId: "workspace-1",
    });
    expect(capturedPayload!.threadId).toBe("1234567890.123456");
  });
});

describe("update.run timeout normalization", () => {
  it("enforces a 1000ms minimum timeout for tiny values", async () => {
    await invokeUpdateRun({ timeoutMs: 1 });

    expect(runGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1000,
      }),
    );
  });
});

describe("update.run restart scheduling", () => {
  it("schedules restart when update succeeds", async () => {
    let payload: { ok: boolean; restart: unknown } | undefined;

    await invokeUpdateRun({}, (_ok: boolean, response: unknown) => {
      const typed = response as { ok: boolean; restart: unknown };
      payload = typed;
    });

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    expect(payload?.ok).toBe(true);
    expect(payload?.restart).toEqual({ scheduled: true });
  });

  it("skips restart when update fails", async () => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "error",
      mode: "git",
      reason: "build-failed",
      steps: [],
      durationMs: 100,
    });

    let payload: { ok: boolean; restart: unknown } | undefined;

    await invokeUpdateRun({}, (_ok: boolean, response: unknown) => {
      const typed = response as { ok: boolean; restart: unknown };
      payload = typed;
    });

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(payload?.ok).toBe(false);
    expect(payload?.restart).toBeNull();
  });
});
