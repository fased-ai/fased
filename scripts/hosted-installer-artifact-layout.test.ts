import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("package.json")) as { files?: string[] };
const files = new Set(manifest.files ?? []);
const installer = read("install.sh");
const builder = read("scripts/build-linux-x64-release-artifact.sh");
const darwinBuilder = read("scripts/build-darwin-release-supplement.sh");
const finalizer = read("scripts/finalize-pretag-candidate.sh");
const releaseWorkflow = read(".github/workflows/hosted-runtime-release.yml");
const hostedArtifactBuilder = read("scripts/build-hosted-runtime-artifact.ts");

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

describe("lean attested Linux managed artifact layout", () => {
  it("ships only public acquisition wrappers and no retired mutation owners", () => {
    expect(files).toContain("install.sh");
    expect(files).toContain("scripts/privileged-release-evidence.mjs");
    for (const removed of removedMutationOwners) {
      expect(files).not.toContain(removed);
      expect(fs.existsSync(path.join(root, removed))).toBe(false);
    }
  });

  it("routes Local and Hosting through one Go bootstrap", () => {
    expect(installer).toContain("fased-bootstrap-${operating_system}-${arch}");
    expect(installer).toContain('profile="protected-local"');
    expect(installer).toContain('profile="hosting"');
    expect(installer).toContain('"$bootstrap" "${bootstrap_args[@]}"');
    expect(installer).not.toContain("generation-updater.mjs");
  });

  it("builds native Linux product bytes once per architecture and combines them once", () => {
    expect(builder).toContain('FASED_SIGNER_TARGETS="linux/amd64"');
    expect(builder).toContain('FASED_LIFECYCLE_TARGETS="linux/amd64"');
    expect(builder).toContain("hosted:artifact:from-dist");
    expect(builder).toContain("assemble-lifecycle-generation.mjs");
    expect(builder).not.toContain("hosted:component-packs");
    expect(builder).not.toContain("podman");
    expect(builder).not.toContain("docker");
    expect(builder).not.toContain("Containerfile");
    expect(builder).not.toContain("test-lifecycle");
    expect(builder).toContain("MAX_CORE_ARTIFACT_FILES=160");
    expect(builder).toContain("MAX_CORE_ARTIFACT_BYTES=1610612736");
    expect(builder).toContain("artifact_file_count <= MAX_CORE_ARTIFACT_FILES");
    expect(builder).toContain("artifact_total_bytes <= MAX_CORE_ARTIFACT_BYTES");
  });

  it("builds Darwin runtime bytes without repeating platform-neutral declarations", () => {
    expect(darwinBuilder).toContain('pnpm --dir "$ROOT_DIR" build:app');
    expect(darwinBuilder).not.toContain('pnpm --dir "$ROOT_DIR" build\n');
    expect(darwinBuilder).not.toContain("build:plugin-sdk:dts");
  });

  it("keeps optional implementations outside the core artifact", () => {
    expect(hostedArtifactBuilder).toContain('const tsxLoader = import.meta.resolve("tsx")');
    expect(hostedArtifactBuilder).toContain("fased-hosted-app-v2-${platform}-${arch}");
    expect(hostedArtifactBuilder).toContain("fased-hosted-deps-${platform}-${arch}");
    expect(hostedArtifactBuilder).not.toContain("fased-hosted-linux-${arch}");
  });

  it("measures packaged Gateway RSS through the native host interface", () => {
    expect(hostedArtifactBuilder).toContain('process.platform === "linux"');
    expect(hostedArtifactBuilder).toContain('process.platform === "darwin"');
    expect(hostedArtifactBuilder).toContain('execFileAsync("/bin/ps", ["-o", "rss="');
    expect(hostedArtifactBuilder).toContain("readProcessRssKiB(child.pid)");
    expect(hostedArtifactBuilder).not.toContain('fs.readFile(`/proc/${child.pid}/status`, "utf8")');
  });

  it("finalizes product bytes without rebuilding", () => {
    expect(finalizer).toContain("fased-lifecycled-linux-amd64");
    expect(finalizer).toContain("fased-signerd-linux-amd64");
    expect(finalizer).toContain("privileged-release-evidence.mjs");
    expect(finalizer).toContain("build-lifecycle-release-index.mjs");
    expect(finalizer).not.toContain("pnpm build");
    expect(finalizer).not.toContain("hosted:artifact:from-dist");
  });

  it("assembles cross-platform payload inventories with the Linux host tool", () => {
    expect(
      builder.match(/--inventory-tool "\$OUTPUT_DIR\/fased-lifecycled-linux-amd64"/gu),
    ).toHaveLength(3);
    expect(builder).not.toContain('--inventory-tool "$OUTPUT_DIR/fased-lifecycled-linux-arm64"');
    expect(builder).not.toContain(
      '--inventory-tool "$OUTPUT_DIR/fased-lifecycled-darwin-${go_architecture}"',
    );
  });

  it("restores executable modes lost by cross-job artifact transport", () => {
    expect(builder).toContain(
      "fased-bootstrap-*|fased-lifecycled-*|fased-signerd-*|fased-node-*) mode=0755",
    );
    expect(builder).toContain('install -m "$mode" "$source" "$OUTPUT_DIR/$name"');
    expect(builder).toContain('test -f "$OUTPUT_DIR/$executable" && test -x');
    expect(builder).not.toContain('install -m "$(stat -c %a "$source")"');
  });

  it("builds, finalizes, and publishes the same bytes once", () => {
    expect(releaseWorkflow).toContain("scripts/build-linux-x64-release-artifact.sh");
    expect(releaseWorkflow).toContain(`run: |
          bash scripts/build-linux-x64-release-artifact.sh \\
            "$RUNNER_TEMP/candidate/raw" "$RUNNER_TEMP/candidate/arm64" \\
            "$RUNNER_TEMP/candidate/darwin-x64" "$RUNNER_TEMP/candidate/darwin-arm64"`);
    expect(releaseWorkflow).not.toContain(
      "run: bash scripts/build-linux-x64-release-artifact.sh \\\n",
    );
    expect(releaseWorkflow).toContain("scripts/finalize-pretag-candidate.sh");
    expect(releaseWorkflow).toContain("gh attestation verify");
    expect(releaseWorkflow.match(/build-linux-x64-release-artifact\.sh/gu)?.length).toBe(1);
    expect(releaseWorkflow).not.toContain("test-lifecycle-hosting-acceptance.sh");
  });

  it("builds and publishes in one run from the immutable tag ref", () => {
    expect(releaseWorkflow).not.toContain("prepare_run_id:");
    expect(releaseWorkflow).not.toContain("inputs.phase");
    expect(releaseWorkflow).toContain('test "$GITHUB_REF" = "refs/tags/v$RELEASE_VERSION"');
    expect(releaseWorkflow).toContain('test "$(git cat-file -t "$GITHUB_REF")" = tag');
    expect(releaseWorkflow).toContain(
      'test "$(git rev-parse "$GITHUB_REF^{commit}")" = "$SOURCE_COMMIT"',
    );
    expect(releaseWorkflow).toContain("actions/download-artifact");
    expect(releaseWorkflow).toContain("build-linux-arm64-release-supplement.sh");
    expect(releaseWorkflow).toContain("ubuntu-24.04-arm");
    expect(releaseWorkflow).toContain("Verify every official attestation is tag-bound");
    expect(releaseWorkflow).toContain("verify-release-set");

    const release = releaseWorkflow.slice(releaseWorkflow.indexOf("  release:"));
    expect(release.match(/build-linux-x64-release-artifact\.sh/gu)?.length).toBe(1);
    expect(release.match(/actions\/attest@/gu)?.length).toBe(11);
  });

  it("contains no simulated Protected Local acceptance implementation", () => {
    for (const removed of [
      "scripts/test-lifecycle-local-acceptance.sh",
      "scripts/docker/protected-local-systemd/lifecycle-acceptance.sh",
      "scripts/run-lifecycle-local0.sh",
    ]) {
      expect(fs.existsSync(path.join(root, removed))).toBe(false);
    }
  });
});
