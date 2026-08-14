import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const install = read("../install.sh");
const networkAdmin = read("./fased-signer-network-hosting.sh");
const onboardingHostSecurity = read("../src/wizard/onboarding.host-security.ts");
const targetAdapter = read("../tools/fased-lifecycled/platform/target_adapter.go");
const networkPolicy = read("../tools/fased-lifecycled/platform/network_policy.go");
const bootstrap = read("../tools/fased-lifecycled/cmd/fased-bootstrap/main.go");
const bootstrapRoute = read("../tools/fased-lifecycled/cmd/fased-bootstrap/route.go");

describe("hosted signer security boundary", () => {
  it("enters privileged Hosting setup only through an immutable attested Go bundle", () => {
    expect(install).toContain('bootstrap_asset="fased-bootstrap-linux-${arch}"');
    expect(install).toContain("curl_args=(-fL --proto '=https' --tlsv1.2");
    expect(install).toContain('if [[ "$verbose" -eq 0 ]]; then curl_args+=(-sS); fi');
    expect(install).toContain("--proto '=https' --tlsv1.2");
    expect(install).toContain('[[ "$actual_sha256" == "$bootstrap_sha256" ]]');
    expect(install).toContain('install -m 0555 "$download" "$bootstrap"');
    expect(install).toContain('"${root_command[@]}" "$bootstrap" "${bootstrap_args[@]}"');
    expect(bootstrap).toContain("trust.VerifyInitialRoot");
    expect(bootstrap).toContain("trust.VerifyRootRotation");
    expect(bootstrap).toContain("trust.VerifyAttestedReleaseIndex");
    expect(bootstrapRoute).toMatch(
      /productionReleaseBase\s*=\s*"https:\/\/github\.com\/fased-ai\/fased\/releases\/download"/u,
    );
    expect(bootstrapRoute).toContain("fased-release-index-v1.json.attestation.json");
    expect(bootstrapRoute).not.toContain("updates.fased.ai");
    expect(bootstrapRoute).not.toContain("delegation.json");
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
    expect(bootstrapRoute).toContain("public lifecycle operation requires root authorization");
    expect(bootstrapRoute).toContain("invokeLifecycleHost");
    expect(bootstrapRoute).toContain("FASED_HOST_ROOT_PREPARED=1");
  });

  it("uses the root-verified Tailscale route without a Node startup owner", () => {
    expect(networkPolicy).toContain("Tailscale binary must use a fixed system path");
    expect(networkPolicy).toContain("Tailscale is not ready");
    expect(targetAdapter).toContain("Environment=FASED_HOST_PROFILE=%s");
    expect(targetAdapter).toContain("Environment=FASED_RUNTIME_SOURCE=go-lifecycle");
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
