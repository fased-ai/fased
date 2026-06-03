import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { registerPluginsCli as registerPluginsCliType } from "./plugins-cli.js";

const loadConfig = vi.hoisted(() => vi.fn());
const writeConfigFile = vi.hoisted(() => vi.fn(async (_config: FasedAgentConfig) => {}));
const buildPluginLifecycleReport = vi.hoisted(() => vi.fn());
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
  buildPluginLifecycleReport,
  buildPluginUninstallPreview: vi.fn(),
  executePluginUninstallLifecycle: vi.fn(),
  executePluginUpdateLifecycle: vi.fn(),
  finalizeInstalledPluginConfig: vi.fn(),
  resolvePluginLifecycleEntry: vi.fn(),
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

describe("plugins CLI runtime helper grants", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ({ registerPluginsCli } = await import("./plugins-cli.js"));
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          demo: {
            enabled: false,
          },
        },
      },
    });
    buildPluginLifecycleReport.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      plugins: [
        {
          id: "demo",
          name: "Demo",
          status: "disabled",
          enabled: false,
          managed: true,
        },
      ],
      diagnostics: [],
    });
  });

  it("enables the read-only sessions helper grant without enabling the plugin", async () => {
    await runPluginsCli(["helpers", "sessions", "enable", "demo"]);

    expect(writeConfigFile).toHaveBeenCalledWith({
      plugins: {
        entries: {
          demo: {
            enabled: false,
            runtime: {
              helpers: {
                sessions: {
                  read: true,
                },
              },
            },
          },
        },
      },
    });
    expect(runtime.log).toHaveBeenCalledWith(
      'Enabled runtime.helpers.sessions.read for plugin "demo". Restart the gateway to apply.',
    );
  });

  it("disables the read-only sessions helper grant", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          demo: {
            enabled: true,
            runtime: {
              helpers: {
                sessions: {
                  read: true,
                },
              },
            },
          },
        },
      },
    });

    await runPluginsCli(["helpers", "sessions", "disable", "demo"]);

    expect(writeConfigFile).toHaveBeenCalledWith({
      plugins: {
        entries: {
          demo: {
            enabled: true,
            runtime: {
              helpers: {
                sessions: {
                  read: false,
                },
              },
            },
          },
        },
      },
    });
  });

  it("prints helper grant status as JSON", async () => {
    await runPluginsCli(["helpers", "sessions", "status", "demo", "--json"]);

    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          pluginId: "demo",
          sessionsRead: false,
          status: "disabled",
          loaded: false,
          enabled: false,
          managed: true,
        },
        null,
        2,
      ),
    );
  });
});
