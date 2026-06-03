import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";

type EmbeddedPiRunnerTestWorkspace = {
  tempRoot: string;
  agentDir: string;
  workspaceDir: string;
};

const E2E_TIMEOUT_MS = 40_000;

function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

let streamCallCount = 0;
let observedContexts: Array<Array<{ role?: string; content?: unknown }>> = [];
const bundleMcpMockState = vi.hoisted(() => ({
  createCount: 0,
  disposeCount: 0,
  lastReservedToolNames: [] as string[],
  stopOnly: false,
}));

async function createEmbeddedPiRunnerTestWorkspace(
  prefix: string,
): Promise<EmbeddedPiRunnerTestWorkspace> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(tempRoot, "agent");
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  return { tempRoot, agentDir, workspaceDir };
}

async function cleanupEmbeddedPiRunnerTestWorkspace(
  workspace: EmbeddedPiRunnerTestWorkspace | undefined,
): Promise<void> {
  if (!workspace) {
    return;
  }
  await fs.rm(workspace.tempRoot, { recursive: true, force: true });
}

function createEmbeddedPiRunnerOpenAiConfig(modelIds: string[]): FasedAgentConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  };
}

async function immediateEnqueue<T>(task: () => Promise<T>): Promise<T> {
  return await task();
}

vi.mock("./pi-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: async (params: { reservedToolNames?: Iterable<string> }) => {
    bundleMcpMockState.createCount += 1;
    bundleMcpMockState.lastReservedToolNames = [...(params.reservedToolNames ?? [])];
    return {
      tools: [
        {
          name: "bundleProbe__bundle_probe",
          label: "bundle_probe",
          description: "Bundle MCP probe",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "FROM-BUNDLE" }],
            details: {
              mcpServer: "bundleProbe",
              mcpTool: "bundle_probe",
            },
          }),
        },
      ],
      dispose: async () => {
        bundleMcpMockState.disposeCount += 1;
      },
    };
  },
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildToolUseMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [
      {
        type: "toolCall" as const,
        id: "tc-bundle-mcp-1",
        name: "bundleProbe__bundle_probe",
        arguments: {},
      },
    ],
    stopReason: "toolUse" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  const buildStopMessage = (
    model: { api: string; provider: string; id: string },
    text: string,
  ) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createMockUsage(1, 1),
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount += 1;
      return streamCallCount === 1
        ? buildToolUseMessage(model)
        : buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE");
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      streamCallCount += 1;
      return streamCallCount === 1
        ? buildToolUseMessage(model)
        : buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE");
    },
    streamSimple: (
      model: { api: string; provider: string; id: string },
      context: { messages?: Array<{ role?: string; content?: unknown }> },
    ) => {
      streamCallCount += 1;
      const messages = (context.messages ?? []).map((message) => ({ ...message }));
      observedContexts.push(messages);
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        if (!bundleMcpMockState.stopOnly && streamCallCount === 1) {
          stream.push({
            type: "done",
            reason: "toolUse",
            message: buildToolUseMessage(model),
          });
          stream.end();
          return;
        }

        const toolResultText = messages.flatMap((message) =>
          Array.isArray(message.content)
            ? (message.content as Array<{ type?: string; text?: string }>)
                .filter((entry) => entry.type === "text" && typeof entry.text === "string")
                .map((entry) => entry.text ?? "")
            : [],
        );
        const sawBundleResult = toolResultText.some((text) => text.includes("FROM-BUNDLE"));
        if (!sawBundleResult) {
          stream.push({
            type: "done",
            reason: "stop",
            message: buildStopMessage(model, "bundle MCP tool result missing from context"),
          });
          stream.end();
          return;
        }

        stream.push({
          type: "done",
          reason: "stop",
          message: buildStopMessage(model, "BUNDLE MCP OK FROM-BUNDLE"),
        });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("fased-bundle-mcp-pi-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

const readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message) as Array<{ role?: string; content?: unknown }>;
};

describe("runEmbeddedPiAgent bundle MCP e2e", () => {
  it(
    "loads bundle MCP into Pi, executes the MCP tool, and includes the result in the follow-up turn",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      streamCallCount = 0;
      observedContexts = [];
      bundleMcpMockState.createCount = 0;
      bundleMcpMockState.disposeCount = 0;
      bundleMcpMockState.lastReservedToolNames = [];
      bundleMcpMockState.stopOnly = false;

      const sessionFile = path.join(workspaceDir, "session-bundle-mcp-e2e.jsonl");
      const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-bundle-mcp"]);

      const result = await runEmbeddedPiAgent({
        sessionId: "bundle-mcp-e2e",
        sessionKey: "agent:test:bundle-mcp-e2e",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "Use the bundle MCP tool and report its result.",
        provider: "openai",
        model: "mock-bundle-mcp",
        timeoutMs: 30_000,
        agentDir,
        runId: "run-bundle-mcp-e2e",
        enqueue: immediateEnqueue,
      });

      expect(result.payloads?.[0]?.text).toContain("BUNDLE MCP OK FROM-BUNDLE");
      expect(streamCallCount).toBe(2);
      expect(bundleMcpMockState.createCount).toBe(1);
      expect(bundleMcpMockState.disposeCount).toBe(1);
      expect(bundleMcpMockState.lastReservedToolNames.length).toBeGreaterThan(0);
      expect(bundleMcpMockState.lastReservedToolNames).not.toContain("bundleProbe__bundle_probe");

      const followUpContext = observedContexts[1] ?? [];
      const followUpTexts = followUpContext.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Array<{ type?: string; text?: string }>)
              .filter((entry) => entry.type === "text" && typeof entry.text === "string")
              .map((entry) => entry.text ?? "")
          : [],
      );
      expect(followUpTexts.some((text) => text.includes("FROM-BUNDLE"))).toBe(true);

      const messages = await readSessionMessages(sessionFile);
      const toolResults = messages.filter((message) => message?.role === "toolResult");
      const toolResultText = toolResults.flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as Array<{ type?: string; text?: string }>)
              .filter((entry) => entry.type === "text" && typeof entry.text === "string")
              .map((entry) => entry.text ?? "")
          : [],
      );
      expect(toolResultText.some((text) => text.includes("FROM-BUNDLE"))).toBe(true);
    },
  );

  it(
    "does not create bundle MCP runtime when tools are disabled",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      streamCallCount = 0;
      observedContexts = [];
      bundleMcpMockState.createCount = 0;
      bundleMcpMockState.disposeCount = 0;
      bundleMcpMockState.lastReservedToolNames = [];
      bundleMcpMockState.stopOnly = true;

      const sessionFile = path.join(workspaceDir, "session-bundle-mcp-disabled.jsonl");
      const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-bundle-mcp-disabled"]);

      const result = await runEmbeddedPiAgent({
        sessionId: "bundle-mcp-disabled",
        sessionKey: "agent:test:bundle-mcp-disabled",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "Do not use tools.",
        provider: "openai",
        model: "mock-bundle-mcp-disabled",
        timeoutMs: 30_000,
        agentDir,
        runId: "run-bundle-mcp-disabled",
        enqueue: immediateEnqueue,
        disableTools: true,
      });

      expect(result.payloads?.[0]?.text).toContain("bundle MCP tool result missing from context");
      expect(bundleMcpMockState.createCount).toBe(0);
      expect(bundleMcpMockState.disposeCount).toBe(0);
    },
  );
});
