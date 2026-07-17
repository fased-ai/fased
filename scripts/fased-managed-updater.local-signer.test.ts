import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./fased-managed-updater.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();

const REQUIRED_FEATURES = [
  "failClosedPolicies",
  "policyHashes",
  "durableCaps",
  "atomicIdempotency",
  "ambiguousBroadcastReconciliation",
  "signerOwnedKeys",
  "typedSolanaTransactions",
  "atomicMultiAssetCaps",
  "signerControlledNativeFeeCaps",
];

function digest(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function identity(version: string, marker: string) {
  return {
    version,
    commit: marker.repeat(40),
    buildInputDigest: `sha256:${marker.repeat(64)}`,
    development: false,
  };
}

function writeFakeRelease(
  releaseRoot: string,
  version: string,
  marker: string,
  options: { healthy?: boolean; manifestMarker?: string; corruptChecksum?: boolean } = {},
) {
  const dir = path.join(releaseRoot, `v${version}`);
  fs.mkdirSync(dir, { recursive: true });
  const releaseIdentity = identity(version, marker);
  const assetName = `fased-signerd-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  const binary = path.join(dir, assetName);
  const features = options.healthy === false ? REQUIRED_FEATURES.slice(1) : REQUIRED_FEATURES;
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const identity = ${JSON.stringify(releaseIdentity)};
if (process.argv.length === 3 && process.argv[2] === "--version") {
  fs.writeSync(1, \`fased-signerd \${identity.version} commit=\${identity.commit} buildInputDigest=\${identity.buildInputDigest} development=false\\n\`);
  process.exit(0);
}
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const readOnly = args.includes("-read-only");
const socketPath = value("-socket");
const controlPath = value("-control-socket");
const statePath = value("-state-db");
const masterPath = value("-master-key");
const pidPath = value("-pid-file");
const auditPath = value("-audit-log");
for (const file of [socketPath, controlPath, pidPath]) { try { fs.rmSync(file, { force: true }); } catch {} }
for (const file of [statePath, masterPath, pidPath, auditPath]) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, "durable-state\\n", { mode: 0o600 });
if (!fs.existsSync(masterPath)) fs.writeFileSync(masterPath, "durable-master\\n", { mode: 0o600 });
fs.writeFileSync(pidPath, \`\${process.pid}\\n\`, { mode: 0o600 });
const health = { ok: true, result: {
  ready: true,
  readOnly,
  keystoreType: "signer-owned-v2",
  release: identity,
  schema: { version: 3, supported: 3, ready: true },
  capabilities: {
    protocol: { current: 2, min: 2, max: 2 },
    nativeFeeReservationLamports: 5000000,
    features: ${JSON.stringify(features)}
  },
  policies: []
}};
const app = net.createServer((socket) => socket.once("data", () => socket.end(JSON.stringify(health) + "\\n")));
const control = net.createServer((socket) => socket.destroy());
const cleanup = () => {
  app.close(); control.close();
  for (const file of [socketPath, controlPath, pidPath]) { try { fs.rmSync(file, { force: true }); } catch {} }
  process.exit(0);
};
process.on("SIGTERM", cleanup); process.on("SIGINT", cleanup);
setTimeout(() => {
  app.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  control.listen(controlPath, () => fs.chmodSync(controlPath, 0o600));
}, Number(process.env.FASED_TEST_FAKE_SIGNER_DELAY_MS || 0));
`,
    { mode: 0o700 },
  );
  const manifestIdentity = identity(version, options.manifestMarker || marker);
  const manifest = path.join(dir, "fased-signerd-release.json");
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({ schemaVersion: 1, ...manifestIdentity }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const binaryDigest = options.corruptChecksum ? "0".repeat(64) : digest(binary);
  fs.writeFileSync(
    path.join(dir, "fased-signerd-checksums.txt"),
    `${binaryDigest}  ${assetName}\n${digest(manifest)}  fased-signerd-release.json\n`,
  );
  return { binary, manifest, releaseIdentity };
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-local-signer-update-"));
  roots.push(root);
  const stateDir = path.join(root, ".fased");
  const releaseRoot = path.join(root, "releases");
  const paths = __testing.resolveLocalSignerPaths({ stateDir });
  const env = {
    ...process.env,
    HOME: root,
    FASED_STATE_DIR: stateDir,
    FASED_LOCAL_SIGNER_BASE_URL: new URL(`file://${releaseRoot}/`).href.replace(/\/$/, ""),
    FASED_LOCAL_SIGNER_ALLOW_UNATTESTED: "1",
  };
  return { root, stateDir, releaseRoot, paths, env };
}

async function withEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
  }
}

async function waitForSocket(socketPath: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      await fsp
        .lstat(socketPath)
        .then((stat) => stat.isSocket())
        .catch(() => false)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`socket did not appear: ${socketPath}`);
}

