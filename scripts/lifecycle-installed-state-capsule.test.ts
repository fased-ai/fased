import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInstalledStateCapsule,
  parseInstalledStateCapsule,
} from "./lifecycle-installed-state-capsule.mjs";
import { inspectCapsuleArchive } from "./restore-predecessor-capsule.mjs";

const temporary: string[] = [];
const digest = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function descriptor(entryDigest: string) {
  return {
    schemaVersion: 1,
    role: "fased-sanitized-predecessor-capsule",
    profile: "hosting",
    compatibilityGroupId: "public-stable-hosting-v1",
    compatibilityDigest: `sha256:${"f".repeat(64)}`,
    release: { version: "0.1.75", commit: "a".repeat(40), tree: "b".repeat(40) },
    sourceReceipt: {
      schemaVersion: 1,
      repository: "fased-ai/fased",
      tag: "v0.1.75",
      authority: "github-artifact-attestation",
      manifest: { name: "release.json", sha256: `sha256:${"1".repeat(64)}` },
      manifestAttestation: {
        name: "release.json.attestation.json",
        sha256: `sha256:${"2".repeat(64)}`,
      },
    },
    releaseIndex: null,
    topology: {
      schemaVersion: 1,
      kind: "public-stable",
      capabilities: ["hosting-systemd", "external-signer"],
    },
    ownership: { rootUid: 0, rootGid: 0, operatorUid: 1000, operatorGid: 1000 },
    pointers: { current: `sha256:${"d".repeat(64)}`, previous: null },
    expectedReceiptDigest: `sha256:${"e".repeat(64)}`,
    archive: { name: "capsule.tar", size: 1, sha256: `sha256:${"c".repeat(64)}` },
    sanitization: { syntheticState: true, containsSecrets: false },
    services: [
      "fased-host-updater.service",
      "fased-host-controller.service",
      "fased-signerd.service",
      "fased-gateway.service",
    ],
    entries: [
      {
        path: "var/lib/fased-lifecycled/installation-manifest.json",
        type: "file",
        mode: 0o600,
        owner: "root",
        sha256: entryDigest,
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("sanitized installed-state capsules", () => {
  it("builds deterministic sanitized bytes without replaying an installer", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "fased-capsule-source-"));
    const output = await mkdtemp(path.join(tmpdir(), "fased-capsule-output-"));
    temporary.push(sourceRoot, output);
    const relative = "var/lib/fased-lifecycled/installation-manifest.json";
    await mkdir(path.join(sourceRoot, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(sourceRoot, relative), '{"schemaVersion":1}\n');
    const base = descriptor(digest('{"schemaVersion":1}\n'));
    const result = await buildInstalledStateCapsule({
      sourceRoot,
      outputDirectory: output,
      spec: {
        schemaVersion: 1,
        role: "fased-installed-state-capsule-spec",
        profile: base.profile,
        compatibilityGroupId: base.compatibilityGroupId,
        compatibilityDigest: base.compatibilityDigest,
        release: base.release,
        sourceReceipt: base.sourceReceipt,
        releaseIndex: base.releaseIndex,
        topology: base.topology,
        ownership: {
          ...base.ownership,
          operatorUid: process.getuid?.() ?? 1000,
          operatorGid: process.getgid?.() ?? 1000,
        },
        pointers: base.pointers,
        expectedReceiptDigest: base.expectedReceiptDigest,
        sanitization: base.sanitization,
        services: base.services,
        archiveName: "fased-predecessor-hosting-0.1.75.tar.gz",
        entries: [{ path: relative, type: "file", owner: "operator" }],
      },
    });
    expect(parseInstalledStateCapsule(result.descriptor)).toBe(result.descriptor);
    expect(result.descriptor.entries[0].sha256).toBe(digest('{"schemaVersion":1}\n'));
  });

  it("binds every archived byte to the sanitized descriptor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fased-capsule-"));
    temporary.push(root);
    const relative = "var/lib/fased-lifecycled/installation-manifest.json";
    const source = path.join(root, relative);
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, '{"schemaVersion":1}\n');
    const archive = path.join(root, "capsule.tar");
    await tar.c({ cwd: root, file: archive }, [relative]);
    const capsule = descriptor(digest('{"schemaVersion":1}\n'));
    expect(parseInstalledStateCapsule(capsule)).toBe(capsule);
    const entries = await inspectCapsuleArchive(archive, capsule);
    expect(entries.get(relative)?.bytes.toString()).toBe('{"schemaVersion":1}\n');
  });

  it("binds a confined managed-runtime pointer without following it while building", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "fased-capsule-source-"));
    const output = await mkdtemp(path.join(tmpdir(), "fased-capsule-output-"));
    temporary.push(sourceRoot, output);
    await mkdir(path.join(sourceRoot, "home/operator/.fased/runtime/releases/0.1.75"), {
      recursive: true,
    });
    await symlink("releases/0.1.75", path.join(sourceRoot, "home/operator/.fased/runtime/current"));
    const base = descriptor(digest("unused"));
    const result = await buildInstalledStateCapsule({
      sourceRoot,
      outputDirectory: output,
      spec: {
        schemaVersion: 1,
        role: "fased-installed-state-capsule-spec",
        profile: base.profile,
        compatibilityGroupId: base.compatibilityGroupId,
        compatibilityDigest: base.compatibilityDigest,
        release: base.release,
        sourceReceipt: base.sourceReceipt,
        releaseIndex: base.releaseIndex,
        topology: base.topology,
        ownership: base.ownership,
        pointers: base.pointers,
        expectedReceiptDigest: base.expectedReceiptDigest,
        sanitization: base.sanitization,
        services: base.services,
        archiveName: "pointer.tar.gz",
        entries: [
          {
            path: "home/operator/.fased/runtime/current",
            type: "symlink",
            owner: "operator",
          },
        ],
      },
    });
    expect(result.descriptor.entries[0]).toEqual({
      path: "home/operator/.fased/runtime/current",
      type: "symlink",
      owner: "operator",
      target: "releases/0.1.75",
    });
  });

  it("rejects absolute and escaping symbolic-link targets", () => {
    const base = descriptor(digest("unused"));
    const link = {
      path: "home/operator/.fased/runtime/current",
      type: "symlink",
      owner: "operator",
      target: "../../../../etc",
    };
    expect(() => parseInstalledStateCapsule({ ...base, entries: [link] })).toThrow(
      "entry inventory is unsafe",
    );
    expect(() =>
      parseInstalledStateCapsule({ ...base, entries: [{ ...link, target: "/etc" }] }),
    ).toThrow("entry inventory is unsafe");
  });

  it("rejects secret paths and archive bytes not declared by the capsule", async () => {
    const capsule = descriptor(digest("expected"));
    expect(() =>
      parseInstalledStateCapsule({
        ...capsule,
        entries: [{ ...capsule.entries[0], path: "var/lib/fased-signerd/master.key" }],
      }),
    ).toThrow("secret-bearing");

    const root = await mkdtemp(path.join(tmpdir(), "fased-capsule-"));
    temporary.push(root);
    const relative = capsule.entries[0].path;
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), "different");
    const archive = path.join(root, "capsule.tar");
    await tar.c({ cwd: root, file: archive }, [relative]);
    await expect(inspectCapsuleArchive(archive, capsule)).rejects.toThrow("digest mismatch");
  });
});
