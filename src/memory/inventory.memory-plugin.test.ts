import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMemoryInventory, validateMemoryInventory } from "./inventory.js";

describe("memory inventory plugin diagnosis", () => {
  it("recognizes a working builtin backend when the CLI registry is not populated", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fased-memory-inventory-"));
    const inventory = await buildMemoryInventory({
      cfg: {
        agents: { list: [{ id: "main", default: true, workspace }] },
        plugins: { enabled: true, slots: { memory: "memory-core" } },
      },
      agentId: "main",
      providerStatus: {
        backend: "builtin",
        provider: "none",
        model: "none",
        requestedProvider: "none",
        files: 0,
        chunks: 0,
        dirty: true,
      },
    });

    expect(inventory.memoryPlugin).toMatchObject({
      configuredSlot: "memory-core",
      enabled: true,
      registryLoaded: true,
      active: { id: "memory-core", status: "loaded", enabled: true },
    });
    expect(validateMemoryInventory(inventory).findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "plugin.memory.unavailable" })]),
    );
  });
});
