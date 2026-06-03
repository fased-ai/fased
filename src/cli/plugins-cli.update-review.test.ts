import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { registerPluginsCli as registerPluginsCliType } from "./plugins-cli.js";

const loadConfig = vi.hoisted(() => vi.fn());
const writeConfigFile = vi.hoisted(() => vi.fn(async (_config: FasedAgentConfig) => {}));
const executePluginUpdateLifecycle = vi.hoisted(() => vi.fn());
const buildPluginMarketplaceReport = vi.hoisted(() => vi.fn());
const promptYesNo = vi.hoisted(() => vi.fn());
const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig,
  STATE_DIR: "/tmp/fased-test-state",
  writeConfigFile,
}));

vi.mock("../plugins/lifecycle.js", () => ({
  buildPluginLifecycleReport: vi.fn(),
  buildPluginUninstallPreview: vi.fn(),
  executePluginUninstallLifecycle: vi.fn(),
  executePluginUpdateLifecycle,
  finalizeInstalledPluginConfig: vi.fn(),
  resolvePluginLifecycleEntry: vi.fn(),
}));

vi.mock("../plugins/marketplace.js", () => ({
  buildPluginMarketplaceReport,
}));

vi.mock("./prompt.js", () => ({
  promptYesNo,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerPluginsCli: typeof registerPluginsCliType;

async function runPluginsCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerPluginsCli(program);
  await program.parseAsync(["plugins", ...args], { from: "user" });
}

function createConfig(): FasedAgentConfig {
  return {
    plugins: {
      installs: {
        demo: {
          source: "npm",
          spec: "@fased/demo@1.0.0",
          integrity: "sha512-old",
        },
      },
    },
  };
}

function createMarketplaceEntry() {
  return {
    id: "demo",
    name: "Demo",
    status: "loaded",
    discovered: true,
    managed: true,
    loaded: true,
    enabled: true,
    hasInstallRecord: true,
    install: {
      source: "npm",
      spec: "@fased/demo@1.0.0",
      integrity: "sha512-old",
    },
    channels: ["telegram"],
    providers: ["openai"],
    toolNames: ["demo.status"],
    hookNames: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpHandlers: 0,
    hookCount: 0,
    installOptions: {},
    actions: ["status", "update"],
  };
}

function createUpdateOutcome(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "demo",
    status: "updated",
    message: "demo updated",
    currentVersion: "1.0.0",
    nextVersion: "1.0.1",
    resolvedSpec: "@fased/demo@1.0.1",
    integrity: "sha512-new",
    packageReview: {
      pluginId: "demo",
      packageName: "@fased/demo",
      version: "1.0.1",
      extensions: ["./dist/index.js"],
      kind: "integration",
      channels: ["telegram"],
      providers: ["openai"],
      skills: [],
      tools: ["demo.status"],
      dependencyCount: 0,
      dependencyKinds: [],
      scriptNames: [],
      dependencyWarnings: [],
      scriptWarnings: [],
    },
    warnings: [],
    ...overrides,
  };
}

describe("plugins update CLI trust review", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ registerPluginsCli } = await import("./plugins-cli.js"));
    loadConfig.mockReturnValue(createConfig());
    writeConfigFile.mockResolvedValue(undefined);
    buildPluginMarketplaceReport.mockReturnValue({
      plugins: [createMarketplaceEntry()],
      diagnostics: [],
    });
    promptYesNo.mockResolvedValue(false);
    executePluginUpdateLifecycle.mockImplementation(async ({ dryRun }: { dryRun: boolean }) => ({
      config: createConfig(),
      changed: !dryRun,
      outcomes: [createUpdateOutcome()],
    }));
  });

  it("prints update trust review during dry-run without prompting", async () => {
    await runPluginsCli(["update", "demo", "--dry-run"]);

    expect(executePluginUpdateLifecycle).toHaveBeenCalledTimes(1);
    expect(executePluginUpdateLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["demo"],
        dryRun: true,
      }),
    );
    expect(promptYesNo).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('Update review for "demo": no approval required'),
    );
  });

  it("cancels risky updates unless explicitly approved", async () => {
    executePluginUpdateLifecycle.mockResolvedValueOnce({
      config: createConfig(),
      changed: false,
      outcomes: [
        createUpdateOutcome({
          packageReview: {
            ...createUpdateOutcome().packageReview,
            channels: ["telegram", "discord"],
            dependencyCount: 1,
            dependencyKinds: ["dependencies"],
            dependencyWarnings: ["package declares runtime dependencies"],
          },
        }),
      ],
    });

    await runPluginsCli(["update", "demo"]);

    expect(executePluginUpdateLifecycle).toHaveBeenCalledTimes(1);
    expect(promptYesNo).toHaveBeenCalledWith("Continue plugin update with 1 risky review?");
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Plugin update cancelled.");
  });

  it("runs approved risky update and writes changed config", async () => {
    executePluginUpdateLifecycle
      .mockResolvedValueOnce({
        config: createConfig(),
        changed: false,
        outcomes: [
          createUpdateOutcome({
            packageReview: {
              ...createUpdateOutcome().packageReview,
              tools: ["demo.status", "demo.send"],
              scriptNames: ["postinstall"],
              scriptWarnings: ["package declares npm scripts: postinstall"],
            },
          }),
        ],
      })
      .mockResolvedValueOnce({
        config: { plugins: { installs: {} } },
        changed: true,
        outcomes: [createUpdateOutcome()],
      });

    await runPluginsCli(["update", "demo", "--approve-risky-changes"]);

    expect(promptYesNo).not.toHaveBeenCalled();
    expect(executePluginUpdateLifecycle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ dryRun: true }),
    );
    expect(executePluginUpdateLifecycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ dryRun: false }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith({ plugins: { installs: {} } });
    expect(runtime.log).toHaveBeenCalledWith("Restart the gateway to load plugins.");
  });
});
