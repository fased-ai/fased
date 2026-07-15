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
      "elif ! refresh_existing_local_gateway_service_after_install",
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
});
