import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import { clearSessionStoreCacheForTest, type SessionEntry } from "../../config/sessions.js";
import { createPluginRuntime } from "./index.js";
import { createScopedPluginRuntime } from "./scoped.js";
import type { PluginRuntimeSessionAuditEvent } from "./session-read-helper.js";

function createSessionStore(entries: Record<string, SessionEntry>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-plugin-runtime-sessions-"));
  const storePath = path.join(dir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries), "utf8");
  clearSessionStoreCacheForTest();
  return storePath;
}

function createConfig(storePath: string, read: boolean): FasedAgentConfig {
  return {
    session: { store: storePath },
    plugins: {
      entries: {
        reader: {
          enabled: true,
          runtime: {
            helpers: {
              sessions: { read },
            },
          },
        },
      },
    },
  };
}

describe("plugin runtime session read helper", () => {
  it("denies session reads without a trusted plugin scope", () => {
    const audit: PluginRuntimeSessionAuditEvent[] = [];
    const runtime = createPluginRuntime({ audit: (event) => audit.push(event) });

    expect(() => runtime.helpers.sessions.list()).toThrow(/trusted plugin id/);
    expect(audit).toEqual([
      {
        helper: "sessions.list",
        outcome: "denied",
        denyReason: "missing trusted plugin id",
      },
    ]);
  });

  it("denies session reads unless the plugin config explicitly allows them", () => {
    const storePath = createSessionStore({});
    const audit: PluginRuntimeSessionAuditEvent[] = [];
    const runtime = createPluginRuntime({
      config: createConfig(storePath, false),
      pluginId: "reader",
      audit: (event) => audit.push(event),
    });

    expect(() => runtime.helpers.sessions.list()).toThrow(/not enabled for plugin: reader/);
    expect(audit).toEqual([
      {
        pluginId: "reader",
        helper: "sessions.list",
        outcome: "denied",
        denyReason: "missing runtime.helpers.sessions.read grant",
      },
    ]);
  });

  it("lists sanitized session metadata when explicitly allowed", () => {
    const storePath = createSessionStore({
      "agent:main:telegram:dm:alice": {
        sessionId: "secret-session-id",
        sessionFile: "secret-transcript.jsonl",
        updatedAt: 123,
        displayName: "Alice",
        channel: "telegram",
        chatType: "direct",
        origin: {
          label: "Alice",
          from: "alice-private-id",
          to: "bot-private-id",
          accountId: "account-private-id",
        },
        lastTo: "alice-private-id",
        lastAccountId: "account-private-id",
        lastChannel: "telegram",
        modelProvider: "openrouter",
        model: "openai/gpt-4.1-mini",
        totalTokens: 42,
        totalTokensFresh: true,
        compactionCheckpoints: [
          {
            checkpointId: "checkpoint-1",
            sessionKey: "agent:main:telegram:dm:alice",
            sessionId: "secret-session-id",
            createdAt: 122,
            reason: "manual",
            summary: "private transcript summary",
            preCompaction: { sessionId: "before" },
            postCompaction: { sessionId: "after" },
          },
        ],
      },
    });
    const audit: PluginRuntimeSessionAuditEvent[] = [];
    const runtime = createPluginRuntime({
      config: createConfig(storePath, true),
      pluginId: "reader",
      audit: (event) => audit.push(event),
    });

    const result = runtime.helpers.sessions.list({ limit: 5 });

    expect(result.count).toBe(1);
    expect(result.sessions[0]).toMatchObject({
      key: "agent:main:telegram:dm:alice",
      kind: "direct",
      displayName: "Alice",
      channel: "telegram",
      chatType: "direct",
      updatedAt: 123,
      lastChannel: "telegram",
      modelProvider: "openrouter",
      model: "openai/gpt-4.1-mini",
      totalTokens: 42,
      totalTokensFresh: true,
      compactionCheckpointCount: 1,
    });
    expect(result.sessions[0]).not.toHaveProperty("sessionId");
    expect(result.sessions[0]).not.toHaveProperty("sessionFile");
    expect(result.sessions[0]).not.toHaveProperty("origin");
    expect(result.sessions[0]).not.toHaveProperty("deliveryContext");
    expect(result.sessions[0]).not.toHaveProperty("lastTo");
    expect(result.sessions[0]).not.toHaveProperty("lastAccountId");
    expect(result.sessions[0]).not.toHaveProperty("lastMessagePreview");
    expect(result.sessions[0]).not.toHaveProperty("compactionCheckpoints");
    expect(audit).toEqual([
      {
        pluginId: "reader",
        helper: "sessions.list",
        outcome: "allowed",
        listCount: 1,
      },
    ]);
  });

  it("records get audit with the requested session key", () => {
    const storePath = createSessionStore({
      "agent:main:direct": {
        sessionId: "session-1",
        updatedAt: 456,
      },
    });
    const audit: PluginRuntimeSessionAuditEvent[] = [];
    const runtime = createPluginRuntime({
      config: createConfig(storePath, true),
      pluginId: "reader",
      audit: (event) => audit.push(event),
    });

    expect(runtime.helpers.sessions.get({ key: "agent:main:direct" })).toMatchObject({
      key: "agent:main:direct",
      updatedAt: 456,
    });
    expect(audit).toEqual([
      {
        pluginId: "reader",
        helper: "sessions.get",
        outcome: "allowed",
        sessionKey: "agent:main:direct",
        listCount: 1,
      },
    ]);
  });

  it("scopes a shared base runtime per plugin before registration exposes it", () => {
    const storePath = createSessionStore({
      "agent:main:direct": {
        sessionId: "session-1",
        updatedAt: 456,
      },
    });
    const base = createPluginRuntime();
    const scoped = createScopedPluginRuntime(base, {
      config: createConfig(storePath, true),
      pluginId: "reader",
    });

    expect(scoped).not.toBe(base);
    expect(scoped.helpers.sessions.get({ key: "agent:main:direct" })).toMatchObject({
      key: "agent:main:direct",
      updatedAt: 456,
    });
    expect(() => base.helpers.sessions.list()).toThrow(/trusted plugin id/);
  });
});
