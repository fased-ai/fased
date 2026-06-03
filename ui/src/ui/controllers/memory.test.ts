import { describe, expect, it, vi } from "vitest";
import { loadMemory, type MemoryState } from "./memory.ts";

describe("loadMemory", () => {
  it("loads read-only Memory Doctor data without calling closed Dream Diary RPCs", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "doctor.memory.inventory":
          return {
            agentId: "main",
            workspace: { path: "/tmp/ws", exists: true, memoryRoots: [] },
            backend: { configured: "builtin", active: "builtin", citations: "auto" },
            qmd: { enabled: false },
            sessionMemory: {
              hookConfigured: false,
              enabled: false,
              messages: 0,
              llmSlug: false,
              memoryDir: { path: "/tmp/ws/memory", exists: true, kind: "directory" },
              filenameDiagnostics: { checked: true, status: "ok", groups: [] },
            },
            memoryPlugin: { configuredSlot: null, enabled: false, registryLoaded: true },
          };
        case "doctor.memory.validate":
          return {
            agentId: "main",
            ok: true,
            summary: { errors: 0, warnings: 0, info: 0 },
            findings: [],
          };
        case "doctor.memory.status":
          return { dreaming: { enabled: false } };
        default:
          throw new Error(`unexpected RPC ${method}`);
      }
    });
    const state: MemoryState = {
      client: { request } as never,
      connected: true,
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "test",
        agents: [
          { id: "main", name: "Assistant" },
          { id: "research", name: "Research" },
        ],
      },
      agentsSelectedId: "research",
      applySessionKey: "agent:research:main",
      configSnapshot: null,
      lastError: null,
      memoryLoading: false,
      memoryError: null,
      memoryInventory: null,
      memoryValidation: null,
      memoryWiki: null,
      memoryWikiRebuilding: false,
      memoryWikiError: null,
      dreamingStatusLoading: false,
      dreamingStatusError: null,
      dreamingStatus: null,
      dreamingModeSaving: false,
      dreamDiaryLoading: false,
      dreamDiaryError: null,
      dreamDiaryPath: null,
      dreamDiaryContent: null,
    };

    await loadMemory(state);

    expect(request).toHaveBeenCalledWith("doctor.memory.inventory", { agentId: "research" });
    expect(request).toHaveBeenCalledWith("doctor.memory.validate", { agentId: "research" });
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: "research" });
    expect(request).not.toHaveBeenCalledWith("doctor.memory.dreamDiary", {});
    expect(state.memoryInventory?.sessionMemory.enabled).toBe(false);
    expect(state.dreamDiaryError).toBeNull();
  });
});
