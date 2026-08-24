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

  it("freezes the legacy public root package and keeps source builds private", async () => {
    const rootPackage = JSON.parse(await source("package.json")) as {
      private?: boolean;
      publishConfig?: unknown;
      packageManager?: string;
    };

    expect(rootPackage.private).toBe(true);
    expect(rootPackage.publishConfig).toBeUndefined();
    expect(rootPackage.packageManager).toMatch(/^pnpm@/u);
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

  it("does not advertise npm-global installation from the macOS application", async () => {
    const onboarding = `${await source("apps/macos/Sources/FasedAgent/Onboarding.swift")}\n${await source("apps/macos/Sources/FasedAgent/OnboardingView+Pages.swift")}`;
    const gatewayEnvironment = await source(
      "apps/macos/Sources/FasedAgent/GatewayEnvironment.swift",
    );

    expect(onboarding).not.toContain("npm install -g fased");
    expect(onboarding).not.toContain("releases/latest/download/install.sh");
    expect(onboarding).toContain("Local mode is compatibility-only");
    expect(gatewayEnvironment).not.toContain("installGlobal");
    expect(gatewayEnvironment).not.toMatch(/(?:npm|pnpm|bun).*(?:install|add).*fased@/u);
  });

  it("removes superseded managed shell and Node migration owners", async () => {
    const rootPackage = JSON.parse(await source("package.json")) as { files?: string[] };
    const superseded = [
      "scripts/fased-managed-service.sh",
      "scripts/start-managed.sh",
      "scripts/start-vps.sh",
      "scripts/migrate-hosted-signer-v2.mjs",
      "scripts/hosted-legacy-wallet-migration.mjs",
      "scripts/fased-launcher-runtime.mjs",
      "scripts/fased-launcher-runtime.d.mts",
      "src/types/fased-launcher-runtime.d.ts",
      "src/commands/managed-up.ts",
      "src/cli/program/register.managed.ts",
      "src/infra/update-global.ts",
      "src/infra/update-runner.ts",
      "src/infra/update-startup.ts",
      "src/gateway/update-status.ts",
      "src/cli/update-cli/legacy-source-update-command.ts",
      "src/cli/update-cli/progress.ts",
      "src/cli/update-cli/restart-helper.ts",
      "src/cli/update-cli/service-target.ts",
      "src/cli/update-cli/wizard.ts",
      "src/cli/lightweight/update-precheck.ts",
      "src/cli/lightweight/update-status.ts",
      "scripts/install-managed-cli-alias.mjs",
      "scripts/e2e/doctor-install-switch-docker.sh",
    ];

    for (const relativePath of superseded) {
      expect(await exists(relativePath), `${relativePath} still exists`).toBe(false);
      expect(rootPackage.files ?? []).not.toContain(relativePath);
    }
  });

  it("fences application-owned privileged mutation in Go-managed runtimes", async () => {
    const [service, tailscale, onboarding, uninstall] = await Promise.all([
      source("src/daemon/service.ts"),
      source("src/infra/tailscale.ts"),
      source("src/wizard/onboarding.ts"),
      source("src/commands/uninstall.ts"),
    ]);
    expect(service).toContain(
      "Managed Gateway service mutation is owned by the verified Go lifecycle",
    );
    expect(tailscale).toContain("is owned by the verified Go lifecycle in managed installations");
    expect(onboarding).toContain("cannot replace its attested signer with a source build");
    expect(uninstall).toContain(
      "Managed installations must be uninstalled by the verified Go lifecycle",
    );
  });

  it("removes npm/global status and mutation routes from runtime and CI", async () => {
    const updateCheck = await source("src/infra/update-check.ts");
    const entry = await source("fased.mjs");
    const buildConfig = await source("tsdown.config.ts");
    const pullRequestWorkflow = await source(".github/workflows/pr.yml");

    expect(updateCheck).not.toContain("registry.npmjs.org");
    expect(updateCheck).not.toContain("resolveNpmChannelTag");
    expect(entry).not.toContain("light-update-status");
    expect(entry).not.toContain("light-update-precheck");
    expect(buildConfig).not.toContain("light-update-status");
    expect(buildConfig).not.toContain("light-update-precheck");
    expect(pullRequestWorkflow).not.toContain("update-runner.test.ts");
    expect(pullRequestWorkflow).not.toContain("managed-updater-bundle.test.ts");
    expect(pullRequestWorkflow).not.toContain("generation-updater.test.ts");
    expect(pullRequestWorkflow).not.toContain("fased-managed-updater-fixed-client.test.ts");
  });

  it("does not tell non-git managed installs to update through npm or pnpm", async () => {
    const doctorUpdate = await source("src/commands/doctor-update.ts");

    expect(doctorUpdate).toContain("verified Go lifecycle");
    expect(doctorUpdate).not.toMatch(/package manager \((?:npm|pnpm)/u);
  });

  it("keeps npm optional and unprivileged for third-party plugins only", async () => {
    const pluginInstaller = await source("src/plugins/install.ts");
    const thirdPartyManifest = JSON.parse(
      await source("extensions/nextcloud-talk/package.json"),
    ) as { fased?: { install?: { npmSpec?: string } } };
    const updateCommand = await source("src/cli/update-cli/update-command.ts");
    const artifactBuilder = await source("scripts/build-linux-x64-release-artifact.sh");

    expect(pluginInstaller).toContain("installPluginFromNpmSpec");
    expect(thirdPartyManifest.fased?.install?.npmSpec).toBe("@fased/nextcloud-talk");
    expect(updateCommand).not.toContain("installPluginFromNpmSpec");
    expect(artifactBuilder).not.toContain("installPluginFromNpmSpec");
  });

  it("uses pnpm, not npm, to assemble and validate release artifacts", async () => {
    const artifactBuilder = await source("scripts/build-hosted-runtime-artifact.ts");
    const releaseCheck = await source("scripts/release-check.ts");
    const packedSmoke = await source("scripts/smoke-packed-core.ts");
    const workflow = await source(".github/workflows/hosted-runtime-release.yml");
    const channelPublisher = await source("scripts/publish-lifecycle-channel.sh");
    const linuxArtifactBuilder = await source("scripts/build-linux-x64-release-artifact.sh");

    expect(artifactBuilder).not.toMatch(/run\(\s*["']npm["']/u);
    expect(releaseCheck).not.toMatch(/execFileSync\(\s*["']npm["']/u);
    expect(packedSmoke).not.toMatch(/execFileSync\(\s*["']npm["']/u);
    expect(workflow).not.toMatch(/\bnpm (?:install|pack|publish|view)\b/u);
    expect(channelPublisher).not.toMatch(/\bnpm\b/u);
    expect(channelPublisher).toContain("fased-channel-$channel-v1");
    expect(linuxArtifactBuilder).not.toMatch(/\bnpm (?:install|pack|publish|view)\b/u);
  });

  it("keeps offline production deploy independent of registry metadata", async () => {
    const artifactBuilder = await source("scripts/build-hosted-runtime-artifact.ts");
    const packedSmoke = await source("scripts/smoke-packed-core.ts");
    const workspace = await source("pnpm-workspace.yaml");
    const offlineProductionDeploy =
      /"--store-dir",\s*pnpmDeployStore,\s*"--offline",\s*"--filter",\s*"@fased\/fased",\s*"deploy",\s*"--prod",\s*"--no-optional"/u;

    expect(workspace).toContain("injectWorkspacePackages: true");
    expect(workspace).not.toContain("forceLegacyDeploy: true");
    expect(artifactBuilder).not.toContain("npm_config_force_legacy_deploy");
    expect(artifactBuilder).toMatch(
      /fs\.copyFile\(\s*path\.join\(rootDir, "pnpm-lock\.yaml"\),\s*path\.join\(packageRoot, "pnpm-lock\.yaml"\),?\s*\)/u,
    );
    expect(packedSmoke).not.toContain("npm_config_force_legacy_deploy");
    expect(artifactBuilder).toContain("createWritablePnpmDeployStoreView(pnpmStore, tempRoot)");
    expect(packedSmoke).toContain("createWritablePnpmDeployStoreView(pnpmStore, tempRoot)");
    expect(artifactBuilder).toContain('["store", "path"]');
    expect(packedSmoke).toContain('["store", "path"]');
    expect(artifactBuilder).not.toContain('["store", "path", "--silent"]');
    expect(packedSmoke).not.toContain('["store", "path", "--silent"]');
    expect(artifactBuilder).toMatch(offlineProductionDeploy);
    expect(packedSmoke).toMatch(offlineProductionDeploy);
  });

  it("removes npm from release acceptance and deletes its superseded installer smoke", async () => {
    const skill = await source("docs/maintainers/codex-skills/fased-release-manager/SKILL.md");
    const release = await source(
      "docs/maintainers/codex-skills/fased-release-manager/references/release.md",
    );
    const rootPackage = JSON.parse(await source("package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(skill).not.toContain("For npm, print only:");
    expect(release).not.toMatch(/\bnpm (?:beta|publication|publish)\b/iu);
    expect(release).toContain(
      "GitHub prerelease exact bytes\n-> signed beta channel advancement from those exact bytes\n-> PUBLIC0 readback",
    );
    expect(await exists(".github/workflows/install-smoke.yml")).toBe(false);
    expect(await exists("scripts/test-install-sh-docker.sh")).toBe(false);
    expect(await exists("scripts/test-install-sh-e2e-docker.sh")).toBe(false);
    expect(await exists("scripts/docker/install-sh-smoke")).toBe(false);
    expect(await exists("scripts/docker/install-sh-e2e")).toBe(false);
    expect(await exists("scripts/docker/install-sh-nonroot")).toBe(false);
    expect(rootPackage.scripts?.["test:install:smoke"]).toBeUndefined();
    expect(rootPackage.scripts?.["test:install:e2e"]).toBeUndefined();
    expect(rootPackage.scripts?.["test:install:e2e:anthropic"]).toBeUndefined();
    expect(rootPackage.scripts?.["test:install:e2e:openai"]).toBeUndefined();
  });

  it("executes one owner-authorized fix and release chain", async () => {
    const skill = await source("docs/maintainers/codex-skills/fased-release-manager/SKILL.md");
    const release = await source(
      "docs/maintainers/codex-skills/fased-release-manager/references/release.md",
    );
    const lifecycle = await source(
      "docs/maintainers/codex-skills/fased-release-manager/references/lifecycle.md",
    );
    const redesign = await source(
      "docs/maintainers/codex-skills/fased-release-manager/references/lifecycle-redesign.md",
    );

    expect(skill).toContain("Treat “fix and release” as one conditional authorization:");
    expect(skill).toContain("the fix, and its nearest focused regression in the same protected PR");
    expect(skill).toContain("Do not add a full-package rerun after the focused predicate passes.");
    expect(skill).toMatch(/under ten minutes when GitHub infrastructure is\s+responsive/u);
    expect(skill).toContain("must not add a second environment-review pause");
    expect(skill).toContain(
      "Exercise adjacent durable transitions once; never publish first-error patches.",
    );
    expect(skill).toMatch(/Fresh Local and Hosting checks are owner-initiated after publication/u);
    expect(lifecycle).toContain("`hosting-container`");
    expect(lifecycle).toContain("`hosting-staging-vps`");
    expect(lifecycle).toContain("`hosting-public-vps`");
    expect(lifecycle).toMatch(
      /Do not synthesize an interrupted phase by editing\s+a successfully\s+committed receipt/u,
    );
    expect(skill).toContain(
      "Metadata-only promotion resumes an already published release without rebuilding.",
    );
    expect(release).toMatch(/builds one Linux-x64 core\s+artifact/u);
    expect(release).toContain("one tag-bound release workflow");
    expect(release).toContain("Do not merge a release-authorized product fix");
    expect(release).toContain("parallel signer/lifecycle compilation remain");
    expect(release).toMatch(/actual `GITHUB_REF` equal to\s+`refs\/tags\/v<version>`/u);
    expect(release).toMatch(/fix the reported predicate\s+in one new protected PR/u);
    expect(redesign).toContain("release workflow starts");
  });

  it("continues the exact authorized chain without repeated approval", async () => {
    const skill = await source("docs/maintainers/codex-skills/fased-release-manager/SKILL.md");

    expect(skill).toContain("The newest owner plan controls;");
    expect(skill).toContain("superseded plans are evidence only.");
    expect(skill).toContain(
      "Continue through those steps without requesting the same authority again.",
    );
    expect(skill).toContain("A request for a fix without release");
    expect(skill).toContain("authority ends after the protected merge.");
    expect(skill).toContain("superseded plans are evidence only.");
  });
});
