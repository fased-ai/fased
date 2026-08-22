import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("package.json")) as { files?: string[] };
const files = new Set(manifest.files ?? []);
const installer = read("install.sh");
const releaseWorkflow = read(".github/workflows/hosted-runtime-release.yml");
const preTagWorkflow = read(".github/workflows/pre-tag-p1.yml");
const ciWorkflow = read(".github/workflows/ci.yml");
const localFixture = read("scripts/test-lifecycle-local-acceptance.sh");
const hostingFixture = read("scripts/test-lifecycle-hosting-acceptance.sh");
const hostingRunner = read("scripts/docker/hosting-systemd/lifecycle-acceptance.sh");
const candidateTrustOverlay = read("scripts/prepare-candidate-fixture-trust.sh");
const candidateFinalizer = read("scripts/finalize-pretag-candidate.sh");
const localRunner = read("scripts/docker/protected-local-systemd/lifecycle-acceptance.sh");
const hostingUbuntu = read("scripts/docker/hosting-systemd/Containerfile.ubuntu");
const hostingRocky = read("scripts/docker/hosting-systemd/Containerfile.rocky");
const hostedArtifactBuilder = read("scripts/build-hosted-runtime-artifact.ts");
const componentPackBuild = 'pnpm --dir "$ROOT_DIR" hosted:component-packs';
const hostedReleaseManifestBuild = 'node "$ROOT_DIR/scripts/build-hosted-release-manifest.mjs"';

const removedMutationOwners = [
  "scripts/fased-managed-updater-core.mjs",
  "scripts/fased-host-updater.mjs",
  "scripts/fased-host-updaterctl.mjs",
  "scripts/fased-lifecycle-supervisor.mjs",
  "scripts/protected-local-bootstrap.mjs",
  "scripts/fased-managed-updater.mjs",
  "scripts/managed-updater-bundle.mjs",
  "scripts/managed-updater-bundle.v1.json",
  "scripts/fased-managed-launcher.sh",
  "src/infra/hosted-runtime-artifact.ts",
];

