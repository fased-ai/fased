import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const manifest = JSON.parse(read("package.json")) as { files?: string[] };
const files = new Set(manifest.files ?? []);
const installer = read("install.sh");
const builder = read("scripts/build-linux-x64-release-artifact.sh");
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

describe("lean attested Linux-x64 artifact layout", () => {
  it("ships only public acquisition wrappers and no retired mutation owners", () => {
    expect(files).toContain("install.sh");
    expect(files).toContain("scripts/privileged-release-evidence.mjs");
    for (const removed of removedMutationOwners) {
      expect(files).not.toContain(removed);
      expect(fs.existsSync(path.join(root, removed))).toBe(false);
    }
  });

  it("routes Local and Hosting through one Go bootstrap", () => {
    expect(installer).toContain("fased-bootstrap-linux-${arch}");
    expect(installer).toContain('profile="protected-local"');
    expect(installer).toContain('profile="hosting"');
    expect(installer).toContain('"$bootstrap" "${bootstrap_args[@]}"');
    expect(installer).not.toContain("generation-updater.mjs");
  });

  it("builds only core Linux-x64 product bytes once", () => {
    expect(builder).toContain('FASED_SIGNER_TARGETS="linux/amd64"');
    expect(builder).toContain('FASED_LIFECYCLE_TARGETS="linux/amd64"');
    expect(builder).toContain("hosted:artifact:from-dist");
    expect(builder).toContain("assemble-lifecycle-generation.mjs");
    expect(builder).not.toContain("hosted:component-packs");
    expect(builder).not.toContain("podman");
    expect(builder).not.toContain("docker");
    expect(builder).not.toContain("Containerfile");
    expect(builder).not.toContain("test-lifecycle");
    expect(builder).toContain("MAX_CORE_ARTIFACT_FILES=96");
    expect(builder).toContain("MAX_CORE_ARTIFACT_BYTES=805306368");
    expect(builder).toContain("artifact_file_count <= MAX_CORE_ARTIFACT_FILES");
    expect(builder).toContain("artifact_total_bytes <= MAX_CORE_ARTIFACT_BYTES");
  });

  it("keeps optional implementations outside the core artifact", () => {
    expect(hostedArtifactBuilder).toContain('const tsxLoader = import.meta.resolve("tsx")');
    expect(hostedArtifactBuilder).toContain("fased-hosted-app-v2-linux-${arch}");
    expect(hostedArtifactBuilder).toContain("fased-hosted-deps-linux-${arch}");
    expect(hostedArtifactBuilder).not.toContain("fased-hosted-linux-${arch}");
  });

  it("finalizes product bytes without rebuilding", () => {
    expect(finalizer).toContain("fased-lifecycled-linux-amd64");
    expect(finalizer).toContain("fased-signerd-linux-amd64");
    expect(finalizer).toContain("privileged-release-evidence.mjs");
    expect(finalizer).toContain("build-lifecycle-release-index.mjs");
    expect(finalizer).not.toContain("pnpm build");
    expect(finalizer).not.toContain("hosted:artifact:from-dist");
  });

  it("builds, finalizes, and publishes the same bytes once", () => {
    expect(releaseWorkflow).toContain("scripts/build-linux-x64-release-artifact.sh");
    expect(releaseWorkflow).toContain("scripts/finalize-pretag-candidate.sh");
    expect(releaseWorkflow).toContain("gh attestation verify");
    expect(releaseWorkflow.match(/build-linux-x64-release-artifact\.sh/gu)?.length).toBe(1);
    expect(releaseWorkflow).not.toContain("test-lifecycle-hosting-acceptance.sh");
  });

  it("prepares on main and creates official attestations only from the immutable tag ref", () => {
    expect(releaseWorkflow).toContain("phase:");
    expect(releaseWorkflow).toContain("prepare_run_id:");
    expect(releaseWorkflow).toContain("if: inputs.phase == 'prepare'");
    expect(releaseWorkflow).toContain("if: inputs.phase == 'finalize'");
    expect(releaseWorkflow).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(releaseWorkflow).toContain('test "$GITHUB_REF" = "refs/tags/v$RELEASE_VERSION"');
    expect(releaseWorkflow).toContain('test "$(git cat-file -t "$GITHUB_REF")" = tag');
    expect(releaseWorkflow).toContain(
      'test "$(git rev-parse "$GITHUB_REF^{commit}")" = "$SOURCE_COMMIT"',
    );
    expect(releaseWorkflow).toContain("run-id: ${{ inputs.prepare_run_id }}");
    expect(releaseWorkflow).toContain("github-token: ${{ github.token }}");
    expect(releaseWorkflow).toContain("Verify every official attestation is tag-bound");
    expect(releaseWorkflow).toContain("verify-release-set");

    const prepare = releaseWorkflow.slice(
      releaseWorkflow.indexOf("  prepare:"),
      releaseWorkflow.indexOf("  finalize:"),
    );
    const finalize = releaseWorkflow.slice(releaseWorkflow.indexOf("  finalize:"));
    expect(prepare).not.toContain("actions/attest@");
    expect(finalize).not.toContain("build-linux-x64-release-artifact.sh");
    expect(finalize).toContain("actions/attest@");
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
