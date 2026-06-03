import { describe, expect, it } from "vitest";
import {
  buildNpmResolutionInstallFields,
  recordPluginInstall,
  repairUpdateOwnedPluginInstallState,
} from "./installs.js";

describe("buildNpmResolutionInstallFields", () => {
  it("maps npm resolution metadata into install record fields", () => {
    const fields = buildNpmResolutionInstallFields({
      name: "@fased/demo",
      version: "1.2.3",
      resolvedSpec: "@fased/demo@1.2.3",
      integrity: "sha512-abc",
      shasum: "deadbeef",
      resolvedAt: "2026-02-22T00:00:00.000Z",
    });
    expect(fields).toEqual({
      resolvedName: "@fased/demo",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@fased/demo@1.2.3",
      integrity: "sha512-abc",
      shasum: "deadbeef",
      resolvedAt: "2026-02-22T00:00:00.000Z",
    });
  });

  it("returns undefined fields when resolution is missing", () => {
    expect(buildNpmResolutionInstallFields(undefined)).toEqual({
      resolvedName: undefined,
      resolvedVersion: undefined,
      resolvedSpec: undefined,
      integrity: undefined,
      shasum: undefined,
      resolvedAt: undefined,
    });
  });
});

describe("recordPluginInstall", () => {
  it("stores install metadata for the plugin id", () => {
    const next = recordPluginInstall({}, { pluginId: "demo", source: "npm", spec: "demo@latest" });
    expect(next.plugins?.installs?.demo).toMatchObject({
      source: "npm",
      spec: "demo@latest",
    });
    expect(typeof next.plugins?.installs?.demo?.installedAt).toBe("string");
  });
});

describe("repairUpdateOwnedPluginInstallState", () => {
  it("fills missing npm install paths for existing source-trusted install records", () => {
    const result = repairUpdateOwnedPluginInstallState(
      {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              spec: "@fased/demo@latest",
              version: "1.0.0",
            },
            archive: {
              source: "archive",
              sourcePath: "/tmp/demo.zip",
            },
            path: {
              source: "path",
              sourcePath: "/workspace/plugin",
              installPath: "/workspace/plugin",
            },
          },
        },
      },
      {
        resolveNpmInstallPath: (pluginId) => `/home/fc/.fased/extensions/${pluginId}`,
      },
    );

    expect(result.changed).toBe(true);
    expect(result.repairedPluginIds).toEqual(["demo"]);
    expect(result.warnings).toEqual([]);
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      source: "npm",
      spec: "@fased/demo@latest",
      version: "1.0.0",
      installPath: "/home/fc/.fased/extensions/demo",
    });
    expect(result.config.plugins?.installs?.archive?.installPath).toBeUndefined();
    expect(result.config.plugins?.installs?.path?.installPath).toBe("/workspace/plugin");
  });

  it("does not invent install paths for npm records without a spec", () => {
    const result = repairUpdateOwnedPluginInstallState(
      {
        plugins: {
          installs: {
            demo: {
              source: "npm",
            },
          },
        },
      },
      {
        resolveNpmInstallPath: (pluginId) => `/home/fc/.fased/extensions/${pluginId}`,
      },
    );

    expect(result.changed).toBe(false);
    expect(result.config.plugins?.installs?.demo?.installPath).toBeUndefined();
    expect(result.warnings).toEqual([
      'Skipped npm install record repair for "demo": missing npm spec.',
    ]);
  });
});
