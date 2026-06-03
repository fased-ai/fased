import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./agent-scope.js");
  vi.doUnmock("./pi-tools.js");
  vi.doUnmock("./pi-embedded-runner/model.js");
  vi.doUnmock("../plugins/tools.js");
  vi.doUnmock("./channel-tools.js");
  vi.doUnmock("./pi-tools.policy.js");
  vi.resetModules();
});

async function loadHarness(options?: {
  tools?: Array<{ name: string; label?: string; description?: string; displaySummary?: string }>;
  createToolsMock?: ReturnType<typeof vi.fn>;
  pluginMeta?: Record<string, { pluginId: string } | undefined>;
  channelMeta?: Record<string, { channelId: string } | undefined>;
  effectivePolicy?: { profile?: string; providerProfile?: string };
  resolvedModelCompat?: Record<string, unknown>;
}) {
  vi.resetModules();
  vi.doMock("./agent-scope.js", async () => {
    const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    return {
      ...actual,
      resolveSessionAgentId: () => "main",
      resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
      resolveAgentDir: () => "/tmp/agents/main/agent",
    };
  });
  const createToolsMock =
    options?.createToolsMock ??
    vi.fn(
      () =>
        options?.tools ?? [
          { name: "exec", label: "Exec", description: "Run shell commands" },
          { name: "docs_lookup", label: "Docs Lookup", description: "Search docs" },
        ],
    );
  vi.doMock("./pi-tools.js", () => ({
    createFasedAgentCodingTools: createToolsMock,
  }));
  vi.doMock("./pi-embedded-runner/model.js", () => ({
    resolveModel: vi.fn(() => ({
      model: options?.resolvedModelCompat ? { compat: options.resolvedModelCompat } : undefined,
      authStorage: {} as never,
      modelRegistry: {} as never,
    })),
  }));
  vi.doMock("../plugins/tools.js", () => ({
    getPluginToolMeta: (tool: { name: string }) => options?.pluginMeta?.[tool.name],
  }));
  vi.doMock("./channel-tools.js", () => ({
    getChannelAgentToolMeta: (tool: { name: string }) => options?.channelMeta?.[tool.name],
  }));
  vi.doMock("./pi-tools.policy.js", () => ({
    resolveEffectiveToolPolicy: () => options?.effectivePolicy ?? {},
  }));
  return await import("./tools-effective-inventory.js");
}

describe("resolveEffectiveToolInventory", () => {
  it("groups core, plugin, and channel tools from the effective runtime set", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      tools: [
        { name: "exec", label: "Exec", description: "Run shell commands" },
        { name: "docs_lookup", label: "Docs Lookup", description: "Search docs" },
        { name: "message_actions", label: "Message Actions", description: "Act on messages" },
      ],
      pluginMeta: { docs_lookup: { pluginId: "docs" } },
      channelMeta: { message_actions: { channelId: "telegram" } },
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    expect(result).toEqual({
      agentId: "main",
      profile: "full",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "exec",
              label: "Exec",
              description: "Run shell commands",
              rawDescription: "Run shell commands",
              source: "core",
            },
          ],
        },
        {
          id: "plugin",
          label: "Connected tools",
          source: "plugin",
          tools: [
            {
              id: "docs_lookup",
              label: "Docs Lookup",
              description: "Search docs",
              rawDescription: "Search docs",
              source: "plugin",
              pluginId: "docs",
            },
          ],
        },
        {
          id: "channel",
          label: "Channel tools",
          source: "channel",
          tools: [
            {
              id: "message_actions",
              label: "Message Actions",
              description: "Act on messages",
              rawDescription: "Act on messages",
              source: "channel",
              channelId: "telegram",
            },
          ],
        },
      ],
    });
  });

  it("disambiguates duplicate labels with source ids", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      tools: [
        { name: "docs_lookup", label: "Lookup", description: "Search docs" },
        { name: "jira_lookup", label: "Lookup", description: "Search Jira" },
      ],
      pluginMeta: {
        docs_lookup: { pluginId: "docs" },
        jira_lookup: { pluginId: "jira" },
      },
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });
    const labels = result.groups.flatMap((group) => group.tools.map((tool) => tool.label));

    expect(labels).toEqual(["Lookup (docs)", "Lookup (jira)"]);
  });

  it("prefers displaySummary over raw description", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      tools: [
        {
          name: "cron",
          label: "Task",
          displaySummary: "Schedule and manage tasks.",
          description: "Long raw description\n\nACTIONS:\n- status",
        },
      ],
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    expect(result.groups[0]?.tools[0]).toEqual({
      id: "cron",
      label: "Task",
      description: "Schedule and manage tasks.",
      rawDescription: "Long raw description\n\nACTIONS:\n- status",
      source: "core",
    });
  });

  it("falls back to a sanitized summary for multi-line raw descriptions", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      tools: [
        {
          name: "cron",
          label: "Task",
          description:
            'Manage Gateway scheduled tasks (status/list/add/update/remove/run/runs) and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check task scheduler status\nTASK SCHEMA:\n{ ... }',
        },
      ],
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    const description = result.groups[0]?.tools[0]?.description ?? "";
    expect(description).toContain(
      "Manage Gateway scheduled tasks (status/list/add/update/remove/run/runs) and send wake events.",
    );
    expect(description.endsWith("...")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(120);
    expect(result.groups[0]?.tools[0]?.rawDescription).toContain("ACTIONS:");
  });

  it("includes the resolved tool profile", async () => {
    const { resolveEffectiveToolInventory } = await loadHarness({
      tools: [{ name: "exec", label: "Exec", description: "Run shell commands" }],
      effectivePolicy: { profile: "minimal", providerProfile: "coding" },
    });

    const result = resolveEffectiveToolInventory({ cfg: {} });

    expect(result.profile).toBe("coding");
  });

  it("passes resolved model compat into effective tool creation", async () => {
    const createToolsMock = vi.fn(() => [
      { name: "exec", label: "Exec", description: "Run shell commands" },
    ]);
    const { resolveEffectiveToolInventory } = await loadHarness({
      createToolsMock,
      resolvedModelCompat: { supportsTools: true, supportsNativeWebSearch: true },
    });

    resolveEffectiveToolInventory({
      cfg: {},
      agentDir: "/tmp/agents/main/agent",
      modelProvider: "xai",
      modelId: "grok-test",
    });

    expect(createToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
        modelCompat: { supportsTools: true, supportsNativeWebSearch: true },
      }),
    );
  });
});
