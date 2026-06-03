import { describe, expect, it, vi } from "vitest";
import { loadOverviewHealth } from "./overview-health.ts";

describe("loadOverviewHealth", () => {
  it("loads only lightweight Overview health data and leaves Debug-only diagnostics alone", async () => {
    const calls: string[] = [];
    const client = {
      request: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === "models.catalog.status") {
          return { totalProviders: 0, totalModels: 0 };
        }
        if (method === "plugins.marketplace.list") {
          return { plugins: [] };
        }
        if (method === "doctor.memory.inventory") {
          return { agentId: "main" };
        }
        if (method === "doctor.memory.validate") {
          return { agentId: "main", ok: true, summary: { errors: 0, warnings: 0, info: 0 } };
        }
        throw new Error(`unexpected ${method}`);
      }),
    };
    const state = {
      client,
      connected: true,
      debugModelCatalogStatus: null,
      debugPluginsMarketplace: null,
      memoryInventory: null,
      memoryValidation: null,
    };

    await loadOverviewHealth(state as never);

    expect(calls).toEqual([
      "models.catalog.status",
      "plugins.marketplace.list",
      "doctor.memory.inventory",
      "doctor.memory.validate",
    ]);
    expect(calls).not.toContain("commands.list");
    expect(calls).not.toContain("diagnostics.stability");
    expect(calls).not.toContain("doctor.memory.repair.preview");
    expect(state.memoryInventory).toEqual({ agentId: "main" });
    expect(state.memoryValidation).toMatchObject({ ok: true });
  });
});
