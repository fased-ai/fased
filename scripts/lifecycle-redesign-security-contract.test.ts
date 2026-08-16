import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveNpmIntegrityDrift } from "../src/infra/npm-integrity.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

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

describe("stable lifecycle appliance security closure", () => {
  it("FSD-LIFE-001 never passes caller-owned archive paths across the root boundary", async () => {
    const daemon = await source("tools/fased-lifecycled/cmd/fased-lifecycled/main.go");

    expect(await exists("scripts/generation-updater.mjs")).toBe(false);
    expect(await exists("tools/fased-lifecycled/candidate/verify.go")).toBe(false);
    expect(daemon).not.toContain('flag.NewFlagSet("stage"');
    expect(daemon).not.toContain("candidate.Verify(");
    expect(daemon).not.toContain("GitHubVerifier{Binary: githubCLI()}");
  });

  it("FSD-LIFE-002 binds monotonic release authority and explicit downgrade rejection", async () => {
    const model = await source("tools/fased-lifecycled/model/model.go");
    const planner = await source("tools/fased-lifecycled/planner/planner.go");

    expect(model).toContain("ReleaseSequence");
    expect(model).toContain("SecurityEpoch");
    expect(planner).toContain("ActionRejectDowngrade");
    expect(planner).toContain("RollbackAuthorization");
  });

  it("FSD-STATE-001 has no pre-quiesce SQLite sidecar exclusion", async () => {
    const target = await source("tools/fased-lifecycled/platform/target_adapter.go");
    const sharedState = await source("tools/fased-lifecycled/platform/typed_state_store.go");
    const statebind = await source("tools/fased-lifecycled/statebind/statebind.go");

    expect(target.indexOf("Predecessor.Quiesce")).toBeLessThan(
      target.indexOf("TypedState.Prepare"),
    );
    expect(await exists("tools/fased-lifecycled/platform/shared_state_store.go")).toBe(false);
    expect(sharedState).not.toContain("isTransientSQLiteSidecar");
    expect(statebind).not.toContain("IgnoreSQLiteTransient");
  });

  it("FSD-BOOT-001 has no dynamic Node or GitHub CLI bootstrap before Fased trust", async () => {
    const installer = await source("install.sh");

    expect(installer).not.toContain("install_root_controlled_bootstrap_node");
    expect(installer).not.toContain("install_current_github_cli_bootstrap");
    expect(installer).not.toContain("deb.nodesource.com/setup_");
    expect(installer).not.toContain("rpm.nodesource.com/setup_");
  });

  it("FSD-PLUGIN-001 separates executable plugin code from preserved mutable state", async () => {
    const statebind = await source("tools/fased-lifecycled/statebind/statebind.go");
    const discovery = await source("src/plugins/discovery.ts");
    const registry = await source("src/plugins/manifest-registry.ts");

    expect(statebind).not.toContain('owner("pluginState", "extensions")');
    expect(discovery).toContain("plugin-code");
    expect(discovery).toContain("plugin-data");
    expect(registry).not.toContain("duplicate plugin id detected; later plugin may be overridden");
  });

  it("FSD-PLUGIN-002 fails npm integrity drift closed without an explicit re-pin", async () => {
    const result = await resolveNpmIntegrityDrift({
      spec: "example-plugin@latest",
      expectedIntegrity: "sha512-old",
      resolution: { integrity: "sha512-new" },
      createPayload: (value) => value,
    });

    expect(result.proceed).toBe(false);
  });

  it("keeps core update separate from plugin-code update", async () => {
    const update = await source("src/cli/update-cli/update-command.ts");
    const discovery = await source("src/plugins/discovery.ts");

    expect(update).not.toContain("updatePluginsAfterCoreUpdate");
    expect(update).not.toContain("syncPluginsForUpdateChannel");
    expect(update).not.toContain("updateNpmInstalledPlugins");
    expect(update).not.toContain("installPluginFromNpmSpec");
    expect(discovery).toContain("install code through fased plugins update");
  });

  it("demolishes the candidate-controlled root target controller", async () => {
    const controllerAdapter = "tools/fased-lifecycled/platform/controller_adapter.go";
    const controller = "tools/fased-lifecycled/controller/controller.go";
    const identity = await source("tools/fased-lifecycled/model/model.go");

    expect(await exists(controllerAdapter)).toBe(false);
    expect(await exists(controller)).toBe(false);
    expect(await exists("tools/fased-lifecycled/cmd/fased-lifecycled/controller.go")).toBe(false);
    expect(identity).toContain("LegacyControllerPlatformIdentity");
    expect(identity).not.toContain("func NewControllerPlatformIdentity");
  });

  it("D9 exposes only archive-bound import and typed participant state", async () => {
    const daemon = await source("tools/fased-lifecycled/cmd/fased-lifecycled/main.go");
    const generationStore = await source("tools/fased-lifecycled/store/generation_store.go");
    const target = await source("tools/fased-lifecycled/platform/target_adapter.go");
    const typedState = await source("tools/fased-lifecycled/platform/typed_state_store.go");

    expect(daemon).not.toContain('args[0] == "apply"');
    expect(daemon).not.toContain('"--generation"');
    expect(daemon).not.toContain('"--generation-id"');
    expect(generationStore).not.toContain("func (s *Store) ImportGeneration(");
    expect(generationStore).toContain("func (s *Store) ImportGenerationArchive(");
    expect(target).not.toContain("SharedState");
    expect(typedState).not.toContain("SharedStateStore");
    expect(typedState).toContain("type TypedStateStore interface");
  });

  it("keeps application generations outside the privileged lifecycle host", async () => {
    const builder = await source("scripts/build-lifecycle-generation.mjs");
    const assembler = await source("scripts/assemble-lifecycle-generation.mjs");
    const workflow = await source(".github/workflows/hosted-runtime-release.yml");
    const supervisor = await source("tools/fased-lifecycled/platform/supervisor_unit.go");

    expect(builder).not.toContain('"lifecycled"');
    expect(builder).toContain('"inventory-tool"');
    expect(assembler).not.toContain('"--lifecycled"');
    expect(workflow).not.toContain('--lifecycled "$lifecycled"');
    expect(supervisor).toContain(
      'const StableLifecycleHostPath = "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled"',
    );
    expect(supervisor).toContain("func RenderSupervisorUnit(config Config)");
  });
});
