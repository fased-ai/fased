import fs from "node:fs";
import { describe, expect, it } from "vitest";

const install = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const managed = fs.readFileSync(new URL("./start-managed.sh", import.meta.url), "utf8");

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("hosted signer security boundary", () => {
  it("never grants the Gateway sudo and uses only the temporary bootstrap during install", () => {
    const rootFlow = sliceBetween(
      install,
      'if [[ "$(id -u)" -eq 0 ]]; then\n  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then',
      'if [[ ! -f "$FASED_DIR/package.json"',
    );
    expect(rootFlow).toContain("ensure_host_boundary_accounts");
    expect(rootFlow).toContain("install_host_signer_and_updater_services");
    expect(rootFlow).toContain("migrate_legacy_hosted_signer_if_needed");
    expect(rootFlow).toContain("start_host_bootstrap_channel");
    expect(rootFlow).not.toContain("install_host_maintenance_sudoers");
    expect(rootFlow).not.toContain("install_host_signer_isolation_helper");
    expect(rootFlow).not.toContain("install_host_signer_maintenance_wrapper");

    const accountBoundary = sliceBetween(
      install,
      "ensure_host_boundary_accounts()",
      "install_host_signer_and_updater_services()",
    );
    expect(accountBoundary).toContain('gpasswd -d "$target_user" "$admin_group"');
    expect(accountBoundary).toContain("passwordless sudo");
    expect(accountBoundary).not.toContain("NOPASSWD");
    expect(install).not.toContain("install_host_maintenance_sudoers()");
    expect(install).not.toContain("install_host_signer_isolation_helper()");
    expect(install).not.toContain("install_host_signer_maintenance_wrapper()");
    expect(install).not.toContain("ensure_host_signer_isolation_user()");
    expect(install).not.toContain("NOPASSWD:");
    expect(install).toContain("/usr/local/sbin/fased-signer-isolation");
  });

  it("cold starts use the external system signer and never start a hosted broker", () => {
    const startup = sliceBetween(
      managed,
      "HOSTED_ROOT_SIGNER=0",
      'if [[ -f "$ZROK_MONITOR_PID_FILE" ]]',
    );
    expect(startup).toContain("HOSTED_ROOT_SIGNER=1");
    expect(startup).toContain('SIGNERD_SOCKET="/run/fased-signerd/app.sock"');
    expect(startup).toContain("elif should_start_signerd");
    expect(startup.indexOf("HOSTED_ROOT_SIGNER=1")).toBeLessThan(
      startup.indexOf("should_start_signerd"),
    );
    const hostedBranch = sliceBetween(
      startup,
      'if [[ "${FASED_HOST_PROFILE:-}" == "hosting" ]]',
      "elif should_start_signerd",
    );
    expect(hostedBranch).not.toContain("start_signerd_process");
    expect(hostedBranch).not.toContain("start_signer_broker");

    const cleanup = sliceBetween(
      managed,
      "cleanup_managed_runtime()",
      "trap cleanup_managed_runtime EXIT",
    );
    expect(cleanup).toContain('if [[ "${HOSTED_ROOT_SIGNER:-0}" != "1" ]]');
  });

  it("keeps hosted Tailscale administration in the temporary root bootstrap", () => {
    expect(install).not.toContain("tailscale-set-operator-self");
    expect(install).not.toContain("tailscale set --operator");
    expect(managed).toContain(
      '[[ "${FASED_TAILSCALE_AUTO_SERVE:-1}" == "1" && "${FASED_HOST_PROFILE:-}" != "hosting" ]]',
    );
  });

  it("installs a hardened external signer with only the application socket group shared", () => {
    const service = sliceBetween(
      install,
      "install_host_signer_and_updater_services()",
      "migrate_legacy_hosted_signer_if_needed()",
    );
    expect(service).toContain("SupplementaryGroups=${gateway_group}");
    expect(service).toContain("-socket /run/fased-signerd/app.sock");
    expect(service).toContain("-control-socket /run/fased-signerd/control.sock");
    expect(service).toContain("-state-db /var/lib/fased-signerd/state.db");
    expect(service).toContain("-update-gate /var/lib/fased-signer-update-gate/active");
    expect(service).toContain("/var/lib/fased-signer-update-gate");
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectSystem=strict");
  });
});
