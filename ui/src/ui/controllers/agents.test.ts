import { describe, expect, it, vi } from "vitest";
import {
  createAgent,
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
  saveAgentsConfig,
} from "./agents.ts";
import type { AgentsConfigSaveState, AgentsState } from "./agents.ts";

function createState(): { state: AgentsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: AgentsState = {
    client: {
      request,
    } as unknown as AgentsState["client"],
    connected: true,
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
    agentsSelectedId: "main",
    agentsCreateBusy: false,
    agentsCreateMessage: null,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    sessionKey: "main",
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "gpt-5.4-mini",
          modelProvider: "openai",
        },
      ],
    },
    chatModelOverrides: {},
    chatModelCatalog: [{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" }],
    agentsPanel: "overview",
  };
  return { state, request };
}

function createSaveState(): {
  state: AgentsConfigSaveState;
  request: ReturnType<typeof vi.fn>;
} {
  const { state, request } = createState();
  return {
    state: {
      ...state,
      applySessionKey: "session-1",
      configLoading: false,
      configRawOriginal: "{}",
      configValid: true,
      configIssues: [],
      configSaving: false,
      configApplying: false,
      configSnapshot: { hash: "hash-1" },
      configAuthStatus: null,
      configModelCatalogStatus: null,
      configAuthActionBusyProfileId: null,
      configAuthAction: null,
      configFormDirty: true,
      configFormMode: "form",
      configForm: { agents: { list: [{ id: "main" }] } },
      configRaw: "{}",
      configSchema: null,
      configSchemaVersion: null,
      configSchemaLoading: false,
      configUiHints: {},
      configFormOriginal: { agents: { list: [{ id: "main" }] } },
      configSearchQuery: "",
      configActiveSection: null,
      configActiveSubsection: null,
      lastError: null,
    },
    request,
  };
}

describe("loadAgents", () => {
  it("preserves selected agent when it still exists in the list", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = "kimi";
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("kimi");
  });

  it("resets to default when selected agent is removed", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = "removed-agent";
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("main");
  });

  it("sets default when no agent is selected", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = null;
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("main");
  });
});

describe("createAgent", () => {
  it("creates an Agent through the gateway and selects it after reloading agents", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      ok: true,
      agentId: "researcher",
      name: "Researcher",
      workspace: "/home/fc/.fased/workspace/agents/researcher",
      model: "openai/gpt-5.5",
    });
    request.mockResolvedValueOnce({
      defaultId: "main",
      mainKey: "main",
      scope: "workspace",
      agents: [
        { id: "main", name: "main" },
        { id: "researcher", name: "Researcher" },
      ],
    });

    const result = await createAgent(state, {
      name: "Researcher",
      workspace: "/home/fc/.fased/workspace/agents/researcher",
      model: "openai/gpt-5.5",
      avatar: "avatars/researcher.png",
    });

    expect(request).toHaveBeenNthCalledWith(1, "agents.create", {
      name: "Researcher",
      workspace: "/home/fc/.fased/workspace/agents/researcher",
      model: "openai/gpt-5.5",
      avatar: "avatars/researcher.png",
    });
    expect(request).toHaveBeenNthCalledWith(2, "agents.list", {});
    expect(result?.agentId).toBe("researcher");
    expect(state.agentsSelectedId).toBe("researcher");
    expect(state.agentsCreateBusy).toBe(false);
    expect(state.agentsCreateMessage).toContain("researcher");
    expect(state.agentsError).toBeNull();
  });

  it("rejects empty create-agent form values before calling the gateway", async () => {
    const { state, request } = createState();

    const result = await createAgent(state, { name: " ", workspace: " " });

    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(state.agentsError).toContain("required");
    expect(state.agentsCreateBusy).toBe(false);
  });
});

