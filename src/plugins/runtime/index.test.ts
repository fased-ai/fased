import { beforeEach, describe, expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

import { createPluginRuntime } from "./index.js";

describe("plugin runtime command execution", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
  });

  it("exposes runtime.system.runCommandWithTimeout by default", async () => {
    const commandResult = {
      stdout: "hello\n",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
    runCommandWithTimeoutMock.mockResolvedValue(commandResult);

    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).resolves.toEqual(commandResult);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("forwards runtime.system.runCommandWithTimeout errors", async () => {
    runCommandWithTimeoutMock.mockRejectedValue(new Error("boom"));
    const runtime = createPluginRuntime();
    await expect(
      runtime.system.runCommandWithTimeout(["echo", "hello"], { timeoutMs: 1000 }),
    ).rejects.toThrow("boom");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(["echo", "hello"], { timeoutMs: 1000 });
  });

  it("does not expose gateway-dispatch helper surfaces by default", () => {
    const runtime = createPluginRuntime() as Record<string, unknown>;

    expect(runtime.subagent).toBeUndefined();
    expect(runtime.nodes).toBeUndefined();
    expect(runtime.gateway).toBeUndefined();
  });

  it("exposes only fixed plugin admin RPC wrappers, never a generic dispatcher", () => {
    const runtime = createPluginRuntime();
    const helpers = runtime.helpers as Record<string, unknown>;
    const adminRpc = helpers.adminRpc as Record<string, unknown>;

    expect(adminRpc).toBeTruthy();
    expect(adminRpc.call).toBeUndefined();
    expect(adminRpc.dispatch).toBeUndefined();
    expect(adminRpc.request).toBeUndefined();
    expect(typeof adminRpc.chatInject).toBe("function");
    expect(typeof adminRpc.pushTest).toBe("function");
    expect(typeof adminRpc.webLoginStart).toBe("function");
    expect(typeof adminRpc.webLoginWait).toBe("function");
    expect(helpers["chat.inject"]).toBeUndefined();
    expect(helpers["push.test"]).toBeUndefined();
    expect(helpers["web.login.start"]).toBeUndefined();
    expect(helpers["web.login.wait"]).toBeUndefined();
  });
});
