import { describe, expect, it } from "vitest";
import { runPostUpdateDoctorRepair } from "../commands/doctor-update.js";
import type { FasedAgentConfig } from "../config/config.js";

describe("Lane 6 update repair acceptance", () => {
  it("repairs update-owned install state without replacing Fased launcher or Node runtime checks", () => {
    const config: FasedAgentConfig = {
      update: {
        channel: "beta",
      },
      plugins: {
        entries: {
          telegram: {
            enabled: true,
            config: {
              botToken: "redacted",
            },
          },
        },
        installs: {
          telegram: {
            source: "npm",
            spec: "@fased/telegram@latest",
          },
          local: {
            source: "path",
            sourcePath: "/workspace/plugins/local",
            installPath: "/workspace/plugins/local",
          },
        },
      },
    };

    const result = runPostUpdateDoctorRepair({
      config,
      updateCompleted: true,
      resolveNpmInstallPath: (pluginId) => `/home/fc/.fased/extensions/${pluginId}`,
    });

    expect(result.phase).toBe("post-update-doctor");
    expect(result.repairs).toEqual(["configured-install-ledger"]);
    expect(result.skippedRepairs).toEqual([
      "runtime-symlink-cleanup:not-applicable-to-fased-pack-installs",
    ]);
    expect(result.config.update?.channel).toBe("beta");
    expect(result.config.plugins?.entries).toBe(config.plugins?.entries);
    expect(result.config.plugins?.installs?.telegram).toMatchObject({
      source: "npm",
      spec: "@fased/telegram@latest",
      installPath: "/home/fc/.fased/extensions/telegram",
    });
    expect(result.config.plugins?.installs?.local).toEqual(config.plugins?.installs?.local);
  });
});
