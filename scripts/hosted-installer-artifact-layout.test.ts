import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("package.json")) as { files?: string[] };
const files = new Set(manifest.files ?? []);
const installer = read("install.sh");
const releaseWorkflow = read(".github/workflows/hosted-runtime-release.yml");
const ciWorkflow = read(".github/workflows/ci.yml");
const hostingFixture = read("scripts/test-go-hosting-systemd-container.sh");
const hostingRunner = read("scripts/docker/hosting-systemd/go-cutover.sh");
const localRunner = read("scripts/docker/protected-local-systemd/run.sh");
const hostingUbuntu = read("scripts/docker/hosting-systemd/Containerfile.ubuntu");
const hostingRocky = read("scripts/docker/hosting-systemd/Containerfile.rocky");
const hostedArtifactBuilder = read("scripts/build-hosted-runtime-artifact.ts");

const removedMutationOwners = [
  "scripts/fased-managed-updater-core.mjs",
  "scripts/fased-host-updater.mjs",
  "scripts/fased-host-updaterctl.mjs",
  "scripts/fased-lifecycle-supervisor.mjs",
  "scripts/protected-local-bootstrap.mjs",
];

describe("attested Go lifecycle artifact layout", () => {
  it("ships only the acquisition wrappers needed by the public installer and updater", () => {
    expect(files).toContain("install.sh");
    expect(files).toContain("scripts/generation-updater.mjs");
    expect(files).toContain("scripts/fased-generation-updater-core.mjs");
    expect(files).toContain("scripts/privileged-release-evidence.mjs");
    for (const removed of removedMutationOwners) {
      expect(files).not.toContain(removed);
      expect(fs.existsSync(path.join(root, removed))).toBe(false);
    }
  });

  it("routes verified Local and Hosting installs into the same Go lifecycle engine", () => {
    expect(installer).toContain(
      'enter_go_lifecycle_bundle "$root_store" "$final_root" "$packaged_commit"',
    );
    expect(installer).toContain(
      '"$selected_package_root/scripts/generation-updater.mjs" initialize',
    );
    expect(installer).toContain('lifecycle_profile="protected-local"');
    expect(installer).toContain('lifecycle_profile="hosting"');
    expect(installer).toContain("--operation COMPLETE_ONBOARDING");
    expect(installer).not.toContain("initialize_hosting_generation_lifecycle");
  });

  it("binds the immutable candidate to Go lifecycle, signer, generation, and evidence assets", () => {
    expect(releaseWorkflow).toContain("fased-lifecycled-linux-${go_arch}");
    expect(releaseWorkflow).toContain("fased-signerd-release.attestation.json");
    expect(releaseWorkflow).toContain("fased-hosting-candidate.json.attestation.json");
    expect(releaseWorkflow).toContain("node scripts/assemble-lifecycle-generation.mjs");
    expect(releaseWorkflow).toContain("gh attestation verify");
  });

  it("builds once, runs packaged proof before the protected publication boundary, and publishes exact bytes", () => {
    const p1Jobs = [
      releaseWorkflow.indexOf("  p1-local-fresh:"),
      releaseWorkflow.indexOf("  p1-local-update:"),
      releaseWorkflow.indexOf("  p1-hosting:"),
    ];
    const publish = releaseWorkflow.indexOf("  publish:");
    const releaseCreate = releaseWorkflow.indexOf('gh release create "$RELEASE_TAG"');
    for (const p1 of p1Jobs) {
      expect(p1).toBeGreaterThan(0);
      expect(publish).toBeGreaterThan(p1);
    }
    expect(releaseCreate).toBeGreaterThan(publish);
    expect(releaseWorkflow.slice(publish)).not.toContain("pnpm build");
    expect(releaseWorkflow.slice(publish)).not.toContain("go build");
  });

  it("keeps the public Hosting proof on the Go-only systemd fixture", () => {
    expect(releaseWorkflow).toContain("scripts/test-go-hosting-systemd-container.sh");
    expect(releaseWorkflow).not.toContain("scripts/test-hosting-systemd-container.sh");
  });

  it("mounts immutable candidate bytes without a direct lifecycle-binary bypass", () => {
    expect(hostingFixture).toContain('-v "$ARTIFACT_DIR:/artifacts:ro,Z"');
    expect(hostingFixture).not.toContain("/fixture-bin");
    expect(hostingRunner).not.toContain('lifecycled="');
    expect(hostingRunner).toContain('bash "$candidate_installer"');
  });

  it("proves the exact stamped Hosting installer provisions Node on a clean host", () => {
    expect(hostingUbuntu).not.toContain("nodejs.org/dist");
    expect(hostingRocky).not.toContain("nodejs.org/dist");
    expect(hostingRunner).toContain('candidate_installer="/artifacts/install.sh"');
    expect(hostingRunner).toContain("! command -v node");
    expect(hostingRunner).toContain('require("node:sqlite")');
    const installCase = hostingRunner.slice(
      hostingRunner.indexOf("  install)"),
      hostingRunner.indexOf("  verify-reboot)"),
    );
    expect(installCase).toContain("install_release_transport_fixture");
    expect(installCase).toContain("run_public_installer");
    expect(installCase).toContain("assert_already_current_receipts /tmp/fased-hosting-noop.out");
    expect(hostingRunner).toContain("length == 2");
    expect(hostingRunner).toContain(".[0].version == $version");
    expect(hostingRunner).toContain('.[1].outcome == "ALREADY_CURRENT"');
    expect(installCase).not.toContain("initialize");
  });

  it("runs Local and Hosting lifecycle fixtures with a non-executable runtime mount", () => {
    const localFixture = fs.readFileSync(
      path.join(root, "scripts/test-protected-local-systemd-container.sh"),
      "utf8",
    );
    expect(localFixture).toContain("--tmpfs /run:rw,noexec");
    expect(localFixture).toContain(
      "FASED_FIXTURE_PREDECESSOR_BOOTSTRAP_RUN_EXEC=$MANAGED_PREDECESSOR_BOOTSTRAP_RUN_EXEC",
    );
    expect(localRunner).toContain("set_run_execution_policy exec");
    expect(localRunner).toContain("set_run_execution_policy noexec");
    expect(localRunner).toContain("run_mount_has_option noexec");
    expect(hostingFixture).toContain("--tmpfs /run:rw,noexec");
    expect(localRunner).toContain(
      'bridge_fault_root="/var/tmp/fased-fixture-bridge-gateway-fault-$$"',
    );
    expect(localRunner).toContain(
      'managed_fault_root="/var/tmp/fased-fixture-managed-gateway-fault-$$"',
    );
    expect(localRunner).not.toContain('fault_root="/run/');
  });

  it("keeps packaged CLI smoke output deterministic under Vitest", () => {
    expect(hostedArtifactBuilder).toContain('FASED_TEST_RUNTIME_LOG: "1"');
    expect(hostedArtifactBuilder).toContain('VITEST: ""');
    expect(hostedArtifactBuilder).toContain("stdoutHandle.fd");
    expect(hostedArtifactBuilder).toContain("stderrHandle.fd");
    expect(hostedArtifactBuilder).toContain('includes("No plugin issues detected.")');
  });

  it("does not route merged-main CI through the deleted legacy Hosting runner", () => {
    expect(ciWorkflow).not.toContain("scripts/test-streamed-hosting-bootstrap-container.sh");
    expect(
      fs.existsSync(path.join(root, "scripts/test-streamed-hosting-bootstrap-container.sh")),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(root, "scripts/docker/streamed-hosting-bootstrap/Dockerfile")),
    ).toBe(false);
  });
});
