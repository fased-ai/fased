import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayReadinessPayload, resolveGatewayGenerationReceipt } from "./probe-payload.js";

const commit = "b".repeat(40);
const sha = "a".repeat(64);
const generationId = `sha256:${"c".repeat(64)}`;

describe("Gateway generation receipt", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function runtimeRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "fased-gateway-receipt-"));
    roots.push(root);
    mkdirSync(path.join(root, "dist"));
    writeFileSync(
      path.join(root, ".fased-hosted-runtime.json"),
      JSON.stringify({ schemaVersion: 2, version: "0.1.76", commit, dependencyHash: sha }),
    );
    writeFileSync(
      path.join(root, ".fased-hosted-release-v2.json"),
      JSON.stringify({
        schemaVersion: 2,
        release: { version: "0.1.76", commit },
        application: {
          linux: {
            x64: { artifact: { sha256: sha }, dependencies: { sha256: sha, dependencyHash: sha } },
          },
        },
      }),
    );
    writeFileSync(
      path.join(root, "dist", "build-info.json"),
      JSON.stringify({ version: "0.1.76", commit }),
    );
    return root;
  }

  it("binds the process environment generation id to packaged release evidence", () => {
    const receipt = resolveGatewayGenerationReceipt(runtimeRoot(), "x64", {
      FASED_GENERATION_ID: generationId,
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      generationId,
      version: "0.1.76",
      releaseCommit: commit,
    });
  });

  it("fails closed when the managed process lacks a generation id", () => {
    expect(resolveGatewayGenerationReceipt(runtimeRoot(), "x64", {})).toBeNull();
  });

  it("builds readiness with one explicitly bound runtime environment", () => {
    const payload = buildGatewayReadinessPayload(
      { ready: true, failing: [], uptimeMs: 45_000 },
      {
        runtimeEntrypoint: runtimeRoot(),
        architecture: "x64",
        pid: 1463,
        startedAt: "2026-08-13T21:13:31.326Z",
        env: {
          FASED_GENERATION_ID: generationId,
          FASED_RUNTIME_SOURCE: "managed-package",
          FASED_VERSION: "0.1.76",
        },
      },
    );

    expect(payload).toMatchObject({
      ok: true,
      status: "ready",
      ready: true,
      pid: 1463,
      startedAt: "2026-08-13T21:13:31.326Z",
      version: "0.1.76",
      runtimeSource: "managed-package",
      generation: { generationId },
    });
  });
});
