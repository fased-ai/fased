import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  capabilitiesDigest,
  parseHostedReleaseManifestV2,
  readHostedReleaseManifestV2,
  verifyManifestArtifact,
} from "./hosted-release-manifest.mjs";

const capabilities = {
  protocol: { current: 2, min: 2, max: 2 },
  nativeFeeReservationLamports: 6_500_000,
  intentTypes: ["solana.nativeTransfer"],
  operationStates: ["reserved"],
  features: ["failClosedPolicies"],
};
const artifact = { asset: "app.tar.gz", sha256: "a".repeat(64) };
const dependency = {
  asset: "deps.tar.gz",
  sha256: "b".repeat(64),
  dependencyHash: "c".repeat(64),
};
const signerPlatforms = Object.fromEntries(
  ["linux-amd64"].map((platform) => [
    platform,
    { asset: `fased-signerd-${platform}`, sha256: "d".repeat(64) },
  ]),
);
const valid = () => ({
  schemaVersion: 2,
  release: { version: "1.2.3", tag: "v1.2.3", commit: "e".repeat(40) },
  application: {
    linux: {
      x64: { artifact, dependencies: dependency },
    },
  },
  signer: {
    release: {
      version: "1.2.3",
      commit: "e".repeat(40),
      buildInputDigest: `sha256:${"f".repeat(64)}`,
      development: false,
    },
    capabilities,
    capabilitiesDigest: capabilitiesDigest(capabilities),
    platforms: signerPlatforms,
  },
});

describe("hosted release manifest v2 verification", () => {
  it("parses only an exactly bound app/signer release", () => {
    expect(parseHostedReleaseManifestV2(valid(), { version: "1.2.3" }).release.commit).toBe(
      "e".repeat(40),
    );
    const mixed = valid();
    mixed.signer.release.commit = "0".repeat(40);
    expect(() => parseHostedReleaseManifestV2(mixed)).toThrow(
      "app and signer release identities do not match",
    );
  });

  it("keeps Darwin and Linux assets separate at the same CPU architecture", () => {
    const base = valid();
    const candidate = {
      ...base,
      application: {
        linux: {
          ...base.application.linux,
          arm64: {
            artifact: { ...artifact, asset: "app-linux-arm64.tar.gz" },
            dependencies: { ...dependency, asset: "deps-linux-arm64.tar.gz" },
          },
        },
        darwin: {
          x64: {
            artifact: { ...artifact, asset: "app-darwin-x64.tar.gz" },
            dependencies: { ...dependency, asset: "deps-darwin-x64.tar.gz" },
          },
          arm64: {
            artifact: { ...artifact, asset: "app-darwin-arm64.tar.gz" },
            dependencies: { ...dependency, asset: "deps-darwin-arm64.tar.gz" },
          },
        },
      },
      signer: {
        ...base.signer,
        platforms: Object.fromEntries(
          ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"].map((platform) => [
            platform,
            { asset: `fased-signerd-${platform}`, sha256: "d".repeat(64) },
          ]),
        ),
      },
    };
    const parsed = parseHostedReleaseManifestV2(candidate);
    expect(parsed.application.darwin.x64.artifact.asset).toBe("app-darwin-x64.tar.gz");
    expect(parsed.application.linux.x64.artifact.asset).toBe("app.tar.gz");
  });

  it("rejects unknown fields and a changed capability contract", () => {
    expect(() => parseHostedReleaseManifestV2({ ...valid(), unexpected: true })).toThrow(
      "unsupported or missing fields",
    );
    const changed = valid();
    changed.signer.capabilities.features.push("unbound-feature");
    expect(() => parseHostedReleaseManifestV2(changed)).toThrow("capability digest");
  });

  it("records the exact manifest digest and validates artifact bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-manifest-verify-"));
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(valid())}\n`);
    const read = await readHostedReleaseManifestV2(manifestPath, { version: "1.2.3" });
    expect(read.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const assetPath = path.join(root, "asset");
    fs.writeFileSync(assetPath, "candidate");
    await expect(
      verifyManifestArtifact(assetPath, { asset: "asset", sha256: "0".repeat(64) }),
    ).rejects.toThrow("attested release manifest");
  });
});
