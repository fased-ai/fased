import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractGeneration,
  generationLifecycle,
  runGenerationInitialize,
  runGenerationUpdate,
  stageInitializerExecutable,
} from "./generation-updater.mjs";

const temporary: string[] = [];
const version = "1.2.3";
const assetName = `fased-generation-linux-x64-v${version}.tar.gz`;
const dependencyHash = "c".repeat(64);
const dependencyAssetName = `fased-hosted-deps-linux-x64-${dependencyHash}.tar.gz`;

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await fsp.rm(directory, { recursive: true, force: true });
  }
});

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fsp.readFile(file));
  return `sha256:${hash.digest("hex")}`;
}

async function fixture(linkTarget = "../tool/bin/cli.js") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-generation-updater-"));
  temporary.push(root);
  const archiveRoot = path.join(root, "archive");
  await fsp.mkdir(path.join(archiveRoot, "generation", "payload", "bin"), { recursive: true });
  const dependencyRoot = path.join(root, "dependency");
  await fsp.mkdir(path.join(dependencyRoot, "node_modules", "tool"), { recursive: true });
  await fsp.writeFile(path.join(dependencyRoot, "node_modules", "tool", "index.js"), "exact\n");
  const dependencyArchive = path.join(root, dependencyAssetName);
  await tar.c({ cwd: dependencyRoot, file: dependencyArchive, gzip: true, portable: true }, [
    "node_modules",
  ]);
  const dependencySHA256 = await digest(dependencyArchive);
  await fsp.writeFile(
    path.join(archiveRoot, "generation", "inventory.json"),
    `${JSON.stringify({
      schemaVersion: 3,
      dependency: {
        hash: dependencyHash,
        asset: dependencyAssetName,
        archiveSHA256: dependencySHA256,
      },
    })}\n`,
  );
  await fsp.writeFile(path.join(archiveRoot, "generation", "payload", "bin", "fased"), "exact\n", {
    mode: 0o755,
  });
  const runtimeModules = path.join(archiveRoot, "generation", "payload", "runtime", "node_modules");
  await fsp.mkdir(path.join(runtimeModules, "tool", "bin"), { recursive: true });
  await fsp.mkdir(path.join(runtimeModules, ".bin"), { recursive: true });
  await fsp.writeFile(path.join(runtimeModules, "tool", "bin", "cli.js"), "exact tool\n");
  await fsp.symlink(linkTarget, path.join(runtimeModules, ".bin", "tool"));
  const archive = path.join(root, assetName);
  await tar.c({ cwd: archiveRoot, file: archive, gzip: true, portable: true }, ["generation"]);
  const stat = await fsp.stat(archive);
  const dependencyStat = await fsp.stat(dependencyArchive);
  const artifacts = [
    { name: assetName, sha256: await digest(archive), size: stat.size },
    { name: dependencyAssetName, sha256: dependencySHA256, size: dependencyStat.size },
  ];
  const descriptor = {
    schemaVersion: 3,
    version,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    lockfileDigest: `sha256:${"c".repeat(64)}`,
    sourceRef: `refs/tags/v${version}`,
    workflowRunId: "1",
    workflowRunAttempt: "1",
    artifacts,
    artifactSetDigest: `sha256:${createHash("sha256").update(JSON.stringify(artifacts)).digest("hex")}`,
  };
  const descriptorPath = path.join(root, "fased-hosting-candidate.json");
  await fsp.writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
  const bundlePath = `${descriptorPath}.attestation.json`;
  await fsp.writeFile(bundlePath, "attestation\n");
  return { root, archive, dependencyArchive, descriptorPath, bundlePath };
}

