#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OID = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,255}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("generation builder requires named option/value pairs");
    }
    result[name.slice(2)] = value;
  }
  return result;
}

async function regularExecutable(file, name) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`${name} must be a regular executable`);
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function copyTree(source, target, root = source) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    if (path.isAbsolute(link) || link.includes("\\")) {
      throw new Error(`runtime contains unsafe symlink: ${source}`);
    }
    const lexicalTarget = path.resolve(path.dirname(source), link);
    let resolvedTarget;
    try {
      resolvedTarget = await fs.realpath(source);
    } catch {
      throw new Error(`runtime contains dangling or cyclic symlink: ${source}`);
    }
    if (!inside(root, lexicalTarget) || !inside(root, resolvedTarget)) {
      throw new Error(`runtime symlink escapes package: ${source}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await fs.symlink(link, target);
    return;
  }
  if (stat.isFile()) {
    await fs.copyFile(source, target);
    await fs.chmod(target, stat.mode & 0o777);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`runtime contains unsupported entry: ${source}`);
  }
  await fs.mkdir(target, { recursive: true, mode: 0o755 });
  for (const entry of (await fs.readdir(source)).toSorted()) {
    if (source === root && entry === "node_modules") {
      continue;
    }
    await copyTree(path.join(source, entry), path.join(target, entry), root);
  }
}

function launcher() {
  return `#!/usr/bin/env bash
set -euo pipefail
PAYLOAD="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
for node_bin in "\${FASED_NODE_BIN:-}" /usr/local/bin/node /usr/bin/node; do
  [[ -n "$node_bin" && -x "$node_bin" ]] || continue
  if "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<14))process.exit(1); require("node:sqlite")' >/dev/null 2>&1; then
    exec "$node_bin" "$PAYLOAD/runtime/fased.mjs" gateway
  fi
done
echo "Compatible Node runtime not found for Fased Gateway" >&2
exit 1
`;
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

export async function buildLifecycleGeneration(argv = process.argv.slice(2)) {
  const args = options(argv);
  const required = [
    "runtime",
    "release-manifest",
    "signer",
    "lifecycled",
    "output",
    "version",
    "commit",
    "tree",
    "dependency-hash",
    "dependency-asset",
    "dependency-archive-sha256",
  ];
  for (const name of required) {
    if (!args[name]) {
      throw new Error(`--${name} is required`);
    }
  }
  if (!VERSION.test(args.version) || !OID.test(args.commit) || !OID.test(args.tree)) {
    throw new Error("generation source identity is invalid");
  }
  if (
    !HASH.test(args["dependency-hash"]) ||
    !ASSET.test(args["dependency-asset"]) ||
    !DIGEST.test(args["dependency-archive-sha256"])
  ) {
    throw new Error("generation dependency identity is invalid");
  }
  const runtime = path.resolve(args.runtime);
  const releaseManifest = path.resolve(args["release-manifest"]);
  const signer = path.resolve(args.signer);
  const lifecycled = path.resolve(args.lifecycled);
  const inventoryLifecycled = path.resolve(args["inventory-lifecycled"] ?? args.lifecycled);
  const output = path.resolve(args.output);
  await regularExecutable(signer, "signer");
  await regularExecutable(lifecycled, "lifecycled");
  await regularExecutable(inventoryLifecycled, "inventory lifecycled");
  const runtimeEntry = path.join(runtime, "fased.mjs");
  const runtimeStat = await fs.lstat(runtimeEntry);
  if (!runtimeStat.isFile() || runtimeStat.isSymbolicLink()) {
    throw new Error("runtime must contain a regular fased.mjs entrypoint");
  }
  const releaseManifestStat = await fs.lstat(releaseManifest);
  if (
    !releaseManifestStat.isFile() ||
    releaseManifestStat.isSymbolicLink() ||
    releaseManifestStat.size > 4 * 1024 * 1024
  ) {
    throw new Error("release manifest must be a bounded regular file");
  }
  const release = JSON.parse(await fs.readFile(releaseManifest, "utf8"));
  if (
    release?.schemaVersion !== 2 ||
    release?.release?.version !== args.version ||
    release?.release?.commit !== args.commit
  ) {
    throw new Error("release manifest does not match generation source identity");
  }
  await fs.rm(output, { recursive: true, force: true });
  const payload = path.join(output, "payload");
  await fs.mkdir(path.join(payload, "bin"), { recursive: true, mode: 0o755 });
  await copyTree(runtime, path.join(payload, "runtime"));
  await fs.mkdir(path.join(payload, "runtime", "node_modules"), {
    recursive: true,
    mode: 0o755,
  });
  await fs.copyFile(
    releaseManifest,
    path.join(payload, "runtime", ".fased-hosted-release-v2.json"),
    fsConstants.COPYFILE_EXCL,
  );
  await fs.chmod(path.join(payload, "runtime", ".fased-hosted-release-v2.json"), 0o644);
  await fs.copyFile(signer, path.join(payload, "bin", "fased-signerd"));
  await fs.copyFile(lifecycled, path.join(payload, "bin", "fased-lifecycled"));
  await fs.chmod(path.join(payload, "bin", "fased-signerd"), 0o755);
  await fs.chmod(path.join(payload, "bin", "fased-lifecycled"), 0o755);
  await fs.writeFile(path.join(payload, "bin", "fased-gateway-launch"), launcher(), {
    mode: 0o755,
  });
  const inventory = path.join(output, "inventory.json");
  const { stdout } = await execFileAsync(
    inventoryLifecycled,
    [
      "inventory",
      "--root",
      payload,
      "--version",
      args.version,
      "--commit",
      args.commit,
      "--tree",
      args.tree,
      "--output",
      inventory,
      "--dependency-hash",
      args["dependency-hash"],
      "--dependency-asset",
      args["dependency-asset"],
      "--dependency-archive-sha256",
      args["dependency-archive-sha256"],
    ],
    {
      cwd: path.dirname(inventoryLifecycled),
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
  const generation = JSON.parse(stdout);
  await fs.writeFile(
    path.join(output, "generation.json"),
    `${JSON.stringify({ schemaVersion: 1, generation, inventorySHA256: await sha256(inventory) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(generation)}\n`);
  return generation;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  buildLifecycleGeneration().catch((error) => {
    process.stderr.write(
      `build-lifecycle-generation: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
