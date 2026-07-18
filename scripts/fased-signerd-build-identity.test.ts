import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSignerBuildInputDigest,
  signerIdentityLDFlags,
  validateSignerBuildIdentity,
} from "./fased-signerd-build-identity.mjs";

describe("native signer build identity", () => {
  it("hashes signer inputs deterministically and changes when an input changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "fased-signer-build-identity-"));
    await mkdir(path.join(root, "tools", "fased-signerd"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"version":"1.2.3"}\n');
    await writeFile(path.join(root, "tools", "fased-signerd", "main.go"), "package main\n");
    const first = await computeSignerBuildInputDigest(root);
    expect(await computeSignerBuildInputDigest(root)).toBe(first);
    await writeFile(path.join(root, "tools", "fased-signerd", "main.go"), "package main\n\n");
    expect(await computeSignerBuildInputDigest(root)).not.toBe(first);
  });

  it("fails closed on incomplete release identity and emits exact ldflags", () => {
    const release = {
      version: "1.2.3",
      commit: "a".repeat(40),
      buildInputDigest: `sha256:${"b".repeat(64)}`,
      development: false,
    };
    expect(signerIdentityLDFlags(release)).toContain("main.signerBuildVersion=1.2.3");
    expect(() => validateSignerBuildIdentity({ ...release, commit: "unknown" })).toThrow(
      "release signer identity requires",
    );
    expect(() => validateSignerBuildIdentity({ ...release, development: "false" })).toThrow(
      "must be true or false",
    );
  });
});
