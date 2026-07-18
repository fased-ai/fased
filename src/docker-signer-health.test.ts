import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDockerSignerHealth,
  validateDockerSignerHealthEnvelope,
} from "../scripts/docker-signer-health.mjs";

const healthScript = fileURLToPath(new URL("../scripts/docker-signer-health.mjs", import.meta.url));
const requiredFeatures = [
  "failClosedPolicies",
  "durableCaps",
  "atomicMultiAssetCaps",
  "signerControlledNativeFeeCaps",
  "atomicIdempotency",
  "signerOwnedKeys",
  "typedSolanaTransactions",
];
const developmentRelease = {
  version: "dev",
  commit: "unknown",
  buildInputDigest: "unknown",
  development: true,
};
const productionRelease = {
  version: "9.9.9",
  commit: "a".repeat(40),
  buildInputDigest: `sha256:${"b".repeat(64)}`,
  development: false,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Docker native signer health", () => {
  it("requires a ready protocol-v2 signer with the security capabilities Docker depends on", () => {
    const healthy = {
      ok: true,
      result: {
        ready: true,
        release: developmentRelease,
        capabilities: {
          protocol: { current: 2, min: 2, max: 2 },
          nativeFeeReservationLamports: 5_000_000,
          features: requiredFeatures,
        },
      },
    };

    expect(validateDockerSignerHealthEnvelope(healthy)).toBe(true);
    expect(
      validateDockerSignerHealthEnvelope({
        ...healthy,
        result: {
          ...healthy.result,
          capabilities: { ...healthy.result.capabilities, features: ["signerOwnedKeys"] },
        },
      }),
    ).toBe(false);
    expect(validateDockerSignerHealthEnvelope({ ok: true, result: { ready: false } })).toBe(false);
    expect(
      validateDockerSignerHealthEnvelope({
        ...healthy,
        result: { ...healthy.result, release: undefined },
      }),
    ).toBe(false);
    expect(
      validateDockerSignerHealthEnvelope({
        ...healthy,
        result: {
          ...healthy.result,
          capabilities: {
            ...healthy.result.capabilities,
            nativeFeeReservationLamports: 5_000_001,
          },
        },
      }),
    ).toBe(false);
  });

  it("binds production health to the complete expected release identity", () => {
    const healthy = {
      ok: true,
      result: {
        ready: true,
        release: productionRelease,
        capabilities: {
          protocol: { current: 2, min: 2, max: 2 },
          nativeFeeReservationLamports: 5_000_000,
          features: requiredFeatures,
        },
      },
    };
    const expected = {
      expectedVersion: productionRelease.version,
      expectedCommit: productionRelease.commit,
      expectedBuildInputDigest: productionRelease.buildInputDigest,
      expectedDevelopment: false,
      requireProduction: true,
    };

    expect(validateDockerSignerHealthEnvelope(healthy, expected)).toBe(true);
    expect(
      validateDockerSignerHealthEnvelope(healthy, {
        ...expected,
        expectedCommit: "c".repeat(40),
      }),
    ).toBe(false);
    expect(
      validateDockerSignerHealthEnvelope(
        { ...healthy, result: { ...healthy.result, release: developmentRelease } },
        expected,
      ),
    ).toBe(false);
  });

  it("probes the Unix socket and rejects an incompatible response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fased-docker-signer-health-"));
    roots.push(root);
    const socketPath = path.join(root, "app.sock");
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          `${JSON.stringify({
            ok: true,
            result: {
              ready: true,
              release: developmentRelease,
              capabilities: {
                protocol: { current: 2, min: 2, max: 2 },
                nativeFeeReservationLamports: 5_000_000,
                features: requiredFeatures,
              },
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(
        checkDockerSignerHealth(socketPath, { timeoutMs: 1_000 }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails closed when the signer socket is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fased-docker-signer-missing-"));
    roots.push(root);
    const socketPath = path.join(root, "missing.sock");

    await expect(checkDockerSignerHealth(socketPath, { timeoutMs: 100 })).rejects.toBeDefined();
    const processResult = spawnSync(process.execPath, [healthScript, socketPath], {
      encoding: "utf8",
    });
    expect(processResult.status).toBe(1);
    expect(processResult.stderr).toContain("fased-signerd unhealthy");
  });
});
