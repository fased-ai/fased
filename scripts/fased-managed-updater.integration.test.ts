import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SIGNER_PROTOCOL_V2 } from "../src/wallet/signer-protocol-v2.generated.js";
import { installManagedRuntime } from "./install-managed-runtime.mjs";
import {
  readManagedInstallManifest,
  resolveManagedRuntimePaths,
} from "./managed-runtime-layout.mjs";

const execFileAsync = promisify(execFile);
const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function copyManagedScripts(packageRoot: string) {
  const scriptsDir = path.join(packageRoot, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  for (const script of [
    "fased-managed-launcher.sh",
    "fased-managed-service.sh",
    "fased-managed-updater.mjs",
    "managed-runtime-layout.mjs",
    "hosted-release-manifest.mjs",
  ]) {
    fs.copyFileSync(path.join(import.meta.dirname, script), path.join(scriptsDir, script));
  }
  fs.writeFileSync(path.join(scriptsDir, "start-managed.sh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
}

function writeFakeRuntime(
  packageRoot: string,
  version: string,
  dependencyHash: string,
  modules: boolean,
) {
  fs.mkdirSync(path.join(packageRoot, "dist", "control-ui"), { recursive: true });
  if (modules) {
    fs.mkdirSync(path.join(packageRoot, "node_modules"), { recursive: true });
  }
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@fased/fased", version, type: "module" })}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "dist", "control-ui", "version.json"),
    `${JSON.stringify({ version })}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, ".fased-hosted-runtime.json"),
    `${JSON.stringify({ schemaVersion: 1, dependencyHash })}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "fased.mjs"),
    [
      "import fs from 'node:fs';",
      `const version = ${JSON.stringify(version)};`,
      "const args = process.argv.slice(2);",
      "if (process.env.FASED_TEST_COMMAND_LOG && args[0] !== '--version') fs.appendFileSync(process.env.FASED_TEST_COMMAND_LOG, `${args.join(' ')}\\n`);",
      "if (args[0] === '--version') fs.writeSync(1, `${version}\\n`);",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  copyManagedScripts(packageRoot);
}

function writeChecksum(filePath: string) {
  const bytes = fs.readFileSync(filePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`);
}

function writeFakeSignerRelease(releaseFiles: string, version: string, marker: string) {
  const releaseIdentity = {
    version,
    commit: marker.repeat(40),
    buildInputDigest: `sha256:${marker.repeat(64)}`,
    development: false,
  };
  const assetName = `fased-signerd-linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
  const binaryPath = path.join(releaseFiles, assetName);
  fs.writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const release = ${JSON.stringify(releaseIdentity)};
const protocol = ${JSON.stringify(SIGNER_PROTOCOL_V2)};
if (process.argv[2] === "--version") { process.stdout.write(\`fased-signerd \${release.version} commit=\${release.commit} buildInputDigest=\${release.buildInputDigest} development=false\\n\`); process.exit(0); }
const args = process.argv.slice(2); const value = (name) => args[args.indexOf(name) + 1]; const readOnly = args.includes("-read-only");
const socketPath = value("-socket"), controlPath = value("-control-socket"), statePath = value("-state-db"), masterPath = value("-master-key"), pidPath = value("-pid-file"), auditPath = value("-audit-log");
for (const file of [socketPath, controlPath, pidPath]) { try { fs.rmSync(file, { force: true }); } catch {} }
for (const file of [statePath, masterPath, pidPath, auditPath]) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
if (!fs.existsSync(statePath)) fs.writeFileSync(statePath, "paired-state\\n", { mode: 0o600 });
if (!fs.existsSync(masterPath)) fs.writeFileSync(masterPath, "paired-master\\n", { mode: 0o600 });
fs.writeFileSync(pidPath, \`\${process.pid}\\n\`, { mode: 0o600 });
const response = { ok: true, result: { ready: true, readOnly, keystoreType: "signer-owned-v2", release, schema: { version: 3, supported: 3, ready: true }, capabilities: protocol, policies: [], network: { ready: true, wallets: [] } } };
const app = net.createServer((socket) => socket.once("data", () => socket.end(JSON.stringify(response) + "\\n")));
const control = net.createServer((socket) => socket.destroy());
const cleanup = () => { app.close(); control.close(); for (const file of [socketPath, controlPath, pidPath]) { try { fs.rmSync(file, { force: true }); } catch {} } process.exit(0); };
process.on("SIGTERM", cleanup); app.listen(socketPath, () => fs.chmodSync(socketPath, 0o600)); control.listen(controlPath, () => fs.chmodSync(controlPath, 0o600));
`,
    { mode: 0o700 },
  );
  const manifestPath = path.join(releaseFiles, "fased-signerd-release.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, ...releaseIdentity }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(releaseFiles, "fased-signerd-checksums.txt"),
    `${createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex")}  ${assetName}\n${createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex")}  fased-signerd-release.json\n`,
  );
  return releaseIdentity;
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

async function stopFakeSigner(pidPath: string) {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  } catch {
    return;
  }
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (alive()) {
    process.kill(pid, "SIGKILL");
  }
}

describe("managed updater transaction", () => {
  it("activates a verified release and makes a same-version update mutation-free", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-managed-update-e2e-"));
    cleanupRoots.push(root);
    const stateDir = path.join(root, "home", ".fased");
    const prefix = path.join(stateDir, "install-cache", "npm-global");
    const paths = resolveManagedRuntimePaths({ stateDir, prefix });
    const dependencyHash = "b".repeat(64);
    const initialRoot = paths.compatibilityPackageRoot;
    writeFakeRuntime(initialRoot, "1.0.0", dependencyHash, true);
    await installManagedRuntime({
      packageRoot: initialRoot,
      stateDir,
      prefix,
      profile: "local",
    });
    fs.writeFileSync(path.join(stateDir, "wallet-state-preserved"), "yes\n");
    const initialVersion = await execFileAsync(paths.prefixLauncherPath, ["--version"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        FASED_STATE_DIR: stateDir,
        FASED_CONFIG_PATH: path.join(stateDir, "fased.json"),
      },
      encoding: "utf8",
    });
    expect(initialVersion.stdout.trim()).toBe("1.0.0");

    const releaseRoot = path.join(root, "release-files");
    const releaseFiles = path.join(releaseRoot, "v1.0.1");
    const appBuild = path.join(root, "app-build");
    const appRoot = path.join(appBuild, "package");
    writeFakeRuntime(appRoot, "1.0.1", dependencyHash, false);
    fs.mkdirSync(releaseFiles, { recursive: true });
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const appAsset = path.join(releaseFiles, `fased-hosted-app-linux-${arch}-v1.0.1.tar.gz`);
    execFileSync("tar", ["-czf", appAsset, "-C", appBuild, "package"]);
    writeChecksum(appAsset);

    const dependencyBuild = path.join(root, "dependency-build");
    fs.mkdirSync(path.join(dependencyBuild, "node_modules"), { recursive: true });
    const dependencyAsset = path.join(
      releaseFiles,
      `fased-hosted-deps-linux-${arch}-${dependencyHash}.tar.gz`,
    );
    execFileSync("tar", ["-czf", dependencyAsset, "-C", dependencyBuild, "node_modules"]);
    writeChecksum(dependencyAsset);

    const commandLog = path.join(root, "commands.log");
    let artifactRequests = 0;
    let registryTarget = "1.0.1";
    let rejectedHealthVersion: string | null = null;
    const server = http.createServer((request, response) => {
      const requestPath = new URL(request.url || "/", "http://localhost").pathname;
      if (requestPath === "/healthz") {
        const manifest = readManagedInstallManifest(paths.manifestPath);
        const activeVersion = manifest?.runtime.activeVersion;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            ok: activeVersion !== rejectedHealthVersion,
            version: activeVersion === rejectedHealthVersion ? "rejected" : activeVersion,
            runtimeSource: "managed-package",
          }),
        );
        return;
      }
      if (requestPath.includes("@fased")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ "dist-tags": { latest: registryTarget } }));
        return;
      }
      const marker = "/releases/download/";
      if (requestPath.startsWith(marker)) {
        artifactRequests += 1;
        const filePath = path.join(releaseRoot, requestPath.slice(marker.length));
        if (!fs.existsSync(filePath)) {
          response.statusCode = 404;
          response.end("missing");
          return;
        }
        fs.createReadStream(filePath).pipe(response);
        return;
      }
      response.statusCode = 404;
      response.end("missing");
    });
    const port = await listen(server);
    fs.writeFileSync(
      path.join(stateDir, "fased.json"),
      `${JSON.stringify({ gateway: { port } })}\n`,
    );
    const env = {
      ...process.env,
      HOME: path.join(root, "home"),
      FASED_STATE_DIR: stateDir,
      FASED_CONFIG_PATH: path.join(stateDir, "fased.json"),
      FASED_HOSTED_ARTIFACT_BASE_URL: `http://127.0.0.1:${port}/releases/download`,
      FASED_LOCAL_SIGNER_BASE_URL: `http://127.0.0.1:${port}/releases/download`,
      FASED_LOCAL_SIGNER_ALLOW_UNATTESTED: "1",
      FASED_LOCAL_SIGNER_START: "1",
      npm_config_registry: `http://127.0.0.1:${port}`,
      FASED_TEST_COMMAND_LOG: commandLog,
    };
    try {
      const first = await execFileAsync(paths.prefixLauncherPath, ["update", "--timeout", "30"], {
        cwd: root,
        env,
        timeout: 60_000,
        encoding: "utf8",
      });
      expect(first.stdout).toContain("Updated Fased 1.0.0 -> 1.0.1");
      expect(readManagedInstallManifest(paths.manifestPath)?.runtime).toMatchObject({
        activeVersion: "1.0.1",
        previousVersion: "1.0.0",
      });
      expect(fs.realpathSync(paths.currentLink)).toBe(path.join(paths.releasesDir, "1.0.1"));
      expect(fs.readFileSync(path.join(stateDir, "wallet-state-preserved"), "utf8")).toBe("yes\n");
      const updatedVersion = await execFileAsync(paths.prefixLauncherPath, ["--version"], {
        cwd: path.join(root, "home"),
        env,
        encoding: "utf8",
      });
      expect(updatedVersion.stdout.trim()).toBe("1.0.1");
      const firstCommands = fs.readFileSync(commandLog, "utf8");
      expect(firstCommands).toContain("gateway install --force");
      expect(firstCommands).toContain("gateway restart");
      const requestsAfterFirst = artifactRequests;

      const second = await execFileAsync(paths.prefixLauncherPath, ["update"], {
        cwd: root,
        env,
        timeout: 30_000,
        encoding: "utf8",
      });
      expect(second.stdout).toContain("Already current: 1.0.1");
      expect(artifactRequests).toBe(requestsAfterFirst);
      expect(fs.readFileSync(commandLog, "utf8")).toBe(firstCommands);

      fs.rmSync(path.join(paths.currentLink, "dist", "control-ui", "version.json"));
      const repaired = await execFileAsync(paths.prefixLauncherPath, ["update"], {
        cwd: root,
        env,
        timeout: 60_000,
        encoding: "utf8",
      });
      expect(repaired.stdout).toContain("Repaired Fased runtime 1.0.1");
      expect(artifactRequests).toBeGreaterThan(requestsAfterFirst);
      expect(readManagedInstallManifest(paths.manifestPath)?.runtime).toMatchObject({
        activeVersion: "1.0.1",
        previousVersion: "1.0.1",
      });
      expect(fs.realpathSync(paths.currentLink)).toMatch(/1\.0\.1\.repair-/);
      expect(
        fs.existsSync(path.join(paths.currentLink, "dist", "control-ui", "version.json")),
      ).toBe(true);
      expect(fs.readFileSync(path.join(stateDir, "wallet-state-preserved"), "utf8")).toBe("yes\n");

      const walletDir = path.join(stateDir, "wallet");
      fs.mkdirSync(walletDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(walletDir, "provider-registry.v1.json"),
        `${JSON.stringify({ wallets: [{ providerId: "local-socket-signer" }] })}\n`,
        { mode: 0o600 },
      );

      const pairedFiles = path.join(releaseRoot, "v1.0.2");
      const pairedBuild = path.join(root, "paired-app-build");
      const pairedAppRoot = path.join(pairedBuild, "package");
      writeFakeRuntime(pairedAppRoot, "1.0.2", dependencyHash, false);
      fs.mkdirSync(pairedFiles, { recursive: true });
      const pairedAsset = path.join(pairedFiles, `fased-hosted-app-linux-${arch}-v1.0.2.tar.gz`);
      execFileSync("tar", ["-czf", pairedAsset, "-C", pairedBuild, "package"]);
      writeChecksum(pairedAsset);
      const pairedSigner = writeFakeSignerRelease(pairedFiles, "1.0.2", "c");
      registryTarget = "1.0.2";

      const paired = await execFileAsync(paths.prefixLauncherPath, ["update", "--timeout", "30"], {
        cwd: root,
        env,
        timeout: 60_000,
        encoding: "utf8",
      });
      expect(paired.stdout).toContain("Updated Fased 1.0.1 -> 1.0.2");
      expect(readManagedInstallManifest(paths.manifestPath)).toMatchObject({
        runtime: { activeVersion: "1.0.2" },
        signer: { release: pairedSigner },
      });
      expect(fs.existsSync(path.join(stateDir, "local-paired-update-transaction.json"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(stateDir, "signer-update", "transaction.json"))).toBe(false);
      expect(fs.readFileSync(path.join(walletDir, "signerd-v2.db"), "utf8")).toBe("paired-state\n");
      expect(fs.readFileSync(path.join(walletDir, "signerd-v2.master.key"), "utf8")).toBe(
        "paired-master\n",
      );

      const rejectedFiles = path.join(releaseRoot, "v1.0.3");
      const rejectedBuild = path.join(root, "rejected-app-build");
      const rejectedAppRoot = path.join(rejectedBuild, "package");
      writeFakeRuntime(rejectedAppRoot, "1.0.3", dependencyHash, false);
      fs.mkdirSync(rejectedFiles, { recursive: true });
      const rejectedAsset = path.join(
        rejectedFiles,
        `fased-hosted-app-linux-${arch}-v1.0.3.tar.gz`,
      );
      execFileSync("tar", ["-czf", rejectedAsset, "-C", rejectedBuild, "package"]);
      writeChecksum(rejectedAsset);
      writeFakeSignerRelease(rejectedFiles, "1.0.3", "d");
      registryTarget = "1.0.3";
      rejectedHealthVersion = "1.0.3";

      await expect(
        execFileAsync(paths.prefixLauncherPath, ["update", "--timeout", "5"], {
          cwd: root,
          env,
          timeout: 30_000,
          encoding: "utf8",
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(readManagedInstallManifest(paths.manifestPath)).toMatchObject({
        runtime: { activeVersion: "1.0.2" },
        signer: { release: pairedSigner },
      });
      expect(await fs.promises.realpath(paths.currentLink)).toBe(
        path.join(paths.releasesDir, "1.0.2"),
      );
      const restoredSignerVersion = await execFileAsync(
        path.join(stateDir, "bin", "fased-signerd"),
        ["--version"],
        { env, encoding: "utf8" },
      );
      expect(restoredSignerVersion.stdout).toContain("fased-signerd 1.0.2");
      expect(fs.readFileSync(path.join(walletDir, "signerd-v2.db"), "utf8")).toBe("paired-state\n");
      expect(fs.readFileSync(path.join(walletDir, "signerd-v2.master.key"), "utf8")).toBe(
        "paired-master\n",
      );
      expect(fs.existsSync(path.join(stateDir, "local-paired-update-transaction.json"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(stateDir, "signer-update", "transaction.json"))).toBe(false);
      expect(fs.readFileSync(path.join(stateDir, "wallet-state-preserved"), "utf8")).toBe("yes\n");
    } finally {
      await stopFakeSigner(path.join(stateDir, "wallet", "local-signer.pid"));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
