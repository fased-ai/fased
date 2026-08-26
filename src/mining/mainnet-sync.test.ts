import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSatMainnetSyncStatus, syncSatMainnetRuntimeIds } from "./mainnet-sync.js";
import { SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT } from "./sat-vnext-release-contract.generated.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonDataUrl(value: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(value))}`;
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const COMPLETE_IDS = {
  mint: "SATbcgGdy8DiE9T2y3GuCHDiQdt9623ptqVuMAybgRg", // pragma: allowlist secret
  programId: "DUWcfXrUu2nK6fBJ4VjcnGmkBa62BNBEm4LDo25ppNBT", // pragma: allowlist secret
  mintProgramId: "dv8wQtfGhHcxXtAPb7ds9nhJxR3PuLBmAxcJfsxy6VU", // pragma: allowlist secret
  bondProgramId: "5VfyRReAeFQLetD7zxQgf5kL7UQHKyk6Tat6VUxzMPeQ", // pragma: allowlist secret
} as const;
const SOURCE_COMMIT = "a".repeat(40);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function completeReleaseDescriptor() {
  const descriptor = {
    $schema: "sat.release-descriptor.v2",
    descriptorVersion: 2,
    stage: "deployed-release",
    source: { status: "BOUND", commit: SOURCE_COMMIT, tree: "b".repeat(40) },
    componentGenerations: {
      status: "BOUND",
      tuple: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations,
    },
    build: {
      status: "BOUND",
      genesis: {
        cluster: "mainnet-beta",
        satMint: COMPLETE_IDS.mint,
        programIds: {
          mining: COMPLETE_IDS.programId,
          mint: COMPLETE_IDS.mintProgramId,
          bond: COMPLETE_IDS.bondProgramId,
        },
      },
    },
    interfaces: {
      status: "BOUND",
      interfaceContractSha256: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.interfaceContractSha256,
      idlSha256: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.idlSha256,
      accountOrderSha256: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.accountOrderSha256,
      stateLayoutsSha256: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.stateLayoutsSha256,
      signerCodecsSha256: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.signerCodecsSha256,
    },
    deployment: {
      status: "BOUND",
      reason: "finalized readback",
      commitment: "finalized",
      programs: [
        {
          role: "mining",
          programId: COMPLETE_IDS.programId,
          programDataAddress: COMPLETE_IDS.programId,
          deploymentSlot: 101,
          deployedByteSha256: `sha256:${"1".repeat(64)}`,
          upgradeAuthority: null,
        },
        {
          role: "mint",
          programId: COMPLETE_IDS.mintProgramId,
          programDataAddress: COMPLETE_IDS.mintProgramId,
          deploymentSlot: 102,
          deployedByteSha256: `sha256:${"2".repeat(64)}`,
          upgradeAuthority: null,
        },
        {
          role: "bond",
          programId: COMPLETE_IDS.bondProgramId,
          programDataAddress: COMPLETE_IDS.bondProgramId,
          deploymentSlot: 103,
          deployedByteSha256: `sha256:${"3".repeat(64)}`,
          upgradeAuthority: null,
        },
      ],
    },
    runtimeCompatibility: {
      status: "BOUND",
      reason: "exact generated client and signer",
      minimumFasedVersion: "0.1.0",
      miningContractDigest: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.interfaceContractSha256,
      signerCapability: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT.componentGenerations.signerCapability,
      signerAcknowledgement: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT,
    },
    publication: { status: "BOUND", reason: "signed address manifest" },
    receiptBinding: {
      status: "BOUND",
      reason: "candidate and deployment receipts",
      candidateReceiptDigest: `sha256:${"4".repeat(64)}`,
      deploymentReceiptDigest: `sha256:${"5".repeat(64)}`,
    },
  };
  return {
    ...descriptor,
    descriptorDigest: `sha256:${sha256(`${JSON.stringify(canonicalize(descriptor))}\n`)}`,
  };
}

function refreshDescriptorDigest(
  descriptor: ReturnType<typeof completeReleaseDescriptor>,
): Record<string, unknown> {
  const unsigned = Object.fromEntries(
    Object.entries(descriptor).filter(([key]) => key !== "descriptorDigest"),
  );
  return {
    ...unsigned,
    descriptorDigest: `sha256:${sha256(`${JSON.stringify(canonicalize(unsigned))}\n`)}`,
  };
}

