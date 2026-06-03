import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  storePath: "",
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      session: {
        store: testState.storePath,
      },
    })),
  };
});

import type { SessionEntry } from "../../config/sessions.js";
import {
  clearCombinedSessionStoreCacheForTest,
  type SessionsListResult,
} from "../session-utils.js";
import { sessionsHandlers } from "./sessions.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-sessions-compaction-rpc-"));
  tmpDirs.push(dir);
  return dir;
}

function writeStore(entry: SessionEntry): void {
  fs.mkdirSync(path.dirname(testState.storePath), { recursive: true });
  fs.writeFileSync(testState.storePath, JSON.stringify({ global: entry }, null, 2), "utf-8");
}

async function callSessionHandler(
  method:
    | "sessions.compaction.list"
    | "sessions.compaction.get"
    | "sessions.compaction.branch"
    | "sessions.compaction.restore"
    | "sessions.compact"
    | "sessions.list",
  params: Record<string, unknown>,
  extra?: Record<string, unknown>,
) {
  const respond = vi.fn();
  await sessionsHandlers[method]({
    params,
    respond,
    ...extra,
  } as unknown as Parameters<(typeof sessionsHandlers)[typeof method]>[0]);
  return respond;
}

function writeCheckpointTranscript(dir: string, sessionId: string): string {
  const checkpointFile = path.join(
    dir,
    `${sessionId}.checkpoint.00000000-0000-4000-8000-000000000000.jsonl`,
  );
  const timestamp = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(
    checkpointFile,
    [
      JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp,
        cwd: dir,
      }),
      JSON.stringify({
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp,
        customType: "test",
        data: { ok: true },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  return checkpointFile;
}

afterEach(() => {
  vi.clearAllMocks();
  clearCombinedSessionStoreCacheForTest();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sessions.compaction read RPCs", () => {
  it("refreshes session list checkpoint summaries after compacting a warm cached store", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    const currentFile = path.join(dir, "session-1.jsonl");
    const timestamp = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(
      currentFile,
      [
        JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "session-1",
          timestamp,
          cwd: dir,
        }),
        JSON.stringify({
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp,
          message: { role: "user", content: "old context" },
        }),
        JSON.stringify({
          type: "message",
          id: "entry-2",
          parentId: "entry-1",
          timestamp,
          message: { role: "assistant", content: "kept context" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeStore({
      sessionId: "session-1",
      sessionFile: currentFile,
      updatedAt: 100,
      totalTokens: 900,
      totalTokensFresh: true,
    });

    const listBefore = await callSessionHandler("sessions.list", { includeGlobal: true });
    const beforePayload = listBefore.mock.calls[0]?.[1] as SessionsListResult;
    expect(beforePayload.sessions[0]?.compactionCheckpointCount).toBe(0);

    const originalStoreStat = fs.statSync(testState.storePath);
    const realStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((filePath: fs.PathLike) => {
      if (path.resolve(String(filePath)) === path.resolve(testState.storePath)) {
        return originalStoreStat;
      }
      return realStatSync(filePath);
    }) as typeof fs.statSync);

    try {
      const compactRespond = await callSessionHandler("sessions.compact", {
        key: "global",
        maxLines: 2,
      });
      expect(compactRespond.mock.calls[0]?.[0]).toBe(true);
      const compactPayload = compactRespond.mock.calls[0]?.[1] as {
        compacted: boolean;
        checkpointId?: string;
      };
      expect(compactPayload.compacted).toBe(true);
      expect(compactPayload.checkpointId).toBeTruthy();

      const listAfter = await callSessionHandler("sessions.list", { includeGlobal: true });
      const afterPayload = listAfter.mock.calls[0]?.[1] as SessionsListResult;
      expect(afterPayload.sessions[0]?.compactionCheckpointCount).toBe(1);
      expect(afterPayload.sessions[0]?.compactionCheckpoints?.[0]?.checkpointId).toBe(
        compactPayload.checkpointId,
      );
    } finally {
      statSpy.mockRestore();
    }
  });

  it("lists and gets stored compaction checkpoints", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    writeStore({
      sessionId: "session-1",
      updatedAt: 100,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "global",
          sessionId: "session-1",
          createdAt: 100,
          reason: "manual",
          preCompaction: { sessionId: "session-1" },
          postCompaction: { sessionId: "session-1" },
        },
      ],
    });

    const listRespond = await callSessionHandler("sessions.compaction.list", { key: "global" });
    expect(listRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: "global",
        checkpoints: [expect.objectContaining({ checkpointId: "checkpoint-1" })],
      }),
      undefined,
    );

    const getRespond = await callSessionHandler("sessions.compaction.get", {
      key: "global",
      checkpointId: "checkpoint-1",
    });
    expect(getRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: "global",
        checkpoint: expect.objectContaining({ checkpointId: "checkpoint-1" }),
      }),
      undefined,
    );
  });

  it("rejects missing checkpoint ids", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    writeStore({ sessionId: "session-1", updatedAt: 100 });

    const respond = await callSessionHandler("sessions.compaction.get", {
      key: "global",
      checkpointId: "missing",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ message: "compaction checkpoint not found" }),
    );
  });

  it("branches from a stored checkpoint snapshot", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    const checkpointFile = writeCheckpointTranscript(dir, "session-1");
    writeStore({
      sessionId: "session-1",
      sessionFile: path.join(dir, "session-1.jsonl"),
      updatedAt: 100,
      label: "Support chat",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      channel: "telegram",
      groupId: "chat-1",
      subject: "Ops",
      groupChannel: "telegram",
      space: "topic-1",
      origin: {
        provider: "telegram",
        surface: "channel",
        to: "chat-1",
        accountId: "telegram-main",
        threadId: "topic-1",
      },
      deliveryContext: {
        channel: "telegram",
        to: "chat-1",
        accountId: "telegram-main",
        threadId: "topic-1",
      },
      lastChannel: "telegram",
      lastTo: "chat-1",
      lastAccountId: "telegram-main",
      lastThreadId: "topic-1",
      totalTokens: 500,
      totalTokensFresh: true,
      acp: {
        backend: "test",
        agent: "main",
        runtimeSessionName: "acp-session-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 100,
      },
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "global",
          sessionId: "session-1",
          createdAt: 100,
          reason: "manual",
          tokensBefore: 500,
          preCompaction: { sessionId: "session-1", sessionFile: checkpointFile },
          postCompaction: {
            sessionId: "session-1",
            sessionFile: path.join(dir, "session-1.jsonl"),
          },
        },
      ],
    });

    const broadcastSessionLifecycleEvent = vi.fn();
    const respond = await callSessionHandler(
      "sessions.compaction.branch",
      {
        key: "global",
        checkpointId: "checkpoint-1",
      },
      {
        context: { broadcastSessionLifecycleEvent },
      },
    );

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const payload = respond.mock.calls[0]?.[1] as {
      key: string;
      sourceKey: string;
      sessionId: string;
      entry: SessionEntry;
    };
    expect(payload.sourceKey).toBe("global");
    expect(payload.key).toMatch(/^agent:main:dashboard:/);
    expect(payload.entry.label).toBe("Support chat (checkpoint)");
    expect(payload.entry.sessionId).toBe(payload.sessionId);
    expect(payload.entry.sessionFile).toBeTruthy();
    expect(payload.entry.compactionCheckpoints).toBeUndefined();
    expect(payload.entry.acp).toBeUndefined();
    expect(payload.entry.spawnedBy).toBeUndefined();
    expect(payload.entry.spawnDepth).toBeUndefined();
    expect(payload.entry.channel).toBeUndefined();
    expect(payload.entry.groupId).toBeUndefined();
    expect(payload.entry.subject).toBeUndefined();
    expect(payload.entry.groupChannel).toBeUndefined();
    expect(payload.entry.space).toBeUndefined();
    expect(payload.entry.origin).toBeUndefined();
    expect(payload.entry.deliveryContext).toBeUndefined();
    expect(payload.entry.lastChannel).toBeUndefined();
    expect(payload.entry.lastTo).toBeUndefined();
    expect(payload.entry.lastAccountId).toBeUndefined();
    expect(payload.entry.lastThreadId).toBeUndefined();
    expect(payload.entry.totalTokens).toBe(500);
    expect(fs.existsSync(payload.entry.sessionFile!)).toBe(true);

    const store = JSON.parse(fs.readFileSync(testState.storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(store[payload.key]?.sessionId).toBe(payload.sessionId);
    expect(store.global?.sessionId).toBe("session-1");
    expect(broadcastSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "global",
      phase: "checkpoint-branch-source",
      reason: "checkpoint-1",
    });
    expect(broadcastSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: payload.key,
      phase: "checkpoint-branch",
      reason: "checkpoint-1",
    });
  });

  it("rejects branch when the checkpoint snapshot is missing", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    writeStore({
      sessionId: "session-1",
      updatedAt: 100,
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "global",
          sessionId: "session-1",
          createdAt: 100,
          reason: "manual",
          preCompaction: {
            sessionId: "session-1",
            sessionFile: path.join(
              dir,
              "session-1.checkpoint.00000000-0000-4000-8000-000000000000.jsonl",
            ),
          },
          postCompaction: { sessionId: "session-1" },
        },
      ],
    });

    const respond = await callSessionHandler("sessions.compaction.branch", {
      key: "global",
      checkpointId: "checkpoint-1",
    });

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ message: "compaction checkpoint snapshot not available" }),
    );
  });

  it("rejects branch from webchat clients", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    writeStore({ sessionId: "session-1", updatedAt: 100 });

    const respond = await callSessionHandler(
      "sessions.compaction.branch",
      {
        key: "global",
        checkpointId: "checkpoint-1",
      },
      {
        client: { connId: "webchat-1", connect: { role: "webchat" } },
        isWebchatConnect: () => true,
      },
    );

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("webchat clients cannot branch"),
      }),
    );
  });

  it("restores the source session from a checkpoint snapshot", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    const checkpointFile = writeCheckpointTranscript(dir, "session-1");
    const currentFile = path.join(dir, "session-1.jsonl");
    fs.writeFileSync(
      currentFile,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "session-1",
        timestamp: "2026-01-02T00:00:00.000Z",
        cwd: dir,
      })}\n`,
      "utf-8",
    );
    writeStore({
      sessionId: "session-1",
      sessionFile: currentFile,
      updatedAt: 100,
      label: "Support chat",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      channel: "telegram",
      groupId: "chat-1",
      subject: "Ops",
      groupChannel: "telegram",
      space: "topic-1",
      origin: {
        provider: "telegram",
        surface: "channel",
        to: "chat-1",
        accountId: "telegram-main",
        threadId: "topic-1",
      },
      deliveryContext: {
        channel: "telegram",
        to: "chat-1",
        accountId: "telegram-main",
        threadId: "topic-1",
      },
      lastChannel: "telegram",
      lastTo: "chat-1",
      lastAccountId: "telegram-main",
      lastThreadId: "topic-1",
      totalTokens: 200,
      totalTokensFresh: false,
      acp: {
        backend: "test",
        agent: "main",
        runtimeSessionName: "acp-session-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 100,
      },
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "global",
          sessionId: "session-1",
          createdAt: 100,
          reason: "manual",
          tokensBefore: 500,
          preCompaction: { sessionId: "session-1", sessionFile: checkpointFile },
          postCompaction: { sessionId: "session-1", sessionFile: currentFile },
        },
      ],
    });

    const broadcastSessionLifecycleEvent = vi.fn();
    const respond = await callSessionHandler(
      "sessions.compaction.restore",
      {
        key: "global",
        checkpointId: "checkpoint-1",
      },
      {
        context: { broadcastSessionLifecycleEvent },
      },
    );

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const payload = respond.mock.calls[0]?.[1] as {
      key: string;
      sessionId: string;
      archived: string[];
      entry: SessionEntry;
    };
    expect(payload.key).toBe("global");
    expect(payload.entry.label).toBe("Support chat");
    expect(payload.entry.sessionId).toBe(payload.sessionId);
    expect(payload.entry.sessionId).not.toBe("session-1");
    expect(payload.entry.sessionFile).toBeTruthy();
    expect(payload.entry.compactionCheckpoints?.[0]?.checkpointId).toBe("checkpoint-1");
    expect(payload.entry.acp).toBeUndefined();
    expect(payload.entry.spawnedBy).toBe("agent:main:main");
    expect(payload.entry.spawnDepth).toBe(1);
    expect(payload.entry.channel).toBe("telegram");
    expect(payload.entry.groupId).toBe("chat-1");
    expect(payload.entry.subject).toBe("Ops");
    expect(payload.entry.groupChannel).toBe("telegram");
    expect(payload.entry.space).toBe("topic-1");
    expect(payload.entry.origin).toEqual({
      provider: "telegram",
      surface: "channel",
      to: "chat-1",
      accountId: "telegram-main",
      threadId: "topic-1",
    });
    expect(payload.entry.deliveryContext).toEqual({
      channel: "telegram",
      to: "chat-1",
      accountId: "telegram-main",
      threadId: "topic-1",
    });
    expect(payload.entry.lastChannel).toBe("telegram");
    expect(payload.entry.lastTo).toBe("chat-1");
    expect(payload.entry.lastAccountId).toBe("telegram-main");
    expect(payload.entry.lastThreadId).toBe("topic-1");
    expect(payload.entry.totalTokens).toBe(500);
    expect(payload.archived.length).toBeGreaterThan(0);
    expect(fs.existsSync(currentFile)).toBe(false);
    expect(fs.existsSync(payload.entry.sessionFile!)).toBe(true);

    const store = JSON.parse(fs.readFileSync(testState.storePath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(store.global?.sessionId).toBe(payload.sessionId);
    expect(broadcastSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "global",
      phase: "checkpoint-restore",
      reason: "checkpoint-1",
    });
  });

  it("rejects restore from webchat clients", async () => {
    const dir = makeTmpDir();
    testState.storePath = path.join(dir, "sessions.json");
    writeStore({ sessionId: "session-1", updatedAt: 100 });

    const respond = await callSessionHandler(
      "sessions.compaction.restore",
      {
        key: "global",
        checkpointId: "checkpoint-1",
      },
      {
        client: { connId: "webchat-1", connect: { role: "webchat" } },
        isWebchatConnect: () => true,
      },
    );

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("webchat clients cannot restore"),
      }),
    );
  });
});
