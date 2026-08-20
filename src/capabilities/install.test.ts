import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCapabilityCatalog = vi.hoisted(() => vi.fn());
const finalizeInstalledPluginConfig = vi.hoisted(() => vi.fn());

vi.mock("./catalog.js", () => ({ loadCapabilityCatalog }));
vi.mock("../plugins/lifecycle.js", () => ({ finalizeInstalledPluginConfig }));

describe("capability component installation", () => {
  beforeEach(() => {
    loadCapabilityCatalog.mockReset();
    finalizeInstalledPluginConfig.mockReset();
    finalizeInstalledPluginConfig.mockReturnValue({ config: { plugins: {} }, slotWarnings: [] });
  });

  it("enables a core plugin without a managed transaction", async () => {
    loadCapabilityCatalog.mockReturnValue([
      { id: "sat-mining", label: "SAT Mining", delivery: "core", pluginId: "sat-mining" },
    ]);
    const { installCapabilityComponent } = await import("./install.js");
    const runManagedTransaction = vi.fn();

    await installCapabilityComponent({
      id: "sat-mining",
      config: {},
      runManagedTransaction,
    });

    expect(runManagedTransaction).not.toHaveBeenCalled();
    expect(finalizeInstalledPluginConfig).toHaveBeenCalledWith({
      config: {},
      pluginId: "sat-mining",
    });
  });

  it("requires and completes P6 before enabling a managed component", async () => {
    loadCapabilityCatalog.mockReturnValue([
      {
        id: "telegram",
        label: "Telegram",
        delivery: "managed-component",
        pluginId: "telegram",
      },
    ]);
    const { installCapabilityComponent } = await import("./install.js");
    const runManagedTransaction = vi.fn().mockResolvedValue(undefined);
    const transaction = {
      catalogPath: "/tmp/telegram.catalog.json",
      catalogDigest: `sha256:${"a".repeat(64)}`,
      archivePath: "/tmp/telegram.tar.gz",
    };

    await expect(
      installCapabilityComponent({ id: "telegram", config: {}, runManagedTransaction }),
    ).rejects.toThrow("requires a signed component catalog and archive");
    expect(finalizeInstalledPluginConfig).not.toHaveBeenCalled();

    await installCapabilityComponent({
      id: "telegram",
      config: {},
      transaction,
      runManagedTransaction,
    });
    expect(runManagedTransaction).toHaveBeenCalledWith({ pluginId: "telegram", transaction });
    expect(finalizeInstalledPluginConfig).toHaveBeenCalledTimes(1);
  });

  it("does not enable managed config when P6 fails and rejects unsafe identities", async () => {
    loadCapabilityCatalog.mockReturnValue([
      {
        id: "telegram",
        label: "Telegram",
        delivery: "managed-component",
        pluginId: "telegram",
      },
    ]);
    const { installCapabilityComponent } = await import("./install.js");
    const runManagedTransaction = vi.fn().mockRejectedValue(new Error("P6 rollback"));

    await expect(
      installCapabilityComponent({
        id: "telegram",
        config: {},
        transaction: {
          catalogPath: "/tmp/../tmp/telegram.catalog.json",
          catalogDigest: `sha256:${"A".repeat(64)}`,
          archivePath: "relative.tar.gz",
        },
        runManagedTransaction,
      }),
    ).rejects.toThrow(/exact absolute path|canonical sha256/u);
    expect(runManagedTransaction).not.toHaveBeenCalled();
    expect(finalizeInstalledPluginConfig).not.toHaveBeenCalled();

    await expect(
      installCapabilityComponent({
        id: "telegram",
        config: {},
        transaction: {
          catalogPath: "/tmp/telegram.catalog.json",
          catalogDigest: `sha256:${"a".repeat(64)}`,
          archivePath: "/tmp/telegram.tar.gz",
        },
        runManagedTransaction,
      }),
    ).rejects.toThrow("P6 rollback");
    expect(finalizeInstalledPluginConfig).not.toHaveBeenCalled();
  });
});
