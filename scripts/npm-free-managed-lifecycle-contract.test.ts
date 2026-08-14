import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const ownedExtensions = [
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "feishu",
  "googlechat",
  "runtime-browser",
  "runtime-media",
  "runtime-speech",
  "runtime-local-memory",
  "runtime-openai",
] as const;

async function source(relativePath: string): Promise<string> {
  return await readFile(resolve(repoRoot, relativePath), "utf8");
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(resolve(repoRoot, relativePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("npm-free managed lifecycle", () => {
  it("does not route Fased-owned capabilities through npm add-ons", async () => {
    const catalog = JSON.parse(await source("config/capability-catalog.json")) as {
      entries?: Array<{ delivery?: string }>;
    };
    expect(catalog.entries?.some((entry) => entry.delivery === "npm-addon")).toBe(false);

    const installer = await source("src/capabilities/install.ts");
    expect(installer).not.toContain("installPluginFromNpmSpec");
    expect(installer).not.toContain('source: "npm"');
  });

  it("ships every Fased-owned extension inside the signed application generation", async () => {
    const rootPackage = JSON.parse(await source("package.json")) as {
      files?: string[];
    };
    const files = rootPackage.files ?? [];

    expect(files).toContain("extensions/");
    for (const extension of ownedExtensions) {
      expect(files).not.toContain(`!extensions/${extension}/`);
      const manifest = JSON.parse(await source(`extensions/${extension}/package.json`)) as {
        private?: boolean;
        publishConfig?: unknown;
        fased?: {
          install?: { npmSpec?: string; localPath?: string; defaultChoice?: string };
        };
      };
      expect(manifest.private).toBe(true);
      expect(manifest.publishConfig).toBeUndefined();
      expect(manifest.fased?.install?.npmSpec).toBeUndefined();
      expect(manifest.fased?.install?.localPath).toBe(`extensions/${extension}`);
      expect(manifest.fased?.install?.defaultChoice).toBe("local");
    }
  });

  it("does not ship or route through the legacy JavaScript managed updater", async () => {
    const rootPackage = JSON.parse(await source("package.json")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };
    const updateCommand = await source("src/cli/update-cli/update-command.ts");

    expect(await exists("scripts/fased-managed-updater.mjs")).toBe(false);
    expect(await exists("scripts/managed-updater-bundle.mjs")).toBe(false);
    expect(await exists("scripts/managed-updater-bundle.v1.json")).toBe(false);
    expect(await exists("scripts/fased-managed-launcher.sh")).toBe(false);
    expect(rootPackage.files ?? []).not.toContain("scripts/fased-managed-updater.mjs");
    expect(rootPackage.scripts?.["test:managed-updater"]).toBeUndefined();
    expect(updateCommand).not.toContain("ensureManagedRuntimeBootstrap");
    expect(updateCommand).not.toContain("fased-managed-updater.mjs");
  });

  it("uses pnpm, not npm, to assemble and validate release artifacts", async () => {
    const artifactBuilder = await source("scripts/build-hosted-runtime-artifact.ts");
    const releaseCheck = await source("scripts/release-check.ts");
    const packedSmoke = await source("scripts/smoke-packed-core.ts");
    const workflow = await source(".github/workflows/hosted-runtime-release.yml");

    expect(artifactBuilder).not.toMatch(/run\(\s*["']npm["']/u);
    expect(releaseCheck).not.toMatch(/execFileSync\(\s*["']npm["']/u);
    expect(packedSmoke).not.toMatch(/execFileSync\(\s*["']npm["']/u);
    expect(workflow).not.toMatch(/\bnpm (?:install|pack|publish|view)\b/u);
  });

  it("keeps offline production deploy independent of registry metadata", async () => {
    const artifactBuilder = await source("scripts/build-hosted-runtime-artifact.ts");
    const packedSmoke = await source("scripts/smoke-packed-core.ts");
    const workspace = await source("pnpm-workspace.yaml");
    const offlineProductionDeploy =
      '["--offline", "--filter", "@fased/fased", "deploy", "--prod", "--no-optional"';

    expect(workspace).toContain("injectWorkspacePackages: true");
    expect(workspace).not.toContain("forceLegacyDeploy: true");
    expect(artifactBuilder).toContain(offlineProductionDeploy);
    expect(packedSmoke).toContain(offlineProductionDeploy);
  });
});
