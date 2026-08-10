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

  it("stages the verified lifecycle binary as executable without mutating candidate bytes", () => {
    expect(hostingFixture).toContain(
      'install -m 0755 "$ARTIFACT_DIR/fased-lifecycled-linux-amd64"',
    );
    expect(hostingFixture).toContain('-v "$ARTIFACT_DIR:/artifacts:ro,Z"');
    expect(hostingFixture).toContain('-v "$EXECUTABLE_DIR:/fixture-bin:ro,Z"');
    expect(hostingFixture).toContain('cmp -s "$ARTIFACT_DIR/fased-lifecycled-linux-amd64"');
    expect(hostingRunner).toContain('lifecycled="/fixture-bin/fased-lifecycled-linux-amd64"');
    expect(hostingRunner).not.toContain('lifecycled="/artifacts/fased-lifecycled-linux-amd64"');
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
