import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { splitSdkTools } from "./pi-embedded-runner.js";
import { toClientToolDefinitions } from "./pi-tool-definition-adapter.js";
import { createStubTool } from "./test-helpers/pi-tool-stubs.js";

function createClientToolDefinitions(...names: string[]) {
  return toClientToolDefinitions(
    names.map((name) => ({
      type: "function" as const,
      function: {
        name,
        description: `Client tool ${name}`,
        parameters: { type: "object", properties: {} },
      },
    })),
  );
}

describe("splitSdkTools", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("exec"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("routes all tools to customTools when sandboxed", () => {
    const { activeToolNames, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
    });
    expect(activeToolNames).toEqual(["read", "exec", "edit", "write", "browser"]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("routes all tools to customTools even when not sandboxed", () => {
    const { activeToolNames, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(activeToolNames).toEqual(["read", "exec", "edit", "write", "browser"]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("activates an ordinary client tool without enabling denied SDK built-ins", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "fased-sdk-tools-"));
    const { activeToolNames, customTools } = splitSdkTools({
      tools: [],
      clientTools: createClientToolDefinitions("get_time"),
      sandboxEnabled: false,
    });

    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd: workspaceDir,
        agentDir: join(workspaceDir, "agent"),
        sessionManager: SessionManager.inMemory(workspaceDir),
        tools: activeToolNames,
        customTools,
      }));

      expect(session.getActiveToolNames()).toEqual(["get_time"]);
      expect(session.getToolDefinition("get_time")).toBeDefined();
      expect(session.getToolDefinition("read")).toBeUndefined();
      expect(session.getToolDefinition("bash")).toBeUndefined();
      expect(session.getToolDefinition("edit")).toBeUndefined();
      expect(session.getToolDefinition("write")).toBeUndefined();
    } finally {
      session?.dispose();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects client names reserved by a policy-disabled host tool", () => {
    expect(() =>
      splitSdkTools({
        tools: [],
        clientTools: createClientToolDefinitions("exec"),
        sandboxEnabled: false,
      }),
    ).toThrow('Client tool name "exec" is reserved by Fased');
  });

  it("rejects a client tool that collides with an active Fased tool", () => {
    expect(() =>
      splitSdkTools({
        tools: [createStubTool("plugin_lookup")],
        clientTools: createClientToolDefinitions("plugin_lookup"),
        sandboxEnabled: false,
      }),
    ).toThrow('Client tool name "plugin_lookup" is reserved by Fased');
  });

  it("rejects duplicate client tool names after normalization", () => {
    expect(() =>
      splitSdkTools({
        tools: [],
        clientTools: createClientToolDefinitions("get_time", "GET_TIME"),
        sandboxEnabled: false,
      }),
    ).toThrow('Duplicate client tool name: "GET_TIME"');
  });
});
