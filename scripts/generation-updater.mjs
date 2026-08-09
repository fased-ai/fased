#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const loadDependency = createRequire(import.meta.url);

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const SUPERVISOR = "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled";

export function generationLifecycle(manifest) {
  let instance = "hosting";
  let config = "/var/lib/fased-lifecycled/platform.json";
  if (manifest?.profile === "local" || manifest?.profile === "protected-local") {
    const match = /^fased-gateway-([a-f0-9]{16})\.service$/u.exec(
      String(manifest?.service?.name ?? ""),
    );
    if (!match) {
      return null;
    }
    instance = match[1];
    config = `/var/lib/fased-local/${instance}/lifecycle/platform.json`;
  } else if (manifest?.profile !== "hosting") {
    return null;
  }
  try {
    const binary = fs.lstatSync(SUPERVISOR);
    const configParent = fs.lstatSync(path.dirname(config));
    if (
      !binary.isFile() ||
      binary.isSymbolicLink() ||
      (binary.mode & 0o111) === 0 ||
      !configParent.isDirectory() ||
      configParent.isSymbolicLink()
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return Object.freeze({ instance, config, supervisor: SUPERVISOR });
}

function parseDescriptor(value, version, assetName) {
  const keys = Object.keys(value ?? {})
    .toSorted()
    .join(",");
  const expected = [
    "artifactSetDigest",
    "artifacts",
    "commit",
    "lockfileDigest",
    "schemaVersion",
    "sourceRef",
    "tree",
    "version",
    "workflowRunAttempt",
    "workflowRunId",
  ]
    .toSorted()
    .join(",");
  if (
    keys !== expected ||
    value.schemaVersion !== 3 ||
    value.version !== version ||
    value.sourceRef !== `refs/tags/v${version}` ||
    !OID.test(value.commit ?? "") ||
    !OID.test(value.tree ?? "") ||
    !DIGEST.test(value.lockfileDigest ?? "") ||
    !/^[1-9][0-9]*$/u.test(String(value.workflowRunId ?? "")) ||
    !/^[1-9][0-9]*$/u.test(String(value.workflowRunAttempt ?? "")) ||
    !DIGEST.test(value.artifactSetDigest ?? "") ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error("candidate descriptor is malformed or not bound to the selected release");
  }
  const names = [];
  for (const artifact of value.artifacts) {
    if (
      Object.keys(artifact ?? {})
        .toSorted()
        .join(",") !== "name,sha256,size" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u.test(artifact.name ?? "") ||
      !DIGEST.test(artifact.sha256 ?? "") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0
    ) {
      throw new Error("candidate descriptor contains an invalid artifact identity");
    }
    names.push(artifact.name);
  }
  const sorted = [...new Set(names)].toSorted((left, right) => left.localeCompare(right));
  if (sorted.length !== names.length || sorted.some((name, index) => name !== names[index])) {
    throw new Error("candidate descriptor artifacts are not sorted and unique");
  }
  const canonicalArtifacts = value.artifacts.map((artifact) => ({
    name: artifact.name,
    sha256: artifact.sha256,
    size: artifact.size,
  }));
  const artifactSetDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalArtifacts))
    .digest("hex")}`;
  if (artifactSetDigest !== value.artifactSetDigest) {
    throw new Error("candidate descriptor artifact-set digest is invalid");
  }
  const selected = value.artifacts.filter((artifact) => artifact?.name === assetName);
  if (
    selected.length !== 1 ||
    Object.keys(selected[0]).toSorted().join(",") !== "name,sha256,size" ||
    !DIGEST.test(selected[0].sha256 ?? "") ||
    !Number.isSafeInteger(selected[0].size) ||
    selected[0].size <= 0
  ) {
    throw new Error("candidate descriptor does not bind one exact lifecycle generation");
  }
  return selected[0];
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function loadArchiveDependency(dependencyRoot) {
  if (!dependencyRoot) {
    return loadDependency("tar");
  }
  if (!path.isAbsolute(dependencyRoot) || path.resolve(dependencyRoot) !== dependencyRoot) {
    throw new Error("lifecycle archive dependency root is invalid");
  }
  const packagePath = path.join(dependencyRoot, "package.json");
  const packageInfo = await fsp.lstat(packagePath);
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink()) {
    throw new Error("lifecycle archive dependency root is unsafe");
  }
  return createRequire(packagePath)("tar");
}

export async function extractGeneration(archive, destination, { dependencyRoot } = {}) {
  const tar = await loadArchiveDependency(dependencyRoot);
  let entries = 0;
  let bytes = 0;
  let unsafeEntry = false;
  await Promise.resolve(
    tar.t({
      file: archive,
      strict: true,
      onentry(entry) {
        entries += 1;
        bytes += entry.size;
        const clean = path.posix.normalize(entry.path);
        const isSymlink = entry.type === "SymbolicLink";
        const linkTarget = isSymlink ? String(entry.linkpath ?? "") : "";
        const resolvedLink = isSymlink
          ? path.posix.normalize(path.posix.join(path.posix.dirname(clean), linkTarget))
          : "";
        if (
          entries > 50_000 ||
          bytes > 600 * 1024 * 1024 ||
          clean !== entry.path ||
          clean === ".." ||
          clean.startsWith("../") ||
          !clean.startsWith("generation/") ||
          !new Set(["File", "Directory", "SymbolicLink"]).has(entry.type) ||
          (isSymlink &&
            (linkTarget.length === 0 ||
              path.posix.isAbsolute(linkTarget) ||
              linkTarget.includes("\\") ||
              resolvedLink === "generation" ||
              !resolvedLink.startsWith("generation/")))
        ) {
          unsafeEntry = true;
        }
      },
    }),
  );
  if (unsafeEntry) {
    throw new Error("lifecycle generation archive contains an unsafe entry");
  }
  // The caller may have a hardened umask such as 0117, which strips every
  // executable bit and invalidates the verified generation. This updater is a
  // single-purpose process, so apply a private extraction umask only for the
  // awaited archive operation and restore the caller's value immediately.
  const previousUmask = process.umask(0o077);
  try {
    await Promise.resolve(
      tar.x({ file: archive, cwd: destination, strict: true, preservePaths: false }),
    );
  } finally {
    process.umask(previousUmask);
  }
  return path.join(destination, "generation");
}

export async function stageInitializerExecutable(source, root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    throw new Error("lifecycle initializer executable root is invalid");
  }
  const rootInfo = await fsp.lstat(root);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.uid !== expectedUid ||
    (rootInfo.mode & 0o022) !== 0
  ) {
    throw new Error("lifecycle initializer executable root is unsafe");
  }
  const directory = await fsp.mkdtemp(path.join(root, ".lifecycle-bootstrap-"));
  await fsp.chmod(directory, 0o700);
  const executable = path.join(directory, "fased-lifecycled");
  try {
    await fsp.copyFile(source, executable, fsConstants.COPYFILE_EXCL);
    await fsp.chmod(executable, 0o500);
    const info = await fsp.lstat(executable);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== expectedUid ||
      (info.mode & 0o777) !== 0o500
    ) {
      throw new Error("staged lifecycle initializer executable is unsafe");
    }
    return Object.freeze({ directory, executable });
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function runGenerationUpdate({
  lifecycle,
  version,
  timeoutMs,
  baseUrl,
  architecture,
  download,
  verifyOfficialAsset,
  runAdministrator,
  sudoPath,
  dependencyRoot,
}) {
  return await runGenerationTransaction({
    lifecycle,
    version,
    timeoutMs,
    baseUrl,
    architecture,
    download,
    verifyOfficialAsset,
    runAdministrator,
    sudoPath,
    dependencyRoot,
    operation: "apply",
  });
}

export async function runGenerationInitialize({
  initialize,
  version,
  timeoutMs,
  baseUrl,
  architecture,
  download,
  verifyOfficialAsset,
  runAdministrator,
  initializerExecutableRoot,
  dependencyRoot,
}) {
  return await runGenerationTransaction({
    version,
    timeoutMs,
    baseUrl,
    architecture,
    download,
    verifyOfficialAsset,
    runAdministrator,
    initializerExecutableRoot,
    dependencyRoot,
    operation: "initialize",
    initialize,
  });
}

async function runGenerationTransaction({
  lifecycle,
  initialize,
  version,
  timeoutMs,
  baseUrl,
  architecture,
  download,
  verifyOfficialAsset,
  runAdministrator,
  sudoPath,
  operation,
  initializerExecutableRoot,
  dependencyRoot,
}) {
  if (!VERSION.test(version)) {
    throw new Error("resolved lifecycle generation version is invalid");
  }
  if (!new Set(["x64", "arm64"]).has(architecture)) {
    throw new Error("lifecycle generation architecture is unsupported");
  }
  if (operation === "initialize") {
    const positiveID = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
    if (
      !initialize ||
      !new Set(["protected-local", "hosting"]).has(initialize.profile) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(initialize.instance ?? "") ||
      !path.isAbsolute(initialize.ownerState ?? "") ||
      path.resolve(initialize.ownerState) !== initialize.ownerState ||
      !Number.isSafeInteger(initialize.gatewayPort) ||
      initialize.gatewayPort < 1 ||
      initialize.gatewayPort > 65_535 ||
      !positiveID(initialize.operatorUid) ||
      !positiveID(initialize.operatorGid) ||
      !positiveID(initialize.gatewayUid) ||
      !positiveID(initialize.gatewayGid) ||
      !positiveID(initialize.signerUid) ||
      !positiveID(initialize.signerGid)
    ) {
      throw new Error("lifecycle generation initialization identity is invalid");
    }
  }
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-generation-update-"));
  let initializerStage = null;
  try {
    const releaseUrl = `${baseUrl.replace(/\/+$/u, "")}/v${version}`;
    const descriptor = path.join(temporary, "fased-hosting-candidate.json");
    const descriptorBundle = `${descriptor}.attestation.json`;
    await download(`${releaseUrl}/fased-hosting-candidate.json`, descriptor, timeoutMs);
    await download(
      `${releaseUrl}/fased-hosting-candidate.json.attestation.json`,
      descriptorBundle,
      timeoutMs,
    );
    await verifyOfficialAsset({
      assetPath: descriptor,
      version,
      timeoutMs,
      bundlePath: descriptorBundle,
    });
    const assetName = `fased-generation-linux-${architecture}-v${version}.tar.gz`;
    const identity = parseDescriptor(
      JSON.parse(await fsp.readFile(descriptor, "utf8")),
      version,
      assetName,
    );
    const archive = path.join(temporary, assetName);
    await download(`${releaseUrl}/${assetName}`, archive, timeoutMs);
    const stat = await fsp.lstat(archive);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== identity.size ||
      (await sha256(archive)) !== identity.sha256
    ) {
      throw new Error(
        "downloaded lifecycle generation does not match the attested candidate descriptor",
      );
    }
    const generation = await extractGeneration(archive, temporary, { dependencyRoot });
    if (operation === "initialize" && initializerExecutableRoot) {
      initializerStage = await stageInitializerExecutable(
        path.join(generation, "payload", "bin", "fased-lifecycled"),
        initializerExecutableRoot,
      );
    }
    const argumentsForAdministrator =
      operation === "initialize"
        ? [
            initializerStage?.executable ??
              path.join(generation, "payload", "bin", "fased-lifecycled"),
            "initialize",
            "--profile",
            initialize.profile,
            "--instance",
            initialize.instance,
            "--owner-state",
            initialize.ownerState,
            "--gateway-port",
            String(initialize.gatewayPort),
            "--operator-uid",
            String(initialize.operatorUid),
            "--operator-gid",
            String(initialize.operatorGid),
            "--gateway-uid",
            String(initialize.gatewayUid),
            "--gateway-gid",
            String(initialize.gatewayGid),
            "--signer-uid",
            String(initialize.signerUid),
            "--signer-gid",
            String(initialize.signerGid),
            "--generation",
            generation,
          ]
        : [
            "--",
            lifecycle.supervisor,
            "apply",
            "--config",
            lifecycle.config,
            "--generation",
            generation,
          ];
    const result = await runAdministrator(
      operation === "initialize" ? null : sudoPath,
      argumentsForAdministrator,
      { timeoutMs },
    );
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || "no subprocess diagnostic";
      const exit = Number.isInteger(result.code) ? String(result.code) : "none";
      const signal = result.signal || "none";
      throw new Error(
        `privileged lifecycle apply failed (exit=${exit}, signal=${signal}, timedOut=${result.timedOut === true}): ${detail}`,
      );
    }
    const response = JSON.parse(result.stdout.trim());
    if (!new Set(["UPDATED", "COMMITTED", "ALREADY_CURRENT"]).has(response.outcome)) {
      throw new Error("lifecycle supervisor returned an invalid convergence outcome");
    }
    return Object.freeze({
      version,
      outcome: response.outcome === "ALREADY_CURRENT" ? "ALREADY_CURRENT" : "COMMITTED",
      transactionId: response.transactionId || null,
    });
  } finally {
    if (initializerStage) {
      await fsp.rm(initializerStage.directory, { recursive: true, force: true });
    }
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

function commandOptions(argv) {
  if (argv[0] !== "initialize") {
    throw new Error(
      "usage: generation-updater.mjs initialize --version VERSION --profile PROFILE --instance ID --owner-state PATH --gateway-port PORT --operator-uid UID --operator-gid GID --gateway-uid UID --gateway-gid GID --signer-uid UID --signer-gid GID",
    );
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) {
      throw new Error("generation initializer received invalid or duplicate arguments");
    }
    values.set(flag, value);
  }
  const required = [
    "--version",
    "--profile",
    "--instance",
    "--owner-state",
    "--gateway-port",
    "--operator-uid",
    "--operator-gid",
    "--gateway-uid",
    "--gateway-gid",
    "--signer-uid",
    "--signer-gid",
  ];
  if (values.size !== required.length || required.some((name) => !values.has(name))) {
    throw new Error("generation initializer is missing a required fixed input");
  }
  const profile = values.get("--profile");
  const instance = values.get("--instance");
  const ownerState = values.get("--owner-state");
  if (
    !new Set(["protected-local", "hosting"]).has(profile) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(instance) ||
    !path.isAbsolute(ownerState) ||
    path.resolve(ownerState) !== ownerState
  ) {
    throw new Error("generation initializer platform identity is invalid");
  }
  const integer = (name) => {
    const value = Number(values.get(name));
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
      throw new Error(`generation initializer ${name} is invalid`);
    }
    return value;
  };
  return {
    version: values.get("--version"),
    initialize: {
      profile,
      instance,
      ownerState,
      gatewayPort: integer("--gateway-port"),
      operatorUid: integer("--operator-uid"),
      operatorGid: integer("--operator-gid"),
      gatewayUid: integer("--gateway-uid"),
      gatewayGid: integer("--gateway-gid"),
      signerUid: integer("--signer-uid"),
      signerGid: integer("--signer-gid"),
    },
  };
}

async function executable(paths, label) {
  for (const candidate of paths) {
    try {
      const info = await fsp.lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink() && (info.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {}
  }
  throw new Error(`${label} is unavailable`);
}

async function commandMain(argv) {
  if (
    typeof process.getuid !== "function" ||
    process.getuid() !== 0 ||
    process.platform !== "linux"
  ) {
    throw new Error("generation initialization requires the verified Linux root installer");
  }
  const options = commandOptions(argv);
  const curl = await executable(["/usr/bin/curl", "/bin/curl"], "curl");
  const gh = await executable(["/usr/bin/gh", "/usr/local/bin/gh"], "GitHub CLI");
  const timeoutMs = 6 * 60_000;
  const result = await runGenerationInitialize({
    ...options,
    timeoutMs,
    baseUrl: "https://github.com/fased-ai/fased/releases/download",
    architecture: process.arch,
    initializerExecutableRoot: "/opt/fased",
    download: async (url, destination) => {
      await execFileAsync(
        curl,
        [
          "-q",
          "-fsSL",
          "--proto",
          "=https",
          "--tlsv1.2",
          "--max-time",
          "360",
          url,
          "-o",
          destination,
        ],
        { timeout: timeoutMs },
      );
    },
    verifyOfficialAsset: async ({ assetPath, version, bundlePath }) => {
      await execFileAsync(
        gh,
        [
          "attestation",
          "verify",
          assetPath,
          "--repo",
          "fased-ai/fased",
          "--bundle",
          bundlePath,
          "--signer-workflow",
          "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
          "--source-ref",
          `refs/tags/v${version}`,
          "--deny-self-hosted-runners",
        ],
        { timeout: timeoutMs },
      );
    },
    runAdministrator: async (_sudo, command, { timeoutMs: operationTimeout }) => {
      try {
        const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
          timeout: operationTimeout,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { ok: true, stdout, stderr };
      } catch (error) {
        return {
          ok: false,
          stdout: error.stdout ?? "",
          stderr: error.stderr || error.message,
        };
      }
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  commandMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `generation-updater: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
