import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  diagnosticSessionStates,
  getDiagnosticSessionStateCountForTest,
  getDiagnosticSessionState,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import { logWebhookError } from "./diagnostic.js";
import { resetLogger, setLoggerOverride } from "./logger.js";

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    vi.useRealTimers();
  });

  it("evicts stale idle session states", () => {
    getDiagnosticSessionState({ sessionId: "stale-1" });
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });

  it("caps tracked session states to a bounded max", () => {
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      diagnosticSessionStates.set(`session-${i}`, {
        sessionId: `session-${i}`,
        lastActivity: now + i,
        state: "idle",
        queueDepth: 1,
      });
    }
    pruneDiagnosticSessionStates(now + 2002, true);

    expect(getDiagnosticSessionStateCountForTest()).toBe(2000);
  });

  it("reuses keyed session state when later looked up by sessionId", () => {
    const keyed = getDiagnosticSessionState({
      sessionId: "s1",
      sessionKey: "agent:main:discord:channel:c1",
    });
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });

    expect(bySessionId).toBe(keyed);
    expect(bySessionId.sessionKey).toBe("agent:main:discord:channel:c1");
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });
});

describe("logger import side effects", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not mkdir at import time", async () => {
    vi.useRealTimers();
    vi.resetModules();

    const mkdirSpy = vi.spyOn(fs, "mkdirSync");

    await import("./logger.js");

    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});

describe("diagnostic log output", () => {
  let logPath = "";

  beforeEach(() => {
    logPath = path.join(os.tmpdir(), `fased-diagnostic-${crypto.randomUUID()}.log`);
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("hashes identifiers and redacts secret-looking error values in log lines", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "silent", file: logPath });

    logWebhookError({
      channel: "telegram",
      chatId: "raw-chat-id",
      error: "failed token=abcdef1234567890ghij",
    });

    const output = fs.readFileSync(logPath, "utf8");
    expect(output).toContain("chatId=sha256:");
    expect(output).toContain("token=abcdef…ghij");
    expect(output).not.toContain("raw-chat-id");
    expect(output).not.toContain("abcdef1234567890ghij");
  });
});
