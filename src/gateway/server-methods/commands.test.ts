import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const skillCommands = [
    {
      skillName: "code-review",
      name: "code_review",
      description: "Run code review",
      acceptsArgs: true,
    },
  ];
  const chatCommands = [
    {
      key: "model",
      nativeName: "model",
      description: "Set model",
      textAliases: ["/model", "/m"],
      acceptsArgs: true,
      args: [
        {
          name: "model",
          description: "Model identifier",
          type: "string",
          choices: [{ value: "gpt-5.2", label: "GPT-5.2" }, "sonnet-4.6"],
        },
      ],
      scope: "both",
      category: "options",
    },
    {
      key: "commands",
      description: "List commands",
      textAliases: ["/commands"],
      scope: "text",
      category: "session",
    },
    {
      key: "debug_prompt",
      nativeName: "debug_prompt",
      description: "Show raw prompt",
      textAliases: ["/debug"],
      acceptsArgs: false,
      args: [
        {
          name: "target",
          description: "Prompt target",
          type: "string",
          choices: () => [{ value: "last", label: "Last" }],
        },
      ],
      scope: "native",
      category: "tools",
    },
    {
      key: "skill:code-review",
      nativeName: "code_review",
      description: "Run code review",
      textAliases: ["/code_review"],
      acceptsArgs: true,
      scope: "both",
      category: "tools",
    },
  ];
  return {
    chatCommands,
    skillCommands,
    listChatCommandsForConfig: vi.fn(() => chatCommands),
    resolveNativeCommandName: vi.fn(
      (cmd: { key: string; nativeName?: string }, provider?: string) =>
        provider === "discord" && cmd.key === "model" ? "set_model" : cmd.nativeName,
    ),
    listSkillCommandsForAgents: vi.fn(() => skillCommands),
    listPluginCommands: vi.fn(() => [
      {
        name: "tts",
        description: "Text to speech",
        pluginId: "plugin-tts",
        acceptsArgs: false,
      },
    ]),
    getPluginCommandSpecs: vi.fn(() => [
      {
        name: "tts_native",
        description: "Text to speech",
        acceptsArgs: false,
      },
    ]),
    loadConfig: vi.fn(() => ({})),
    listAgentIds: vi.fn(() => ["main", "dev"]),
    resolveDefaultAgentId: vi.fn(() => "main"),
  };
});

vi.mock("../../auto-reply/commands-registry.js", () => ({
  listChatCommandsForConfig: mocks.listChatCommandsForConfig,
  resolveNativeCommandName: mocks.resolveNativeCommandName,
}));

vi.mock("../../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents: mocks.listSkillCommandsForAgents,
}));