function completeManifest() {
  return {
    schema: "sat-mainnet-addresses.v1",
    network: "mainnet-beta",
    status: "live",
    releaseTag: "v1.0.0",
    sourceCommit: SOURCE_COMMIT,
    sat: COMPLETE_IDS,
    releaseDescriptor: completeReleaseDescriptor(),
  };
}

async function readProductionKeyFixture() {
  const fixturePath = path.join(
    import.meta.dirname,
    "fixtures",
    "sat-mainnet-addresses.production-key-test.json",
  );
  return {
    manifest: await readFile(fixturePath, "utf8"),
    hash: await readFile(`${fixturePath}.sha256`, "utf8"),
    signature: await readFile(`${fixturePath}.sig`, "utf8"),
  };
}

async function withManifestServer(
  files: Record<string, string>,
  fn: (baseUrl: string) => Promise<void>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const requestUrl = input instanceof Request ? input.url : input;
      const requestPath = new URL(requestUrl).pathname;
      const body = files[requestPath];
      return body == null
        ? new Response("not found", { status: 404 })
        : new Response(body, {
            status: 200,
            headers: {
              "content-type": requestPath.endsWith(".json") ? "application/json" : "text/plain",
            },
          });
    }),
  );
  await fn("https://manifest.test");
}

describe("SAT mainnet sync", () => {
  it("reports pre-launch not_live manifest without requiring signature", async () => {
    const status = await getSatMainnetSyncStatus({
      env: {},
      manifestUrl: jsonDataUrl({
        schema: "sat-mainnet-addresses.v1",
        network: "mainnet-beta",
        status: "not_live",
      }),
    });

    expect(status.ok).toBe(true);
    expect(status.state).toBe("not_live");
    expect(status.verification).toEqual({ hash: "not_required", signature: "not_required" });
    expect(status.trustKeySource).toBe("not_required");
  });

  it("rejects a live manifest signed by an untrusted key", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const manifest = JSON.stringify({
      schema: "sat-mainnet-addresses.v1",
      network: "mainnet-beta",
      status: "live",
      sat: {
        mint: "sat-mint-mainnet",
        programId: "sat-program-mainnet",
        mintProgramId: "sat-mint-program-mainnet",
        bondProgramId: "sat-bond-program-mainnet",
      },
    });
    const signature = sign(null, Buffer.from(manifest), privateKey).toString("base64");

    await withManifestServer(
      {
        "/sat-mainnet-addresses.json": manifest,
        "/sat-mainnet-addresses.json.sha256": sha256(manifest),
        "/sat-mainnet-addresses.json.sig": signature,
      },
      async (baseUrl) => {
        const status = await getSatMainnetSyncStatus({
          env: {},
          manifestUrl: `${baseUrl}/sat-mainnet-addresses.json`,
        });
        expect(status).toMatchObject({
          ok: false,
          state: "failed",
          trustKeySource: "embedded",
          verification: { hash: "valid", signature: "invalid" },
          error: "Signed manifest verification failed.",
        });
      },
    );
  });

  it("verifies the rehearsal signature but rejects its incomplete legacy release binding", async () => {
    const fixture = await readProductionKeyFixture();

    await withManifestServer(
      {
        "/sat-mainnet-addresses.json": fixture.manifest,
        "/sat-mainnet-addresses.json.sha256": fixture.hash,
        "/sat-mainnet-addresses.json.sig": fixture.signature,
      },
      async (baseUrl) => {
        const status = await getSatMainnetSyncStatus({
          env: {},
          manifestUrl: `${baseUrl}/sat-mainnet-addresses.json`,
        });
        expect(status).toMatchObject({
          ok: false,
          state: "failed",
          trustKeySource: "embedded",
          verification: { hash: "valid", signature: "valid" },
          error: "SAT release descriptor is not complete: descriptor is missing",
        });
      },
    );
  });

  it("rejects a modified production-key fixture before signature verification", async () => {
    const fixture = await readProductionKeyFixture();

    await withManifestServer(
      {
        "/sat-mainnet-addresses.json": fixture.manifest.replace(
          "test-only-sat-mint",
          "modified-test-only-sat-mint",
        ),
        "/sat-mainnet-addresses.json.sha256": fixture.hash,
        "/sat-mainnet-addresses.json.sig": fixture.signature,
      },
      async (baseUrl) => {
        const status = await getSatMainnetSyncStatus({
          env: {},
          manifestUrl: `${baseUrl}/sat-mainnet-addresses.json`,
        });
        expect(status).toMatchObject({
          ok: false,
          state: "failed",
          trustKeySource: "embedded",
          verification: { hash: "invalid", signature: "missing" },
        });
      },
    );
  });

  it("applies a live manifest only after hash and detached signature verify", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    const manifest = JSON.stringify(completeManifest());
    const signature = sign(null, Buffer.from(manifest), privateKey).toString("base64");
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "fased-sat-mainnet-sync-"));
    const runtimeFile = path.join(runtimeDir, "sat-runtime.env");

    await withManifestServer(
      {
        "/sat-mainnet-addresses.json": manifest,
        "/sat-mainnet-addresses.json.sha256": `${sha256(manifest)}  sat-mainnet-addresses.json\n`,
        "/sat-mainnet-addresses.json.sig": `${signature}\n`,
      },
      async (baseUrl) => {
        const env: NodeJS.ProcessEnv = {
          FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY: String(publicJwk.x),
          FASED_SAT_RUNTIME_ENV_FILE: runtimeFile,
          FASED_SAT_PROGRAM_ID: "old-program",
          FASED_SAT_BOND_PROGRAM_ID: "old-bond",
          FASED_SAT_MINT_ADDRESS: "old-mint",
          FASED_SAT_MINT_PROGRAM_ID: "old-mint-program",
        };
        const status = await syncSatMainnetRuntimeIds({
          env,
          manifestUrl: `${baseUrl}/sat-mainnet-addresses.json`,
          signerAcknowledgement: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT,
        });

        expect(status.state).toBe("available");
        expect(status.verification).toEqual({ hash: "valid", signature: "valid" });
        expect(status.trustKeySource).toBe("environment");
        expect(await readFile(runtimeFile, "utf8")).toContain(
          `FASED_SAT_PROGRAM_ID=${COMPLETE_IDS.programId}`,
        );
        expect(await readFile(runtimeFile, "utf8")).toContain(
          `FASED_SAT_RUNTIME_MANIFEST_SHA256=${sha256(manifest)}`,
        );
        expect(await readFile(`${runtimeFile}.manifest.json`, "utf8")).toBe(manifest);
        expect((await readFile(`${runtimeFile}.manifest.sig`, "utf8")).trim()).toBe(signature);
        expect(env.FASED_SAT_RUNTIME_MANIFEST_PATH).toBe(`${runtimeFile}.manifest.json`);
        expect(env.FASED_SAT_MINT_ADDRESS).toBe(COMPLETE_IDS.mint);
        expect(status.installedDescriptorDigest).toBe(status.releaseDescriptorDigest);
        expect(status.message).toContain("remains inactive");
      },
    );
  });

  it("does not report synced from a signed four-ID manifest even when all local IDs match", async () => {
    const signer = generateKeyPairSync("ed25519");
    const signerJwk = signer.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const legacyManifest = JSON.stringify({
      schema: "sat-mainnet-addresses.v1",
      network: "mainnet-beta",
      status: "live",
      sourceCommit: SOURCE_COMMIT,
      sat: COMPLETE_IDS,
    });
    const signature = sign(null, Buffer.from(legacyManifest), signer.privateKey).toString("base64");

    await withManifestServer(
      {
        "/sat-mainnet-addresses.json": legacyManifest,
        "/sat-mainnet-addresses.json.sha256": sha256(legacyManifest),
        "/sat-mainnet-addresses.json.sig": signature,
      },
      async (baseUrl) => {
        const status = await getSatMainnetSyncStatus({
          env: {
            FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY: String(signerJwk.x),
            FASED_SAT_PROGRAM_ID: COMPLETE_IDS.programId,
            FASED_SAT_BOND_PROGRAM_ID: COMPLETE_IDS.bondProgramId,
            FASED_SAT_MINT_ADDRESS: COMPLETE_IDS.mint,
            FASED_SAT_MINT_PROGRAM_ID: COMPLETE_IDS.mintProgramId,
          },
          manifestUrl: `${baseUrl}/sat-mainnet-addresses.json`,
          signerAcknowledgement: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT,
        });
        expect(status).toMatchObject({
          ok: false,
          state: "failed",
          needsSync: false,
          error: "SAT release descriptor is not complete: descriptor is missing",
        });
      },
    );
  });

  it("rejects descriptor drift in finalized deployment and installed client identities", async () => {
    const cases: Array<{
      expectedError: string;
      mutate: (descriptor: ReturnType<typeof completeReleaseDescriptor>) => void;
    }> = [
      {
        mutate: (descriptor) => {
          descriptor.deployment.commitment = "confirmed";
        },
        expectedError:
          "SAT release descriptor is not complete: deployment commitment is not finalized",
      },
      {
        mutate: (descriptor) => {
          Object.assign(descriptor.interfaces, { idlSha256: `sha256:${"e".repeat(64)}` });
        },
        expectedError:
          "SAT release descriptor is not complete: interfaces.idlSha256 does not match the installed client contract",
      },
    ];

    for (const testCase of cases) {
      const signer = generateKeyPairSync("ed25519");
      const signerJwk = signer.publicKey.export({ format: "jwk" }) as JsonWebKey;
      const descriptor = completeReleaseDescriptor();
      testCase.mutate(descriptor);
      const manifest = JSON.stringify({
        ...completeManifest(),
        releaseDescriptor: refreshDescriptorDigest(descriptor),
      });
      const signature = sign(null, Buffer.from(manifest), signer.privateKey).toString("base64");

      await withManifestServer(
        {
          "/sat-mainnet-addresses.json": manifest,
          "/sat-mainnet-addresses.json.sha256": sha256(manifest),
          "/sat-mainnet-addresses.json.sig": signature,
        },
        async (baseUrl) => {
          const status = await getSatMainnetSyncStatus({
            env: { FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY: String(signerJwk.x) },
            manifestUrl: `${baseUrl}/sat-mainnet-addresses.json`,
            signerAcknowledgement: SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT,
          });
          expect(status).toMatchObject({
            ok: false,
            state: "failed",
            error: testCase.expectedError,
          });
        },
      );
    }
  });

  it("rejects a complete descriptor when the native signer acknowledgement differs", async () => {
    const signer = generateKeyPairSync("ed25519");
    const signerJwk = signer.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const manifest = JSON.stringify(completeManifest());
    const signature = sign(null, Buffer.from(manifest), signer.privateKey).toString("base64");

    await withManifestServer(
      {
        "/sat-mainnet-addresses.json": manifest,
        "/sat-mainnet-addresses.json.sha256": sha256(manifest),
        "/sat-mainnet-addresses.json.sig": signature,
      },
      async (baseUrl) => {
        const status = await getSatMainnetSyncStatus({
          env: { FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY: String(signerJwk.x) },
          manifestUrl: `${baseUrl}/sat-mainnet-addresses.json`,
          signerAcknowledgement: {
            ...SAT_VNEXT_RELEASE_ACKNOWLEDGEMENT,
            state: "FROZEN_NOT_ACTIVE",
            idlSha256: `sha256:${"f".repeat(64)}`,
          },
        });
        expect(status).toMatchObject({
          ok: false,
          state: "failed",
          error:
            "SAT release descriptor is not complete: native signer acknowledgement does not match the installed client contract",
        });
      },
    );
  });

  it("rejects an invalid rehearsal key and accepts a rotated valid key", async () => {
    const signer = generateKeyPairSync("ed25519");
    const wrong = generateKeyPairSync("ed25519");
    const signerJwk = signer.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const wrongJwk = wrong.publicKey.export({ format: "jwk" }) as JsonWebKey;
    const manifest = JSON.stringify({
      schema: "sat-mainnet-addresses.v1",
      network: "mainnet-beta",
      status: "live",
      sat: {
        mint: "sat-mint-mainnet",
        programId: "sat-program-mainnet",
        mintProgramId: "sat-mint-program-mainnet",
        bondProgramId: "sat-bond-program-mainnet",
      },
    });
    const signature = sign(null, Buffer.from(manifest), signer.privateKey).toString("base64");

    await withManifestServer(
      {
        "/sat-mainnet-addresses.json": manifest,
        "/sat-mainnet-addresses.json.sha256": sha256(manifest),
        "/sat-mainnet-addresses.json.sig": signature,
      },
      async (baseUrl) => {
        const manifestUrl = `${baseUrl}/sat-mainnet-addresses.json`;
        const invalid = await getSatMainnetSyncStatus({
          env: { FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEY: String(wrongJwk.x) },
          manifestUrl,
        });
        expect(invalid).toMatchObject({
          ok: false,
          trustKeySource: "embedded",
          verification: { hash: "valid", signature: "invalid" },
        });

        const rotated = await getSatMainnetSyncStatus({
          env: {
            FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEYS: `${String(wrongJwk.x)},${String(signerJwk.x)}`,
          },
          manifestUrl,
        });
        expect(rotated).toMatchObject({
          ok: false,
          state: "failed",
          trustKeySource: "environment",
          verification: { hash: "valid", signature: "valid" },
          error: "SAT release descriptor is not complete: descriptor is missing",
        });
      },
    );
  });
});