describe("loadToolsCatalog", () => {
  it("loads catalog and stores result", async () => {
    const { state, request } = createState();
    const payload = {
      agentId: "main",
      profiles: [{ id: "full", label: "Full" }],
      groups: [
        {
          id: "media",
          label: "Media",
          source: "core",
          tools: [{ id: "tts", label: "tts", description: "Text-to-speech", source: "core" }],
        },
      ],
    };
    request.mockResolvedValue(payload);

    await loadToolsCatalog(state, "main");

    expect(request).toHaveBeenCalledWith("tools.catalog", {
      agentId: "main",
      includePlugins: true,
    });
    expect(state.toolsCatalogResult).toEqual(payload);
    expect(state.toolsCatalogError).toBeNull();
    expect(state.toolsCatalogLoading).toBe(false);
  });

  it("captures request errors for fallback UI handling", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("gateway unavailable"));

    await loadToolsCatalog(state, "main");

    expect(state.toolsCatalogResult).toBeNull();
    expect(state.toolsCatalogError).toContain("gateway unavailable");
    expect(state.toolsCatalogLoading).toBe(false);
  });
});

describe("loadToolsEffective", () => {
  it("loads effective tools for the active session", async () => {
    const { state, request } = createState();
    const payload = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "read",
              label: "Read",
              description: "Read files",
              rawDescription: "Read files",
              source: "core",
            },
          ],
        },
      ],
    };
    request.mockResolvedValue(payload);

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(state.toolsEffectiveResult).toEqual(payload);
    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5.4-mini");
    expect(state.toolsEffectiveError).toBeNull();
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("captures effective-tool request errors", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("gateway unavailable"));

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(state.toolsEffectiveResult).toBeNull();
    expect(state.toolsEffectiveResultKey).toBeNull();
    expect(state.toolsEffectiveError).toContain("gateway unavailable");
    expect(state.toolsEffectiveLoading).toBe(false);
  });
});

describe("saveAgentsConfig", () => {
  it("restores the pre-save agent after reload when it still exists", async () => {
    const { state, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request.mockImplementation(async (method: string) => {
      if (method === "config.set") {
        return undefined;
      }
      if (method === "config.get") {
        state.agentsSelectedId = null;
        return {
          hash: "hash-2",
          raw: '{"agents":{"list":[{"id":"main"},{"id":"kimi"}]}}',
          config: {
            agents: {
              list: [{ id: "main" }, { id: "kimi" }],
            },
          },
          valid: true,
          issues: [],
        };
      }
      if (method === "models.auth.status") {
        return { storePath: "/tmp/auth.json", warnAfterMs: 0, providers: [] };
      }
      if (method === "models.catalog.status") {
        return { totalProviders: 0, configuredProviders: 0, totalModels: 0, providers: [] };
      }
      if (method === "agents.list") {
        state.agentsSelectedId = null;
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "main" },
            { id: "kimi", name: "kimi" },
          ],
        };
      }
      return undefined;
    });

    await saveAgentsConfig(state);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "config.set",
      expect.objectContaining({ baseHash: "hash-1" }),
    );
    expect(JSON.parse(request.mock.calls[0]?.[1]?.raw as string)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
    expect(request).toHaveBeenCalledWith("config.get", {});
    expect(request).toHaveBeenCalledWith("models.auth.status", {});
    expect(request).toHaveBeenCalledWith("models.catalog.status", {});
    expect(request).toHaveBeenCalledWith("agents.list", {});
    expect(state.agentsSelectedId).toBe("kimi");
  });

  it("falls back to the default agent when the saved agent disappears", async () => {
    const { state, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request.mockImplementation(async (method: string) => {
      if (method === "config.set") {
        return undefined;
      }
      if (method === "config.get") {
        return {
          hash: "hash-2",
          raw: '{"agents":{"list":[{"id":"main"}]}}',
          config: {
            agents: {
              list: [{ id: "main" }],
            },
          },
          valid: true,
          issues: [],
        };
      }
      if (method === "models.auth.status") {
        return { storePath: "/tmp/auth.json", warnAfterMs: 0, providers: [] };
      }
      if (method === "models.catalog.status") {
        return { totalProviders: 0, configuredProviders: 0, totalModels: 0, providers: [] };
      }
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "main" }],
        };
      }
      return undefined;
    });

    await saveAgentsConfig(state);

    expect(state.agentsSelectedId).toBe("main");
  });
});
