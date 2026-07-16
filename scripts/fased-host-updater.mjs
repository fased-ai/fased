#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const RELEASE_BASE = "https://github.com/fased-ai/fased/releases/download";
const RELEASE_REPOSITORY = "fased-ai/fased";
const RELEASE_WORKFLOW = "fased-ai/fased/.github/workflows/hosted-runtime-release.yml";
const SOCKET_PATH = "/run/fased-host-updater/request.sock";
const STATE_DIR = "/var/lib/fased-host-updater";
const SIGNER_PATH = "/opt/fased/signer/fased-signerd";
const VERSION_PATH = path.join(STATE_DIR, "signer-version");
const CHANNEL_PATH = "/etc/fased/host-updater-channel";
const MAX_REQUEST_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 20 * 60_000;

export function parseReleaseVersion(value) {
  const version = String(value ?? "")
    .trim()
    .replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error("version must be an exact semantic release version");
  }
  return version;
}

export function parseUpdateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request must be an object");
  }
  const keys = Object.keys(value).toSorted();
  if (keys.join(",") !== "op,schemaVersion,version") {
    throw new Error("request contains unsupported fields");
  }
  if (value.schemaVersion !== 1 || value.op !== "prepareRelease") {
    throw new Error("unsupported updater request");
  }
  return { schemaVersion: 1, op: "prepareRelease", version: parseReleaseVersion(value.version) };
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
    if (!match) {
      return null;
    }
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === r) {
      continue;
    }
    if (l === undefined || r === undefined) {
      return l === undefined ? -1 : 1;
    }
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      return Number(l) < Number(r) ? -1 : 1;
    }
    if (ln !== rn) {
      return ln ? -1 : 1;
    }
    return l < r ? -1 : 1;
  }
  return 0;
}

function releaseArchitecture() {
  if (process.platform !== "linux") {
    throw new Error("host updater supports Linux only");
  }
  if (process.arch === "x64") {
    return "amd64";
  }
  if (process.arch === "arm64") {
    return "arm64";
  }
  throw new Error(`unsupported host architecture: ${process.arch}`);
}

async function fixedExecutable(candidates, label) {
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next root-controlled system path.
    }
  }
  throw new Error(`${label} is not installed in a root-controlled system path`);
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`official release download failed (${response.status})`);
  }
  await pipeline(response.body, fs.createWriteStream(destination, { mode: 0o600 }));
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function verifyReleaseAsset(assetPath, version) {
  const gh = await fixedExecutable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  await execFileAsync(
    gh,
    [
      "attestation",
      "verify",
      assetPath,
      "--repo",
      RELEASE_REPOSITORY,
      "--signer-workflow",
      RELEASE_WORKFLOW,
      "--source-ref",
      `refs/tags/v${version}`,
      "--deny-self-hosted-runners",
    ],
    {
      env: {
        HOME: STATE_DIR,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        GH_PROMPT_DISABLED: "1",
      },
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function verifyAdjacentChecksum(assetPath, checksumPath, assetName) {
  const checksum = await fsp.readFile(checksumPath, "utf8");
  const expected = checksum
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1]?.replace(/^\*/, "") === assetName)?.[0]
    ?.toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("official signer checksum entry is missing");
  }
  if ((await sha256(assetPath)) !== expected) {
    throw new Error("official signer checksum mismatch");
  }
}

async function readInstalledVersion() {
  try {
    return parseReleaseVersion(await fsp.readFile(VERSION_PATH, "utf8"));
  } catch {
    return null;
  }
}

function releaseAllowedForChannel(version, channel) {
  return !version.includes("-") || channel.trim() === "beta";
}

async function assertReleaseChannelAllowed(version) {
  const channel = await fsp.readFile(CHANNEL_PATH, "utf8").catch(() => "stable");
  if (!releaseAllowedForChannel(version, channel)) {
    throw new Error(
      "prerelease signer updates require root to set /etc/fased/host-updater-channel to beta",
    );
  }
}

function assertSignerV2Health(response) {
  const protocol = response?.result?.capabilities?.protocol;
  if (
    response?.ok !== true ||
    response?.result?.ready !== true ||
    response?.result?.keystoreType !== "signer-owned-v2" ||
    protocol?.current !== 2 ||
    protocol?.min > 2 ||
    protocol?.max < 2 ||
    !Array.isArray(response?.result?.policies)
  ) {
    throw new Error("signer health did not acknowledge protocol v2 and signer-owned custody");
  }
}

export async function probeSignerV2() {
  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: "/run/fased-signerd/app.sock" });
    socket.setEncoding("utf8");
    socket.setTimeout(3000);
    let body = "";
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "health" })}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      socket.destroy();
      try {
        resolve(JSON.parse(body.slice(0, newline)));
      } catch {
        reject(new Error("signer health response is invalid"));
      }
    });
    socket.once("timeout", () => reject(new Error("signer health probe timed out")));
    socket.once("error", reject);
  });
  assertSignerV2Health(response);
}

