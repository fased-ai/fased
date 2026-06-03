import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSatMainnetSyncStatus, syncSatMainnetRuntimeIds } from "./mainnet-sync.js";

afterEach(() => {
  vi.unstubAllEnvs();
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
  const server = http.createServer((req, res) => {
    const requestPath = req.url ?? "/";
    const body = files[requestPath];
    if (body == null) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader(
      "content-type",
      requestPath.endsWith(".json") ? "application/json" : "text/plain",
    );
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind to a TCP port");
    }
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
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
        expect(await readFile(runtimeFile, "utf8")).toContain(
          "FASED_SAT_PROGRAM_ID=sat-program-mainnet",
        );
        expect(env.FASED_SAT_MINT_ADDRESS).toBe("sat-mint-mainnet");
      },
    );
  });
});