vi.mock("../../plugins/commands.js", () => ({
  getPluginCommandSpecs: mocks.getPluginCommandSpecs,
  listPluginCommands: mocks.listPluginCommands,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

const { ErrorCodes } = await import("../protocol/index.js");
const { buildCommandsListResult, commandsHandlers } = await import("./commands.js");

function callHandler(params: Record<string, unknown> = {}) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    result = { ok, payload, error };
  };
  void commandsHandlers["commands.list"]({
    params,
    respond,
    req: { type: "req", id: "1", method: "commands.list" },
    client: null,
    isWebchatConnect: () => false,
    context: {} as never,
  });
  return result!;
}

describe("commands.list handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns native, skill, and plugin commands", () => {
    const { ok, payload } = callHandler();
    expect(ok).toBe(true);
    const { commands } = payload as { commands: Array<{ source: string }> };
    expect(new Set(commands.map((command) => command.source))).toEqual(
      new Set(["native", "skill", "plugin"]),
    );
  });

  it("maps native command metadata and static args", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Array<Record<string, unknown>> };
    const model = commands.find((command) => command.name === "model");
    expect(model).toMatchObject({
      name: "model",
      nativeName: "model",
      textAliases: ["/model", "/m"],
      description: "Set model",
      category: "options",
      source: "native",
      scope: "both",
      acceptsArgs: true,
    });
    expect((model!.args as Array<Record<string, unknown>>)[0].choices).toEqual([
      { value: "gpt-5.2", label: "GPT-5.2" },
      { value: "sonnet-4.6", label: "sonnet-4.6" },
    ]);
  });

  it("does not serialize args for commands that do not accept args", () => {
    const { payload } = callHandler();
    const { commands } = payload as { commands: Array<Record<string, unknown>> };
    const debug = commands.find((command) => command.name === "debug_prompt");
    expect(debug!.args).toBeUndefined();
  });

  it("marks dynamic args without evaluating choices", () => {
    const debug = mocks.chatCommands.find((command) => command.key === "debug_prompt")!;
    debug.acceptsArgs = true;
    try {
      const { payload } = callHandler();
      const { commands } = payload as { commands: Array<Record<string, unknown>> };
      const debugEntry = commands.find((command) => command.name === "debug_prompt");
      const arg = (debugEntry!.args as Array<Record<string, unknown>>)[0];
      expect(arg.dynamic).toBe(true);
      expect(arg.choices).toBeUndefined();
    } finally {
      debug.acceptsArgs = false;
    }
  });

  it("filters built-in commands by native scope", () => {
    const { payload } = callHandler({ scope: "native" });
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    const names = commands.filter((command) => command.source !== "plugin").map((c) => c.name);
    expect(names).toContain("model");
    expect(names).toContain("debug_prompt");
    expect(names).not.toContain("commands");
  });

  it("filters built-in commands by text scope and uses text names", () => {
    const { payload } = callHandler({ provider: "Discord", scope: "text" });
    const { commands } = payload as {
      commands: Array<{ name: string; nativeName?: string; source: string }>;
    };
    expect(
      commands.find((command) => command.source === "native" && command.name === "model"),
    ).toMatchObject({ nativeName: "set_model" });
    expect(commands.find((command) => command.name === "debug_prompt")).toBeUndefined();
    expect(commands.find((command) => command.name === "commands")).toBeDefined();
  });

  it("resolves provider-specific native command names", () => {
    const { payload } = callHandler({ provider: "Discord" });
    const { commands } = payload as { commands: Array<{ name: string; source: string }> };
    expect(commands.find((command) => command.name === "set_model")).toBeDefined();
    expect(commands.find((command) => command.name === "model")).toBeUndefined();
    expect(mocks.resolveNativeCommandName).toHaveBeenCalledWith(
      expect.objectContaining({ key: "model" }),
      "discord",
    );
  });

  it("uses plugin text names for text scope and native names otherwise", () => {
    const textResult = callHandler({ scope: "text" }).payload as {
      commands: Array<{ name: string; source: string }>;
    };
    const nativeResult = callHandler({ scope: "native" }).payload as {
      commands: Array<{ name: string; source: string }>;
    };
    expect(textResult.commands.find((command) => command.source === "plugin")).toMatchObject({
      name: "tts",
    });
    expect(nativeResult.commands.find((command) => command.source === "plugin")).toMatchObject({
      name: "tts_native",
    });
  });

  it("excludes args when includeArgs=false", () => {
    const { payload } = callHandler({ includeArgs: false });
    const { commands } = payload as { commands: Array<Record<string, unknown>> };
    expect(commands.find((command) => command.name === "model")!.args).toBeUndefined();
  });

  it("rejects unknown agent ids", () => {
    const { ok, error } = callHandler({ agentId: "missing" });
    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'unknown agent id "missing"',
    });
  });

  it("rejects invalid params", () => {
    const { ok, error } = callHandler({ scope: "invalid" });
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
  });
});

describe("buildCommandsListResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is callable directly for tests and future UI adapters", () => {
    const result = buildCommandsListResult({ cfg: {} as never, agentId: "main" });
    expect(result.commands.length).toBeGreaterThan(0);
    expect(result.commands.every((command) => typeof command.scope === "string")).toBe(true);
  });
});
