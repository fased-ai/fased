#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { digestJSON, HOSTED_SIGNER_CAPABILITIES_V2 } from "./build-hosted-release-manifest.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SAFE_ASSET_PATTERN = /^[A-Za-z0-9._-]+$/u;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = { artifactDir: "", sourceRoot: "", version: "", commit: "", port: 0 };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) {
      fail(`missing value for ${key || "argument"}`);
    }
    if (key === "--artifact-dir") {
      options.artifactDir = path.resolve(value);
    } else if (key === "--source-root") {
      options.sourceRoot = path.resolve(value);
    } else if (key === "--version") {
      options.version = value;
    } else if (key === "--commit") {
      options.commit = value;
    } else if (key === "--port") {
      options.port = Number.parseInt(value, 10);
    } else {
      fail(`unsupported Q0 artifact server argument: ${key}`);
    }
  }
  if (
    !options.artifactDir ||
    !options.sourceRoot ||
    !VERSION_PATTERN.test(options.version) ||
    !COMMIT_PATTERN.test(options.commit) ||
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    fail(
      "usage: q0-protected-local-artifact-server.mjs --artifact-dir DIR --source-root DIR --version X.Y.Z --commit SHA [--port PORT]",
    );
  }
  return options;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await fsp.readFile(filePath));
  return hash.digest("hex");
}

async function exactFile(filePath) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    fail(`Q0 artifact server input is unsafe: ${filePath}`);
  }
  return stat;
}

async function readJson(filePath) {
  await exactFile(filePath);
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function buildFixture(options) {
  const identityPath = path.join(
    options.artifactDir,
    `fased-hosted-app-linux-x64-v${options.version}.tar.gz.release.json`,
  );
  const appIdentity = await readJson(identityPath);
  const signerIdentity = await readJson(
    path.join(options.artifactDir, "fased-signerd-release.json"),
  );
  if (
    appIdentity?.schemaVersion !== 1 ||
    appIdentity.version !== options.version ||
    appIdentity.commit !== options.commit ||
    appIdentity.architecture !== "x64" ||
    signerIdentity?.schemaVersion !== 1 ||
    signerIdentity.version !== options.version ||
    signerIdentity.commit !== options.commit ||
    signerIdentity.development !== false
  ) {
    fail("Q0 artifact identities do not match the exact candidate");
  }
  const signerAsset = "fased-signerd-linux-amd64";
  const installerPath = path.join(options.sourceRoot, "install.sh");
  const assets = new Map();
  for (const asset of [appIdentity.app, appIdentity.dependencies]) {
    const filePath = path.join(options.artifactDir, asset.asset);
    await exactFile(filePath);
    if ((await sha256(filePath)) !== asset.sha256) {
      fail(`Q0 artifact digest mismatch: ${asset.asset}`);
    }
    assets.set(asset.asset, filePath);
  }
  const signerPath = path.join(options.artifactDir, signerAsset);
  await Promise.all([exactFile(installerPath), exactFile(signerPath)]);
  const signerSha = await sha256(signerPath);
  assets.set(signerAsset, signerPath);
  const application = {
    artifact: appIdentity.app,
    dependencies: {
      dependencyHash: appIdentity.dependencyHash,
      ...appIdentity.dependencies,
    },
  };
  const signerArtifact = { asset: signerAsset, sha256: signerSha };
  const manifest = {
    schemaVersion: 2,
    release: {
      version: options.version,
      tag: `v${options.version}`,
      commit: options.commit,
    },
    application: {
      linux: {
        x64: application,
        arm64: application,
      },
    },
    signer: {
      release: {
        version: signerIdentity.version,
        commit: signerIdentity.commit,
        buildInputDigest: signerIdentity.buildInputDigest,
        development: signerIdentity.development,
      },
      capabilities: HOSTED_SIGNER_CAPABILITIES_V2,
      capabilitiesDigest: digestJSON(HOSTED_SIGNER_CAPABILITIES_V2),
      platforms: {
        "linux-amd64": signerArtifact,
        "linux-arm64": signerArtifact,
        "darwin-amd64": signerArtifact,
        "darwin-arm64": signerArtifact,
      },
    },
  };
  return {
    assets,
    installerPath,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  };
}

function sendFile(response, filePath, size) {
  response.writeHead(200, {
    "content-length": size,
    "content-type": "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(response);
}

const options = parseArguments(process.argv.slice(2));
const fixture = await buildFixture(options);
const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const requestPath = decodeURIComponent(
      new URL(request.url || "/", "http://127.0.0.1").pathname,
    );
    if (requestPath === "/@fased%2ffased" || requestPath === "/@fased/fased") {
      const bytes = Buffer.from(
        `${JSON.stringify({ "dist-tags": { latest: options.version, beta: options.version } })}\n`,
      );
      response.writeHead(200, {
        "content-length": bytes.length,
        "content-type": "application/json",
      });
      response.end(bytes);
      return;
    }
    const releasePrefix = `/v${options.version}/`;
    if (!requestPath.startsWith(releasePrefix)) {
      response.writeHead(404).end();
      return;
    }
    const asset = requestPath.slice(releasePrefix.length);
    if (!SAFE_ASSET_PATTERN.test(asset)) {
      response.writeHead(400).end();
      return;
    }
    if (asset === "fased-hosted-release-v2.json") {
      response.writeHead(200, {
        "content-length": fixture.manifestBytes.length,
        "content-type": "application/json",
      });
      response.end(fixture.manifestBytes);
      return;
    }
    const filePath = asset === "install.sh" ? fixture.installerPath : fixture.assets.get(asset);
    if (!filePath) {
      response.writeHead(404).end();
      return;
    }
    const stat = await exactFile(filePath);
    sendFile(response, filePath, stat.size);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end(`${error.message}\n`);
  }
});

server.listen(options.port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    fail("Q0 artifact server did not bind a TCP port");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      baseUrl: `http://127.0.0.1:${address.port}`,
      version: options.version,
      commit: options.commit,
    })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