describe("attested Go lifecycle artifact layout", () => {
  it("allows fresh-core proof to skip optional packs without changing core bytes", () => {
    expect(localFixture).toContain(
      'BUILD_COMPONENT_PACKS="${FASED_SYSTEMD_FIXTURE_BUILD_COMPONENT_PACKS:-1}"',
    );
    expect(localFixture.indexOf(componentPackBuild)).toBeGreaterThan(0);
    expect(localFixture).toContain('if [[ "$BUILD_COMPONENT_PACKS" == "1" ]]');
    expect(localFixture.indexOf(hostedReleaseManifestBuild)).toBeGreaterThan(
      localFixture.indexOf(componentPackBuild),
    );
    expect(localFixture).toContain(
      'HOSTED_ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_HOSTED_ARTIFACT_DIR:-}"',
    );
    expect(localFixture).toContain('copy_verified_hosted_artifact "$HOSTED_ARTIFACT_DIR"');
    expect(localFixture).toContain(".dependencyCache.downloads == 0");
    expect(localFixture).toContain('.loadedPlugins == ["device-pair","memory-core","sat-mining"]');
    expect(localFixture).toContain("runtimeEvidence.dormantMiningImplementationLoaded == false");
  });

  it("ships only the acquisition wrappers needed by the public installer and updater", () => {
    expect(files).toContain("install.sh");
    expect(files).not.toContain("scripts/fased-managed-updater.mjs");
    expect(files).not.toContain("scripts/generation-updater.mjs");
    expect(files).not.toContain("scripts/fased-generation-updater-core.mjs");
    expect(files).toContain("scripts/privileged-release-evidence.mjs");
    for (const removed of removedMutationOwners) {
      expect(files).not.toContain(removed);
      expect(fs.existsSync(path.join(root, removed))).toBe(false);
    }
  });

  it("routes verified Local and Hosting installs into the same Go lifecycle engine", () => {
    expect(installer).toContain("fased-bootstrap-linux-${arch}");
    expect(installer).toContain('profile="protected-local"');
    expect(installer).toContain('profile="hosting"');
    expect(installer).toContain('"$bootstrap" "${bootstrap_args[@]}"');
    expect(installer).not.toContain("generation-updater.mjs");
    expect(installer).not.toContain("initialize_hosting_generation_lifecycle");
  });

  it("binds the immutable candidate to Go lifecycle, signer, generation, and evidence assets", () => {
    expect(releaseWorkflow).toContain("scripts/finalize-pretag-candidate.sh");
    expect(releaseWorkflow).toContain("fased-signerd-release.attestation.json");
    expect(releaseWorkflow).toContain("fased-hosting-candidate.json.attestation.json");
    expect(candidateFinalizer).toContain("fased-lifecycled-linux-amd64");
    expect(releaseWorkflow).toContain("gh attestation verify");
  });

  it("builds once, runs packaged proof before the protected publication boundary, and publishes exact bytes", () => {
    const p1Jobs = [
      preTagWorkflow.indexOf("  local-fresh:"),
      preTagWorkflow.indexOf("  local-update:"),
      preTagWorkflow.indexOf("  hosting:"),
    ];
    const finalize = releaseWorkflow.indexOf("  finalize-candidate:");
    const publish = releaseWorkflow.indexOf("  publish:");
    const releaseCreate = releaseWorkflow.indexOf('gh release create "$RELEASE_TAG"');
    for (const p1 of p1Jobs) {
      expect(p1).toBeGreaterThan(0);
    }
    expect(finalize).toBeGreaterThan(0);
    expect(publish).toBeGreaterThan(finalize);
    expect(releaseCreate).toBeGreaterThan(publish);
    expect(releaseWorkflow.slice(publish)).not.toContain("pnpm build");
    expect(releaseWorkflow.slice(publish)).not.toContain("go build");
  });

  it("keeps the public Hosting proof on the Go-only systemd fixture", () => {
    expect(preTagWorkflow).toContain("scripts/test-lifecycle-hosting-acceptance.sh");
    expect(preTagWorkflow).not.toContain("scripts/test-hosting-systemd-container.sh");
  });

  it("preserves the first failed Hosting fixture and supports serial diagnosis", () => {
    expect(hostingFixture).toContain("FASED_HOSTING_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS");
    expect(hostingFixture).toContain("FASED_HOSTING_SYSTEMD_FIXTURE_PRESERVE_FAILURE");
    expect(hostingFixture).toContain("FASED_HOSTING_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR");
    expect(hostingFixture).toContain("${distro}-${scenario}.partial.json");
    expect(hostingFixture).toContain('wait -n -p completed_pid "${scenario_pids[@]}"');
    expect(hostingFixture).toContain("FASED_LIFECYCLE_FIXTURE_START_LOCK");
    expect(hostingFixture).toContain('flock "$start_lock_fd"');
    expect(hostingFixture).toContain('exec {image_cache_lock_fd}>"${image_archive}.lock"');
    expect(hostingFixture).toContain("Preserved failed Hosting fixture support directory:");
    expect(hostingFixture).toContain("trap 'exit 143' TERM");
    expect(hostingFixture).toContain("Serial Hosting proof stopped on the first failed scenario.");
    expect(hostingFixture).toContain('lifecycle-acceptance.sh "$fixture_phase" || return 1');
    expect(hostingFixture).toContain('lifecycle-receipt-verifier.mjs" \\');
    expect(hostingFixture).toContain(
      "--acquisition-evidence-class SUPPORTING >/dev/null || return 1",
    );
    expect(hostingFixture).toContain(
      "Parallel Hosting proof stopped: distro=$failed_distro scenario=$failed_scenario container=$failed_name",
    );
  });

  it("preserves the exact Local partial receipt before retaining a failed fixture", () => {
    expect(localFixture).toContain("preserve_partial_receipt");
    expect(localFixture).toContain("${distro}-${scenario}.partial.json");
    expect(localFixture).toContain("preserved partial lifecycle receipt:");
  });

  it("mounts immutable candidate bytes without a direct lifecycle-binary bypass", () => {
    expect(hostingFixture).toContain('-v "$ARTIFACT_DIR:/artifacts:ro,Z"');
    expect(hostingFixture).not.toContain("/fixture-bin");
    expect(hostingRunner).not.toContain('lifecycled="');
    expect(hostingRunner).toContain('bash "$candidate_installer"');
  });

  it("does not nest dependency mounts below a read-only fixture mount", () => {
    for (const fixture of [localFixture, hostingFixture]) {
      expect(fixture).toContain('ln -s "$ROOT_DIR/node_modules"');
      expect(fixture).toContain(":$ROOT_DIR/node_modules:ro,");
      expect(fixture).not.toContain(":/fixture-tools/node_modules:ro,");
    }
    expect(hostingFixture).toContain(":/fixture-node:ro,");
    expect(hostingRunner).not.toContain("/fixture-tools/node");
  });

  it("binds the plugin compiler loader before artifact staging changes dependencies", () => {
    expect(hostedArtifactBuilder).toContain('const tsxLoader = import.meta.resolve("tsx")');
    expect(hostedArtifactBuilder).toContain('"--import",\n        tsxLoader');
    expect(hostedArtifactBuilder).not.toContain('"--import",\n        "tsx"');
  });

  it("emits only the generation application and dependency archives", () => {
    expect(hostedArtifactBuilder).toContain("fased-hosted-app-v2-linux-${arch}");
    expect(hostedArtifactBuilder).toContain("fased-hosted-deps-linux-${arch}");
    expect(hostedArtifactBuilder).not.toContain("fased-hosted-linux-${arch}");
    expect(hostedArtifactBuilder).not.toContain("legacyAppAssetName");
    expect(hostedArtifactBuilder).not.toContain("schemaVersion: 1, dependencyHash");
    expect(localRunner).not.toContain("fased-hosted-linux-x64");
    expect(localRunner).toContain('app_identity="/artifacts/fased-hosted-app-v2-linux-x64');
    expect(localRunner).toContain('tar -xzf "/artifacts/$app_asset"');
    expect(localRunner).toContain('tar -xzf "/artifacts/$dependency_asset"');
  });

  it("materializes the canonical supervisor only at the stable lifecycle path", () => {
    expect(localRunner).not.toContain("$generation_root/payload/bin/fased-lifecycled");
    expect(localRunner).toContain(
      'supervisor_path="/opt/fased/lifecycle/supervisor-v1/fased-lifecycled"',
    );
    expect(localRunner).toContain(
      'test "$(stat -c \'%U:%G:%a\' "$supervisor_path")" = "root:root:755"',
    );
  });

  it("keeps branch proof assets truthful and publishes only the retained x64 lane", () => {
    expect(localFixture).not.toContain("copy_branch_x64_fixture_aliases");
    expect(localFixture).not.toContain('cp --reflink=auto "$signer_source"');
    expect(localFixture).not.toContain('cp --reflink=auto "$ARTIFACT_DIR/$x64_app"');
    expect(localFixture).not.toContain("--profile branch-x64");
    expect(localFixture).toContain('"$PUBLIC_ACQUISITION" == "1" && "$BUILD_ONLY" == "0"');
    expect(releaseWorkflow).not.toContain("matrix.arch");
    expect(releaseWorkflow).not.toContain("ubuntu-24.04-arm");
    expect(releaseWorkflow).not.toContain("- arch: arm64");
  });

  it("finalizes only the exact pre-tag product bytes without rebuilding or replaying P1", () => {
    expect(candidateFinalizer).toContain("fased-candidate-original");
    expect(candidateFinalizer).toContain(".candidate.descriptorSha256 == $digest");
    expect(candidateFinalizer).toContain(".artifacts[]");
    expect(candidateFinalizer).toContain("fased-branch-*");
    expect(candidateFinalizer).toContain("privileged-release-evidence.mjs");
    expect(candidateFinalizer).toContain("build-lifecycle-release-index.mjs");
    expect(candidateFinalizer).toContain('lifecycle-release-compatibility.mjs" verify');
    expect(candidateFinalizer).toContain(
      '--manifest "$OUTPUT_DIR/fased-lifecycle-release-compatibility-v1.json"',
    );
    expect(candidateFinalizer).not.toContain('lifecycle-release-compatibility.mjs" build');
    expect(candidateFinalizer).not.toContain("pnpm build");
    expect(candidateFinalizer).not.toContain("hosted:artifact:from-dist");
    expect(candidateFinalizer).not.toContain("test-lifecycle-local-acceptance.sh");
    expect(candidateFinalizer).not.toContain("test-lifecycle-hosting-acceptance.sh");
  });

  it("builds independent native release families with bounded concurrency", () => {
    expect(releaseWorkflow).not.toContain("bash scripts/build-native-release-assets.sh");
    expect(releaseWorkflow).not.toContain(
      "bash scripts/release-fased-signerd.sh\n          bash scripts/release-fased-lifecycled.sh",
    );
    expect(localFixture).toContain('bash "$ROOT_DIR/scripts/build-native-release-assets.sh"');
  });

  it("binds replay trust to the exact immutable candidate inventory", () => {
    expect(candidateTrustOverlay).toContain("fased-candidate-fixture-trust-overlay");
    expect(candidateTrustOverlay).toContain("fased-candidate-original");
    expect(candidateTrustOverlay).toContain("fased-branch-trust");
    expect(candidateTrustOverlay).toContain("generation/inventory.json");
    expect(candidateTrustOverlay).toContain(".generation.artifactSetDigest");
    expect(candidateTrustOverlay).toContain("publishable:false");
    expect(candidateTrustOverlay).toContain("--architecture x64");
    expect(candidateTrustOverlay).toContain(
      'metadata_base="https://github.com/fased-ai/fased/releases/download/v${version}"',
    );
    expect(candidateTrustOverlay).toContain("fased-hosted-release-v2.json.attestation.json");
    expect(candidateTrustOverlay).toContain('"fixtureOfflineAttestation":true');
    expect(localFixture).toContain("fixture-artifact-compat");
    expect(localFixture).toContain('cp -a --reflink=auto "$ARTIFACT_DIR/."');
    expect(localFixture).toContain("fased-hosted-release-v2.json.attestation.json");
    expect(candidateTrustOverlay).not.toContain(
      'metadata_base="https://github.com/fased-ai/fased/releases/download/v${version}/lifecycle/v1"',
    );
    expect(localFixture).toContain(
      'fixture_metadata_base="https://github.com/fased-ai/fased/releases/download/v${VERSION}"',
    );
    expect(localFixture).not.toContain(
      'fixture_metadata_base="https://github.com/fased-ai/fased/releases/download/v${VERSION}/lifecycle/v1"',
    );
    for (const runner of [localRunner, hostingRunner]) {
      expect(runner).toContain('"fased-lifecycle-root-v1.json"');
      expect(runner).toContain('"fased-release-index-v1.json"');
      expect(runner).toContain('"fased-release-index-v1.json.attestation.json"');
      expect(runner).toContain("selectFixtureTrustAsset");
      expect(runner).not.toContain("/lifecycle/v1");
    }
    expect(localRunner).toContain("fs.existsSync(path.join(releaseAssets, branchAsset))");
    expect(localRunner).toContain("function handleGithubRequest(request, response)");
    expect(localRunner).toContain("function handleRpcRequest(request, response)");
    expect(localRunner).toContain("http.createServer(handleRpcRequest)");
    expect(localRunner).toContain("handleGithubRequest,");
    expect(localRunner).toContain(
      "fased-channel-${target_channel}-v1/fased-lifecycle-root-v2.json",
    );
    expect(localRunner).toContain("/tmp/fixture-absent-root-v2.json");
    expect(localRunner).toContain("/tmp/fixture-rpc-get.json");
    expect(hostingRunner).toContain("fs.existsSync(`/artifacts/${branchAsset}`)");
    expect(hostingRunner).toContain(String.raw`-f "/artifacts/\$branch_asset"`);
    expect(candidateTrustOverlay).not.toContain("gh release");
    expect(candidateTrustOverlay).not.toContain("git tag");
    expect(localFixture).toContain("FASED_SYSTEMD_FIXTURE_EXACT_CANDIDATE_REPLAY");
    expect(localFixture).toContain("Exact candidate replay rejected product changes:");
    expect(localFixture).toContain(
      "Exact candidate replay requires an unmodified candidate artifact directory.",
    );
    for (const fixture of [localFixture, hostingFixture]) {
      expect(fixture).toContain("fased-candidate-fixture-overlay.json");
      expect(fixture).toContain("fased-candidate-original/$name");
      expect(fixture).toContain("candidate_artifact_path");
    }
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
    expect(installCase).toContain('grep -F "Already current: $version"');
    expect(installCase).toContain("run_public_updater");
    expect(installCase).toContain("acceptance_finish");
    expect(hostingRunner).toContain("lifecycle-receipt-verifier.mjs");
    expect(installCase).not.toContain("initialize");
  });

  it("reproduces the exact interrupted legacy updater before Hosting convergence", () => {
    const legacyFixture = hostingRunner.slice(
      hostingRunner.indexOf("prepare_interrupted_legacy_updater_fixture()"),
      hostingRunner.indexOf("verify_sshd_runtime_prerequisites()"),
    );
    const installCase = hostingRunner.slice(
      hostingRunner.indexOf("  install)"),
      hostingRunner.indexOf("  managed-update)"),
    );
    expect(legacyFixture).toContain("Fased verified native signer updater");
    expect(legacyFixture).toContain(
      "ExecStart=/usr/bin/node /opt/fased/host-controller/current/fased-host-updater.mjs --socket-gid 995",
    );
    expect(legacyFixture).toContain("root:root:644:958");
    expect(legacyFixture).toContain("systemctl is-active --quiet fased-host-updater.service");
    expect(installCase.indexOf("prepare_interrupted_legacy_updater_fixture")).toBeLessThan(
      installCase.indexOf("run_public_installer"),
    );
    expect(installCase).toContain(
      "! grep -Fq '/opt/fased/host-controller/current/fased-host-updater.mjs'",
    );
  });

  it("runs Local and Hosting lifecycle fixtures with a non-executable runtime mount", () => {
    expect(localFixture).toContain("--tmpfs /run:rw,noexec");
    expect(localFixture).toContain("FASED_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_DIR");
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
    expect(hostedArtifactBuilder).toContain("pluginDoctorReport.ok !== true");
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
