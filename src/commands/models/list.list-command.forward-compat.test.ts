import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const printModelTable = vi.fn();
  return {
    loadConfig: vi.fn().mockReturnValue({
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
      models: { providers: {} },
    }),
    ensureAuthProfileStore: vi.fn().mockReturnValue({ version: 1, profiles: {}, order: {} }),
    loadModelRegistry: vi
      .fn()
      .mockResolvedValue({ models: [], availableKeys: new Set(), registry: {} }),
    loadModelCatalog: vi.fn().mockResolvedValue([]),
    resolveConfiguredEntries: vi.fn().mockReturnValue({
      entries: [
        {
          key: "openai-codex/gpt-5.3-codex",
          ref: { provider: "openai-codex", model: "gpt-5.3-codex" },
          tags: new Set(["configured"]),
          aliases: [],
        },
      ],
    }),
    printModelTable,
    resolveForwardCompatModel: vi.fn().mockReturnValue({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
      contextWindow: 272000,
      maxTokens: 128000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  };
});

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: vi.fn().mockReturnValue([]),
  };
});

vi.mock("./list.registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./list.registry.js")>();
  return {
    ...actual,
    loadModelRegistry: mocks.loadModelRegistry,
  };
});

vi.mock("./list.configured.js", () => ({
  resolveConfiguredEntries: mocks.resolveConfiguredEntries,
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("./list.table.js", () => ({
  printModelTable: mocks.printModelTable,
}));

vi.mock("../../agents/model-forward-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-forward-compat.js")>();
  return {
    ...actual,
    resolveForwardCompatModel: mocks.resolveForwardCompatModel,
  };
});

import { modelsListCommand } from "./list.list-command.js";

describe("modelsListCommand forward-compat", () => {
  beforeEach(() => {
    mocks.printModelTable.mockClear();
    mocks.loadModelRegistry.mockReset();
    mocks.loadModelRegistry.mockResolvedValue({
      models: [],
      availableKeys: new Set(),
      registry: {},
    });
    mocks.loadModelCatalog.mockReset();
    mocks.loadModelCatalog.mockResolvedValue([]);
    mocks.resolveConfiguredEntries.mockReset();
    mocks.resolveConfiguredEntries.mockReturnValue({
      entries: [
        {
          key: "openai-codex/gpt-5.3-codex",
          ref: { provider: "openai-codex", model: "gpt-5.3-codex" },
          tags: new Set(["configured"]),
          aliases: [],
        },
      ],
    });
  });

  it("does not mark configured codex model as missing when forward-compat can build a fallback", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };

    await modelsListCommand({ json: true }, runtime as never);

    expect(mocks.printModelTable).toHaveBeenCalled();
    const rows = mocks.printModelTable.mock.calls[0]?.[0] as Array<{
      key: string;
      tags: string[];
      missing: boolean;
    }>;

    const codex = rows.find((r) => r.key === "openai-codex/gpt-5.3-codex");
    expect(codex).toBeTruthy();
    expect(codex?.missing).toBe(false);
    expect(codex?.tags).not.toContain("missing");
  });

  it("uses merged catalog rows for provider-filtered --all when registry is stale", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    mocks.loadModelRegistry.mockRejectedValueOnce(new Error("registry stale"));
    mocks.loadModelCatalog.mockResolvedValueOnce([
      {
        id: "qwen3-max",
        name: "Qwen3 Max",
        provider: "qwen",
        catalogSource: "provider-index",
        input: ["text"],
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
    ]);
    mocks.resolveConfiguredEntries.mockReturnValue({ entries: [] });

    await modelsListCommand({ all: true, provider: "qwen", json: true }, runtime as never);

    expect(runtime.error).not.toHaveBeenCalled();
    expect(mocks.printModelTable).toHaveBeenCalled();
    const rows = mocks.printModelTable.mock.calls[0]?.[0] as Array<{ key: string }>;
    expect(rows.map((row) => row.key)).toEqual(["qwen/qwen3-max"]);
  });

  it("hides unconfigured local catalog rows from broad --all but shows explicit provider filters", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    mocks.resolveConfiguredEntries.mockReturnValue({ entries: [] });
    mocks.loadModelRegistry.mockResolvedValue({
      registry: {},
      availableKeys: new Set(),
      models: [
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          input: ["text"],
          baseUrl: "https://api.openai.com/v1",
        },
        {
          id: "qwen3-coder",
          name: "Qwen3 Coder",
          provider: "vllm",
          input: ["text"],
          baseUrl: "http://127.0.0.1:8000/v1",
        },
      ],
    });

    await modelsListCommand({ all: true, json: true }, runtime as never);
    const broadRows = mocks.printModelTable.mock.calls[0]?.[0] as Array<{ key: string }>;
    expect(broadRows.map((row) => row.key)).toEqual(["openai/gpt-5.5"]);

    mocks.printModelTable.mockClear();
    await modelsListCommand({ all: true, provider: "vllm", json: true }, runtime as never);
    const filteredRows = mocks.printModelTable.mock.calls[0]?.[0] as Array<{ key: string }>;
    expect(filteredRows.map((row) => row.key)).toEqual(["vllm/qwen3-coder"]);
  });
});
