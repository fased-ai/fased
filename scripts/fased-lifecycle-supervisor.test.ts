import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  parseLifecycleTrustMetadata,
  parseSupervisorConfiguration,
  parseSupervisorRequest,
  stageTrustedController,
} from "./fased-lifecycle-supervisor.mjs";

const version = "1.2.3";
const issuedAt = "2026-07-28T00:00:00.000Z";
const expiresAt = "2027-07-28T00:00:00.000Z";
const now = Date.parse("2026-07-29T00:00:00.000Z");
const digest = (character: string) => character.repeat(64);

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    role: "fased-lifecycle-targets",
    release: { version, tag: `v${version}`, commit: "a".repeat(40) },
    validity: { issuedAt, expiresAt },
    policy: {
      channels: ["beta", "stable"],
      platforms: ["linux-arm64", "linux-x64"],
      supervisorProtocol: 1,
      controllerProtocol: 2,
    },
    targets: {
      supervisor: { asset: "fased-lifecycle-supervisor.mjs", sha256: digest("a") },
      controllerServer: { asset: "fased-host-updater.mjs", sha256: digest("b") },
      controllerClient: { asset: "fased-host-updaterctl.mjs", sha256: digest("c") },
    },
    ...overrides,
  };
}

function request(op = "updateController") {
  return parseSupervisorRequest({
    schemaVersion: 2,
    op,
    transactionId: randomUUID(),
    version,
  });
}

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-supervisor-"));
  return {
    root,
    paths: {
      publicSocketPath: path.join(root, "run", "request.sock"),
      privateSocketPath: path.join(root, "run", "controller.sock"),
      stateDir: path.join(root, "state"),
      supervisorStateDir: path.join(root, "state", "supervisor"),
      releasesDir: path.join(root, "controller", "releases"),
      currentLink: path.join(root, "controller", "current"),
      controllerVersionPath: path.join(root, "state", "controller-version.json"),
      rollbackFloorPath: path.join(root, "state", "rollback-floor"),
      channelPath: path.join(root, "channel"),
      supervisorPath: path.join(root, "supervisor.mjs"),
      controllerUnit: "fixed-controller.service",
      supervisorUnit: "fixed-supervisor.service",
    },
  };
}

