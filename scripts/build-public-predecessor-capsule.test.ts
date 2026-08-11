import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPublicPredecessorCapsule } from "./build-public-predecessor-capsule.mjs";
import { inspectCapsuleArchive } from "./restore-predecessor-capsule.mjs";

const temporary: string[] = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true }))),
);

async function fixture(profile: "protected-local" | "hosting") {
  const root = await mkdtemp(path.join(tmpdir(), "fased-public-capsule-test-"));
  const output = path.join(root, "output");
  temporary.push(root);
  const releaseManifest = path.join(root, "release.json");
  const compatibility = path.join(root, "compatibility.json");
  const acceptance = path.join(root, "acceptance.json");
  await writeFile(
    releaseManifest,
    `${JSON.stringify({ schemaVersion: 2, release: { version: "0.1.75", tag: "v0.1.75", commit: "a".repeat(40) } })}\n`,
  );
  await writeFile(compatibility, "{}\n");
  await writeFile(acceptance, "{}\n");
  const result = await buildPublicPredecessorCapsule({
    profile,
    releaseManifestPath: releaseManifest,
    releaseTree: "b".repeat(40),
    compatibilityIndexPath: compatibility,
    acceptanceContractPath: acceptance,
    outputDirectory: output,
    builderCommit: "c".repeat(40),
    builderTree: "d".repeat(40),
    branchProof: true,
  });
  return { root, output, result };
}

describe("public predecessor capsule builder", () => {
  it.each(["protected-local", "hosting"] as const)(
    "builds deterministic %s topology without a historical installer",
    async (profile) => {
      const { output, result } = await fixture(profile);
      const descriptor = result.descriptor;
      expect(descriptor.release).toEqual({
        version: "0.1.75",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
      });
      expect(descriptor.entries).toContainEqual(
        expect.objectContaining({
          path: `home/${profile === "hosting" ? "app" : "testop"}/.fased/runtime/current`,
          type: "symlink",
          target: "releases/0.1.75",
        }),
      );
      const archive = await inspectCapsuleArchive(result.archivePath, descriptor);
      expect(archive.size).toBe(descriptor.entries.length);
      const proof = JSON.parse(
        await readFile(path.join(output, "fased-predecessor-branch-proof.json"), "utf8"),
      );
      expect(proof).toMatchObject({
        role: "fased-predecessor-capsule-branch-proof",
        publishable: false,
        profile,
      });
    },
  );

  it("reproduces exact capsule identities from the same public release evidence", async () => {
    const first = await fixture("protected-local");
    const second = await fixture("protected-local");
    expect(second.result.descriptor.archive.sha256).toBe(first.result.descriptor.archive.sha256);
    expect(await readFile(second.result.descriptorPath, "utf8")).toBe(
      await readFile(first.result.descriptorPath, "utf8"),
    );
  });
});
