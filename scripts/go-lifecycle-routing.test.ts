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
  "scripts/fased-generation-updater-core.mjs",
  "scripts/managed-update-contract.mjs",
] as const;

const productionRoutingSurfaces = [
  "install.sh",
  "package.json",
  "scripts/fased-managed-updater.mjs",
  "scripts/fased-managed-updater-core.mjs",
  "scripts/generation-updater.mjs",
  "scripts/managed-updater-bundle.v1.json",
  "scripts/build-lifecycle-trust-metadata.mjs",
  "scripts/privileged-release-evidence.mjs",
  "scripts/release-check.ts",
  "scripts/test-hosted-runtime-install.sh",
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
  it("physically removes every superseded lifecycle mutation owner", async () => {
    const remaining = [];
    for (const relativePath of deletedLifecycleOwners) {
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
      for (const owner of deletedLifecycleOwners) {
        const basename = owner.split("/").at(-1);
        if (basename && source.includes(basename)) {
          violations.push(`${relativePath}: references ${basename}`);
        }
      }
      for (const symbol of legacyMutationSymbols) {
        if (source.includes(symbol)) {
          violations.push(`${relativePath}: contains ${symbol}`);
        }
      }
    }
    expect(violations, `old lifecycle production routes remain:\n${violations.join("\n")}`).toEqual(
      [],
    );
  });

  it("requires Go-owned service identities during public initialization", async () => {
    const violations: string[] = [];
    for (const relativePath of [
      "install.sh",
      "scripts/generation-updater.mjs",
      "tools/fased-lifecycled/cmd/fased-lifecycled/main.go",
    ]) {
      const source = await readFile(resolve(repoRoot, relativePath), "utf8");
      for (const flag of callerOwnedIdentityFlags) {
        if (source.includes(flag)) {
          violations.push(`${relativePath}: accepts ${flag}`);
        }
      }
    }
    expect(
      violations,
      `public initialization still accepts caller-owned service identities:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