async function restartSigner() {
  const systemctl = await fixedExecutable(["/usr/bin/systemctl", "/bin/systemctl"], "systemctl");
  await execFileAsync(systemctl, ["restart", "fased-signerd.service"], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 60_000,
  });
  await execFileAsync(systemctl, ["is-active", "--quiet", "fased-signerd.service"], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 30_000,
  });
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await probeSignerV2();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`signer protocol v2 readiness failed: ${lastError?.message || "unknown error"}`);
}

async function installSignerRelease(version) {
  await assertReleaseChannelAllowed(version);
  const current = await readInstalledVersion();
  if (current && compareVersions(current, version) === 1) {
    throw new Error(`refusing signer downgrade from ${current} to ${version}`);
  }
  if (current === version) {
    try {
      await fsp.access(SIGNER_PATH, fs.constants.X_OK);
      await probeSignerV2();
      return { changed: false, version };
    } catch {
      // Repair a missing, corrupt, or incompatible same-version signer below.
    }
  }

  const arch = releaseArchitecture();
  const assetName = `fased-signerd-linux-${arch}`;
  const releaseUrl = `${RELEASE_BASE}/v${version}`;
  await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.dirname(SIGNER_PATH), { recursive: true, mode: 0o755 });
  const staging = await fsp.mkdtemp(path.join(STATE_DIR, `.staging-${version}-`));
  const assetPath = path.join(staging, assetName);
  const checksumsPath = path.join(staging, "fased-signerd-checksums.txt");
  const candidatePath = `${SIGNER_PATH}.candidate`;
  const previousPath = `${SIGNER_PATH}.previous`;
  let replaced = false;
  try {
    await Promise.all([
      download(`${releaseUrl}/${assetName}`, assetPath),
      download(`${releaseUrl}/fased-signerd-checksums.txt`, checksumsPath),
    ]);
    await verifyAdjacentChecksum(assetPath, checksumsPath, assetName);
    await verifyReleaseAsset(assetPath, version);

    await fsp.copyFile(assetPath, candidatePath);
    await fsp.chmod(candidatePath, 0o755);
    await fsp.rm(previousPath, { force: true });
    try {
      await fsp.rename(SIGNER_PATH, previousPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await fsp.rename(candidatePath, SIGNER_PATH);
    replaced = true;
    try {
      await restartSigner();
    } catch (error) {
      await fsp.rm(SIGNER_PATH, { force: true });
      try {
        await fsp.rename(previousPath, SIGNER_PATH);
        await restartSigner().catch(() => undefined);
      } catch {
        // Preserve the original restart failure below.
      }
      throw new Error(`signer activation failed and was rolled back: ${error.message}`, {
        cause: error,
      });
    }
    const versionTemp = `${VERSION_PATH}.tmp`;
    await fsp.writeFile(versionTemp, `${version}\n`, { mode: 0o600 });
    await fsp.rename(versionTemp, VERSION_PATH);
    await fsp.rm(previousPath, { force: true });
    return { changed: true, version };
  } finally {
    await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
    await fsp.rm(staging, { recursive: true, force: true });
    if (!replaced) {
      await fsp.rm(candidatePath, { force: true }).catch(() => undefined);
    }
  }
}

function writeResponse(socket, payload) {
  socket.end(`${JSON.stringify(payload)}\n`);
}

export async function startServer() {
  const gidIndex = process.argv.indexOf("--socket-gid");
  const socketGid = gidIndex >= 0 ? Number(process.argv[gidIndex + 1]) : Number.NaN;
  if (!Number.isSafeInteger(socketGid) || socketGid <= 0) {
    throw new Error("--socket-gid must be a positive numeric group id");
  }
  await fsp.mkdir(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o750 });
  await fsp.rm(SOCKET_PATH, { force: true });
  process.umask(0o117);
  let queue = Promise.resolve();
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    let body = "";
    let handled = false;
    const fail = (message) => {
      if (!handled) {
        handled = true;
        writeResponse(socket, { ok: false, error: message });
      }
    };
    socket.on("timeout", () => fail("updater request timed out"));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }
      body += chunk;
      if (body.length > MAX_REQUEST_BYTES) {
        fail("updater request is too large");
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return;
      }
      handled = true;
      let request;
      try {
        request = parseUpdateRequest(JSON.parse(body.slice(0, newline)));
      } catch (error) {
        writeResponse(socket, { ok: false, error: error.message });
        return;
      }
      const operation = queue.then(() => installSignerRelease(request.version));
      queue = operation.catch(() => undefined);
      void operation.then(
        (result) => writeResponse(socket, { ok: true, ...result }),
        (error) => writeResponse(socket, { ok: false, error: error.message }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, resolve);
  });
  await fsp.chmod(SOCKET_PATH, 0o660);
  await fsp.chown(SOCKET_PATH, 0, socketGid);
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(SOCKET_PATH, { force: true });
  };
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  return { server, close };
}

const isMain = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href
  : false;
if (isMain) {
  await startServer();
}

export const __testing = {
  assertSignerV2Health,
  compareVersions,
  releaseAllowedForChannel,
  releaseArchitecture,
};
