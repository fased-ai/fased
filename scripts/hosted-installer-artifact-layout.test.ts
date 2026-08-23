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
const preTagWorkflow = read(".github/workflows/pre-tag-p1.yml");
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

  it("passes the same finalized bytes from pre-tag to publication", () => {
    expect(preTagWorkflow).toContain("scripts/build-linux-x64-release-artifact.sh");
    expect(preTagWorkflow).toContain("scripts/finalize-pretag-candidate.sh");
    expect(preTagWorkflow).toContain("product.sha256");
    expect(preTagWorkflow).not.toContain("test-lifecycle-hosting-acceptance.sh");
    expect(releaseWorkflow).toContain("product.sha256");
    expect(releaseWorkflow).toContain("gh attestation verify");
    expect(releaseWorkflow).not.toContain("pnpm install");
    expect(releaseWorkflow).not.toContain("pnpm build");
    expect(releaseWorkflow).not.toContain("go build");
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