describe("stable lifecycle supervisor contract", () => {
  it("accepts only fixed profile selectors and a typed operation allowlist", () => {
    expect(
      parseSupervisorConfiguration([
        "--profile",
        "protected-local",
        "--protected-local-instance",
        "0123456789abcdef",
        "--operator-uid",
        "1000",
        "--operator-gid",
        "1000",
      ]),
    ).toMatchObject({
      profile: "protected-local",
      instanceId: "0123456789abcdef",
      operatorUid: 1000,
      operatorGid: 1000,
    });
    expect(request("commitRelease").op).toBe("commitRelease");
    for (const injected of [
      { command: "/bin/sh" },
      { path: "/tmp/controller" },
      { url: "https://attacker.invalid" },
      { env: { LD_PRELOAD: "/tmp/x" } },
      { unit: "attacker.service" },
      { owner: "root:root" },
    ]) {
      expect(() =>
        parseSupervisorRequest({
          schemaVersion: 2,
          op: "updateController",
          transactionId: randomUUID(),
          version,
          ...injected,
        }),
      ).toThrow("unsupported or missing fields");
    }
    expect(() =>
      parseSupervisorConfiguration([
        "--profile",
        "hosting",
        "--operator-uid",
        "1000",
        "--operator-gid",
        "1000",
        "--controller-path",
        "/tmp/controller",
      ]),
    ).toThrow("unsupported lifecycle supervisor argument");
  });

  it("keeps the replaceable controller outside supervisor code, state, and unit files", () => {
    const { paths } = tempPaths();
    const operator = fs
      .readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .map((line) => line.split(":"))
      .find(
        (fields) =>
          Number(fields[2]) > 0 &&
          /^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/u.test(fields[0] ?? "") &&
          path.isAbsolute(fields[5] ?? ""),
      );
    expect(operator).toBeDefined();
    const units = __testing.renderBoundaryUnits(
      {
        profile: "hosting",
        instanceId: null,
        operatorUid: Number(operator?.[2]),
        operatorGid: Number(operator?.[3]),
        paths,
      },
      "/usr/bin/node",
    );
    expect(units.controller.content).toContain(
      "ReadOnlyPaths=/opt/fased/host-controller/supervisor /var/lib/fased-host-updater/supervisor /etc/systemd/system/fixed-supervisor.service",
    );
    expect(units.supervisor.content).toContain(
      "CapabilityBoundingSet=CAP_CHOWN\nAmbientCapabilities=",
    );
  });

  it("requires unexpired, architecture-bound, channel-bound immutable metadata", () => {
    expect(
      parseLifecycleTrustMetadata(metadata(), {
        expectedVersion: version,
        channel: "stable",
        platform: "linux-x64",
        now,
      }),
    ).toMatchObject({ role: "fased-lifecycle-targets" });
    expect(() =>
      parseLifecycleTrustMetadata(metadata(), {
        expectedVersion: version,
        channel: "stable",
        platform: "linux-x64",
        now: Date.parse("2028-01-01T00:00:00.000Z"),
      }),
    ).toThrow("stale, incompatible, or mismatched");
    expect(() =>
      parseLifecycleTrustMetadata(metadata(), {
        expectedVersion: version,
        channel: "stable",
        platform: "linux-riscv64",
        now,
      }),
    ).toThrow("stale, incompatible, or mismatched");
    expect(() =>
      parseLifecycleTrustMetadata(
        metadata({
          policy: {
            channels: ["beta"],
            platforms: ["linux-x64"],
            supervisorProtocol: 1,
            controllerProtocol: 2,
          },
        }),
        {
          expectedVersion: version,
          channel: "stable",
          platform: "linux-x64",
          now,
        },
      ),
    ).toThrow("stale, incompatible, or mismatched");
    expect(() =>
      parseLifecycleTrustMetadata(
        metadata({
          validity: {
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2027-12-31T00:00:00.000Z",
          },
        }),
        {
          expectedVersion: version,
          channel: "stable",
          platform: "linux-x64",
          now,
        },
      ),
    ).toThrow("stale, incompatible, or mismatched");
  });

  it("promotes only metadata-bound controller bytes and records an immutable generation", async () => {
    const { root, paths } = tempPaths();
    await fsp.mkdir(path.dirname(paths.channelPath), { recursive: true });
    await fsp.writeFile(paths.channelPath, "beta\n");
    await fsp.writeFile(paths.supervisorPath, "stable-supervisor\n");
    const supervisorSha = await import("node:crypto").then(({ createHash }) =>
      createHash("sha256").update("stable-supervisor\n").digest("hex"),
    );
    const server = "verified-server\n";
    const client = "verified-client\n";
    const createHash = (await import("node:crypto")).createHash;
    const serverSha = createHash("sha256").update(server).digest("hex");
    const clientSha = createHash("sha256").update(client).digest("hex");
    const trust = metadata({
      targets: {
        supervisor: { asset: "fased-lifecycle-supervisor.mjs", sha256: supervisorSha },
        controllerServer: { asset: "fased-host-updater.mjs", sha256: serverSha },
        controllerClient: { asset: "fased-host-updaterctl.mjs", sha256: clientSha },
      },
    });
    const downloads = new Map([
      ["fased-lifecycle-trust-v1.json", `${JSON.stringify(trust)}\n`],
      ["fased-lifecycle-trust-v1.json.attestation.json", "{}\n"],
      ["fased-host-updater.mjs", server],
      ["fased-host-updaterctl.mjs", client],
    ]);
    const configuration = {
      profile: "hosting",
      operatorUid: process.getuid?.() ?? 1000,
      operatorGid: process.getgid?.() ?? 1000,
      paths,
    };
    const verifyMetadata = vi.fn(async () => undefined);
    const context = __testing.createContext(configuration, {
      rootUid: process.getuid?.() ?? 0,
      rootGid: process.getgid?.() ?? 0,
      platform: "linux-x64",
      now: () => now,
      verifyMetadata,
      selfCheckController: async () => undefined,
      download: async (url: string, destination: string) => {
        const name = url.slice(url.lastIndexOf("/") + 1);
        const body = downloads.get(name);
        if (body === undefined) {
          throw new Error(`unexpected asset ${name}`);
        }
        await fsp.writeFile(destination, body);
      },
    });
    const staged = await stageTrustedController(request(), context);
    expect(staged.changed).toBe(true);
    expect(await fsp.realpath(paths.currentLink)).toBe(path.join(paths.releasesDir, `v${version}`));
    expect(JSON.parse(await fsp.readFile(paths.controllerVersionPath, "utf8"))).toMatchObject({
      version,
      serverSha256: serverSha,
      clientSha256: clientSha,
    });
    expect(verifyMetadata).toHaveBeenCalledOnce();
    await expect(
      fsp.lstat(path.join(root, "controller", "releases", `v${version}`)),
    ).resolves.toMatchObject({ uid: process.getuid?.() ?? 0 });
  });

  it("restores the prior controller selection when worker restart fails", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const restore = vi.fn(async () => undefined);
    const restart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("worker failed"))
      .mockResolvedValueOnce(undefined);
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        stageTrustedController: async () => ({
          changed: true,
          identity: {
            schemaVersion: 1,
            version,
            serverSha256: digest("a"),
            clientSha256: digest("b"),
          },
          previousGeneration: "/fixed/previous",
          previousIdentity: {
            schemaVersion: 1,
            version: "1.2.2",
            serverSha256: digest("c"),
            clientSha256: digest("d"),
          },
        }),
        restoreControllerSelection: restore,
        restartController: restart,
        waitForController: async () => undefined,
      },
    );
    await expect(
      __testing.handleSupervisorRequest(request(), context, {
        controllerInstanceId: randomUUID(),
      }),
    ).rejects.toThrow("promotion failed and was restored");
    expect(restore).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("removes an unactivated first controller selection when no prior generation exists", async () => {
    const { paths } = tempPaths();
    const selected = path.join(paths.releasesDir, `v${version}`);
    await fsp.mkdir(selected, { recursive: true });
    await fsp.symlink(selected, paths.currentLink, "dir");
    await fsp.mkdir(path.dirname(paths.controllerVersionPath), { recursive: true });
    await fsp.writeFile(paths.controllerVersionPath, `${JSON.stringify({ version })}\n`);

    await __testing.restoreControllerSelection(paths, {
      previousGeneration: null,
      previousIdentity: null,
    });

    await expect(fsp.lstat(paths.currentLink)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsp.lstat(paths.controllerVersionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restarts an already-selected generation when the running worker identity is stale", async () => {
    const { paths } = tempPaths();
    await fsp.mkdir(paths.supervisorStateDir, { recursive: true });
    const activeInstance = randomUUID();
    const restart = vi.fn(async () => undefined);
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("stale worker"))
      .mockResolvedValueOnce(activeInstance);
    const context = __testing.createContext(
      {
        profile: "hosting",
        operatorUid: 1000,
        operatorGid: 1000,
        paths,
      },
      {
        stageTrustedController: async () => ({
          changed: false,
          identity: {
            schemaVersion: 1,
            version,
            serverSha256: digest("a"),
            clientSha256: digest("b"),
          },
        }),
        probeControllerIdentity: probe,
        restartController: restart,
        waitForController: async () => undefined,
      },
    );
    const result = await __testing.handleSupervisorRequest(request(), context, {
      controllerInstanceId: randomUUID(),
    });

    expect(result).toMatchObject({
      ok: true,
      version,
      controllerChanged: true,
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
