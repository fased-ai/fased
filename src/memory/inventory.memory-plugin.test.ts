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

  it("reports intentional FTS-only memory as ready without a semantic warning", async () => {
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
        requestedProvider: "auto",
        dirty: false,
        fts: { enabled: true, available: true },
        vector: { enabled: true, available: false },
        custom: {
          searchMode: "fts-only",
          providerUnavailableReason: "No embedding API key is configured.",
        },
      },
    });

    expect(inventory.backend).toMatchObject({
      searchMode: "fts-only",
      semantic: { state: "not-configured" },
    });
    const findings = validateMemoryInventory(inventory).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "info",
          code: "backend.semantic.not-configured",
        }),
      ]),
    );
    expect(findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "backend.semantic.unavailable" })]),
    );
  });
});
