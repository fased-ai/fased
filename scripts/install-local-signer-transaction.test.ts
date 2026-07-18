import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const signerInstaller = fs.readFileSync(
  path.join(root, "scripts", "install-fased-signerd.sh"),
  "utf8",
);
const updater = fs.readFileSync(path.join(root, "scripts", "fased-managed-updater.mjs"), "utf8");

describe("Local app/signer installer transaction", () => {
  it("prepares the matching signer and commits only after exact Gateway and signer health", () => {
    const prepare = installer.indexOf("prepare_existing_local_signer_after_runtime_install");
    const gatewayVerified = installer.lastIndexOf("GATEWAY_RUNTIME_HEALTH_VERIFIED=1");
    const signerVerified = installer.lastIndexOf("verify_local_signer_after_runtime_install");
    const commit = installer.lastIndexOf("commit_local_signer_after_runtime_install");

    expect(prepare).toBeGreaterThan(0);
    expect(installer).toContain('bash "$script" --version "$version" --defer-commit');
    expect(gatewayVerified).toBeGreaterThan(prepare);
    expect(signerVerified).toBeGreaterThan(gatewayVerified);
    expect(commit).toBeGreaterThan(signerVerified);
    expect(installer).toContain(
      "The matching Local signer remains read-only because exact Gateway health was not verified.",
    );
  });

  it("supports explicit verify/commit/rollback control without requiring Go", () => {
    expect(signerInstaller).toContain("--verify");
    expect(signerInstaller).toContain("--defer-commit");
    expect(signerInstaller).toContain("--rollback");
    expect(signerInstaller).toContain("--commit");
    expect(signerInstaller).not.toMatch(/\bgo build\b/);
  });

  it("keeps every pre-commit candidate read-only and promotes only after a durable commit", () => {
    expect(updater).toContain("startSignerProcess(preflightPaths, release.candidatePath, true)");
    expect(updater).toContain("startSignerProcess(paths, paths.binaryPath, true)");
    expect(updater).toContain("journal.candidateShouldRun");
    expect(updater).toContain(
      "Local signer has a durable commit decision; rollback is refused and recovery must finish forward",
    );
  });
});