async function startInstalledSigner(paths: ReturnType<typeof __testing.resolveLocalSignerPaths>) {
  await fsp.mkdir(paths.materialDir, { recursive: true, mode: 0o700 });
  const child = spawn(
    paths.binaryPath,
    [
      "-socket",
      paths.socketPath,
      "-control-socket",
      paths.controlSocketPath,
      "-state-db",
      paths.stateDbPath,
      "-master-key",
      paths.masterKeyPath,
      "-pid-file",
      paths.pidPath,
      "-audit-log",
      paths.auditPath,
    ],
    { stdio: "ignore", detached: true, env: process.env },
  );
  child.unref();
  children.add(child);
  await waitForSocket(paths.socketPath);
  return child;
}

afterEach(async () => {
  for (const child of children) {
    try {
      process.kill(child.pid!, "SIGTERM");
    } catch {}
  }
  children.clear();
  for (const root of roots.splice(0)) {
    const pidPath = path.join(root, ".fased", "wallet", "local-signer.pid");
    try {
      const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 1) {
        process.kill(pid, "SIGTERM");
      }
    } catch {}
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe.sequential("transactional Local native signer updater", () => {
  it("maps WSL/Linux and native macOS assets and rejects native Windows", () => {
    expect(__testing.resolveLocalSignerAsset("linux", "x64")).toEqual({
      platform: "linux",
      arch: "amd64",
      assetName: "fased-signerd-linux-amd64",
    });
    expect(__testing.resolveLocalSignerAsset("darwin", "arm64")).toEqual({
      platform: "darwin",
      arch: "arm64",
      assetName: "fased-signerd-darwin-arm64",
    });
    expect(() => __testing.resolveLocalSignerAsset("win32", "x64")).toThrow(/WSL2/);
  });

  it("requires an exact production release tuple and strict manifest", () => {
    const release = identity("1.2.3", "a");
    expect(
      __testing.parseSignerVersionOutput(
        `fased-signerd 1.2.3 commit=${release.commit} buildInputDigest=${release.buildInputDigest} development=false`,
        "1.2.3",
      ),
    ).toEqual(release);
    expect(() =>
      __testing.parseSignerVersionOutput(
        "fased-signerd 1.2.3 commit=unknown buildInputDigest=unknown development=true",
      ),
    ).toThrow(/production identity/);
    expect(() =>
      __testing.parseSignerReleaseManifest({ schemaVersion: 1, ...release, extra: true }, "1.2.3"),
    ).toThrow(/unsupported fields/);
  });

  it("installs fresh without Go and updates an active signer while preserving state", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "1.0.0", "a");
    writeFakeRelease(fixture.releaseRoot, "1.0.1", "b");
    await withEnv(fixture.env, async () => {
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "1.0.0", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ action: "committed", identity: { version: "1.0.0" } });
      await startInstalledSigner(fixture.paths);
      fs.writeFileSync(path.join(fixture.paths.materialDir, "owner-policy-proof"), "preserve\n", {
        mode: 0o600,
      });
      const beforePid = fs.readFileSync(fixture.paths.pidPath, "utf8").trim();
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "1.0.1", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ action: "committed", identity: { version: "1.0.1" } });
      const afterPid = fs.readFileSync(fixture.paths.pidPath, "utf8").trim();
      expect(afterPid).not.toBe(beforePid);
      expect(
        fs.readFileSync(path.join(fixture.paths.materialDir, "owner-policy-proof"), "utf8"),
      ).toBe("preserve\n");
      expect(fs.readFileSync(fixture.paths.stateDbPath, "utf8")).toBe("durable-state\n");
      expect(fs.readFileSync(fixture.paths.masterKeyPath, "utf8")).toBe("durable-master\n");
      await expect(
        __testing.probeLocalSignerHealth(fixture.paths.socketPath, identity("1.0.1", "b"), 3_000),
      ).resolves.toMatchObject({ ready: true });
    });
  }, 30_000);

  it("restores policy helpers and templates when a deferred paired update rolls back", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "1.1.0", "a");
    writeFakeRelease(fixture.releaseRoot, "1.1.1", "b");
    await withEnv(fixture.env, async () => {
      await __testing.runLocalSignerTransaction(
        { action: "install", targetVersion: "1.1.0", timeoutMs: 10_000 },
        { stateDir: fixture.stateDir },
      );
      fs.mkdirSync(path.dirname(fixture.paths.policyHelperPath), { recursive: true });
      fs.mkdirSync(path.dirname(fixture.paths.policyTemplatePaths[0]), { recursive: true });
      fs.writeFileSync(fixture.paths.policyHelperPath, "old-helper\n", { mode: 0o700 });
      fs.writeFileSync(fixture.paths.policyTemplatePaths[0], "old-template\n", { mode: 0o600 });

      await __testing.runLocalSignerTransaction(
        {
          action: "install",
          targetVersion: "1.1.1",
          timeoutMs: 10_000,
          deferCommit: true,
        },
        { stateDir: fixture.stateDir },
      );
      fs.writeFileSync(fixture.paths.policyHelperPath, "new-helper\n", { mode: 0o700 });
      fs.writeFileSync(fixture.paths.policyTemplatePaths[0], "new-template\n", { mode: 0o600 });

      await __testing.runLocalSignerTransaction(
        { action: "rollback", timeoutMs: 10_000 },
        { stateDir: fixture.stateDir },
      );

      expect(fs.readFileSync(fixture.paths.policyHelperPath, "utf8")).toBe("old-helper\n");
      expect(fs.readFileSync(fixture.paths.policyTemplatePaths[0], "utf8")).toBe("old-template\n");
      const restored = await execFileAsync(fixture.paths.binaryPath, ["--version"], {
        encoding: "utf8",
      });
      expect(restored.stdout).toContain("fased-signerd 1.1.0");
    });
  });

  it("rejects tampered assets, manifest mismatch, and unconfirmed downgrade", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "2.0.0", "b");
    writeFakeRelease(fixture.releaseRoot, "1.9.9", "a");
    writeFakeRelease(fixture.releaseRoot, "2.0.1", "c", { corruptChecksum: true });
    writeFakeRelease(fixture.releaseRoot, "2.0.2", "d", { manifestMarker: "e" });
    await withEnv(fixture.env, async () => {
      await __testing.runLocalSignerTransaction(
        { action: "install", targetVersion: "2.0.0", timeoutMs: 10_000 },
        { stateDir: fixture.stateDir },
      );
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "1.9.9", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).rejects.toThrow(/Refusing signer downgrade/);
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "2.0.1", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).rejects.toThrow(/Checksum mismatch/);
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "2.0.2", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).rejects.toThrow(/identities do not match/);
      await expect(
        __testing.runLocalSignerTransaction(
          {
            action: "install",
            targetVersion: "1.9.9",
            timeoutMs: 10_000,
            confirmDowngrade: "1.9.9",
          },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ identity: { version: "1.9.9" } });
    });
  }, 30_000);

  it("restores the exact active signer and state when candidate health fails", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "3.0.0", "a");
    writeFakeRelease(fixture.releaseRoot, "3.0.1", "b", { healthy: false });
    await withEnv(fixture.env, async () => {
      await __testing.runLocalSignerTransaction(
        { action: "install", targetVersion: "3.0.0", timeoutMs: 10_000 },
        { stateDir: fixture.stateDir },
      );
      await startInstalledSigner(fixture.paths);
      fs.writeFileSync(path.join(fixture.paths.materialDir, "audit-policy-proof"), "exact\n", {
        mode: 0o600,
      });
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "3.0.1", timeoutMs: 3_000 },
          { stateDir: fixture.stateDir },
        ),
      ).rejects.toMatchObject({ code: "LOCAL_SIGNER_UPDATE_ROLLED_BACK" });
      expect(
        fs.readFileSync(path.join(fixture.paths.materialDir, "audit-policy-proof"), "utf8"),
      ).toBe("exact\n");
      await expect(
        __testing.probeLocalSignerHealth(fixture.paths.socketPath, identity("3.0.0", "a"), 3_000),
      ).resolves.toMatchObject({ ready: true });
    });
  }, 30_000);

  it("recovers deterministically after a crash at every durable signer phase", async () => {
    const updater = path.join(import.meta.dirname, "fased-managed-updater.mjs");
    for (const phase of [
      "staging",
      "quiesced",
      "snapshotted",
      "prepared",
      "activating",
      "candidate-active",
      "committing",
    ]) {
      const fixture = makeFixture();
      writeFakeRelease(fixture.releaseRoot, "4.0.0", "a");
      await expect(
        execFileAsync(
          process.execPath,
          [updater, "local-signer", "install", "--version", "4.0.0"],
          {
            env: { ...fixture.env, FASED_TEST_LOCAL_SIGNER_CRASH_AFTER_PHASE: phase },
            timeout: 20_000,
          },
        ),
      ).rejects.toMatchObject({ code: 97 });
      await execFileAsync(process.execPath, [updater, "local-signer", "recover"], {
        env: fixture.env,
        timeout: 20_000,
      });
      expect(fs.existsSync(fixture.paths.journalPath)).toBe(false);
      if (phase === "candidate-active" || phase === "committing") {
        expect(fs.existsSync(fixture.paths.binaryPath)).toBe(true);
      } else {
        expect(fs.existsSync(fixture.paths.binaryPath)).toBe(false);
      }
    }
  }, 120_000);

  it("serializes concurrent updates with an owner-only transaction lock", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "5.0.0", "a");
    const updater = path.join(import.meta.dirname, "fased-managed-updater.mjs");
    const env = { ...fixture.env, FASED_TEST_FAKE_SIGNER_DELAY_MS: "500" };
    const first = execFileAsync(
      process.execPath,
      [updater, "local-signer", "install", "--version", "5.0.0"],
      { env, timeout: 20_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(
      execFileAsync(process.execPath, [updater, "local-signer", "install", "--version", "5.0.0"], {
        env,
        timeout: 20_000,
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Another Fased update") });
    await expect(first).resolves.toBeTruthy();
  }, 30_000);
});
