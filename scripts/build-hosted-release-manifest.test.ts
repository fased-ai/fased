import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHostedReleaseManifest,
  digestJSON,
  HOSTED_SIGNER_CAPABILITIES_V2,
} from "./build-hosted-release-manifest.mjs";

const version = "1.2.3";
const commit = "a".repeat(40);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-hosted-release-v2-"));
  for (const [operatingSystem, architecture] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
  ]) {
    const app = `app-${architecture}`;
    const dependencies = `dependencies-${architecture}`;
    const appAsset = `fased-hosted-app-v2-${operatingSystem}-${architecture}-v${version}.tar.gz`;
    const dependencyHash = digest(`lock-${architecture}`);
    const dependenciesAsset = `fased-hosted-deps-linux-${architecture}-${dependencyHash}.tar.gz`;
    fs.writeFileSync(path.join(assetsDir, appAsset), app);
    fs.writeFileSync(path.join(assetsDir, dependenciesAsset), dependencies);
    fs.writeFileSync(
      path.join(assetsDir, `${appAsset}.release.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        version,
        commit,
        operatingSystem,
        architecture,
        dependencyHash,
        app: { asset: appAsset, sha256: digest(app) },
        dependencies: { asset: dependenciesAsset, sha256: digest(dependencies) },
      })}\n`,
    );
  }
  const signerIdentity = {
    schemaVersion: 1,
    version,
    commit,
    buildInputDigest: `sha256:${"b".repeat(64)}`,
    development: false,
  };
  fs.writeFileSync(
    path.join(assetsDir, "fased-signerd-release.json"),
    `${JSON.stringify(signerIdentity)}\n`,
  );
  for (const asset of [
    "fased-signerd-linux-amd64",
    "fased-signerd-linux-arm64",
    "fased-signerd-darwin-amd64",
    "fased-signerd-darwin-arm64",
  ]) {
    fs.writeFileSync(path.join(assetsDir, asset), asset);
  }
  return assetsDir;
}

describe("unified hosted release manifest v2", () => {
  it("binds exact app, dependency, signer, commit, protocol, and capability identities", async () => {
    const assetsDir = fixture();
    const manifest = await buildHostedReleaseManifest({ assetsDir, version, commit });
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      release: { version, tag: `v${version}`, commit },
      signer: {
        release: { version, commit, development: false },
        capabilities: { protocol: { current: 2, min: 2, max: 2 } },
      },
    });
    expect(manifest.signer.capabilitiesDigest).toBe(digestJSON(HOSTED_SIGNER_CAPABILITIES_V2));
    expect(manifest.application.linux.x64.artifact.sha256).toBe(
      digest(fs.readFileSync(path.join(assetsDir, manifest.application.linux.x64.artifact.asset))),
    );
    expect(manifest.signer.platforms["linux-amd64"].sha256).toBe(
      digest("fased-signerd-linux-amd64"),
    );
    expect(manifest.application.linux.arm64.artifact.sha256).toBe(
      digest(
        fs.readFileSync(path.join(assetsDir, manifest.application.linux.arm64.artifact.asset)),
      ),
    );
    expect(manifest.signer.platforms["linux-arm64"].sha256).toBe(
      digest("fased-signerd-linux-arm64"),
    );
    expect(manifest.application.darwin.arm64.artifact.asset).toContain("darwin-arm64");
  });

  it("rejects a mixed-commit app before producing a release manifest", async () => {
    const assetsDir = fixture();
    const identityPath = path.join(
      assetsDir,
      `fased-hosted-app-v2-linux-x64-v${version}.tar.gz.release.json`,
    );
    const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    identity.commit = "c".repeat(40);
    fs.writeFileSync(identityPath, JSON.stringify(identity));
    await expect(buildHostedReleaseManifest({ assetsDir, version, commit })).rejects.toThrow(
      "malformed or mismatched",
    );
  });

  it("rejects changed artifact bytes even when a sidecar claims the old digest", async () => {
    const assetsDir = fixture();
    fs.appendFileSync(
      path.join(assetsDir, `fased-hosted-app-v2-linux-x64-v${version}.tar.gz`),
      "x",
    );
    await expect(buildHostedReleaseManifest({ assetsDir, version, commit })).rejects.toThrow(
      "artifact digest mismatch",
    );
  });

  it("marks the x64-only branch fixture as non-publishable without platform aliases", async () => {
    const assetsDir = fixture();
    const manifest = await buildHostedReleaseManifest({
      assetsDir,
      version,
      commit,
      profile: "branch-x64",
    });
    expect(manifest).toMatchObject({
      schemaVersion: 2,
      fixture: { profile: "branch-x64", publishable: false },
      application: { linux: { x64: expect.any(Object) } },
      signer: { platforms: { "linux-amd64": expect.any(Object) } },
    });
    expect(Object.keys(manifest.application.linux)).toEqual(["x64"]);
    expect(Object.keys(manifest.signer.platforms)).toEqual(["linux-amd64"]);
  });

  it("builds a publishable Linux-x64-only release manifest", async () => {
    const assetsDir = fixture();
    const manifest = await buildHostedReleaseManifest({
      assetsDir,
      version,
      commit,
      profile: "release-x64",
    });
    expect(manifest).not.toHaveProperty("fixture");
    expect(Object.keys(manifest.application)).toEqual(["linux"]);
    expect(Object.keys(manifest.application.linux)).toEqual(["x64"]);
    expect(Object.keys(manifest.signer.platforms)).toEqual(["linux-amd64"]);
  });
});
