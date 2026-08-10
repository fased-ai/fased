import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const install = read("../install.sh");
const managed = read("./start-managed.sh");
const networkAdmin = read("./fased-signer-network-hosting.sh");
const onboardingHostSecurity = read("../src/wizard/onboarding.host-security.ts");
const targetAdapter = read("../tools/fased-lifecycled/platform/target_adapter.go");
const networkPolicy = read("../tools/fased-lifecycled/platform/network_policy.go");

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("hosted signer security boundary", () => {
  it("enters privileged Hosting setup only through an immutable attested Go bundle", () => {
    expect(install).toContain("bootstrap_hosting_attested_bundle()");
    expect(install).toContain("verify_release_attestation_source()");
    expect(install).toContain('--source-ref "refs/tags/v${release_version}"');
    expect(install).not.toContain('--source-ref "refs/heads/main"');
    expect(install).toContain("root_owned_bundle_tree_is_secure()");
    expect(install).toContain('enter_go_lifecycle_bundle "$root_store"');
    expect(install).toContain("/var/lib/fased-installer/install.lock");
    expect(install).toContain("flock -x 9");
    expect(install).toContain('local root_store="${release_parent}/${actual}"');
    expect(install).not.toContain("install_host_signer_and_updater_services()");
    expect(install).not.toContain("migrate_legacy_hosted_signer_if_needed()");
    expect(install).not.toContain("fased-host-updater.mjs");
  });

  it("never grants broad Gateway sudo or restores a JavaScript root controller", () => {
    expect(install).not.toContain("NOPASSWD:");
    expect(install).not.toContain("install_host_maintenance_sudoers()");
    expect(install).not.toContain("FASED_HOST_BOOTSTRAP_SOCKET=");
    expect(install).not.toContain("node /usr/local/libexec/fased-host-bootstrapd.mjs");
    expect(install).not.toContain("fased-lifecycle-supervisor.mjs");
    expect(install).toContain("FASED_HOST_ROOT_PREPARED=1");
    expect(install).toContain("/opt/fased/lifecycle/supervisor-v1/fased-lifecycled request");
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
    const hostedBranch = sliceBetween(
      startup,
      'if [[ "${FASED_HOST_PROFILE:-}" == "hosting" || "${FASED_PROTECTED_LOCAL:-0}" == "1" ]]',
      "elif should_start_signerd",
    );
    expect(hostedBranch).not.toContain("start_signerd_process");
    expect(hostedBranch).not.toContain("start_signer_broker");
  });

  it("uses the root-verified Tailscale route without installing a zrok tunnel", () => {
    expect(managed).toContain('if [[ "${FASED_HOST_PROFILE:-}" == "hosting" ]]');
    expect(managed).toContain(
      "Hosting uses its root-verified private Tailscale Serve route; no zrok tunnel is started.",
    );
    expect(networkPolicy).toContain("Tailscale binary must use a fixed system path");
    expect(networkPolicy).toContain("Tailscale is not ready");
  });

  it("never imports legacy wallet key material into managed startup", () => {
    const envLoader = sliceBetween(
      managed,
      "load_wallet_signer_env_file()",
      "clear_legacy_wallet_key_env()",
    );
    expect(envLoader).not.toContain("grep -E '^export FASED_WALLET_' \"$SIGNERD_ENV_FILE\"");
    expect(envLoader).not.toContain("PASSPHRASE");
    expect(envLoader).not.toContain("PRIVATE_KEY");
    expect(managed).toContain("FASED_WALLET_SOLANA_KEYSTORE_PATH__*");
    expect(managed).toContain("FASED_WALLET_MNEMONIC__*");
  });

  it("keeps hosted network activation root-only and stdin-bound", () => {
    expect(networkAdmin).toContain('if [[ "${EUID}" != "0" ]]');
    expect(networkAdmin).toContain("--network-file");
    expect(networkAdmin).toContain('file_owner" == "0"');
    expect(networkAdmin).toContain('"$socket_mode" == "600"');
    expect(networkAdmin).toContain('printf \'%s\\n\' "$request" | "${common[@]}" put');
    expect(onboardingHostSecurity).not.toContain("tailscale up");
    expect(onboardingHostSecurity).not.toContain("tailscale set");
    expect(onboardingHostSecurity).not.toContain("firewall-cmd");
  });

  it("renders signer and Gateway authority from the Go Hosting adapter", () => {
    expect(targetAdapter).toContain("-operator-socket %s -control-socket %s");
    expect(targetAdapter).toContain("-application-uid %d -operator-uid %d -control-uid %d");
    expect(targetAdapter).toContain("-state-db %s/state.db -master-key %s/master.key");
    expect(targetAdapter).toContain("NoNewPrivileges=true");
    expect(targetAdapter).toContain("ProtectSystem=strict");
    expect(targetAdapter).toContain('return "hosting"');
  });

  it("keeps legacy custody helpers out of the public installer", () => {
    expect(install).not.toContain("fased-signer-wallet-import-hosting.sh");
    expect(install).not.toContain("migrate-hosted-signer-v2.mjs");
    expect(install).not.toContain("hosted-legacy-wallet-migration.mjs");
    expect(install).not.toContain("fased-host-updaterctl.mjs");
  });
});
