import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLifecycleTrustMetadata } from "./build-lifecycle-trust-metadata.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-lifecycle-trust-"));
  fs.writeFileSync(path.join(root, "fased-lifecycle-supervisor.mjs"), "supervisor\n");
  fs.writeFileSync(path.join(root, "fased-host-updater.mjs"), "server\n");
  fs.writeFileSync(path.join(root, "fased-host-updaterctl.mjs"), "client\n");
  return root;
}

describe("lifecycle trust metadata", () => {
  it("binds one release to fixed supervisor and controller target names", async () => {
    const metadata = await buildLifecycleTrustMetadata({
      assetsDir: fixture(),
      version: "1.2.3",
      commit: "a".repeat(40),
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2027-07-28T00:00:00.000Z",
    });
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      role: "fased-lifecycle-targets",
      release: { version: "1.2.3", tag: "v1.2.3", commit: "a".repeat(40) },
      policy: {
        channels: ["beta", "stable"],
        platforms: ["linux-arm64", "linux-x64"],
        supervisorProtocol: 1,
        controllerProtocol: 2,
      },
      targets: {
        supervisor: { asset: "fased-lifecycle-supervisor.mjs" },
        controllerServer: { asset: "fased-host-updater.mjs" },
        controllerClient: { asset: "fased-host-updaterctl.mjs" },
      },
    });
    for (const target of Object.values(metadata.targets)) {
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("binds prereleases to beta and rejects an excessive validity window", async () => {
    const root = fixture();
    const metadata = await buildLifecycleTrustMetadata({
      assetsDir: root,
      version: "1.2.3-rc.1",
      commit: "b".repeat(40),
      issuedAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2027-07-28T00:00:00.000Z",
    });
    expect(metadata.policy.channels).toEqual(["beta"]);
    await expect(
      buildLifecycleTrustMetadata({
        assetsDir: root,
        version: "1.2.3",
        commit: "b".repeat(40),
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-12-31T00:00:00.000Z",
      }),
    ).rejects.toThrow("at most 400 days");
  });

  it("rejects symlinked lifecycle targets", async () => {
    const root = fixture();
    fs.rmSync(path.join(root, "fased-host-updater.mjs"));
    fs.symlinkSync(
      path.join(root, "fased-host-updaterctl.mjs"),
      path.join(root, "fased-host-updater.mjs"),
    );
    await expect(
      buildLifecycleTrustMetadata({
        assetsDir: root,
        version: "1.2.3",
        commit: "c".repeat(40),
        issuedAt: "2026-07-28T00:00:00.000Z",
        expiresAt: "2027-07-28T00:00:00.000Z",
      }),
    ).rejects.toThrow("regular single-link file");
  });
});
