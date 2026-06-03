import { describe, expect, it } from "vitest";
import {
  ensureActiveMemoryPluginAllowlisted,
  repairInstalledPluginAllowlist,
  resolveActiveMemoryPluginAllowlistId,
} from "./plugins-allowlist.js";

describe("repairInstalledPluginAllowlist", () => {
  it("pins enabled installed plugins when the allowlist is empty", () => {
    const result = repairInstalledPluginAllowlist({
      plugins: {
        allow: [],
        entries: {
          feishu: { enabled: true },
          disabled: { enabled: false },
        },
        installs: {
          "custom-chat": { source: "npm", spec: "@example/custom-chat-plugin" },
        },
      },
    });

    expect(result.repairedPluginIds).toEqual(["custom-chat", "feishu", "memory-core"]);
    expect(result.config.plugins?.allow).toEqual(["custom-chat", "feishu", "memory-core"]);
  });

  it("preserves an explicit allowlist while adding configured plugins and the active memory plugin", () => {
    const result = repairInstalledPluginAllowlist({
      plugins: {
        allow: ["telegram"],
        entries: {
          feishu: { enabled: true },
          "sat-mining": {
            enabled: true,
            config: { walletId: "mining" },
          },
        },
      },
    });

    expect(result.repairedPluginIds).toEqual(["feishu", "memory-core", "sat-mining"]);
    expect(result.config.plugins?.allow).toEqual([
      "feishu",
      "memory-core",
      "sat-mining",
      "telegram",
    ]);
  });

  it("does not add memory-core when the memory slot is intentionally disabled", () => {
    const result = repairInstalledPluginAllowlist({
      plugins: {
        allow: ["telegram"],
        slots: { memory: "none" },
      },
    });

    expect(result.repairedPluginIds).toEqual([]);
    expect(result.config.plugins?.allow).toEqual(["telegram"]);
  });

  it("does not repair plugins explicitly disabled in entries", () => {
    const result = repairInstalledPluginAllowlist({
      plugins: {
        allow: ["telegram"],
        entries: {
          disabled: { enabled: false },
        },
      },
    });

    expect(result.config.plugins?.allow).not.toContain("disabled");
  });

  it("resolves and allowlists custom active memory plugins", () => {
    const cfg = {
      plugins: {
        allow: ["telegram"],
        slots: { memory: "memory-lancedb" },
      },
    };

    expect(resolveActiveMemoryPluginAllowlistId(cfg)).toBe("memory-lancedb");
    expect(ensureActiveMemoryPluginAllowlisted(cfg).plugins?.allow).toEqual([
      "telegram",
      "memory-lancedb",
    ]);
  });
});
