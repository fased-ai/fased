import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Local and WSL managed runtime migration", () => {
  const installer = fs.readFileSync(path.resolve(import.meta.dirname, "..", "install.sh"), "utf8");

  it("reconciles the installer-owned command only on the prebuilt runtime path", () => {
    const prebuiltStart = installer.indexOf("install_prebuilt_release_runtime() {");
    const prebuiltEnd = installer.indexOf("\n}\n", prebuiltStart);
    const prebuilt = installer.slice(prebuiltStart, prebuiltEnd);
    const sourceStart = installer.indexOf("install_fased_cli_launcher() {");
    const sourceEnd = installer.indexOf("\n}\n", sourceStart);
    const source = installer.slice(sourceStart, sourceEnd);

    expect(prebuilt).toContain("install-managed-cli-alias.mjs");
    expect(source).not.toContain("install-managed-cli-alias.mjs");
  });

  it("reinstalls an existing Local service before requesting its restart", () => {
    const branchStart = installer.lastIndexOf('if [[ "$RUN_ONBOARD" -eq 0 ]]');
    const refresh = installer.indexOf(
      "if ! refresh_existing_local_gateway_service_after_install",
      branchStart,
    );
    const restart = installer.indexOf(
      "if restart_existing_gateway_service_after_install",
      branchStart,
    );

    expect(refresh).toBeGreaterThan(branchStart);
    expect(restart).toBeGreaterThan(refresh);
    expect(installer).toContain('"$FASED_CLI_PATH" gateway install --force');
  });

  it("requires the refreshed Gateway identity to match the managed CLI", () => {
    expect(installer).toContain("verify_gateway_runtime_identity_after_install");
    expect(installer).toContain("verify-gateway-runtime-identity.mjs");
    expect(installer).toContain("Gateway restarted, but runtime identity verification failed.");
    expect(installer).toContain("rollback_managed_runtime_after_failed_install");
    expect(installer).toContain("--rollback");
  });

  it("verifies rollback without letting the restored legacy CLI rewrite its service", () => {
    const rollbackStart = installer.indexOf("rollback_managed_runtime_after_failed_install() {");
    const rollbackEnd = installer.indexOf("\n}\n", rollbackStart);
    const rollback = installer.slice(rollbackStart, rollbackEnd);

    expect(rollback).not.toContain('"$FASED_CLI_PATH" gateway install --force');
    expect(rollback).toContain("restart_existing_gateway_service_after_install");
    expect(rollback).toContain("wait_for_gateway_health_after_restart");
    expect(rollback).toContain("verify_gateway_runtime_identity_after_install");
    expect(rollback).toContain(
      "Managed runtime rollback did not restore the prior Gateway service.",
    );
    expect(rollback).not.toContain(
      "restart_existing_gateway_service_after_install >/dev/null 2>&1 || true",
    );
  });

  it("allows source-checkout identity only for an explicit source install", () => {
    expect(installer).toContain("if ! use_prebuilt_release_runtime; then");
    expect(installer).toContain("verify_args+=(--allow-source-checkout true)");
  });

  it("installs the repaired CLI without touching a pre-v2 wallet so native migration can run", () => {
    expect(installer).toContain("local_legacy_signer_material_detected");
    expect(installer).toContain("Pre-v2 Local wallet detected");
    expect(installer).toContain(
      "fased wallet setup --mode local-signer-import --wallet-id <wallet-id>",
    );
  });
});
