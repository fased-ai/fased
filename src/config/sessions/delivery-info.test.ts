import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDeliveryInfo, parseSessionThreadInfo } from "./delivery-info.js";
import type { SessionEntry } from "./types.js";

let tempHome: string | undefined;

const buildEntry = (deliveryContext: SessionEntry["deliveryContext"]): SessionEntry => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  deliveryContext,
});

function sessionStorePath(): string {
  if (!tempHome) {
    throw new Error("test home is not initialized");
  }
  return path.join(tempHome, ".fased", "agents", "main", "sessions", "sessions.json");
}

function writeStore(store: Record<string, SessionEntry>): void {
  const storePath = sessionStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "fased-delivery-info-"));
  vi.stubEnv("FASED_HOME", tempHome);
  vi.stubEnv("HOME", tempHome);
  vi.stubEnv("FASED_SESSION_CACHE_TTL_MS", "0");
  writeStore({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (tempHome) {
    fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("extractDeliveryInfo", () => {
  it("parses base session and thread/topic ids", () => {
    expect(parseSessionThreadInfo("agent:main:telegram:group:1:topic:55")).toEqual({
      baseSessionKey: "agent:main:telegram:group:1",
      threadId: "55",
    });
    expect(parseSessionThreadInfo("agent:main:slack:channel:C1:thread:123.456")).toEqual({
      baseSessionKey: "agent:main:slack:channel:C1",
      threadId: "123.456",
    });
    expect(parseSessionThreadInfo("agent:main:telegram:dm:user-1")).toEqual({
      baseSessionKey: "agent:main:telegram:dm:user-1",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo(undefined)).toEqual({
      baseSessionKey: undefined,
      threadId: undefined,
    });
  });

  it("returns deliveryContext for direct session keys", () => {
    const sessionKey = "agent:main:webchat:dm:user-123";
    writeStore({
      [sessionKey]: buildEntry({
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      }),
    });

    const result = extractDeliveryInfo(sessionKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("falls back to base sessions for :thread: keys", () => {
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    writeStore({
      [baseKey]: buildEntry({
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      }),
    });

    const result = extractDeliveryInfo(threadKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
  });

  it("falls back to base sessions for :topic: keys", () => {
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    writeStore({
      [baseKey]: buildEntry({
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
      }),
    });

    const result = extractDeliveryInfo(topicKey);

    expect(result).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
      },
      threadId: "55",
    });
  });
});
