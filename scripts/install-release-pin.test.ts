import fs from "node:fs";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");

describe("managed installer release pinning", () => {
  it("permits only fresh exact streamed Hosting and retains exact-tag repair", () => {
    expect(installer).toContain(
      'if [[ "$install_entry_is_stream" -eq 1 && "$install_entry_hosting" -eq 1 ]]',
    );
    expect(installer).toContain(
      "Streamed VPS Hosting accepts only the exact fresh-install selector: --hosting",
    );
    expect(installer).toContain("Streamed VPS Hosting is only for a fresh host");
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
    expect(installer).toContain('if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]');
    expect(installer).toContain("resolve_public_latest_release_tag");
    expect(installer).not.toContain("gh release view --repo fased-ai/fased");
    expect(installer).toContain("install_current_github_cli_bootstrap");
    expect(installer).not.toContain("run_as_root apt-get update\n      run_as_root env");
    expect(installer).toContain('hosting_release="$latest_local_tag"');
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
});
