import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");

describe("managed installer release pinning", () => {
  it("permits fresh stable or exact-release streamed Hosting and retains exact-tag repair", () => {
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 1 && "$install_entry_hosting" -eq 1 ]]',
    );
    expect(installer).toContain(
      "Streamed VPS Hosting accepts only the public one-command selector:",
    );
    expect(installer).toContain(
      "--hosting --release vX.Y.Z[-prerelease] --update-channel stable|beta",
    );
    expect(installer).toContain(
      "The same selector installs fresh or repairs an interrupted/completed installation",
    );
    expect(installer).toContain("Refusing Fased environment overrides during streamed VPS Hosting");
    expect(installer).toContain(
      'if [[ "$hosting_bootstrap" -eq 1 && "$hosting_repair_bootstrap" -eq 0 && -z "$hosting_release" ]]',
    );
    expect(installer).not.toContain("Refusing streamed VPS Hosting repair");
    expect(installer).toContain('hosting_release="latest"');
    expect(installer).toContain("bootstrap_hosting_attested_bundle");
    expect(installer).toContain('gh attestation verify "$release_manifest"');
    expect(installer).toContain('--bundle "$release_manifest_bundle"');
    expect(installer).toContain('"$actual" != "$expected"');
    expect(installer).toContain('"$dependency_actual" != "$dependency_expected"');
    expect(installer).toContain('"$signer_actual" != "$signer_expected"');
  });

  it("resolves a streamed fresh Local install to one stable release before cloning source", () => {
    const localReleaseStart = installer.indexOf(
      'if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]',
    );
    const localReleaseEnd = installer.indexOf("\n  fi\n", localReleaseStart);
    const localReleaseResolver = installer.slice(localReleaseStart, localReleaseEnd);

    expect(installer).toContain('if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]');
    expect(installer).toContain("resolve_public_latest_release_tag");
    expect(installer).not.toContain("gh release view --repo fased-ai/fased");
    expect(installer).toContain("install_current_github_cli_bootstrap");
    expect(localReleaseStart).toBeGreaterThanOrEqual(0);
    expect(localReleaseEnd).toBeGreaterThan(localReleaseStart);
    expect(localReleaseResolver).not.toContain("apt-get");
    expect(installer).toContain('hosting_release="$latest_local_tag"');
  });

  it("bootstraps a downloaded Local installer that has no packaged companion files", () => {
    expect(installer).toContain("install_entry_local_file_bootstrap=0");
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 0 && "$install_entry_hosting" -eq 0',
    );
    expect(installer).toContain(
      'if [[ ! -f "$install_entry_source_dir/scripts/install-runtime-profile.sh" ]]',
    );
    expect(installer).toContain("install_entry_local_file_bootstrap=1");
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 1 || "$install_entry_local_file_bootstrap" -eq 1',
    );
  });

  it("drains a streamed installer before replacing its pipe reader", () => {
    const functionStart = installer.indexOf("  exec_bootstrapped_installer() {");
    const functionEnd = installer.indexOf("\n\n  exec_bootstrapped_installer ", functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const handoffFunction = installer.slice(functionStart, functionEnd);
    expect(handoffFunction).toContain("cat >/dev/null");
    expect(handoffFunction).toContain('exec bash "$installer_path" "$@" < /dev/null');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-local-stream-handoff-"));
    try {
      const inner = path.join(tempRoot, "inner.sh");
      const harness = path.join(tempRoot, "harness.sh");
      fs.writeFileSync(
        inner,
        "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'handoff=%s\\n' \"$1\"\n",
        { mode: 0o700 },
      );
      fs.writeFileSync(
        harness,
        `#!/usr/bin/env bash
set -euo pipefail
install_entry_is_stream=1
${handoffFunction}
exec_bootstrapped_installer ${JSON.stringify(inner)} marker
`,
        { mode: 0o700 },
      );

      const result = spawnSync(
        "bash",
        [
          "-o",
          "pipefail",
          "-c",
          `dd if=/dev/zero bs=1048576 count=4 2>/dev/null | bash ${JSON.stringify(harness)}`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("handoff=marker");
      expect(result.stderr).not.toContain("Broken pipe");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults a normal checkout install to the Local managed runtime profile", () => {
    const start = installer.indexOf("resolved_host_profile() {");
    const end = installer.indexOf("\n}\n", start);
    const resolver = installer.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(resolver).toContain('if [[ -z "$profile" ]]');
    expect(resolver).toContain('profile="local"');
  });

  it("installs a dirty local checkout from source instead of replacing it with the published runtime", () => {
    expect(installer).toContain(
      'git -C "$FASED_DIR" status --porcelain=v1 --untracked-files=normal',
    );
    expect(installer).toContain(
      "local checkout has changes; building and installing this checkout",
    );
    expect(installer).toContain("DIRTY_CHECKOUT_SOURCE_AUTO_SELECTED=1");
    expect(installer).toContain('if [[ "$DIRTY_CHECKOUT_SOURCE_AUTO_SELECTED" -ne 1 ]]');
    expect(installer).toContain("SOURCE_INSTALL_REQUESTED=1");
  });

  it("binds an exact Local repair checkout to the attested unified manifest commit", () => {
    expect(installer).toContain('local_bootstrap_release="${hosting_release#v}"');
    expect(installer).toContain("fased-hosted-release-v2.json.attestation.json");
    expect(installer).toContain('local_bootstrap_commit="$(resolve_attested_local_release_commit');
    expect(installer).toContain(
      '"refs/tags/v${local_bootstrap_release}:refs/fased-installer/v${local_bootstrap_release}"',
    );
    expect(installer).toContain('if [[ "$fetched_release_commit" != "$local_bootstrap_commit" ]]');
    expect(installer).toContain(
      'git -C "$install_base_dir" checkout --detach "$local_bootstrap_commit"',
    );
    expect(installer).toContain('fetched_release_commit=""');
    expect(installer).not.toContain('local fetched_release_commit=""');
  });

  it("installs GitHub CLI attestation support before a macOS signer transaction", () => {
    expect(installer).toContain(
      'if use_prebuilt_release_runtime || [[ "$(uname -s)" == "Darwin" ]]; then',
    );
    expect(installer).toContain("install_github_cli_for_attestations");
  });

  it("pins the managed runtime package whenever an exact release was requested", () => {
    expect(installer).toContain('if [[ -n "$HOSTING_RELEASE" ]]; then');
    expect(installer).toContain('package_spec="@fased/fased@${HOSTING_RELEASE}"');
  });

  it("permits prerelease Hosting only through an explicit beta update channel", () => {
    expect(installer).toContain("Hosting prerelease installation requires --update-channel beta.");
    expect(installer).toContain("Local prerelease installation requires --update-channel beta.");
    expect(installer).toContain(
      'if [[ "$HOSTING_RELEASE" == *-* && "$UPDATE_CHANNEL" != "beta" ]]',
    );
    expect(installer).toContain("VPS Hosting prerelease setup requires --update-channel beta.");
    expect(installer).toContain("printf '%s\\n' \"$UPDATE_CHANNEL\"");
    expect(installer).toContain("/etc/fased/host-updater-channel");
    expect(installer).toContain(
      'if [[ "$UPDATE_CHANNEL_EXPLICIT" -ne 1 && "$HOSTING_REQUESTED" -ne 1 ]]',
    );
  });

  it("keeps update-channel persistence outside the install marker JSON", () => {
    const markerStart = installer.indexOf("write_install_marker() {");
    const markerEnd = installer.indexOf("\nEOF\n  chmod 600", markerStart);
    const channelFunction = installer.indexOf("persist_runtime_update_channel() {");

    expect(markerStart).toBeGreaterThanOrEqual(0);
    expect(markerEnd).toBeGreaterThan(markerStart);
    expect(channelFunction).toBeGreaterThan(markerEnd);
    expect(installer.slice(markerStart, markerEnd)).not.toContain("persist_runtime_update_channel");
  });

  it("does not downgrade shared Protected Local state after activation", () => {
    const permissionsStart = installer.indexOf("ensure_fased_config_dir_permissions() {");
    const permissionsEnd = installer.indexOf("\n}\n", permissionsStart);
    const markerStart = installer.indexOf("write_install_marker() {");
    const markerEnd = installer.indexOf("\n}\n", markerStart);
    const channelStart = installer.indexOf("persist_runtime_update_channel() {");
    const channelEnd = installer.indexOf("\n}\n", channelStart);
    const envStart = installer.indexOf("persist_managed_env_var() {");
    const envEnd = installer.indexOf("\n}\n", envStart);

    expect(permissionsStart).toBeGreaterThanOrEqual(0);
    expect(permissionsEnd).toBeGreaterThan(permissionsStart);
    const permissions = installer.slice(permissionsStart, permissionsEnd);
    expect(permissions).toContain("Fased shared state group mismatch");
    expect(permissions).toContain("Fased shared state mode mismatch");
    expect(permissions).toContain('if [[ "$actual_mode" != "2770" ]]');
    expect(permissions).not.toContain('chmod 2770 "$FASED_CONFIG_DIR"');

    const marker = installer.slice(markerStart, markerEnd);
    expect(marker).toContain("ensure_fased_config_dir_permissions");
    expect(marker).not.toContain('chmod 700 "$FASED_CONFIG_DIR"');

    const channel = installer.slice(channelStart, channelEnd);
    expect(channel).toContain("ensure_fased_config_dir_permissions");
    expect(channel).toContain('config_mode="$(managed_state_file_mode)"');
    expect(channel).toContain('CONFIG_MODE="$config_mode"');
    expect(channel).toContain('transaction_phase="${1:-active}"');
    expect(channel).toContain('transaction_phase" == "protected-local-pre-activation');

    const managedEnv = installer.slice(envStart, envEnd);
    expect(managedEnv).toContain("ensure_fased_config_dir_permissions");
    expect(managedEnv).toContain('env_mode="$(managed_state_file_mode)"');

    const protectedActivation = installer.indexOf("bootstrap_protected_local_topology activate");
    const preparedChannel = installer.lastIndexOf(
      "persist_runtime_update_channel protected-local-pre-activation",
      protectedActivation,
    );
    const finalMarker = installer.indexOf(
      'write_install_marker "$REPO_ROOT" "true"',
      protectedActivation,
    );
    expect(preparedChannel).toBeGreaterThanOrEqual(0);
    expect(preparedChannel).toBeLessThan(protectedActivation);
    expect(finalMarker).toBeGreaterThan(protectedActivation);
  });
});
