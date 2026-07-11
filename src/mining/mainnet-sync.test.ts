import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSatMainnetSyncStatus, syncSatMainnetRuntimeIds } from "./mainnet-sync.js";

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

  it("fails a live manifest clearly when this release has no trusted key", async () => {
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
          trustKeySource: "missing",
          verification: { hash: "valid", signature: "invalid" },
          error:
            "This Fased release has no trusted SAT mainnet manifest key. Update Fased before syncing or mining.",
        });
      },
    );
  });

  it("applies a live manifest only after hash and detached signature verify", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    const manifest = JSON.stringify({
      schema: "sat-mainnet-addresses.v1",
      network: "mainnet-beta",
      status: "live",
      releaseTag: "v1.0.0",
      sourceCommit: "abc123",
      sat: {
        mint: "sat-mint-mainnet",
        programId: "sat-program-mainnet",
        mintProgramId: "sat-mint-program-mainnet",
        bondProgramId: "sat-bond-program-mainnet",
      },
    });
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
        });

        expect(status.state).toBe("synced");
        expect(status.verification).toEqual({ hash: "valid", signature: "valid" });
        expect(status.trustKeySource).toBe("environment");
        expect(await readFile(runtimeFile, "utf8")).toContain(
          "FASED_SAT_PROGRAM_ID=sat-program-mainnet",
        );
        expect(env.FASED_SAT_MINT_ADDRESS).toBe("sat-mint-mainnet");
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
          trustKeySource: "environment",
          verification: { hash: "valid", signature: "invalid" },
        });

        const rotated = await getSatMainnetSyncStatus({
          env: {
            FASED_SAT_MAINNET_MANIFEST_PUBLIC_KEYS: `${String(wrongJwk.x)},${String(signerJwk.x)}`,
          },
          manifestUrl,
        });
        expect(rotated).toMatchObject({
          ok: true,
          state: "available",
          trustKeySource: "environment",
          verification: { hash: "valid", signature: "valid" },
        });
      },
    );
  });
});
