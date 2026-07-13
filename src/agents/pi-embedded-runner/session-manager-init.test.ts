import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSessionManagerForRun } from "./session-manager-init.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

const tempDirs: string[] = [];

async function createSessionPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-session-init-"));
  tempDirs.push(dir);
  return { dir, file: path.join(dir, "session.jsonl") };
}

function header(id = "session-1") {
  return {
    type: "session",
    version: 7,
    id,
    timestamp: new Date().toISOString(),
    cwd: "/tmp",
  };
}

function userMessage(text = "hello"): AppendMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AppendMessage;
}

function assistantMessage(text = "hello back"): AppendMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  } as AppendMessage;
}

function parseEntries(content: string): Array<{ type: string; message?: { role?: string } }> {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; message?: { role?: string } });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareSessionManagerForRun", () => {
  it("persists a new transcript with the requested session identity", async () => {
    const { file } = await createSessionPath();
    const manager = SessionManager.open(file);

    await prepareSessionManagerForRun({
      sessionManager: manager,
      sessionFile: file,
      hadSessionFile: false,
      sessionId: "requested-session",
      cwd: "/workspace",
    });
    manager.appendMessage(userMessage());
    manager.appendMessage(assistantMessage());

    const entries = parseEntries(await fs.readFile(file, "utf-8"));
    expect(manager.getSessionId()).toBe("requested-session");
    expect(entries.map((entry) => entry.message?.role ?? entry.type)).toEqual([
      "session",
      "user",
      "assistant",
    ]);
  });

  it.each([
    ["empty", ""],
    ["header-only", `${JSON.stringify(header())}\n`],
    [
      "user-only",
      `${JSON.stringify(header())}\n${JSON.stringify({
        type: "message",
        id: "message-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: userMessage("existing user message"),
      })}\n`,
    ],
  ])("appends safely to an existing %s transcript", async (_name, initialContent) => {
    const { file } = await createSessionPath();
    await fs.writeFile(file, initialContent, "utf-8");
    const manager = SessionManager.open(file);

    await prepareSessionManagerForRun({
      sessionManager: manager,
      sessionFile: file,
      hadSessionFile: true,
      sessionId: "session-1",
      cwd: "/workspace",
    });
    if (_name !== "user-only") {
      manager.appendMessage(userMessage());
    }
    expect(() => manager.appendMessage(assistantMessage())).not.toThrow();

    const entries = parseEntries(await fs.readFile(file, "utf-8"));
    expect(entries.map((entry) => entry.message?.role ?? entry.type)).toEqual([
      "session",
      "user",
      "assistant",
    ]);
  });
});
