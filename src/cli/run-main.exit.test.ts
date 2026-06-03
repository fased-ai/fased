import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tryRouteCliMock = vi.hoisted(() => vi.fn());
const loadDotEnvMock = vi.hoisted(() => vi.fn());
const normalizeEnvMock = vi.hoisted(() => vi.fn());
const ensurePathMock = vi.hoisted(() => vi.fn());
const assertRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("./route.js", () => ({
  tryRouteCli: tryRouteCliMock,
}));

vi.mock("../infra/dotenv.js", () => ({
  loadDotEnv: loadDotEnvMock,
}));

vi.mock("../infra/env.js", () => ({
  normalizeEnv: normalizeEnvMock,
}));

vi.mock("../infra/path-env.js", () => ({
  ensureFasedAgentCliOnPath: ensurePathMock,
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: assertRuntimeMock,
}));

const { runCli } = await import("./run-main.js");

function overrideStdinIsTTY(value: boolean | undefined) {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value,
  });
  return () => {
    if (original) {
      Object.defineProperty(process.stdin, "isTTY", original);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  };
}

describe("runCli exit behavior", () => {
  let restoreStdinIsTTY: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreStdinIsTTY?.();
    restoreStdinIsTTY = undefined;
    vi.restoreAllMocks();
  });

  it("does not force process.exit after successful routed command", async () => {
    tryRouteCliMock.mockResolvedValueOnce(true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "fased", "status"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "fased", "status"]);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("pauses non-TTY stdin after successful routed commands without emitting output", async () => {
    restoreStdinIsTTY = overrideStdinIsTTY(false);
    tryRouteCliMock.mockResolvedValueOnce(true);
    const pauseSpy = vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit(${String(code)})`);
    }) as typeof process.exit);

    await runCli(["node", "fased", "status", "--json"]);

    expect(tryRouteCliMock).toHaveBeenCalledWith(["node", "fased", "status", "--json"]);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not pause TTY stdin after successful routed commands", async () => {
    restoreStdinIsTTY = overrideStdinIsTTY(true);
    tryRouteCliMock.mockResolvedValueOnce(true);
    const pauseSpy = vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);

    await runCli(["node", "fased", "status"]);

    expect(pauseSpy).not.toHaveBeenCalled();
  });
});
