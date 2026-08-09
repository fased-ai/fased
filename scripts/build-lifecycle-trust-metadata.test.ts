import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLifecycleTrustMetadata } from "./build-lifecycle-trust-metadata.mjs";
import { INITIAL_LIFECYCLE_ROOT_ENVELOPE } from "./lifecycle-trust-runtime.mjs";

const rootPolicyPath = path.join(
  import.meta.dirname,
  "..",
  "release",
  "lifecycle-trust",
  "root-v1",
  "fased-lifecycle-root-v1.json",
);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-lifecycle-trust-"));
  fs.writeFileSync(path.join(root, "install.sh"), "bootstrap\n");
  fs.writeFileSync(path.join(root, "fased-lifecycled-linux-amd64"), "lifecycle x64\n");
  fs.writeFileSync(path.join(root, "fased-lifecycled-linux-arm64"), "lifecycle arm64\n");
  fs.writeFileSync(path.join(root, "fased-privileged-release-evidence.mjs"), "evidence verifier\n");
  fs.writeFileSync(
    path.join(root, "fased-privileged-provenance-v1.intoto.json"),
    '{"provenance":true}\n',
  );
  fs.writeFileSync(path.join(root, "fased-privileged-sbom-v1.spdx.json"), '{"sbom":true}\n');
  fs.writeFileSync(path.join(root, "fased-privileged-vex-v1.openvex.json"), '{"vex":true}\n');
  return root;
}

describe("lifecycle trust metadata", () => {
  it("binds one release to fixed Go lifecycle target names", async () => {
    const metadata = await buildLifecycleTrustMetadata({
      assetsDir: fixture(),
      rootPolicyPath,
      version: "1.2.3",
      commit: "a".repeat(40),
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2027-07-28T00:00:00.000Z",
    });
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      role: "fased-lifecycle-targets",
      rootPolicy: INITIAL_LIFECYCLE_ROOT_ENVELOPE,
      release: { version: "1.2.3", tag: "v1.2.3", commit: "a".repeat(40) },
      policy: {
        channels: ["beta", "stable"],
        platforms: ["linux-arm64", "linux-x64"],
        lifecycleProtocol: 1,
      },
      targets: {
        bootstrap: { asset: "install.sh" },
        lifecycleLinuxX64: { asset: "fased-lifecycled-linux-amd64" },
        lifecycleLinuxArm64: { asset: "fased-lifecycled-linux-arm64" },
        evidenceVerifier: { asset: "fased-privileged-release-evidence.mjs" },
      },
      evidence: {
        provenance: { asset: "fased-privileged-provenance-v1.intoto.json" },
        sbom: { asset: "fased-privileged-sbom-v1.spdx.json" },
        vex: { asset: "fased-privileged-vex-v1.openvex.json" },
      },
    });
    for (const target of Object.values(metadata.targets)) {
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    for (const evidence of Object.values(metadata.evidence)) {
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("binds prereleases to beta and rejects an excessive validity window", async () => {
    const root = fixture();
    const metadata = await buildLifecycleTrustMetadata({
      assetsDir: root,
      rootPolicyPath,
      version: "1.2.3-rc.1",
      commit: "b".repeat(40),
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2027-07-28T00:00:00.000Z",
    });
    expect(metadata.policy.channels).toEqual(["beta"]);
    await expect(
      buildLifecycleTrustMetadata({
        assetsDir: root,
        rootPolicyPath,
        version: "1.2.3",
        commit: "b".repeat(40),
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-12-31T00:00:00.000Z",
      }),
    ).rejects.toThrow("at most 400 days");
  });

  it("rejects symlinked lifecycle targets", async () => {
    const root = fixture();
    fs.rmSync(path.join(root, "fased-lifecycled-linux-amd64"));
    fs.symlinkSync(
      path.join(root, "fased-lifecycled-linux-arm64"),
      path.join(root, "fased-lifecycled-linux-amd64"),
    );
    await expect(
      buildLifecycleTrustMetadata({
        assetsDir: root,
        rootPolicyPath,
        version: "1.2.3",
        commit: "c".repeat(40),
        issuedAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2027-07-28T00:00:00.000Z",
      }),
    ).rejects.toThrow("regular single-link file");
  });

  it("requires the release workflow to select one regular signed-root file", async () => {
    const root = fixture();
    const rootPolicyLink = path.join(root, "root-policy.json");
    fs.symlinkSync(rootPolicyPath, rootPolicyLink);
    await expect(
      buildLifecycleTrustMetadata({
        assetsDir: root,
        rootPolicyPath: rootPolicyLink,
        version: "1.2.3",
        commit: "d".repeat(40),
        issuedAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2027-07-28T00:00:00.000Z",
      }),
    ).rejects.toThrow("root policy must be one bounded regular single-link file");
  });
});
