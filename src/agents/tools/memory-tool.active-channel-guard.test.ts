import { beforeEach, describe, expect, it } from "vitest";
import { resetMemoryToolMockState } from "../../../test/helpers/memory-tool-manager-mock.js";
import { createMemorySearchTool } from "./memory-tool.js";

describe("memory_search active-memory channel guard acceptance", () => {
  beforeEach(() => {
    resetMemoryToolMockState({
      backend: "qmd",
      searchImpl: async () => [
        {
          path: "memory/telegram-topic.md",
          startLine: 1,
          endLine: 1,
          score: 0.99,
          snippet: "Topic-scoped memory result",
          source: "sessions",
        },
      ],
    });
  });

  it("keeps channel recall scoped to the exact agent session key before any memory-only sub-run", async () => {
    const tool = createMemorySearchTool({
      config: {
        agents: {
          defaults: { memorySearch: { enabled: true } },
          list: [{ id: "main", default: true }],
        },
        memory: {
          backend: "qmd",
          qmd: {
            scope: {
              default: "deny",
              rules: [
                {
                  action: "allow",
                  match: {
                    rawKeyPrefix: "agent:main:telegram:channel:-1001234567890:topic:42",
                  },
                },
              ],
            },
          },
        },
      },
      agentSessionKey: "agent:main:telegram:channel:-1001234567890:topic:42",
    });

    if (!tool) {
      throw new Error("memory_search tool missing");
    }

    const result = await tool.execute("guard", { query: "topic memory" });
    const details = result.details as Record<string, unknown>;
    expect(details).toMatchObject({
      results: [
        {
          path: "memory/telegram-topic.md",
          snippet: "Topic-scoped memory result",
        },
      ],
      provider: "builtin",
      model: "builtin",
    });
  });

  it("returns an explicit unavailable payload when the channel topic key is denied", async () => {
    const tool = createMemorySearchTool({
      config: {
        agents: {
          defaults: { memorySearch: { enabled: true } },
          list: [{ id: "main", default: true }],
        },
        memory: {
          backend: "qmd",
          qmd: {
            scope: {
              default: "deny",
              rules: [
                {
                  action: "allow",
                  match: {
                    rawKeyPrefix: "agent:main:telegram:channel:-1001234567890:topic:42",
                  },
                },
              ],
            },
          },
        },
      },
      agentSessionKey: "agent:main:telegram:channel:-1001234567890:topic:43",
    });

    if (!tool) {
      throw new Error("memory_search tool missing");
    }

    const result = await tool.execute("guard", { query: "topic memory" });
    const details = result.details as Record<string, unknown>;
    expect(details).toMatchObject({
      results: [],
      disabled: true,
      unavailable: true,
      warning:
        "Memory search is unavailable because this session is outside the configured memory scope.",
      action:
        "Use an allowed direct/channel session or update memory.qmd.scope before retrying memory_search.",
    });
    expect(String(details.error)).toContain("agent:main:telegram:channel:-1001234567890:topic:43");
  });

  it("does not register memory_search when memory tools are disabled", async () => {
    const tool = createMemorySearchTool({
      config: {
        agents: {
          defaults: { memorySearch: { enabled: false } },
          list: [{ id: "main", default: true }],
        },
      },
      agentSessionKey: "agent:main:telegram:channel:-1001234567890:topic:42",
    });

    expect(tool).toBeNull();
  });
});
