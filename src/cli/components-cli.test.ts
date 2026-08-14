import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ log: vi.fn() }));
const writeConfigFile = vi.hoisted(() => vi.fn());
const finalizeInstalledPluginConfig = vi.hoisted(() => vi.fn());
const report = vi.hoisted(() => ({
  entries: [
    {
      id: "agent-core",
      label: "Fased Agent",
      category: "core",
      delivery: "core",
      description: "Agent",
      docsPath: "/start/fased",
      surface: "Agent > Models",
      state: "included",
      action: "configure",
      detail: "Included",
    },
  ],
  summary: {
    total: 1,
    coreIncluded: 1,
    configured: 0,
    externalRequired: 0,
    errors: 0,
  },
}));

vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  writeConfigFile,
}));
vi.mock("../plugins/lifecycle.js", () => ({ finalizeInstalledPluginConfig }));
vi.mock("../capabilities/catalog.js", () => ({
  buildCapabilityReadinessReport: vi.fn(() => report),
  formatCapabilityReadinessSummary: vi.fn(() => "Core included: 1"),
  loadCapabilityCatalog: vi.fn(() => [
    {
      id: "media-runtime",
      label: "Media Runtime",
      category: "runtime",
      delivery: "core",
      packageName: "@fased/media-runtime",
      pluginId: "media-runtime",
      docsPath: "/nodes/media-understanding",
      surface: "Services > Components",
      description: "Media",
      restartRequired: true,
    },
  ]),
}));

describe("components CLI", () => {
  beforeEach(() => {
    runtime.log.mockClear();
    writeConfigFile.mockReset();
    finalizeInstalledPluginConfig.mockReset();
  });

  it("prints the shared capability report as JSON", async () => {
    const { registerComponentsCli } = await import("./components-cli.js");
    const program = new Command().name("fased");
    registerComponentsCli(program);
    await program.parseAsync(["components", "--json"], { from: "user" });
    expect(JSON.parse(runtime.log.mock.calls[0]?.[0] as string)).toEqual(report);
  });

  it("prints lifecycle states in the table", async () => {
    const { registerComponentsCli } = await import("./components-cli.js");
    const program = new Command().name("fased");
    registerComponentsCli(program);
    await program.parseAsync(["components"], { from: "user" });
    expect(runtime.log.mock.calls.flat().join("\n")).toContain("Fased Agent");
    expect(runtime.log.mock.calls.flat().join("\n")).toContain("included");
  });

  it("enables a bundled runtime through the plugin lifecycle", async () => {
    finalizeInstalledPluginConfig.mockReturnValue({ config: { plugins: {} }, slotWarnings: [] });
    const { registerComponentsCli } = await import("./components-cli.js");
    const program = new Command().name("fased");
    registerComponentsCli(program);

    await program.parseAsync(["components", "install", "media-runtime"], { from: "user" });

    expect(finalizeInstalledPluginConfig).toHaveBeenCalledWith({
      config: {},
      pluginId: "media-runtime",
    });
    expect(writeConfigFile).toHaveBeenCalledWith({ plugins: {} });
    expect(runtime.log.mock.calls.flat().join("\n")).toContain(
      "Enabled bundled component: Media Runtime",
    );
  });
});
