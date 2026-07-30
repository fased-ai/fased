import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCTION_ROOT_KEYSET_DIRECTORY,
  loadLifecycleRootKeyset,
} from "./lifecycle-trust-production-roots.mjs";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => fsp.rm(root, { recursive: true })));
});

describe("production lifecycle root public keys", () => {
  it("loads the exact three distinct owner-approved Ed25519 roots", async () => {
    const keyset = await loadLifecycleRootKeyset();
    expect(keyset).toMatchObject({
      schemaVersion: 1,
      threshold: 2,
      roots: [
        {
          name: "root-1",
          keyId: "a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a",
        },
        {
          name: "root-2",
          keyId: "93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971",
        },
        {
          name: "root-3",
          keyId: "65e5a3b316f86ddacfefd042b2e06bf9320e2e170bef2053541556ae8ba3573b",
        },
      ],
    });
    expect(new Set(keyset.roots.map(({ keyId }) => keyId)).size).toBe(3);
    expect(keyset.roots.every(({ publicKey }) => publicKey.keyType === "ed25519")).toBe(true);
  });

  it("rejects a manifest fingerprint that does not match its public key", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-root-keyset-"));
    cleanupRoots.push(root);
    await fsp.cp(PRODUCTION_ROOT_KEYSET_DIRECTORY, root, { recursive: true });
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    manifest.keys[0].keyId = "f".repeat(64);
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await expect(loadLifecycleRootKeyset(root)).rejects.toThrow(
      "fingerprint does not match its public key",
    );
  });

  it("rejects a symlinked public-key input", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-root-keyset-"));
    cleanupRoots.push(root);
    await fsp.cp(PRODUCTION_ROOT_KEYSET_DIRECTORY, root, { recursive: true });
    const publicKeyPath = path.join(root, "root-1.public.pem");
    await fsp.rm(publicKeyPath);
    await fsp.symlink(
      path.join(PRODUCTION_ROOT_KEYSET_DIRECTORY, "root-1.public.pem"),
      publicKeyPath,
    );

    await expect(loadLifecycleRootKeyset(root)).rejects.toThrow(
      "must be one regular single-link file",
    );
  });
});