describe("generation updater", () => {
  it("delegates root-only lifecycle configuration validation to the supervisor", () => {
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation((candidate) => {
      if (String(candidate) === "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled") {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          mode: 0o100755,
        } as fs.Stats;
      }
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    try {
      expect(
        generationLifecycle({
          profile: "protected-local",
          instance: "0123456789abcdef",
          config: "/var/lib/fased-local/0123456789abcdef/lifecycle/platform.json",
        }),
      ).toEqual({
        instance: "0123456789abcdef",
        config: "/var/lib/fased-local/0123456789abcdef/lifecycle/platform.json",
        supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
      });
      expect(lstat).toHaveBeenCalledTimes(1);
    } finally {
      lstat.mockRestore();
    }
  });

  it("stages an initializer outside a no-exec download directory and cleans safely", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-generation-stage-"));
    temporary.push(root);
    await fsp.chmod(root, 0o700);
    const source = path.join(root, "source");
    await fsp.writeFile(source, "verified bytes\n", { mode: 0o600 });
    const stage = await stageInitializerExecutable(source, root);
    expect(await fsp.readFile(stage.executable, "utf8")).toBe("verified bytes\n");
    expect((await fsp.stat(stage.executable)).mode & 0o777).toBe(0o500);
    await fsp.rm(stage.directory, { recursive: true, force: true });
  });

  it("downloads descriptor-bound bytes, stages once, and delegates one privileged apply", async () => {
    const value = await fixture();
    const verify = vi.fn(async () => undefined);
    const administrator = vi.fn(async (_command, args: string[]) => ({
      ok: true,
      stdout: args.includes("stage")
        ? `${JSON.stringify({ id: `sha256:${"a".repeat(64)}`, version })}\n`
        : `${JSON.stringify({ outcome: "UPDATED", transactionId: "tx" })}\n`,
      stderr: "",
      args,
    }));
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
      [dependencyAssetName, value.dependencyArchive],
    ]);
    const result = await runGenerationUpdate({
      lifecycle: {
        supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
        config: "/var/lib/fased-lifecycled/platform.json",
      },
      version,
      timeoutMs: 30_000,
      baseUrl: "https://example.invalid/releases/download",
      architecture: "x64",
      download: async (url: string, destination: string) => {
        const source = sources.get(url.split("/").at(-1) ?? "");
        if (!source) {
          throw new Error("unexpected download");
        }
        await fsp.copyFile(source, destination);
      },
      verifyOfficialAsset: verify,
      runAdministrator: administrator,
      sudoPath: "/usr/bin/sudo",
    });
    expect(result).toMatchObject({ version, outcome: "COMMITTED", transactionId: "tx" });
    expect(verify).toHaveBeenCalledOnce();
    expect(administrator).toHaveBeenCalledTimes(2);
    expect(administrator.mock.calls[0][1]).toContain("stage");
    expect(administrator.mock.calls[0][1]).toContain("--dependency-archive");
    expect(administrator.mock.calls[1][1]).toContain("apply");
    expect(administrator.mock.calls[1][1]).toContain("--generation-id");
  });

  it("rejects an unsupported privileged convergence outcome", async () => {
    const value = await fixture();
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
      [dependencyAssetName, value.dependencyArchive],
    ]);
    await expect(
      runGenerationUpdate({
        lifecycle: {
          supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
          config: "/var/lib/fased-lifecycled/platform.json",
        },
        version,
        timeoutMs: 30_000,
        baseUrl: "https://example.invalid/releases/download",
        architecture: "x64",
        download: async (url: string, destination: string) => {
          const source = sources.get(url.split("/").at(-1) ?? "");
          if (!source) {
            throw new Error("unexpected download");
          }
          await fsp.copyFile(source, destination);
        },
        verifyOfficialAsset: async () => undefined,
        runAdministrator: async (_command, args) => ({
          ok: true,
          stdout: args.includes("stage")
            ? `${JSON.stringify({ id: `sha256:${"a".repeat(64)}`, version })}\n`
            : `${JSON.stringify({ outcome: "PREPARED" })}\n`,
          stderr: "",
        }),
        sudoPath: "/usr/bin/sudo",
      }),
    ).rejects.toThrow("invalid convergence outcome");
  });

  it.each([
    ["ROLLED_BACK", "target release failed and was rolled back"],
    ["RECOVERY_PENDING", "lifecycle recovery is pending"],
  ])("preserves the bounded %s lifecycle outcome", async (outcome, message) => {
    const value = await fixture();
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
      [dependencyAssetName, value.dependencyArchive],
    ]);
    await expect(
      runGenerationUpdate({
        lifecycle: {
          supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
          config: "/var/lib/fased-lifecycled/platform.json",
        },
        version,
        timeoutMs: 30_000,
        baseUrl: "https://example.invalid/releases/download",
        architecture: "x64",
        download: async (url: string, destination: string) => {
          const source = sources.get(url.split("/").at(-1) ?? "");
          if (!source) {
            throw new Error("unexpected download");
          }
          await fsp.copyFile(source, destination);
        },
        verifyOfficialAsset: async () => undefined,
        runAdministrator: async (_command, args) => ({
          ok: true,
          stdout: args.includes("stage")
            ? `${JSON.stringify({ id: `sha256:${"a".repeat(64)}`, version })}\n`
            : `${JSON.stringify({ outcome, detail: "injected failure", transactionId: "tx" })}\n`,
          stderr: "",
        }),
        sudoPath: "/usr/bin/sudo",
      }),
    ).rejects.toThrow(`${message}: injected failure`);
  });

  it("preserves declared executable modes under a restrictive caller umask", async () => {
    const value = await fixture();
    const destination = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-generation-extract-"));
    temporary.push(destination);
    const previousUmask = process.umask(0o117);
    try {
      const generation = await extractGeneration(value.archive, destination);
      expect(
        (await fsp.stat(path.join(generation, "payload", "bin", "fased"))).mode & 0o111,
      ).not.toBe(0);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("loads archive support from the active immutable runtime", async () => {
    const value = await fixture();
    const destination = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-generation-runtime-"));
    temporary.push(destination);
    const dependencyRoot = path.resolve(".");
    const generation = await extractGeneration(value.archive, destination, { dependencyRoot });
    expect(await fsp.readFile(path.join(generation, "payload", "bin", "fased"), "utf8")).toBe(
      "exact\n",
    );
  });

  it("loads archive support from an immutable node_modules layer", async () => {
    const value = await fixture();
    const destination = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-generation-layer-"));
    temporary.push(destination);
    const dependencyRoot = path.resolve("node_modules");
    const generation = await extractGeneration(value.archive, destination, { dependencyRoot });
    expect(await fsp.readFile(path.join(generation, "payload", "bin", "fased"), "utf8")).toBe(
      "exact\n",
    );
  });

  it("rejects a generation archive symlink that escapes before privileged mutation", async () => {
    const value = await fixture("../../../../../../outside");
    const administrator = vi.fn();
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
      [dependencyAssetName, value.dependencyArchive],
    ]);
    await expect(
      runGenerationUpdate({
        lifecycle: {
          supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
          config: "/var/lib/fased-lifecycled/platform.json",
        },
        version,
        timeoutMs: 30_000,
        baseUrl: "https://example.invalid/releases/download",
        architecture: "x64",
        download: async (url: string, destination: string) => {
          const source = sources.get(url.split("/").at(-1) ?? "");
          if (!source) {
            throw new Error("unexpected download");
          }
          await fsp.copyFile(source, destination);
        },
        verifyOfficialAsset: async () => undefined,
        runAdministrator: administrator,
        sudoPath: "/usr/bin/sudo",
      }),
    ).rejects.toThrow("unsafe entry");
    expect(administrator).not.toHaveBeenCalled();
  });

  it("rejects a descriptor digest mismatch before privileged mutation", async () => {
    const value = await fixture();
    const descriptor = JSON.parse(await fsp.readFile(value.descriptorPath, "utf8"));
    descriptor.artifactSetDigest = `sha256:${"f".repeat(64)}`;
    await fsp.writeFile(value.descriptorPath, JSON.stringify(descriptor));
    const administrator = vi.fn();
    await expect(
      runGenerationUpdate({
        lifecycle: {
          supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
          config: "/var/lib/fased-lifecycled/platform.json",
        },
        version,
        timeoutMs: 30_000,
        baseUrl: "https://example.invalid/releases/download",
        architecture: "x64",
        download: async (url: string, destination: string) => {
          const name = url.split("/").at(-1);
          const source =
            name === "fased-hosting-candidate.json"
              ? value.descriptorPath
              : name?.endsWith("attestation.json")
                ? value.bundlePath
                : name === dependencyAssetName
                  ? value.dependencyArchive
                  : value.archive;
          await fsp.copyFile(source, destination);
        },
        verifyOfficialAsset: async () => undefined,
        runAdministrator: administrator,
        sudoPath: "/usr/bin/sudo",
      }),
    ).rejects.toThrow("artifact-set digest");
    expect(administrator).not.toHaveBeenCalled();
  });

  it("rejects a dependency identity mismatch before privileged mutation", async () => {
    const value = await fixture();
    const descriptor = JSON.parse(await fsp.readFile(value.descriptorPath, "utf8"));
    descriptor.artifacts[1].sha256 = `sha256:${"f".repeat(64)}`;
    descriptor.artifactSetDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(descriptor.artifacts))
      .digest("hex")}`;
    await fsp.writeFile(value.descriptorPath, JSON.stringify(descriptor));
    const administrator = vi.fn();
    await expect(
      runGenerationUpdate({
        lifecycle: {
          supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
          config: "/var/lib/fased-lifecycled/platform.json",
        },
        version,
        timeoutMs: 30_000,
        baseUrl: "https://example.invalid/releases/download",
        architecture: "x64",
        download: async (url: string, destination: string) => {
          const name = url.split("/").at(-1);
          const source =
            name === "fased-hosting-candidate.json"
              ? value.descriptorPath
              : name?.endsWith("attestation.json")
                ? value.bundlePath
                : name === dependencyAssetName
                  ? value.dependencyArchive
                  : value.archive;
          await fsp.copyFile(source, destination);
        },
        verifyOfficialAsset: async () => undefined,
        runAdministrator: administrator,
        sudoPath: "/usr/bin/sudo",
      }),
    ).rejects.toThrow("bind different dependency archives");
    expect(administrator).not.toHaveBeenCalled();
  });

  it("rejects incomplete candidate provenance before privileged mutation", async () => {
    const value = await fixture();
    const descriptor = JSON.parse(await fsp.readFile(value.descriptorPath, "utf8"));
    descriptor.lockfileDigest = "unbound";
    await fsp.writeFile(value.descriptorPath, JSON.stringify(descriptor));
    const administrator = vi.fn();
    await expect(
      runGenerationUpdate({
        lifecycle: {
          supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
          config: "/var/lib/fased-lifecycled/platform.json",
        },
        version,
        timeoutMs: 30_000,
        baseUrl: "https://example.invalid/releases/download",
        architecture: "x64",
        download: async (url: string, destination: string) => {
          const name = url.split("/").at(-1);
          await fsp.copyFile(
            name === "fased-hosting-candidate.json"
              ? value.descriptorPath
              : name?.endsWith("attestation.json")
                ? value.bundlePath
                : name === dependencyAssetName
                  ? value.dependencyArchive
                  : value.archive,
            destination,
          );
        },
        verifyOfficialAsset: async () => undefined,
        runAdministrator: administrator,
        sudoPath: "/usr/bin/sudo",
      }),
    ).rejects.toThrow("malformed or not bound");
    expect(administrator).not.toHaveBeenCalled();
  });

  it("initializes one canonical public-stable bridge from the descriptor-bound generation", async () => {
    const value = await fixture();
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
      [dependencyAssetName, value.dependencyArchive],
    ]);
    const administrator = vi.fn(async (_sudo, command: string[]) => ({
      ok: true,
      stdout: `${JSON.stringify({ outcome: "ALREADY_CURRENT" })}\n`,
      stderr: "",
      command,
    }));
    const result = await runGenerationInitialize({
      initialize: {
        profile: "protected-local",
        instance: "0123456789abcdef",
        ownerState: "/home/example/.fased",
        operatorUser: "example",
        gatewayPort: 18789,
        sourceTopology: "local-user-systemd-v1",
      },
      version,
      timeoutMs: 30_000,
      baseUrl: "https://example.invalid/releases/download",
      architecture: "x64",
      download: async (url: string, destination: string) => {
        const source = sources.get(url.split("/").at(-1) ?? "");
        if (!source) {
          throw new Error("unexpected download");
        }
        await fsp.copyFile(source, destination);
      },
      verifyOfficialAsset: async () => undefined,
      runAdministrator: administrator,
    });
    expect(result.outcome).toBe("ALREADY_CURRENT");
    const command = administrator.mock.calls[0][1];
    expect(command[0]).toMatch(/generation\/payload\/bin\/fased-lifecycled$/u);
    expect(command).toEqual(
      expect.arrayContaining([
        "initialize",
        "--profile",
        "protected-local",
        "--instance",
        "0123456789abcdef",
        "--operator-user",
        "example",
        "--gateway-port",
        "18789",
        "--generation-archive",
        "--source-topology",
        "local-user-systemd-v1",
      ]),
    );
    expect(command).not.toContain("--generation");
  });

  it("preserves a failed privileged initializer diagnostic emitted on stdout", async () => {
    const value = await fixture();
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
      [dependencyAssetName, value.dependencyArchive],
    ]);
    await expect(
      runGenerationInitialize({
        initialize: {
          profile: "protected-local",
          instance: "0123456789abcdef",
          ownerState: "/home/example/.fased",
          operatorUser: "example",
          gatewayPort: 18789,
        },
        version,
        timeoutMs: 30_000,
        baseUrl: "https://example.invalid/releases/download",
        architecture: "x64",
        download: async (url: string, destination: string) => {
          const source = sources.get(url.split("/").at(-1) ?? "");
          if (!source) {
            throw new Error("unexpected download");
          }
          await fsp.copyFile(source, destination);
        },
        verifyOfficialAsset: async () => undefined,
        runAdministrator: async () => ({
          ok: false,
          stdout: "exact lifecycle predicate\n",
          stderr: "",
        }),
      }),
    ).rejects.toThrow("exact lifecycle predicate");
  });
});
