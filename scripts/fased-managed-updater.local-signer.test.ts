import { execFile, spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./fased-managed-updater.mjs";
import {
  resolveSignerBuildIdentity,
  signerIdentityLDFlags,
} from "./fased-signerd-build-identity.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const children = new Set<ReturnType<typeof spawn>>();
const repoRoot = path.resolve(import.meta.dirname, "..");

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

function healthyLocalSignerResponse(version = "1.2.3", marker = "a") {
  return {
    ok: true,
    result: {
      ready: true,
      readOnly: true,
      keystoreType: "signer-owned-v2",
      release: identity(version, marker),
      schema: { version: 3, supported: 3, ready: true },
      capabilities: {
        protocol: { current: 2, min: 2, max: 2 },
        nativeFeeReservationLamports: 5_000_000,
        features: [...REQUIRED_FEATURES],
      },
      policies: [
        {
          walletId: "agent",
          version: 1,
          hash: `sha256:${"a".repeat(64)}`,
        },
      ],
      network: {
        ready: true,
        wallets: [
          {
            walletId: "agent",
            configured: true,
            version: 1,
            ready: true,
            hash: `hmac-sha256:${"b".repeat(64)}`,
          },
        ],
      },
    },
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
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const assetName = `fased-signerd-${platform}-${process.arch === "arm64" ? "arm64" : "amd64"}`;
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
  policies: [],
  network: { ready: true, wallets: [] }
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

function rewriteAsCanonicalDevelopmentSigner(binaryPath: string) {
  const source = fs.readFileSync(binaryPath, "utf8");
  const developmentIdentity = {
    version: "dev",
    commit: "unknown",
    buildInputDigest: "unknown",
    development: true,
  };
  fs.writeFileSync(
    binaryPath,
    source
      .replace(
        /^const identity = .*;$/mu,
        `const identity = ${JSON.stringify(developmentIdentity)};`,
      )
      .replace(
        /if \(process\.argv\.length === 3 && process\.argv\[2\] === "--version"\) \{[\s\S]*?\n\}/u,
        [
          'if (process.argv.length === 3 && process.argv[2] === "--version") {',
          '  fs.writeSync(1, "fased-signerd dev commit=unknown buildInputDigest=unknown development=true\\n");',
          "  process.exit(0);",
          "}",
        ].join("\n"),
      ),
    { mode: 0o700 },
  );
}

async function writeRealSignerRelease(releaseRoot: string) {
  const packageVersion = String(
    JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version,
  );
  const commit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
  ).stdout.trim();
  const identityEnv = {
    ...process.env,
    FASED_SIGNER_BUILD_VERSION: packageVersion,
    FASED_SIGNER_BUILD_COMMIT: commit,
    FASED_SIGNER_BUILD_DEVELOPMENT: "false",
  };
  const identity = await resolveSignerBuildIdentity({ root: repoRoot, env: identityEnv });
  const ldflags = signerIdentityLDFlags(identity);
  const dir = path.join(releaseRoot, `v${packageVersion}`);
  await fsp.mkdir(dir, { recursive: true });
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const assetName = `fased-signerd-${platform}-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  const binary = path.join(dir, assetName);
  await execFileAsync(
    "go",
    ["build", "-buildvcs=false", "-trimpath", `-ldflags=-buildid= ${ldflags}`, "-o", binary, "."],
    { cwd: path.join(repoRoot, "tools", "fased-signerd"), env: process.env },
  );
  await fsp.chmod(binary, 0o700);
  const manifest = path.join(dir, "fased-signerd-release.json");
  await fsp.writeFile(manifest, `${JSON.stringify({ schemaVersion: 1, ...identity }, null, 2)}\n`, {
    mode: 0o600,
  });
  await fsp.writeFile(
    path.join(dir, "fased-signerd-checksums.txt"),
    `${digest(binary)}  ${assetName}\n${digest(manifest)}  fased-signerd-release.json\n`,
    { mode: 0o600 },
  );
  return { packageVersion, binary };
}

function legacySolanaEnvelope(keypair: Keypair, passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keypair.secretKey)), cipher.final()]);
  return {
    kind: "fased-solana-keypair",
    version: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    publicKey: keypair.publicKey.toBase58(),
  };
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

async function stopInstalledSigner(paths: ReturnType<typeof __testing.resolveLocalSignerPaths>) {
  const pid = Number.parseInt(await fsp.readFile(paths.pidPath, "utf8"), 10);
  if (Number.isSafeInteger(pid) && pid > 1) {
    process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const running =
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
    if (!running) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`signer did not stop: ${pid}`);
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

  it("requires an explicit boolean when the paired updater verifies runtime mode", () => {
    expect(
      __testing.parseLocalSignerTransactionArgs([
        "local-signer",
        "verify",
        "--version",
        "0.1.73",
        "--expected-read-only",
        "false",
      ]),
    ).toMatchObject({ action: "verify", expectedReadOnly: false });
    expect(() =>
      __testing.parseLocalSignerTransactionArgs([
        "local-signer",
        "verify",
        "--version",
        "0.1.73",
        "--expected-read-only",
        "sometimes",
      ]),
    ).toThrow(/must be true or false/);
    expect(() =>
      __testing.parseLocalSignerTransactionArgs([
        "local-signer",
        "rollback",
        "--expected-read-only",
        "false",
      ]),
    ).toThrow(/supported only by local-signer verify/);
  });

  it("refreshes a v0.1.72 source transaction with exact target controller bytes", async () => {
    const fixture = makeFixture();
    const sourceRoot = path.join(fixture.root, "source");
    const transactionId = "12345678-1234-4123-8123-123456789abc";
    const transactionDir = path.join(
      fixture.stateDir,
      "source-paired-update",
      "transactions",
      transactionId,
    );
    const controllerDir = path.join(transactionDir, "controller");
    await fsp.mkdir(path.join(sourceRoot, "scripts"), { recursive: true });
    await fsp.mkdir(path.join(sourceRoot, "dist"), { recursive: true });
    await fsp.mkdir(controllerDir, { recursive: true });
    for (const name of [
      "fased-managed-updater.mjs",
      "hosted-release-manifest.mjs",
      "managed-runtime-layout.mjs",
    ]) {
      await fsp.copyFile(
        path.join(repoRoot, "scripts", name),
        path.join(sourceRoot, "scripts", name),
      );
    }
    await fsp.writeFile(
      path.join(sourceRoot, "package.json"),
      `${JSON.stringify({ name: "@fased/fased", version: "0.1.73" })}\n`,
    );
    await execFileAsync("git", ["init", "-q"], { cwd: sourceRoot });
    await execFileAsync("git", ["config", "user.email", "fixture@fased.test"], {
      cwd: sourceRoot,
    });
    await execFileAsync("git", ["config", "user.name", "Fixture"], { cwd: sourceRoot });
    await execFileAsync("git", ["add", "."], { cwd: sourceRoot });
    await execFileAsync("git", ["commit", "-qm", "candidate"], { cwd: sourceRoot });
    const targetCommit = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" })
    ).stdout.trim();
    await fsp.writeFile(
      path.join(sourceRoot, "dist", "build-info.json"),
      `${JSON.stringify({ version: "0.1.73", commit: targetCommit })}\n`,
    );
    await fsp.writeFile(path.join(controllerDir, "fased-managed-updater.mjs"), "old-controller\n");
    const journalPath = path.join(fixture.stateDir, "source-paired-update", "transaction.json");
    await fsp.writeFile(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "source-checkout",
        transactionId,
        transactionDir,
        sourceRoot,
        controllerPath: path.join(controllerDir, "fased-managed-updater.mjs"),
        phase: "app-active",
        previous: { sha: "a".repeat(40), version: "0.1.72", branch: null },
        target: { sha: targetCommit, version: "0.1.73" },
      })}\n`,
    );

    await expect(
      __testing.refreshLocalSourceController(
        { sourceRoot, targetVersion: "0.1.73", expectedCommit: targetCommit },
        { stateDir: fixture.stateDir },
      ),
    ).resolves.toEqual({ action: "refreshed", targetVersion: "0.1.73" });
    for (const name of [
      "fased-managed-updater.mjs",
      "hosted-release-manifest.mjs",
      "managed-runtime-layout.mjs",
    ]) {
      expect(digest(path.join(controllerDir, name))).toBe(
        digest(path.join(sourceRoot, "scripts", name)),
      );
    }
    await fsp.appendFile(
      path.join(sourceRoot, "scripts", "fased-managed-updater.mjs"),
      "\n// untrusted working-tree change\n",
    );
    await expect(
      __testing.refreshLocalSourceController(
        { sourceRoot, targetVersion: "0.1.73", expectedCommit: targetCommit },
        { stateDir: fixture.stateDir },
      ),
    ).rejects.toThrow(/not exact target Git content/);
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

  it("reports every Local signer health predicate with a stable reason code", () => {
    const expected = identity("1.2.3", "a");
    const healthy = healthyLocalSignerResponse();
    expect(__testing.evaluateLocalSignerHealth(healthy, expected, true)).toMatchObject({
      ok: true,
      reasons: [],
    });

    const cases = [
      {
        code: "response_not_ok",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.ok = false;
        },
      },
      {
        code: "signer_not_ready",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.ready = false;
        },
      },
      {
        code: "custody_type_mismatch",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.keystoreType = "legacy";
        },
      },
      {
        code: "protocol_range_mismatch",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.capabilities.protocol.current = 1;
        },
      },
      {
        code: "fee_reservation_mismatch",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.capabilities.nativeFeeReservationLamports = 4_999_999;
        },
      },
      {
        code: "schema_not_ready",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.schema.ready = false;
        },
      },
      {
        code: "mode_mismatch",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.readOnly = false;
        },
      },
      {
        code: "missing_capability",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.capabilities.features.shift();
        },
      },
      {
        code: "policy_record_invalid",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.policies[0].hash = "invalid";
        },
      },
      {
        code: "network_record_invalid",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.network.wallets[0].hash = "invalid";
        },
      },
      {
        code: "release_identity_invalid",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.release.commit = "invalid";
        },
      },
      {
        code: "release_identity_mismatch",
        mutate: (response: ReturnType<typeof healthyLocalSignerResponse>) => {
          response.result.release.commit = "b".repeat(40);
        },
      },
    ];

    for (const testCase of cases) {
      const response = structuredClone(healthy);
      testCase.mutate(response);
      const evaluation = __testing.evaluateLocalSignerHealth(response, expected, true);
      expect(evaluation.ok, testCase.code).toBe(false);
      expect(
        evaluation.reasons.map((reason: { code: string }) => reason.code),
        testCase.code,
      ).toContain(testCase.code);
    }
  });

  it("formats signer health reasons without raw response or secret values", () => {
    const formatted = __testing.formatLocalSignerHealthReasons([
      { code: "mode_mismatch", detail: "expected=read-only observed=read-write" },
      { code: "missing_capability", detail: "failClosedPolicies" },
    ]);
    expect(formatted).toBe(
      "mode_mismatch (expected=read-only observed=read-write); missing_capability (failClosedPolicies)",
    );
    expect(formatted).not.toContain("socket");
    expect(formatted).not.toContain("rpc");
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
      const signerInfo = await fsp.stat(fixture.paths.binaryPath);
      const enrollmentInfo = await fsp.stat(fixture.paths.enrollmentPath);
      expect(signerInfo.ino).not.toBe(enrollmentInfo.ino);
      expect(await fsp.readFile(fixture.paths.enrollmentPath)).toEqual(
        await fsp.readFile(fixture.paths.binaryPath),
      );
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

  it("replaces the canonical development signer without weakening candidate identity", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "1.0.0", "a");
    writeFakeRelease(fixture.releaseRoot, "1.0.1", "b");
    await withEnv(fixture.env, async () => {
      await __testing.runLocalSignerTransaction(
        { action: "install", targetVersion: "1.0.0", timeoutMs: 10_000 },
        { stateDir: fixture.stateDir },
      );
      fs.mkdirSync(fixture.paths.materialDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(fixture.paths.stateDbPath, "durable-state\n", { mode: 0o600 });
      fs.writeFileSync(fixture.paths.masterKeyPath, "durable-master\n", { mode: 0o600 });
      rewriteAsCanonicalDevelopmentSigner(fixture.paths.binaryPath);
      await startInstalledSigner(fixture.paths);

      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "1.0.1", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ action: "committed", identity: { version: "1.0.1" } });

      expect(fs.readFileSync(fixture.paths.stateDbPath, "utf8")).toBe("durable-state\n");
      expect(fs.readFileSync(fixture.paths.masterKeyPath, "utf8")).toBe("durable-master\n");
      await expect(
        __testing.probeLocalSignerHealth(fixture.paths.socketPath, identity("1.0.1", "b"), 3_000),
      ).resolves.toMatchObject({ ready: true });
    });
  }, 30_000);

  it("verifies the read-write candidate after a v0.1.72 Gateway restart", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "0.1.72", "a");
    const candidate = writeFakeRelease(fixture.releaseRoot, "0.1.73", "b");
    await withEnv(fixture.env, async () => {
      await __testing.runLocalSignerTransaction(
        { action: "install", targetVersion: "0.1.72", timeoutMs: 10_000 },
        { stateDir: fixture.stateDir },
      );
      await startInstalledSigner(fixture.paths);
      fs.writeFileSync(path.join(fixture.paths.materialDir, "owner-policy-proof"), "preserve\n", {
        mode: 0o600,
      });

      await expect(
        __testing.runLocalSignerTransaction(
          {
            action: "install",
            targetVersion: "0.1.73",
            timeoutMs: 10_000,
            deferCommit: true,
          },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ action: "candidate-active" });

      await stopInstalledSigner(fixture.paths);
      await startInstalledSigner(fixture.paths);

      await expect(
        __testing.runLocalSignerTransaction(
          {
            action: "verify",
            targetVersion: "0.1.73",
            expectedCommit: candidate.releaseIdentity.commit,
            timeoutMs: 10_000,
          },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ action: "verified", identity: { version: "0.1.73" } });

      await expect(
        __testing.runLocalSignerTransaction(
          { action: "commit", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ action: "committed", identity: { version: "0.1.73" } });
      expect(
        fs.readFileSync(path.join(fixture.paths.materialDir, "owner-policy-proof"), "utf8"),
      ).toBe("preserve\n");
      expect(fs.readFileSync(fixture.paths.stateDbPath, "utf8")).toBe("durable-state\n");
      expect(fs.readFileSync(fixture.paths.masterKeyPath, "utf8")).toBe("durable-master\n");
    });
  }, 30_000);

  it("restores a canonical development signer byte-for-byte when candidate health fails", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "1.0.0", "a");
    writeFakeRelease(fixture.releaseRoot, "1.0.1", "b", { healthy: false });
    await withEnv(fixture.env, async () => {
      await __testing.runLocalSignerTransaction(
        { action: "install", targetVersion: "1.0.0", timeoutMs: 10_000 },
        { stateDir: fixture.stateDir },
      );
      fs.mkdirSync(fixture.paths.materialDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(fixture.paths.stateDbPath, "durable-state\n", { mode: 0o600 });
      fs.writeFileSync(fixture.paths.masterKeyPath, "durable-master\n", { mode: 0o600 });
      rewriteAsCanonicalDevelopmentSigner(fixture.paths.binaryPath);
      const developmentDigest = digest(fixture.paths.binaryPath);
      await startInstalledSigner(fixture.paths);

      try {
        await __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "1.0.1", timeoutMs: 3_000 },
          { stateDir: fixture.stateDir },
        );
        throw new Error("expected unhealthy candidate rollback");
      } catch (error) {
        expect(error).toMatchObject({ code: "LOCAL_SIGNER_UPDATE_ROLLED_BACK" });
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("candidate preflight");
        expect((error as Error).message).toContain("missing_capability");
      }

      expect(digest(fixture.paths.binaryPath)).toBe(developmentDigest);
      expect(fs.readFileSync(fixture.paths.stateDbPath, "utf8")).toBe("durable-state\n");
      expect(fs.readFileSync(fixture.paths.masterKeyPath, "utf8")).toBe("durable-master\n");
      await expect(
        __testing.probeLocalSignerHealth(
          fixture.paths.socketPath,
          {
            version: "dev",
            commit: "unknown",
            buildInputDigest: "unknown",
            development: true,
          },
          3_000,
        ),
      ).resolves.toMatchObject({ ready: true });

      writeFakeRelease(fixture.releaseRoot, "1.0.1", "b");
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "1.0.1", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).resolves.toMatchObject({ action: "committed", identity: { version: "1.0.1" } });
      expect(fs.readFileSync(fixture.paths.stateDbPath, "utf8")).toBe("durable-state\n");
      expect(fs.readFileSync(fixture.paths.masterKeyPath, "utf8")).toBe("durable-master\n");
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

  it("leaves unregistered legacy files untouched because their wallet roles cannot be guessed", async () => {
    const fixture = makeFixture();
    writeFakeRelease(fixture.releaseRoot, "1.0.0", "a");
    fs.mkdirSync(fixture.paths.materialDir, { recursive: true, mode: 0o700 });
    const legacyKeystore = path.join(
      fixture.paths.materialDir,
      "keystore-solana-agent-primary.v1.enc",
    );
    fs.writeFileSync(legacyKeystore, '{"version":1}\n', { mode: 0o600 });

    await withEnv(fixture.env, async () => {
      await expect(
        __testing.runLocalSignerTransaction(
          { action: "install", targetVersion: "1.0.0", timeoutMs: 10_000 },
          { stateDir: fixture.stateDir },
        ),
      ).rejects.toThrow(/no registered legacy wallets/iu);
    });

    expect(fs.readFileSync(legacyKeystore, "utf8")).toBe('{"version":1}\n');
    expect(fs.existsSync(fixture.paths.binaryPath)).toBe(false);
    expect(fs.existsSync(fixture.paths.journalPath)).toBe(false);
    expect(fs.readdirSync(fixture.paths.transactionsDir)).toEqual([]);
  });

  it("builds an automatic multi-wallet migration from the existing registry and stored legacy passphrase", async () => {
    const fixture = makeFixture();
    const transactionDir = path.join(fixture.paths.transactionsDir, "migration-plan");
    await fsp.mkdir(transactionDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(fixture.paths.materialDir, { recursive: true, mode: 0o700 });
    for (const walletID of ["agent-2", "vault"]) {
      await fsp.writeFile(
        path.join(fixture.paths.materialDir, `keystore-solana-${walletID}.v1.enc`),
        '{"version":1}\n',
        { mode: 0o600 },
      );
    }
    await fsp.writeFile(
      path.join(fixture.paths.materialDir, "provider-registry.v1.json"),
      `${JSON.stringify({
        version: 1,
        providers: { "embedded-keystore": { enabled: true } },
        wallets: [
          {
            id: "agent-2",
            name: "Agent 2",
            providerId: "embedded-keystore",
            addresses: { solana: "agent-address" },
            metadata: { role: "agent" },
          },
          {
            id: "vault",
            name: "Vault",
            providerId: "embedded-keystore",
            addresses: { solana: "vault-address" },
            metadata: { purpose: "vault" },
          },
        ],
        assignments: {},
      })}\n`,
      { mode: 0o600 },
    );
    await fsp.writeFile(
      path.join(fixture.stateDir, "fased.json"),
      `${JSON.stringify({
        env: {
          vars: {
            FASED_WALLET_PASSPHRASE: "inline legacy secret",
            FASED_WALLET_SOLANA_RPC_URL__AGENT_2: "https://agent-rpc.example",
            FASED_WALLET_SOLANA_RPC_URL__VAULT: "https://vault-rpc.example",
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const plan = await __testing.buildLegacyLocalWalletMigrationPlan(fixture.paths, transactionDir);
    expect(plan?.wallets).toMatchObject([
      {
        walletID: "agent-2",
        signerWalletID: "agent_2",
        role: "agent",
        rpcURL: "https://agent-rpc.example",
      },
      {
        walletID: "vault",
        signerWalletID: "vault",
        role: "vault",
        rpcURL: "https://vault-rpc.example",
      },
    ]);
    expect(plan?.wallets[0]?.passphrasePath).not.toBe(plan?.wallets[1]?.passphrasePath);
    const firstWallet = plan?.wallets[0];
    if (!firstWallet) {
      throw new Error("legacy wallet migration plan was empty");
    }
    expect(await fsp.readFile(firstWallet.passphrasePath, "utf8")).toBe("inline legacy secret\n");
  });

  it("recognizes the Local legacy layouts shipped by v0.1.60 through v0.1.69", async () => {
    for (let patchVersion = 60; patchVersion <= 69; patchVersion += 1) {
      const fixture = makeFixture();
      const originVersion = `0.1.${patchVersion}`;
      const transactionDir = path.join(fixture.paths.transactionsDir, `from-${originVersion}`);
      await fsp.mkdir(transactionDir, { recursive: true, mode: 0o700 });
      await fsp.mkdir(fixture.paths.materialDir, { recursive: true, mode: 0o700 });
      const keystoreName =
        patchVersion <= 63 ? "keystore-solana.v1.enc" : "keystore-solana-agent-2.v1.enc";
      await fsp.writeFile(path.join(fixture.paths.materialDir, keystoreName), "{}\n", {
        mode: 0o600,
      });
      const passphrasePath = path.join(
        fixture.paths.materialDir,
        patchVersion <= 66 ? "passphrase" : "passphrase-agent-2",
      );
      if (patchVersion >= 64) {
        await fsp.writeFile(passphrasePath, "historical secret\n", { mode: 0o600 });
      }
      await fsp.writeFile(
        path.join(fixture.paths.materialDir, "provider-registry.v1.json"),
        `${JSON.stringify({
          version: 1,
          defaultWalletId: "agent-2",
          providers: { "embedded-keystore": { enabled: true } },
          wallets: [
            {
              id: "agent-2",
              name: "Agent 2",
              providerId: "embedded-keystore",
              addresses: { solana: "historical-address" },
              metadata: {},
            },
          ],
          assignments: {},
        })}\n`,
        { mode: 0o600 },
      );
      const vars =
        patchVersion <= 63
          ? {
              FASED_WALLET_PASSPHRASE: "historical secret",
              FASED_WALLET_RPC_URL: "https://legacy-rpc.example",
            }
          : patchVersion <= 66
            ? {
                FASED_WALLET_PASSPHRASE_FILE: passphrasePath,
                FASED_WALLET_SOLANA_RPC_URL: "https://legacy-rpc.example",
              }
            : {
                FASED_WALLET_PASSPHRASE_FILE__AGENT_2: passphrasePath,
                FASED_WALLET_SOLANA_RPC_URL__AGENT_2: "https://legacy-rpc.example",
              };
      await fsp.writeFile(
        path.join(fixture.stateDir, "fased.json"),
        `${JSON.stringify({ metadata: { originVersion }, env: { vars } })}\n`,
        { mode: 0o600 },
      );

      const plan = await __testing.buildLegacyLocalWalletMigrationPlan(
        fixture.paths,
        transactionDir,
      );
      expect(plan?.wallets).toMatchObject([
        {
          walletID: "agent-2",
          signerWalletID: "agent_2",
          role: "agent",
          rpcURL: "https://legacy-rpc.example",
        },
      ]);
      const firstWallet = plan?.wallets[0];
      if (!firstWallet) {
        throw new Error(`legacy wallet migration plan was empty for ${originVersion}`);
      }
      expect(await fsp.readFile(firstWallet.passphrasePath, "utf8")).toBe("historical secret\n");
    }
  });

  it("finishes an old-updater candidate by importing the real legacy key, RPC, and role transactionally", async () => {
    if (!new Set(["linux", "darwin"]).has(process.platform)) {
      return;
    }
    const fixture = makeFixture();
    const { packageVersion } = await writeRealSignerRelease(fixture.releaseRoot);
    const passphrase = "legacy migration integration secret";
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const stagedLegacy = path.join(fixture.root, "legacy-staged");
    await fsp.mkdir(stagedLegacy, { recursive: true, mode: 0o700 });
    const keystorePath = path.join(fixture.paths.materialDir, "keystore-solana-agent.v1.enc");
    const passphrasePath = path.join(fixture.paths.materialDir, "passphrase-agent");
    await fsp.writeFile(
      path.join(stagedLegacy, "keystore"),
      `${JSON.stringify(legacySolanaEnvelope(keypair, passphrase), null, 2)}\n`,
      { mode: 0o600 },
    );
    await fsp.writeFile(path.join(stagedLegacy, "passphrase"), `${passphrase}\n`, { mode: 0o600 });
    await fsp.writeFile(
      path.join(stagedLegacy, "registry"),
      `${JSON.stringify({
        version: 1,
        defaultWalletId: "agent",
        providers: { "embedded-keystore": { enabled: true } },
        wallets: [
          {
            id: "agent",
            name: "Agent",
            providerId: "embedded-keystore",
            addresses: { solana: publicKey },
            metadata: { role: "agent" },
          },
        ],
        assignments: {},
      })}\n`,
      { mode: 0o600 },
    );
    const rpc = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const id = JSON.parse(body || "{}").id ?? 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: "11111111111111111111111111111111",
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
    const address = rpc.address();
    if (!address || typeof address === "string") {
      throw new Error("test RPC did not bind");
    }
    const rpcURL = `http://127.0.0.1:${address.port}`;
    await fsp.writeFile(
      path.join(stagedLegacy, "config"),
      `${JSON.stringify({
        env: {
          vars: {
            FASED_WALLET_PASSPHRASE_FILE__AGENT: passphrasePath,
            FASED_WALLET_SOLANA_RPC_URL__AGENT: rpcURL,
          },
        },
        wallet: { provider: { id: "embedded-keystore" }, keystore: { path: keystorePath } },
      })}\n`,
      { mode: 0o600 },
    );
    await fsp.writeFile(
      path.join(stagedLegacy, "service"),
      `[Service]\nEnvironment=FASED_GATEWAY_PORT=18789\nEnvironment=FASED_WALLET_PASSPHRASE_FILE__AGENT=${passphrasePath}\nEnvironment=FASED_WALLET_SOLANA_RPC_URL__AGENT=${rpcURL}\n`,
      { mode: 0o600 },
    );

    try {
      await withEnv(fixture.env, async () => {
        await __testing.runLocalSignerTransaction(
          { action: "prepare", targetVersion: packageVersion, timeoutMs: 30_000 },
          { stateDir: fixture.stateDir },
        );
        await __testing.runLocalSignerTransaction(
          { action: "activate", timeoutMs: 30_000 },
          { stateDir: fixture.stateDir },
        );
        await fsp.mkdir(fixture.paths.materialDir, { recursive: true, mode: 0o700 });
        const serviceDir = path.join(fixture.root, ".config", "systemd", "user");
        await fsp.mkdir(serviceDir, { recursive: true, mode: 0o700 });
        await Promise.all([
          fsp.rename(path.join(stagedLegacy, "keystore"), keystorePath),
          fsp.rename(path.join(stagedLegacy, "passphrase"), passphrasePath),
          fsp.rename(
            path.join(stagedLegacy, "registry"),
            path.join(fixture.paths.materialDir, "provider-registry.v1.json"),
          ),
          fsp.rename(path.join(stagedLegacy, "config"), path.join(fixture.stateDir, "fased.json")),
          fsp.rename(
            path.join(stagedLegacy, "service"),
            path.join(serviceDir, "fased-gateway.service"),
          ),
        ]);
        await expect(
          __testing.runLocalSignerTransaction(
            { action: "migrate-active", timeoutMs: 30_000 },
            { stateDir: fixture.stateDir },
          ),
        ).resolves.toMatchObject({
          action: "migrated-active",
          migratedWallets: [{ walletID: "agent", publicKey, networkConfigured: true }],
        });
        const result = await __testing.runLocalSignerTransaction(
          { action: "commit", timeoutMs: 30_000 },
          { stateDir: fixture.stateDir },
        );
        expect(result).toMatchObject({
          action: "committed",
          legacyMigrationRequired: true,
          migratedWallets: [
            {
              walletID: "agent",
              signerWalletID: "agent",
              role: "agent",
              publicKey,
              roleBaselinePending: false,
              networkConfigured: true,
            },
          ],
        });
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        rpc.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const registry = JSON.parse(
      await fsp.readFile(path.join(fixture.paths.materialDir, "provider-registry.v1.json"), "utf8"),
    );
    expect(registry.wallets[0]).toMatchObject({
      providerId: "local-socket-signer",
      addresses: { solana: publicKey },
      metadata: { role: "agent", signerWalletId: "agent" },
    });
    const config = JSON.parse(
      await fsp.readFile(path.join(fixture.stateDir, "fased.json"), "utf8"),
    );
    expect(config.wallet.provider).toEqual({ id: "local-socket-signer" });
    expect(config.wallet.keystore).toBeUndefined();
    expect(config.env.vars).toEqual({
      FASED_WALLET_SOLANA_RPC_URL__AGENT: rpcURL,
    });
    expect(fs.existsSync(keystorePath)).toBe(false);
    expect(fs.existsSync(passphrasePath)).toBe(false);
    expect(await fsp.readdir(fixture.paths.transactionsDir)).toEqual([]);
    const service = await fsp.readFile(
      path.join(fixture.root, ".config", "systemd", "user", "fased-gateway.service"),
      "utf8",
    );
    expect(service).toContain("Environment=FASED_GATEWAY_PORT=18789"); // pragma: allowlist secret
    expect(service).not.toContain("PASSPHRASE");
    expect(service).not.toContain("SOLANA_RPC_URL");

    const policy = JSON.parse(
      (
        await execFileAsync(
          fixture.paths.binaryPath,
          [
            "admin",
            "policy",
            "get",
            "--control-socket",
            fixture.paths.controlSocketPath,
            "--wallet-id",
            "agent",
          ],
          { encoding: "utf8" },
        )
      ).stdout,
    );
    expect(policy).toMatchObject({ walletId: "agent", version: 1 });
    const network = JSON.parse(
      (
        await execFileAsync(
          fixture.paths.binaryPath,
          [
            "admin",
            "network",
            "get",
            "--control-socket",
            fixture.paths.controlSocketPath,
            "--wallet-id",
            "agent",
          ],
          { encoding: "utf8" },
        )
      ).stdout,
    );
    expect(network).toMatchObject({ walletId: "agent", configured: true, version: 1 });
  }, 120_000);

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
