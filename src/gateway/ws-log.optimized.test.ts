import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../globals.js", () => ({
  isVerbose: () => false,
}));

vi.mock("../logging/console.js", () => ({
  shouldLogSubsystemToConsole: () => true,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mocks,
}));

const { logWs } = await import("./ws-log.js");

describe("gateway ws optimized logging", () => {
  beforeEach(() => {
    mocks.info.mockClear();
    mocks.warn.mockClear();
    mocks.error.mockClear();
  });

  test("suppresses optional missing SAT mining method responses", () => {
    logWs("in", "req", {
      connId: "conn-1",
      id: "req-1",
      method: "sat.getMiningStatus",
    });
    logWs("out", "res", {
      connId: "conn-1",
      id: "req-1",
      ok: false,
      method: "sat.getMiningStatus",
      errorCode: "INVALID_REQUEST",
      errorMessage: "unknown method: sat.getMiningStatus",
    });

    expect(mocks.info).not.toHaveBeenCalled();
  });

  test("still logs other failed gateway responses", () => {
    logWs("in", "req", {
      connId: "conn-1",
      id: "req-2",
      method: "config.get",
    });
    logWs("out", "res", {
      connId: "conn-1",
      id: "req-2",
      ok: false,
      method: "config.get",
      errorCode: "INVALID_REQUEST",
      errorMessage: "config failed",
    });

    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(String(mocks.info.mock.calls[0]?.[0] ?? "")).toContain("config.get");
  });
});
