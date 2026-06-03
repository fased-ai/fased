import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import { saveSessionStore } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

vi.mock("../../agents/session-write-lock.js", () => ({
  acquireSessionWriteLock: async () => ({ release: async () => {} }),
}));

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-active-named-session-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("initSessionState named channel sessions", () => {
  it("routes normal channel turns to the active named session while /session commands stay on the base route", async () => {
    const storePath = path.join(tempDir, "sessions.json");
    const baseSessionKey = "agent:main:telegram:direct:123";
    const childSessionKey = `${baseSessionKey}:chat:market-watch`;
    await saveSessionStore(storePath, {
      [baseSessionKey]: {
        sessionId: "base-session",
        updatedAt: Date.now(),
        activeSessionKey: childSessionKey,
      },
      [childSessionKey]: {
        sessionId: "child-session",
        updatedAt: Date.now(),
        baseSessionKey,
        sessionSlug: "market-watch",
        displayName: "Market Watch",
      },
    });
    const cfg = { session: { store: storePath } } as FasedAgentConfig;

    const normalTurn = await initSessionState({
      ctx: {
        Body: "check this",
        CommandBody: "check this",
        SessionKey: baseSessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(normalTurn.sessionKey).toBe(childSessionKey);
    expect(normalTurn.sessionEntry.displayName).toBe("Market Watch");

    const controlTurn = await initSessionState({
      ctx: {
        Body: "/session list",
        CommandBody: "/session list",
        SessionKey: baseSessionKey,
        Provider: "telegram",
        Surface: "telegram",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(controlTurn.sessionKey).toBe(baseSessionKey);
  });
});
