import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const deletedLifecycleOwners = [
  "scripts/protected-local-bootstrap.mjs",
  "scripts/protected-local-layout.mjs",
  "scripts/protected-local-service-plan.mjs",
  "scripts/fased-lifecycle-supervisor.mjs",
  "scripts/fased-host-updater.mjs",
  "scripts/fased-host-updaterctl.mjs",
  "scripts/lifecycle-control-normalizer.mjs",
  "scripts/fased-managed-updater-core.mjs",
  "scripts/install-managed-runtime.mjs",
  "scripts/install-hosted-runtime.sh",
  "scripts/install-runtime-profile.sh",
  "scripts/managed-update-contract.mjs",
  "scripts/fased-generation-updater-core.mjs",
  "scripts/generation-updater.mjs",
] as const;

const mutationOwners = deletedLifecycleOwners;

const deletedD9Surfaces = [
  "tools/fased-lifecycled/candidate/verify.go",
  "tools/fased-lifecycled/controller/controller.go",
  "tools/fased-lifecycled/platform/controller_adapter.go",
  "tools/fased-lifecycled/platform/shared_state_store.go",
  "scripts/docker/hosting-systemd/go-cutover.sh",
  "scripts/docker/protected-local-systemd/run.sh",
  "scripts/test-go-hosting-systemd-container.sh",
  "scripts/test-protected-local-systemd-container.sh",
  ".github/workflows/candidate-p1-retry.yml",
  "config/lifecycle-acceptance.v1.json",
] as const;

const productionRoutingSurfaces = [
  "package.json",
  "src/cli/update-cli/update-command.ts",
  "scripts/fased-managed-updater.mjs",
  "scripts/managed-updater-bundle.v1.json",
  "scripts/build-lifecycle-trust-metadata.mjs",
  "scripts/privileged-release-evidence.mjs",
  "scripts/release-check.ts",
  ".github/workflows/hosted-runtime-release.yml",
] as const;

const legacyMutationSymbols = [
  "bootstrap_protected_local_topology",
  "ensure_host_boundary_accounts",
  "prepare_fresh_hosting_application_boundary",
  "reconcile_hosting_shared_state",
  "install_host_signer_and_updater_services",
  "migrate_legacy_hosted_signer_if_needed",
  "initialize_hosting_generation_lifecycle",
  "updateManagedRuntime",
  "runLocalSignerTransaction",
  "runHostedTransactionControl",
] as const;

const callerOwnedIdentityFlags = [
  "--operator-uid",
  "--operator-gid",
  "--gateway-uid",
  "--gateway-gid",
  "--signer-uid",
  "--signer-gid",
] as const;

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

describe("single Go lifecycle production routing", () => {
  it("physically removes every superseded lifecycle owner and route", async () => {
    const remaining = [];
    for (const relativePath of [...deletedLifecycleOwners, ...deletedD9Surfaces]) {
      if (await exists(relativePath)) {
        remaining.push(relativePath);
      }
    }
    expect(remaining, `superseded lifecycle owners remain:\n${remaining.join("\n")}`).toEqual([]);
  });

  it("removes old lifecycle owners and mutation decisions from production routing", async () => {
    const violations: string[] = [];
    for (const relativePath of productionRoutingSurfaces) {
      const source = await readFile(resolve(repoRoot, relativePath), "utf8");
      for (const owner of mutationOwners) {
        const basename = owner.split("/").at(-1);
        if (basename && source.includes(basename)) {
          violations.push(`${relativePath}: references ${basename}`);
        }
      }
      for (const symbol of legacyMutationSymbols) {
        const calls = source
          .split("\n")
          .filter(
            (line) => line.includes(`${symbol}(`) && !line.match(/^\s*(?:async\s+)?function\s+/u),
          );
        if (calls.length > 0) {
          violations.push(`${relativePath}: invokes ${symbol}`);
        }
      }
    }
    const installer = await readFile(resolve(repoRoot, "install.sh"), "utf8");
    if (!installer.includes("fased-bootstrap-linux-${arch}")) {
      violations.push("install.sh: public route does not acquire the static lifecycle bootstrap");
    }
    if (!installer.includes('"$bootstrap" "${bootstrap_args[@]}"')) {
      violations.push("install.sh: public route does not invoke the fixed bootstrap client");
    }
    if (installer.includes("generation-updater.mjs")) {
      violations.push("install.sh: public route still invokes the Node generation updater");
    }
    for (const owner of mutationOwners) {
      const basename = owner.split("/").at(-1);
      if (basename && installer.includes(basename)) {
        violations.push(`install.sh: verified root entry invokes ${basename}`);
      }
    }
    if (
      installer.includes('exec bash "$existing_root/install.sh"') ||
      installer.includes('exec bash "$final_root/install.sh"')
    ) {
      violations.push(
        "install.sh: verified bundle recursively re-enters the legacy root installer",
      );
    }
    expect(violations, `old lifecycle production routes remain:\n${violations.join("\n")}`).toEqual(
      [],
    );
  });

  it("requires Go-owned service identities during public initialization", async () => {
    const violations: string[] = [];
    for (const relativePath of ["tools/fased-lifecycled/cmd/fased-lifecycled/main.go"]) {
      const source = await readFile(resolve(repoRoot, relativePath), "utf8");
      for (const flag of callerOwnedIdentityFlags) {
        if (source.includes(flag)) {
          violations.push(`${relativePath}: accepts ${flag}`);
        }
      }
    }
    const installer = await readFile(resolve(repoRoot, "install.sh"), "utf8");
    for (const flag of callerOwnedIdentityFlags) {
      if (installer.includes(flag)) {
        violations.push(`install.sh: verified Go entry accepts ${flag}`);
      }
    }
    expect(
      violations,
      `public initialization still accepts caller-owned service identities:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the missing-tool bootstrap transport independent of jq", async () => {
    const runner = await readFile(
      resolve(repoRoot, "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh"),
      "utf8",
    );
    const start = runner.indexOf("cat >/usr/local/bin/curl <<'EOF_FIXTURE_CURL'");
    const end = runner.indexOf("\nEOF_FIXTURE_CURL", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(runner.slice(start, end)).not.toContain("/usr/bin/jq");
  });
});
