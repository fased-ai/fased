import fs from "node:fs";
import { describe, expect, it } from "vitest";

const install = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const managed = fs.readFileSync(new URL("./start-managed.sh", import.meta.url), "utf8");
const networkAdmin = fs.readFileSync(
  new URL("./fased-signer-network-hosting.sh", import.meta.url),
  "utf8",
);
const onboardingHostSecurity = fs.readFileSync(
  new URL("../src/wizard/onboarding.host-security.ts", import.meta.url),
  "utf8",
);

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("hosted signer security boundary", () => {
  it("enters privileged Hosting setup only through an immutable attested release bundle", () => {
    expect(install).toContain("VPS Hosting requires an explicit tagged release");
    expect(install).toContain('gh attestation verify "$archive"');
    expect(install).toContain('--source-ref "refs/tags/v${release_version}"');
    expect(install).toContain("/var/lib/fased-installer/install.lock");
    expect(install).toContain("flock -x 9");
    expect(install).toContain('local root_store="${release_parent}/${actual}"');
    expect(install).toContain(
      "Refusing privileged Hosting setup from an unverified or caller-owned source tree",
    );
    expect(install).toContain("Refusing privileged Hosting setup from a Git checkout");
    expect(install).toContain("! -user root -o -perm /022");
    expect(install).toContain("! -type f ! -type d");
    expect(install).toContain("-type f -links +1");
    expect(install).toContain(
      "printf 'version=%s\\nsha256=%s\\nrelease_manifest_sha256=%s\\ncommit=%s\\n'",
    );
    expect(install).toContain('tagged_head" == "$attested_commit');
    expect(install).toContain('tagged_package_version" == "$HOSTING_RELEASE');
    expect(install).not.toContain('tagged_head" == "$expected_tag_head');
    expect(install).not.toContain('rm -rf -- "$root_store"');
  });

  it("never grants the Gateway sudo or an app-visible root control socket", () => {
    const rootFlow = sliceBetween(
      install,
      'if [[ "$(id -u)" -eq 0 ]]; then\n  assert_verified_hosting_root_source',
      'if [[ ! -f "$FASED_DIR/package.json"',
    );
    expect(rootFlow).toContain("ensure_host_boundary_accounts");
    expect(rootFlow).toContain("install_host_signer_and_updater_services");
    expect(rootFlow).toContain("migrate_legacy_hosted_signer_if_needed");
    expect(rootFlow).not.toContain("start_host_bootstrap_channel");
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
    expect(install).not.toContain("FASED_HOST_BOOTSTRAP_CTL=");
    expect(install).not.toContain("FASED_HOST_BOOTSTRAP_SOCKET=");
    expect(install).not.toContain("node /usr/local/libexec/fased-host-bootstrapd.mjs");
    expect(install).toContain("FASED_HOST_ROOT_PREPARED=1");
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

  it("never imports legacy wallet key material from signer.env into managed startup", () => {
    const envLoader = sliceBetween(
      managed,
      "load_wallet_signer_env_file()",
      "clear_legacy_wallet_key_env()",
    );
    expect(envLoader).not.toContain("grep -E '^export FASED_WALLET_' \"$SIGNERD_ENV_FILE\"");
    expect(envLoader).toContain("SOLANA_RPC_URL");
    expect(envLoader).toContain("LOCAL_SIGNER_(SOCKET|");
    expect(envLoader).toContain("CONTROL_SOCKET");
    expect(envLoader).toContain("STATE_DB");
    expect(envLoader).toContain("MASTER_KEY");
    expect(envLoader).not.toContain("PASSPHRASE");
    expect(envLoader).not.toContain("PRIVATE_KEY");

    const legacyClear = sliceBetween(
      managed,
      "clear_legacy_wallet_key_env()",
      "resolve_wallet_chains_from_config()",
    );
    expect(legacyClear).toContain("FASED_WALLET_SOLANA_KEYSTORE_PATH__*");
    expect(legacyClear).toContain("FASED_WALLET_PASSPHRASE_FILE__*");
    expect(legacyClear).toContain("FASED_WALLET_PRIVATE_KEY__*");
    expect(legacyClear).toContain("FASED_WALLET_MNEMONIC__*");
    expect(managed).toMatch(
      /load_wallet_signer_env_file\s+clear_legacy_wallet_key_env\s+SIGNERD_BIN=/,
    );
  });

  it("keeps hosted Tailscale administration in the provider-console root phase", () => {
    expect(install).not.toContain("tailscale-set-operator-self");
    expect(install).not.toContain("tailscale set --operator");
    expect(managed).toContain(
      '[[ "${FASED_TAILSCALE_AUTO_SERVE:-1}" == "1" && "${FASED_HOST_PROFILE:-}" != "hosting" ]]',
    );
    expect(install).toContain("prepare_hosting_root_prerequisites");
    expect(install).toContain("tailnetSshConfirmed=true");
    expect(onboardingHostSecurity).not.toContain("fased-host-maintenance");
    expect(onboardingHostSecurity).not.toContain("tailscale up");
    expect(onboardingHostSecurity).not.toContain("tailscale set");
    expect(onboardingHostSecurity).not.toContain("firewall-cmd");
    expect(onboardingHostSecurity).not.toContain("systemctl enable");
    expect(onboardingHostSecurity).not.toContain("systemctl restart");
    expect(onboardingHostSecurity).toContain('probe("sudo", ["-n", "true"])');
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

  it("keeps hosted network activation root-only and stdin-bound", () => {
    expect(networkAdmin).toContain('if [[ "${EUID}" != "0" ]]');
    expect(networkAdmin).toContain("--network-file");
    expect(networkAdmin).toContain('file_owner" == "0"');
    expect(networkAdmin).toContain('"$socket_mode" == "600"');
    expect(networkAdmin).toContain('printf \'%s\\n\' "$request" | "${common[@]}" put');
    expect(networkAdmin).not.toContain("FASED_HOST_BOOTSTRAP");
  });

  it("moves legacy custody migration into the verified native signer binary", () => {
    const prepare = sliceBetween(
      install,
      "migrate_legacy_hosted_signer_if_needed()",
      "finalize_legacy_hosted_signer_migration()",
    );
    const commit = sliceBetween(
      install,
      "finalize_legacy_hosted_signer_migration()",
      "assert_verified_hosting_root_source()",
    );
    for (const phase of [prepare, commit]) {
      expect(phase).toContain("/opt/fased/signer/fased-signerd admin migration hosted-v1");
      expect(phase).toContain("--control-socket /run/fased-signerd/control.sock");
      expect(phase).toContain("--state-dir /var/lib/fased-signerd");
      expect(phase).toContain('--marker-file "$marker_file"');
      expect(phase).not.toContain("node /usr/local/libexec/migrate-hosted-signer-v2.mjs");
      expect(phase).not.toContain("FASED_DEFER_LEGACY_QUARANTINE");
    }
    expect(prepare).toContain("--phase prepare");
    expect(commit).toContain("--phase commit");
    expect(commit).toContain('[[ "${#legacy_keystores[@]}" -gt 0 || -f "$marker_file" ]]');
  });
});
