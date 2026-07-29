import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing as controllerTesting } from "./fased-host-updater.mjs";
import {
  __testing as supervisorTesting,
  verifyEmbeddedLifecycleRootPolicy,
} from "./fased-lifecycle-supervisor.mjs";
import {
  INITIAL_LIFECYCLE_ROOT_ENVELOPE,
  INITIAL_LIFECYCLE_ROOT_SHA256,
  INITIAL_LIFECYCLE_TRUST,
  loadInitialLifecycleTrust,
  officialReleaseAttestationVerifyArgs,
} from "./lifecycle-trust-runtime.mjs";

describe("production lifecycle trust runtime", () => {
  it("loads the owner-signed root through its immutable pin", () => {
    const loaded = loadInitialLifecycleTrust(
      INITIAL_LIFECYCLE_ROOT_ENVELOPE,
      INITIAL_LIFECYCLE_ROOT_SHA256,
      Date.parse("2026-07-29T21:00:00.000Z"),
    );

    expect(loaded).toMatchObject({
      pinnedSha256: "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca",
      state: {
        schemaVersion: 1,
        rootVersion: 1,
        rootSha256: "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca",
      },
      root: {
        root: { threshold: 2 },
        releaseAuthority: {
          repository: "fased-ai/fased",
          workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
          sourceRefPrefix: "refs/tags/v",
          denySelfHostedRunners: true,
        },
      },
    });
  });

  it("derives every GitHub attestation selector from the signed root", () => {
    expect(
      officialReleaseAttestationVerifyArgs({
        assetPath: "/tmp/fased-asset",
        version: "1.2.3-rc.4",
        bundlePath: "/tmp/fased-asset.attestation.json",
      }),
    ).toEqual([
      "attestation",
      "verify",
      "/tmp/fased-asset",
      "--repo",
      "fased-ai/fased",
      "--bundle",
      "/tmp/fased-asset.attestation.json",
      "--signer-workflow",
      "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
      "--source-ref",
      "refs/tags/v1.2.3-rc.4",
      "--deny-self-hosted-runners",
    ]);
  });

  it("keeps the standalone supervisor root identical to the shipped public root", () => {
    const envelope = JSON.parse(
      fs.readFileSync(
        path.join(
          import.meta.dirname,
          "..",
          "release",
          "lifecycle-trust",
          "root-v1",
          "fased-lifecycle-root-v1.json",
        ),
        "utf8",
      ),
    );
    expect(INITIAL_LIFECYCLE_ROOT_ENVELOPE).toEqual(envelope);
    expect(supervisorTesting.INITIAL_LIFECYCLE_ROOT_ENVELOPE).toEqual(envelope);
    expect(supervisorTesting.INITIAL_LIFECYCLE_ROOT_SHA256).toBe(
      INITIAL_LIFECYCLE_TRUST.pinnedSha256,
    );
    expect(supervisorTesting.EMBEDDED_LIFECYCLE_ROOT.releaseAuthority).toEqual(
      INITIAL_LIFECYCLE_TRUST.root.releaseAuthority,
    );
    expect(controllerTesting.LIFECYCLE_ROOT_POLICY_SHA256).toBe(
      INITIAL_LIFECYCLE_TRUST.pinnedSha256,
    );
    expect(controllerTesting.ROOT_APPROVED_RELEASE_AUTHORITY).toEqual(
      INITIAL_LIFECYCLE_TRUST.root.releaseAuthority,
    );
  });

  it("fails closed when the standalone root or pin is altered", () => {
    const tampered = structuredClone(supervisorTesting.INITIAL_LIFECYCLE_ROOT_ENVELOPE);
    tampered.signed.releaseAuthority.repository = "attacker/fork";
    expect(() =>
      verifyEmbeddedLifecycleRootPolicy(
        tampered,
        supervisorTesting.INITIAL_LIFECYCLE_ROOT_SHA256,
        Date.parse("2026-07-29T21:00:00.000Z"),
      ),
    ).toThrow("immutable bootstrap pin");
    expect(() =>
      verifyEmbeddedLifecycleRootPolicy(
        supervisorTesting.INITIAL_LIFECYCLE_ROOT_ENVELOPE,
        "0".repeat(64),
        Date.parse("2026-07-29T21:00:00.000Z"),
      ),
    ).toThrow("immutable bootstrap pin");
  });
});
