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

async function fixture(
  profile: "protected-local" | "hosting",
  attestation = '{"verificationResult":"fixture"}\n',
) {
  const root = await mkdtemp(path.join(tmpdir(), "fased-public-capsule-test-"));
  const output = path.join(root, "output");
  temporary.push(root);
  const releaseManifest = path.join(root, "release.json");
  const releaseManifestAttestation = path.join(root, "release.json.attestation.json");
  const compatibility = path.join(root, "compatibility.json");
  const acceptance = path.join(root, "acceptance.json");
  await writeFile(
    releaseManifest,
    `${JSON.stringify({ schemaVersion: 2, release: { version: "0.1.75", tag: "v0.1.75", commit: "a".repeat(40) } })}\n`,
  );
  await writeFile(compatibility, "{}\n");
  await writeFile(acceptance, "{}\n");
  await writeFile(releaseManifestAttestation, attestation);
  const result = await buildPublicPredecessorCapsule({
    profile,
    releaseManifestPath: releaseManifest,
    releaseManifestAttestationPath: releaseManifestAttestation,
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
      expect(descriptor.sourceReceipt).toEqual({
        schemaVersion: 1,
        repository: "fased-ai/fased",
        tag: "v0.1.75",
        authority: "github-artifact-attestation",
        manifest: {
          name: "release.json",
          sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        manifestAttestation: {
          name: "release.json.attestation.json",
          sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      });
      expect(descriptor.releaseIndex).toBeNull();
      expect(descriptor.compatibilityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(descriptor.entries).toContainEqual(
        expect.objectContaining({
          path: `home/${profile === "hosting" ? "app" : "testop"}/.fased/runtime/current`,
          type: "symlink",
          target: "releases/0.1.75",
        }),
      );
      const archive = await inspectCapsuleArchive(result.archivePath, descriptor);
      expect(archive.size).toBe(descriptor.entries.length);
      const owner = profile === "hosting" ? "app" : "testop";
      const config = JSON.parse(
        archive.get(`home/${owner}/.fased/fased.json`)?.bytes.toString("utf8") ?? "null",
      );
      expect(config?.gateway?.mode).toBe(profile === "hosting" ? "remote" : "local");
      expect(config?.gateway?.remote?.token).toBe(config?.gateway?.auth?.token);
      const identity = JSON.parse(
        archive.get(`home/${owner}/.fased/identity/device.json`)?.bytes.toString("utf8") ?? "null",
      );
      expect(identity).toMatchObject({
        version: 1,
        createdAtMs: 0,
        deviceId: expect.stringMatching(/^[a-f0-9]{64}$/u),
        publicKeyPem: expect.stringContaining("BEGIN PUBLIC KEY"),
        privateKeyPem: expect.stringContaining("BEGIN PRIVATE KEY"),
      });
      const walletRegistry = JSON.parse(
        archive
          .get(`home/${owner}/.fased/wallet/provider-registry.v1.json`)
          ?.bytes.toString("utf8") ?? "null",
      );
      expect(walletRegistry).toMatchObject({
        version: 1,
        providers: {
          "embedded-keystore": { enabled: false },
          "local-socket-signer": { enabled: true },
          "wallet-standard": { enabled: true },
        },
        wallets: [],
        assignments: {},
      });
      const gateway = archive.get(`home/${owner}/.fased/runtime/releases/0.1.75/gateway.mjs`);
      expect(gateway?.bytes.toString("utf8")).toContain('runtimeSource:"managed-package"');
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

  it("binds the exact verified public-manifest attestation into the descriptor", async () => {
    const first = await fixture("hosting");
    const second = await fixture("hosting", '{"verificationResult":"different"}\n');
    expect(second.result.descriptor.sourceReceipt.manifestAttestation.sha256).not.toBe(
      first.result.descriptor.sourceReceipt.manifestAttestation.sha256,
    );
    expect(await readFile(second.result.descriptorPath, "utf8")).not.toBe(
      await readFile(first.result.descriptorPath, "utf8"),
    );
  });
});
