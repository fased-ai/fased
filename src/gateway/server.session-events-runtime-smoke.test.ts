import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness;
let sessionDir: string | undefined;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-session-events-smoke-"));
});

afterEach(async () => {
  if (sessionDir) {
    await fs.rm(sessionDir, { recursive: true, force: true });
    sessionDir = undefined;
  }
});

afterAll(async () => {
  await harness.close();
});

async function seedMainTranscript() {
  if (!sessionDir) {
    throw new Error("missing sessionDir");
  }
  const sessionFile = path.join(sessionDir, "sess-main.jsonl");
  const storePath = path.join(sessionDir, "sessions.json");
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "sess-main",
      timestamp: new Date(0).toISOString(),
      cwd: sessionDir,
    })}\n`,
    "utf-8",
  );
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        sessionFile,
        updatedAt: Date.now(),
        label: "Main",
      },
    },
    storePath,
  });
}

async function seedTelegramTranscript() {
  if (!sessionDir) {
    throw new Error("missing sessionDir");
  }
  const sessionFile = path.join(sessionDir, "sess-telegram.jsonl");
  const storePath = path.join(sessionDir, "sessions.json");
  const key = "agent:main:telegram:direct:alice";
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "sess-telegram",
      timestamp: new Date(0).toISOString(),
      cwd: sessionDir,
    })}\n`,
    "utf-8",
  );
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {
      "telegram:direct:alice": {
        sessionId: "sess-telegram",
        sessionFile,
        updatedAt: Date.now(),
        label: "Telegram Alice",
        displayName: "Telegram Alice",
        deliveryContext: {
          channel: "telegram",
          to: "chat-123",
          accountId: "bot-main",
        },
      },
    },
    storePath,
  });
  return { key, sessionFile };
}

type GatewayEventFrame = {
  type?: string;
  event?: string;
  payload?: Record<string, unknown> | null;
};

describe("gateway session event runtime broadcasts", () => {
  test("subscribed operator receives transcript message and session changed events", async () => {
    await seedMainTranscript();
    const { ws } = await harness.openClient({ scopes: ["operator.read", "operator.admin"] });
    try {
      const broadSub = await rpcReq(ws, "sessions.subscribe");
      expect(broadSub.ok).toBe(true);

      const messageSub = await rpcReq<{ key?: string }>(ws, "sessions.messages.subscribe", {
        key: "main",
      });
      expect(messageSub.ok).toBe(true);
      expect(messageSub.payload?.key).toBe("agent:main:main");

      const messageEvent = onceMessage<GatewayEventFrame>(
        ws,
        (frame) => frame.type === "event" && frame.event === "session.message",
      );
      void messageEvent.catch(() => undefined);
      const changedEvent = onceMessage<GatewayEventFrame>(
        ws,
        (frame) => frame.type === "event" && frame.event === "sessions.changed",
      );
      void changedEvent.catch(() => undefined);

      const injected = await rpcReq<{ ok?: boolean }>(ws, "chat.inject", {
        sessionKey: "main",
        message: "hello [[reply_to_current]]",
      });
      expect(injected.ok).toBe(true);
      expect(injected.payload?.ok).toBe(true);

      await expect(messageEvent).resolves.toEqual(
        expect.objectContaining({
          event: "session.message",
          payload: expect.objectContaining({
            sessionKey: "agent:main:main",
            sessionId: "sess-main",
            messageId: expect.any(String),
            messageSeq: expect.any(Number),
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: "hello " }],
            }),
          }),
        }),
      );

      await expect(changedEvent).resolves.toEqual(
        expect.objectContaining({
          event: "sessions.changed",
          payload: expect.objectContaining({
            sessionKey: "agent:main:main",
            sessionId: "sess-main",
            phase: "message",
            messageId: expect.any(String),
            messageSeq: expect.any(Number),
            ts: expect.any(Number),
          }),
        }),
      );
    } finally {
      ws.close();
    }
  });

  test("webchat selected channel session receives fake channel transcript updates", async () => {
    const { key, sessionFile } = await seedTelegramTranscript();
    const ws = await connectWebchatClient({ port: harness.port });
    try {
      const messageSub = await rpcReq<{ key?: string }>(ws, "sessions.messages.subscribe", {
        key,
      });
      expect(messageSub.ok).toBe(true);
      expect(messageSub.payload?.key).toBe(key);

      const messageEvent = onceMessage<GatewayEventFrame>(
        ws,
        (frame) => frame.type === "event" && frame.event === "session.message",
      );
      void messageEvent.catch(() => undefined);

      emitSessionTranscriptUpdate({
        sessionFile,
        sessionKey: key,
        messageId: "fake-telegram-msg",
        message: {
          role: "user",
          content: "incoming from Telegram",
        },
      });

      await expect(messageEvent).resolves.toEqual(
        expect.objectContaining({
          event: "session.message",
          payload: expect.objectContaining({
            sessionKey: key,
            sessionId: "sess-telegram",
            label: "Telegram Alice",
            deliveryContext: {
              channel: "telegram",
              to: "chat-123",
              accountId: "bot-main",
            },
            messageId: "fake-telegram-msg",
            messageSeq: expect.any(Number),
            message: {
              role: "user",
              content: "incoming from Telegram",
            },
          }),
        }),
      );
    } finally {
      ws.close();
    }
  });
});
