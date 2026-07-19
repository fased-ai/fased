import fs from "node:fs";
import { describe, expect, it } from "vitest";

const installer = fs.readFileSync(new URL("../install.sh", import.meta.url), "utf8");

describe("managed installer release pinning", () => {
  it("rejects streamed Hosting before selecting or downloading a release", () => {
    expect(installer).toContain("Refusing streamed VPS Hosting execution");
    expect(installer).not.toContain(
      'if [[ "$install_entry_is_stream" -eq 1 && "$hosting_bootstrap" -eq 1 && "$hosting_repair_bootstrap" -eq 0 && -z "$hosting_release" ]]',
    );
    expect(installer).toContain("bootstrap_hosting_attested_bundle");
    expect(installer).toContain('gh attestation verify "$release_manifest"');
    expect(installer).toContain('gh attestation verify "$archive"');
  });

  it("resolves a streamed fresh Local install to one stable release before cloning source", () => {
    expect(installer).toContain('if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]');
    expect(installer).toContain("resolve_public_latest_release_tag");
    expect(installer).not.toContain("gh release view --repo fased-ai/fased");
    expect(installer).toContain("install_current_github_cli_bootstrap");
    expect(installer).not.toContain("run_as_root apt-get update\n      run_as_root env");
    expect(installer).toContain('hosting_release="$latest_local_tag"');
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
});
