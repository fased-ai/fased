import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { buildCanonicalManagedPredecessorCapsule } from "./build-canonical-managed-predecessor-capsule.mjs";
import { parsePredecessorCapsule } from "./predecessor-capsule.mjs";

const temporary: string[] = [];
const hash = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("canonical managed predecessor capsule", () => {
  it("binds an exact schema-one Local topology to immutable generation bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fased-managed-capsule-test-"));
    temporary.push(root);
    const source = path.join(root, "generation-source");
    const output = path.join(root, "output");
    await mkdir(path.join(source, "generation/payload/bin"), { recursive: true });
    await mkdir(output);
    const version = "0.1.76-rc.72";
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    const generationId = `sha256:${"c".repeat(64)}`;
    const dependencyHash = "d".repeat(64);
    const dependencyArchive = path.join(
      root,
      `fased-hosted-deps-linux-x64-${dependencyHash}.tar.gz`,
    );
    const dependencySource = path.join(root, "dependency-source");
    await mkdir(path.join(dependencySource, "node_modules"), { recursive: true });
    await writeFile(path.join(dependencySource, "node_modules/.fixture"), "dependency\n");
    await tar.c({ cwd: dependencySource, file: dependencyArchive, gzip: true }, ["node_modules"]);
    const inventory = {
      schemaVersion: 1,
      version,
      commit,
      tree,
      dependency: {
        hash: dependencyHash,
        asset: path.basename(dependencyArchive),
        archiveSHA256: hash(
          await import("node:fs/promises").then((fs) => fs.readFile(dependencyArchive)),
        ),
      },
      stateSchemas: { managedInstall: 2, signer: 2, walletRegistry: 1 },
      capabilities: {
        supervisor: { min: 1, max: 1 },
        controller: { min: 1, max: 1 },
        migrator: { min: 1, max: 1 },
        signer: { min: 2, max: 2 },
      },
    };
    await writeFile(
      path.join(source, "generation/generation.json"),
      `${JSON.stringify({ schemaVersion: 1, generation: { id: generationId, version, commit, tree, artifactSetDigest: generationId }, inventorySHA256: "0".repeat(64) })}\n`,
    );
    await writeFile(
      path.join(source, "generation/inventory.json"),
      `${JSON.stringify(inventory)}\n`,
    );
    await writeFile(path.join(source, "generation/payload/bin/fased-lifecycled"), "binary\n");
    const generationArchive = path.join(root, `fased-generation-linux-x64-v${version}.tar.gz`);
    await tar.c({ cwd: source, file: generationArchive, gzip: true }, ["generation"]);
    const releaseManifest = path.join(root, "fased-hosted-release-v2.json");
    const releaseAttestation = `${releaseManifest}.attestation.json`;
    await writeFile(
      releaseManifest,
      `${JSON.stringify({ schemaVersion: 2, release: { version, tag: `v${version}`, commit } })}\n`,
    );
    await writeFile(releaseAttestation, "{}\n");
    const candidateDescriptor = path.join(root, "fased-hosting-candidate.json");
    const artifact = async (file: string) => ({
      name: path.basename(file),
      size: (await import("node:fs/promises").then((fs) => fs.stat(file))).size,
      sha256: hash(await import("node:fs/promises").then((fs) => fs.readFile(file))),
    });
    await writeFile(
      candidateDescriptor,
      `${JSON.stringify({ version, commit, tree, artifacts: [await artifact(generationArchive), await artifact(dependencyArchive)] })}\n`,
    );
    const previous = path.join(root, "previous.json");
    await writeFile(
      previous,
      `${JSON.stringify({ id: `sha256:${"e".repeat(64)}`, version: "0.1.76-rc.70", commit: "f".repeat(40), tree: "1".repeat(40), artifactSetDigest: `sha256:${"e".repeat(64)}` })}\n`,
    );
    const compatibility = path.join(root, "compatibility.json");
    const acceptance = path.join(root, "acceptance.json");
    await writeFile(compatibility, "{}\n");
    await writeFile(acceptance, "{}\n");

    const result = await buildCanonicalManagedPredecessorCapsule({
      releaseManifestPath: releaseManifest,
      releaseManifestAttestationPath: releaseAttestation,
      releaseTree: tree,
      candidateDescriptorPath: candidateDescriptor,
      generationArchivePath: generationArchive,
      dependencyArchivePath: dependencyArchive,
      previousGenerationPath: previous,
      compatibilityIndexPath: compatibility,
      acceptanceContractPath: acceptance,
      outputDirectory: output,
      builderCommit: "2".repeat(40),
      builderTree: "3".repeat(40),
      branchProof: true,
    });
    const capsule = parsePredecessorCapsule(result.descriptor);
    expect(capsule.installationClass.kind).toBe("canonical-managed");
    expect(capsule.installationClass.manifestSchema).toBe(1);
    expect(capsule.installationClass.platform.adapter).toBe("linux-systemd-local-v1");
    expect(capsule.installationClass.activeGeneration.id).toBe(generationId);
    expect(capsule.installationClass.previousGeneration.version).toBe("0.1.76-rc.70");
    expect(capsule.services).toHaveLength(4);
    expect(capsule.entries.some((entry) => entry.path.endsWith("generation.tar.gz"))).toBe(true);
    const restored = path.join(root, "restored");
    await mkdir(restored);
    await tar.x({ cwd: restored, file: result.archivePath });
    const platform = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(
          path.join(restored, "var/lib/fased-local/1122334455667788/lifecycle/platform.json"),
          "utf8",
        ),
      ),
    );
    expect(platform.operator.uid).toBe(2000);
    expect(platform.gateway.uid).toBe(2101);
    expect(platform.signer.uid).toBe(2102);
    expect(new Set([platform.operator.uid, platform.gateway.uid, platform.signer.uid]).size).toBe(
      3,
    );
    expect(
      capsule.entries.find((entry) => entry.path === "var/lib/fased-local/1122334455667788"),
    ).toMatchObject({ type: "directory", mode: 0o755, owner: "root" });
    expect(capsule.installationClass.platform.instanceId).toBe("1122334455667788");
  });
});
