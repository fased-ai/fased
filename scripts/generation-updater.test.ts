import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGenerationInitialize, runGenerationUpdate } from "./generation-updater.mjs";

const temporary: string[] = [];
const version = "1.2.3";
const assetName = `fased-generation-linux-x64-v${version}.tar.gz`;

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
  await fsp.writeFile(path.join(archiveRoot, "generation", "inventory.json"), "{}\n");
  await fsp.writeFile(path.join(archiveRoot, "generation", "payload", "bin", "fased"), "exact\n");
  const runtimeModules = path.join(archiveRoot, "generation", "payload", "runtime", "node_modules");
  await fsp.mkdir(path.join(runtimeModules, "tool", "bin"), { recursive: true });
  await fsp.mkdir(path.join(runtimeModules, ".bin"), { recursive: true });
  await fsp.writeFile(path.join(runtimeModules, "tool", "bin", "cli.js"), "exact tool\n");
  await fsp.symlink(linkTarget, path.join(runtimeModules, ".bin", "tool"));
  const archive = path.join(root, assetName);
  await tar.c({ cwd: archiveRoot, file: archive, gzip: true, portable: true }, ["generation"]);
  const stat = await fsp.stat(archive);
  const artifacts = [{ name: assetName, sha256: await digest(archive), size: stat.size }];
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
  return { root, archive, descriptorPath, bundlePath };
}

describe("generation updater", () => {
  it("downloads descriptor-bound bytes and delegates one privileged apply", async () => {
    const value = await fixture();
    const verify = vi.fn(async () => undefined);
    const administrator = vi.fn(async (_command, args: string[]) => ({
      ok: true,
      stdout: `${JSON.stringify({ outcome: "COMMITTED", transactionId: "tx" })}\n`,
      stderr: "",
      args,
    }));
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
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
    expect(administrator).toHaveBeenCalledOnce();
    expect(administrator.mock.calls[0][1]).toContain("apply");
  });

  it("rejects a generation archive symlink that escapes before privileged mutation", async () => {
    const value = await fixture("../../../../../../outside");
    const administrator = vi.fn();
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
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

  it("initializes one canonical platform from the descriptor-bound generation", async () => {
    const value = await fixture();
    const sources = new Map([
      ["fased-hosting-candidate.json", value.descriptorPath],
      ["fased-hosting-candidate.json.attestation.json", value.bundlePath],
      [assetName, value.archive],
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
        gatewayPort: 18789,
        operatorUid: 1000,
        operatorGid: 1000,
        gatewayUid: 997,
        gatewayGid: 997,
        signerUid: 996,
        signerGid: 996,
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
        "--gateway-port",
        "18789",
        "--generation",
      ]),
    );
  });
});
