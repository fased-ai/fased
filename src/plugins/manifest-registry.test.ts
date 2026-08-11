import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `fased-manifest-registry-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "fased.plugin.json"), JSON.stringify(manifest), "utf-8");
}

function createPluginCandidate(params: {
  idHint: string;
  rootDir: string;
  sourceName?: string;
  origin: "bundled" | "global" | "workspace" | "config";
  packageName?: string;
  packageDir?: string;
  packageManifest?: PluginCandidate["packageManifest"];
}): PluginCandidate {
  return {
    idHint: params.idHint,
    source: path.join(params.rootDir, params.sourceName ?? "index.ts"),
    rootDir: params.rootDir,
    origin: params.origin,
    packageName: params.packageName,
    packageDir: params.packageDir,
    packageManifest: params.packageManifest,
  };
}

function loadRegistry(candidates: PluginCandidate[]) {
  return loadPluginManifestRegistry({
    candidates,
    cache: false,
  });
}

function countDuplicateErrors(registry: ReturnType<typeof loadPluginManifestRegistry>): number {
  return registry.diagnostics.filter(
    (diagnostic) =>
      diagnostic.level === "error" && diagnostic.message?.includes("duplicate plugin id"),
  ).length;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      break;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("loadPluginManifestRegistry", () => {
  it("rejects a truly distinct plugin with the same id", () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const manifest = { id: "test-plugin", configSchema: { type: "object" } };
    writeManifest(dirA, manifest);
    writeManifest(dirB, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "test-plugin",
        rootDir: dirA,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "test-plugin",
        rootDir: dirB,
        origin: "global",
      }),
    ];

    const registry = loadRegistry(candidates);
    expect(countDuplicateErrors(registry)).toBe(1);
    expect(registry.plugins).toHaveLength(1);
  });

  it("deduplicates runtime-only component manifests without loading two plugin records", () => {
    const workspaceDir = makeTempDir();
    const installedDir = makeTempDir();
    const manifest = {
      id: "openai-runtime",
      runtimeOnly: true,
      configSchema: { type: "object" },
    };
    writeManifest(workspaceDir, manifest);
    writeManifest(installedDir, manifest);

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "openai-runtime",
        rootDir: workspaceDir,
        origin: "workspace",
      }),
      createPluginCandidate({
        idHint: "openai-runtime",
        rootDir: installedDir,
        origin: "config",
      }),
    ]);

    expect(countDuplicateErrors(registry)).toBe(0);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]).toMatchObject({
      id: "openai-runtime",
      runtimeOnly: true,
      origin: "config",
    });
  });

  it("deduplicates a legacy installed OpenAI runtime manifest by official package identity", () => {
    const workspaceDir = makeTempDir();
    const installedDir = makeTempDir();
    writeManifest(workspaceDir, {
      id: "openai-runtime",
      runtimeOnly: true,
      configSchema: { type: "object" },
    });
    writeManifest(installedDir, {
      id: "openai-runtime",
      configSchema: { type: "object" },
    });

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "openai-runtime",
        rootDir: workspaceDir,
        origin: "workspace",
        packageName: "@fased/openai-runtime",
      }),
      createPluginCandidate({
        idHint: "openai-runtime",
        rootDir: installedDir,
        origin: "config",
        packageName: "@fased/openai-runtime",
      }),
    ]);

    expect(countDuplicateErrors(registry)).toBe(0);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]).toMatchObject({
      id: "openai-runtime",
      runtimeOnly: true,
      origin: "config",
    });
  });

  it("does not let a runtime-only manifest suppress a normal duplicate-id rejection", () => {
    const normalDir = makeTempDir();
    const runtimeDir = makeTempDir();
    writeManifest(normalDir, { id: "shared-id", configSchema: { type: "object" } });
    writeManifest(runtimeDir, {
      id: "shared-id",
      runtimeOnly: true,
      configSchema: { type: "object" },
    });

    const registry = loadRegistry([
      createPluginCandidate({ idHint: "shared-id", rootDir: normalDir, origin: "workspace" }),
      createPluginCandidate({ idHint: "shared-id", rootDir: runtimeDir, origin: "config" }),
    ]);

    expect(countDuplicateErrors(registry)).toBe(1);
    expect(registry.plugins).toHaveLength(1);
  });

  it("suppresses duplicate warning when candidates share the same physical directory via symlink", () => {
    const realDir = makeTempDir();
    const manifest = { id: "feishu", configSchema: { type: "object" } };
    writeManifest(realDir, manifest);

    // Create a symlink pointing to the same directory
    const symlinkParent = makeTempDir();
    const symlinkPath = path.join(symlinkParent, "feishu-link");
    try {
      fs.symlinkSync(realDir, symlinkPath, "junction");
    } catch {
      // On systems where symlinks are not supported (e.g. restricted Windows),
      // skip this test gracefully.
      return;
    }

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "feishu",
        rootDir: realDir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "feishu",
        rootDir: symlinkPath,
        origin: "bundled",
      }),
    ];

    expect(countDuplicateErrors(loadRegistry(candidates))).toBe(0);
  });

  it("suppresses duplicate warning when candidates have identical rootDir paths", () => {
    const dir = makeTempDir();
    const manifest = { id: "same-path-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "same-path-plugin",
        rootDir: dir,
        sourceName: "a.ts",
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "same-path-plugin",
        rootDir: dir,
        sourceName: "b.ts",
        origin: "global",
      }),
    ];

    expect(countDuplicateErrors(loadRegistry(candidates))).toBe(0);
  });

  it("prefers higher-precedence origins for the same physical directory (config > workspace > global > bundled)", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    const manifest = { id: "precedence-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    // Use a different-but-equivalent path representation without requiring symlinks.
    const altDir = path.join(dir, "sub", "..");

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "precedence-plugin",
        rootDir: dir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "precedence-plugin",
        rootDir: altDir,
        origin: "config",
      }),
    ];

    const registry = loadRegistry(candidates);
    expect(countDuplicateErrors(registry)).toBe(0);
    expect(registry.plugins.length).toBe(1);
    expect(registry.plugins[0]?.origin).toBe("config");
  });

  it("rejects manifest paths that escape plugin root via symlink", () => {
    const rootDir = makeTempDir();
    const outsideDir = makeTempDir();
    const outsideManifest = path.join(outsideDir, "fased.plugin.json");
    const linkedManifest = path.join(rootDir, "fased.plugin.json");
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf-8");
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({ id: "unsafe-symlink", configSchema: { type: "object" } }),
      "utf-8",
    );
    try {
      fs.symlinkSync(outsideManifest, linkedManifest);
    } catch {
      return;
    }

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "unsafe-symlink",
        rootDir,
        origin: "workspace",
      }),
    ]);
    expect(registry.plugins).toHaveLength(0);
    expect(
      registry.diagnostics.some((diag) => diag.message.includes("unsafe plugin manifest path")),
    ).toBe(true);
  });

  it("rejects manifest paths that escape plugin root via hardlink", () => {
    if (process.platform === "win32") {
      return;
    }
    const rootDir = makeTempDir();
    const outsideDir = makeTempDir();
    const outsideManifest = path.join(outsideDir, "fased.plugin.json");
    const linkedManifest = path.join(rootDir, "fased.plugin.json");
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf-8");
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({ id: "unsafe-hardlink", configSchema: { type: "object" } }),
      "utf-8",
    );
    try {
      fs.linkSync(outsideManifest, linkedManifest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "unsafe-hardlink",
        rootDir,
        origin: "workspace",
      }),
    ]);
    expect(registry.plugins).toHaveLength(0);
    expect(
      registry.diagnostics.some((diag) => diag.message.includes("unsafe plugin manifest path")),
    ).toBe(true);
  });

  it("preserves richer manifest and package metadata on registry records", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "rich-plugin",
      configSchema: { type: "object" },
      enabledByDefault: true,
      legacyPluginIds: ["rich-plugin-legacy"],
      autoEnableWhenConfiguredProviders: ["openrouter"],
      providers: ["openrouter"],
      providerAuthEnvVars: {
        openrouter: ["OPENROUTER_API_KEY"],
      },
      providerAuthAliases: {
        "openrouter-plan": "openrouter",
      },
      contracts: {
        webSearchProviders: ["openrouter-search"],
      },
      channelConfigs: {
        telegram: {
          schema: { type: "object" },
          label: "Telegram",
        },
      },
    });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@fased/rich-plugin",
        fased: {
          extensions: ["index.ts"],
          channel: {
            id: "telegram",
            blurb: "Telegram channel",
            preferOver: ["telegram-legacy"],
          },
          startup: {
            deferConfiguredChannelFullLoadUntilAfterListen: true,
          },
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "index.ts"), "export default function () {}", "utf-8");

    const registry = loadPluginManifestRegistry({
      cache: false,
      candidates: [
        createPluginCandidate({
          idHint: "rich-plugin",
          rootDir: dir,
          origin: "workspace",
          packageDir: dir,
          packageManifest: {
            extensions: ["index.ts"],
            channel: {
              id: "telegram",
              blurb: "Telegram channel",
              preferOver: ["telegram-legacy"],
            },
            startup: {
              deferConfiguredChannelFullLoadUntilAfterListen: true,
            },
          },
        }),
      ],
    });
    const record = registry.plugins.find((plugin) => plugin.id === "rich-plugin");
    expect(record).toBeDefined();
    expect(record?.enabledByDefault).toBe(true);
    expect(record?.legacyPluginIds).toEqual(["rich-plugin-legacy"]);
    expect(record?.autoEnableWhenConfiguredProviders).toEqual(["openrouter"]);
    expect(record?.providerAuthEnvVars).toEqual({
      openrouter: ["OPENROUTER_API_KEY"],
    });
    expect(record?.providerAuthAliases).toEqual({
      "openrouter-plan": "openrouter",
    });
    expect(record?.contracts).toEqual({
      webSearchProviders: ["openrouter-search"],
    });
    expect(record?.channelConfigs?.telegram).toEqual({
      schema: { type: "object" },
      label: "Telegram",
      description: "Telegram channel",
      preferOver: ["telegram-legacy"],
    });
    expect(record?.channelCatalogMeta).toEqual({
      id: "telegram",
      blurb: "Telegram channel",
      preferOver: ["telegram-legacy"],
    });
    expect(record?.startupDeferConfiguredChannelFullLoadUntilAfterListen).toBe(true);
  });

  it("skips plugins whose package minHostVersion exceeds the current host", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "future-plugin",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@fased/future-plugin",
        fased: {
          extensions: ["index.ts"],
          install: {
            minHostVersion: ">=9999.0.0",
          },
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "index.ts"), "export default function () {}", "utf-8");

    const registry = loadPluginManifestRegistry({
      cache: false,
      candidates: [
        createPluginCandidate({
          idHint: "future-plugin",
          rootDir: dir,
          origin: "workspace",
          packageDir: dir,
          packageManifest: {
            extensions: ["index.ts"],
            install: {
              minHostVersion: ">=9999.0.0",
            },
          },
        }),
      ],
      env: { ...process.env, FASED_VERSION: "2026.2.27" },
    });
    expect(registry.plugins.find((plugin) => plugin.id === "future-plugin")).toBeUndefined();
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "future-plugin" &&
          diag.level === "error" &&
          diag.message.includes("requires Fased >=9999.0.0"),
      ),
    ).toBe(true);
  });
});
