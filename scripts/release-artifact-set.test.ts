import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_ATTESTATION,
  CANDIDATE_DESCRIPTOR,
  buildCandidateDescriptor,
  buildPromotionArtifacts,
  verifyCandidateDirectory,
  verifyPublishedAssets,
} from "./release-artifact-set.mjs";

const roots: string[] = [];

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-release-artifact-set-"));
  roots.push(root);
  await fsp.writeFile(path.join(root, "application.tar.gz"), "application\n");
  await fsp.writeFile(path.join(root, "signer"), "signer\n");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("exact release artifact promotion", () => {
  it("binds and verifies the exact immutable candidate bytes", async () => {
    const directory = await fixture();
    const built = await buildCandidateDescriptor({
      directory,
      version: "0.1.76-rc.32",
      commit: "a".repeat(40),
      sourceRef: "refs/tags/v0.1.76-rc.32",
      workflowRunId: "12345",
    });
    expect(built.descriptor.artifacts.map(({ name }) => name)).toEqual([
      "application.tar.gz",
      "signer",
    ]);
    await fsp.writeFile(path.join(directory, CANDIDATE_ATTESTATION), "attestation\n");
    const verified = await verifyCandidateDirectory({
      directory,
      expected: {
        version: "0.1.76-rc.32",
        commit: "a".repeat(40),
        sourceRef: "refs/tags/v0.1.76-rc.32",
        workflowRunId: "12345",
      },
    });
    expect(verified.descriptorDigest).toBe(built.descriptorDigest);
    expect(verified.promotionArtifacts.map(({ identity }) => identity)).toEqual([
      "application.tar.gz",
      CANDIDATE_DESCRIPTOR,
      CANDIDATE_ATTESTATION,
      "signer",
    ]);
    expect(verified.promotionArtifactSetDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects changed, missing, extra, and linked artifacts", async () => {
    const directory = await fixture();
    await buildCandidateDescriptor({
      directory,
      version: "0.1.76-rc.32",
      commit: "b".repeat(40),
      sourceRef: "refs/tags/v0.1.76-rc.32",
      workflowRunId: "99",
    });
    await fsp.writeFile(path.join(directory, CANDIDATE_ATTESTATION), "attestation\n");
    await fsp.writeFile(path.join(directory, "application.tar.gz"), "changed\n");
    await expect(verifyCandidateDirectory({ directory })).rejects.toThrow("content mismatch");

    await fsp.writeFile(path.join(directory, "application.tar.gz"), "application\n");
    await fsp.writeFile(path.join(directory, "extra"), "extra\n");
    await expect(verifyCandidateDirectory({ directory })).rejects.toThrow("exactly match");
    await fsp.rm(path.join(directory, "extra"));

    await fsp.rm(path.join(directory, "signer"));
    await expect(verifyCandidateDirectory({ directory })).rejects.toThrow("exactly match");

    const linked = await fixture();
    fs.symlinkSync("application.tar.gz", path.join(linked, "linked"));
    await expect(
      buildCandidateDescriptor({
        directory: linked,
        version: "0.1.76-rc.32",
        commit: "c".repeat(40),
        sourceRef: "refs/tags/v0.1.76-rc.32",
        workflowRunId: "100",
      }),
    ).rejects.toThrow("regular single-link");
  });

  it("requires tag-bound identity and a descriptor attestation", async () => {
    const directory = await fixture();
    await expect(
      buildCandidateDescriptor({
        directory,
        version: "0.1.76-rc.32",
        commit: "d".repeat(40),
        sourceRef: "refs/heads/main",
        workflowRunId: "101",
      }),
    ).rejects.toThrow("exact version tag");

    await buildCandidateDescriptor({
      directory,
      version: "0.1.76-rc.32",
      commit: "d".repeat(40),
      sourceRef: "refs/tags/v0.1.76-rc.32",
      workflowRunId: "101",
    });
    expect(fs.existsSync(path.join(directory, CANDIDATE_DESCRIPTOR))).toBe(true);
    await expect(verifyCandidateDirectory({ directory })).rejects.toThrow(
      "attestation bundle is missing",
    );
  });

  it("proves the published release inventory is the exact candidate byte set", async () => {
    const directory = await fixture();
    await buildCandidateDescriptor({
      directory,
      version: "0.1.76-rc.32",
      commit: "e".repeat(40),
      sourceRef: "refs/tags/v0.1.76-rc.32",
      workflowRunId: "102",
    });
    await fsp.writeFile(path.join(directory, CANDIDATE_ATTESTATION), "attestation\n");
    const artifacts = await buildPromotionArtifacts(directory);
    const assets = await Promise.all(
      artifacts.map(async ({ identity, digest }) => ({
        name: identity,
        digest,
        size: (await fsp.stat(path.join(directory, identity))).size,
      })),
    );
    const result = await verifyPublishedAssets({ directory, assets: assets.toReversed() });
    expect(result.assets).toEqual(artifacts);

    assets[0] = { ...assets[0], digest: `sha256:${"f".repeat(64)}` };
    await expect(verifyPublishedAssets({ directory, assets })).rejects.toThrow("exactly match");
  });
});
