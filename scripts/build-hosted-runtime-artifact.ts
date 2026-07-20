import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as tar from "tar";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");

type PackageJson = {
  name?: string;
  version?: string;
};

type HostedRuntimeMetadata = {
  schemaVersion: 2;
  version: string;
  commit: string;
  dependencyHash: string;
};

type RunResult = {
  durationMs: number;
  stdout: string;
  stderr: string;
};

const HOSTED_DEPENDENCY_LAYER_SCHEMA = 2;
const HOSTED_DEPENDENCY_FILE_BUDGET = 40_000;
const HOSTED_DEPENDENCY_BYTE_BUDGET = 350 * 1024 * 1024;

function parseOutputDir(): string {
  const outputFlag = process.argv.indexOf("--output");
  const value = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
  return path.resolve(rootDir, value?.trim() || ".artifacts/hosted-runtime");
}

function hostedArch(): string {
  if (process.platform !== "linux") {
    throw new Error(`Hosted runtime artifacts require Linux, found ${process.platform}.`);
  }
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }
  throw new Error(`Unsupported hosted runtime architecture: ${process.arch}.`);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        ...extraEnv,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    if (failed.stdout?.trim()) {
      process.stdout.write(failed.stdout);
    }
    if (failed.stderr?.trim()) {
      process.stderr.write(failed.stderr);
    }
    throw error;
  }
  if (stdout.trim()) {
    process.stdout.write(stdout);
  }
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
  return { durationMs: Date.now() - startedAt, stdout, stderr };
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function hostedDependencyHash(lockfilePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`fased-hosted-dependencies-v${HOSTED_DEPENDENCY_LAYER_SCHEMA}\0`);
  for await (const chunk of createReadStream(lockfilePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function pruneHostedDependencies(
  nodeModulesRoot: string,
  arch: string,
): Promise<{ files: number; bytes: number }> {
  const keepClipboardPackages = new Set([
    `clipboard-linux-${arch}-gnu`,
    `clipboard-linux-${arch}-musl`,
  ]);
  let removedFiles = 0;
  let removedBytes = 0;
  let removedDirectories = 0;
  let retainedFiles = 0;
  let retainedBytes = 0;

  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const isForeignClipboardPackage =
          path.basename(dir) === "@mariozechner" &&
          entry.name.startsWith("clipboard-") &&
          !keepClipboardPackages.has(entry.name);
        if (isForeignClipboardPackage) {
          await fs.rm(fullPath, { recursive: true, force: true });
          removedDirectories += 1;
          continue;
        }
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith(".map") && !entry.name.endsWith(".d.ts"))) {
        if (entry.isFile()) {
          const stat = await fs.stat(fullPath);
          retainedFiles += 1;
          retainedBytes += stat.size;
        }
        continue;
      }
      const stat = await fs.stat(fullPath);
      await fs.rm(fullPath, { force: true });
      removedFiles += 1;
      removedBytes += stat.size;
    }
  };

  await visit(nodeModulesRoot);
  console.log(
    `hosted-artifact: pruned ${removedFiles} runtime-irrelevant files and ${removedDirectories} foreign-platform directories (${(removedBytes / 1024 / 1024).toFixed(1)} MB)`,
  );
  return { files: retainedFiles, bytes: retainedBytes };
}

async function writeChecksum(assetPath: string): Promise<string> {
  const digest = await sha256(assetPath);
  await fs.writeFile(`${assetPath}.sha256`, `${digest}  ${path.basename(assetPath)}\n`, "utf8");
  return digest;
}

async function findPackedTarball(dir: string): Promise<string> {
  const entries = await fs.readdir(dir);
  const filename = entries.find((entry) => entry.endsWith(".tgz"));
  if (!filename) {
    throw new Error("npm pack did not produce a tarball.");
  }
  return path.join(dir, filename);
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  };
  await visit(root);
  return files.toSorted();
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a loopback gateway port.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", fail);
    socket.once("timeout", fail);
  });
}

async function smokeGateway(
  packageRoot: string,
  smokeEnv: NodeJS.ProcessEnv,
): Promise<{ pluginLoadMs: number; output: string }> {
  const port = await reserveLoopbackPort();
  const output: string[] = [];
  const child = spawn(
    process.execPath,
    [
      path.join(packageRoot, "dist", "entry.js"),
      "gateway",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      String(port),
    ],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        ...smokeEnv,
        FASED_NO_RESPAWN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    const deadline = Date.now() + 30_000;
    let listening = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Hosted runtime gateway exited before listening.\n${output.join("").slice(-8_000)}`,
        );
      }
      listening ||= await canConnect(port);
      const combinedOutput = output.join("");
      const timingMatch = combinedOutput.match(/plugins\.load(?:\.deferred)?=(\d+)ms/);
      if (listening && timingMatch?.[1]) {
        return { pluginLoadMs: Number.parseInt(timingMatch[1], 10), output: combinedOutput };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `Hosted runtime gateway did not become ready with plugin timing within 30 seconds.\n${output.join("").slice(-8_000)}`,
    );
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000),
      ),
    ]);
  }
}

async function main(): Promise<void> {
  const outputDir = parseOutputDir();
  const arch = hostedArch();
  const packageJson = JSON.parse(
    await fs.readFile(path.join(rootDir, "package.json"), "utf8"),
  ) as PackageJson;
  const version = packageJson.version?.trim();
  if (!version || packageJson.name !== "@fased/fased") {
    throw new Error("Root package metadata is missing @fased/fased and its version.");
  }
  const buildInfo = JSON.parse(
    await fs.readFile(path.join(rootDir, "dist", "build-info.json"), "utf8"),
  ) as { version?: string; commit?: string };
  const commit = String(buildInfo.commit || "").trim();
  if (buildInfo.version !== version || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error(
      "Hosted runtime build identity must match the package version and full commit.",
    );
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-hosted-runtime-"));
  const packDir = path.join(tempRoot, "pack");
  const extractDir = path.join(tempRoot, "extract");
  const packageRoot = path.join(extractDir, "package");

  try {
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(extractDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    console.log(`hosted-artifact: packing @fased/fased@${version}`);
    await run(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", packDir, "--loglevel=error"],
      rootDir,
      { npm_config_cache: path.join(tempRoot, "npm-cache") },
    );
    const packedTarball = await findPackedTarball(packDir);
    await tar.x({ file: packedTarball, cwd: extractDir });

    console.log("hosted-artifact: installing production runtime dependencies");
    await run(
      "npm",
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      packageRoot,
      { npm_config_cache: path.join(tempRoot, "npm-cache") },
    );

    console.log("hosted-artifact: pruning runtime-irrelevant dependency files");
    const dependencyBudget = await pruneHostedDependencies(
      path.join(packageRoot, "node_modules"),
      arch,
    );
    console.log(
      `hosted-artifact: dependency budget ${dependencyBudget.files} files, ${(dependencyBudget.bytes / 1024 / 1024).toFixed(1)} MB`,
    );
    if (
      dependencyBudget.files > HOSTED_DEPENDENCY_FILE_BUDGET ||
      dependencyBudget.bytes > HOSTED_DEPENDENCY_BYTE_BUDGET
    ) {
      throw new Error(
        `Hosted dependency layer exceeds budget (${dependencyBudget.files}/${HOSTED_DEPENDENCY_FILE_BUDGET} files, ${(dependencyBudget.bytes / 1024 / 1024).toFixed(1)}/${HOSTED_DEPENDENCY_BYTE_BUDGET / 1024 / 1024} MB).`,
      );
    }

    console.log("hosted-artifact: compiling core runtime plugins");
    await run(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(rootDir, "scripts", "compile-hosted-core-plugins.ts"),
        "--root",
        packageRoot,
      ],
      rootDir,
    );

    for (const pluginId of ["memory-core", "sat-mining"]) {
      const pluginRoot = path.join(packageRoot, "extensions", pluginId);
      await fs.access(path.join(pluginRoot, "index.js"));
      const remainingTypeScript = (await listFiles(pluginRoot)).filter(
        (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".d.ts"),
      );
      if (remainingTypeScript.length > 0) {
        throw new Error(
          `Hosted ${pluginId} plugin still contains runtime TypeScript: ${remainingTypeScript.join(", ")}`,
        );
      }
    }

    const smokeHome = path.join(tempRoot, "smoke-home");
    await fs.mkdir(smokeHome, { recursive: true });
    const smokeStateDir = path.join(smokeHome, ".fased");
    await fs.mkdir(smokeStateDir, { recursive: true });
    await fs.writeFile(
      path.join(smokeStateDir, "fased.json"),
      `${JSON.stringify(
        {
          plugins: {
            allow: ["memory-core", "sat-mining"],
            entries: { "sat-mining": { enabled: true } },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const smokeEnv = {
      HOME: smokeHome,
      FASED_STATE_DIR: smokeStateDir,
      FASED_CONFIG_PATH: path.join(smokeStateDir, "fased.json"),
    };
    await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "--version"],
      packageRoot,
      smokeEnv,
    );
    const pluginDoctor = await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "plugins", "doctor"],
      packageRoot,
      smokeEnv,
    );
    const pluginDoctorOutput = `${pluginDoctor.stdout}\n${pluginDoctor.stderr}`;
    if (!pluginDoctorOutput.includes("No plugin issues detected.")) {
      throw new Error(`Hosted core plugin doctor was not clean.\n${pluginDoctorOutput}`);
    }
    const satPluginInfo = await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "plugins", "info", "sat-mining"],
      packageRoot,
      smokeEnv,
    );
    const satPluginOutput = `${satPluginInfo.stdout}\n${satPluginInfo.stderr}`;
    if (!satPluginOutput.includes("Status: loaded")) {
      throw new Error(`Hosted sat-mining plugin did not load.\n${satPluginOutput}`);
    }
    console.log("hosted-artifact: starting isolated packaged gateway");
    const gatewaySmoke = await smokeGateway(packageRoot, smokeEnv);
    const pluginLoadMs = gatewaySmoke.pluginLoadMs;
    for (const pluginId of ["memory-core", "sat-mining"]) {
      if (!gatewaySmoke.output.includes(`[plugins] ${pluginId} native preload `)) {
        throw new Error(
          `Hosted ${pluginId} did not use native preload.\n${gatewaySmoke.output.slice(-8_000)}`,
        );
      }
    }
    if (gatewaySmoke.output.includes("native preload failed")) {
      throw new Error(`Hosted native plugin preload failed.\n${gatewaySmoke.output.slice(-8_000)}`);
    }
    const corePluginBudgetMs = Number.parseInt(
      process.env.FASED_HOSTED_CORE_PLUGIN_MAX_MS ?? "10000",
      10,
    );
    if (pluginLoadMs > corePluginBudgetMs) {
      throw new Error(
        `Hosted core plugin smoke took ${pluginLoadMs}ms; budget is ${corePluginBudgetMs}ms.`,
      );
    }
    console.log(
      `hosted-artifact: core plugins loaded in ${pluginLoadMs}ms (budget ${corePluginBudgetMs}ms)`,
    );
    const cachedPluginInfo = await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "plugins", "info", "sat-mining"],
      packageRoot,
      smokeEnv,
    );
    const cachedPluginDoctor = await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "plugins", "doctor"],
      packageRoot,
      smokeEnv,
    );
    const pluginInfoBudgetMs = Number.parseInt(
      process.env.FASED_HOSTED_PLUGIN_INFO_MAX_MS ?? "3000",
      10,
    );
    const pluginDoctorBudgetMs = Number.parseInt(
      process.env.FASED_HOSTED_PLUGIN_DOCTOR_MAX_MS ?? "5000",
      10,
    );
    if (cachedPluginInfo.durationMs > pluginInfoBudgetMs) {
      throw new Error(
        `Hosted cached plugin info took ${cachedPluginInfo.durationMs}ms; budget is ${pluginInfoBudgetMs}ms.`,
      );
    }
    if (cachedPluginDoctor.durationMs > pluginDoctorBudgetMs) {
      throw new Error(
        `Hosted cached plugin doctor took ${cachedPluginDoctor.durationMs}ms; budget is ${pluginDoctorBudgetMs}ms.`,
      );
    }
    console.log(
      `hosted-artifact: cached plugin info ${cachedPluginInfo.durationMs}ms; doctor ${cachedPluginDoctor.durationMs}ms`,
    );
    console.log("hosted-artifact: packaged gateway smoke passed");

    const dependencyHash = await hostedDependencyHash(path.join(rootDir, "pnpm-lock.yaml"));
    const runtimeMetadata: HostedRuntimeMetadata = {
      schemaVersion: 2,
      version,
      commit,
      dependencyHash,
    };
    await fs.writeFile(
      path.join(packageRoot, ".fased-hosted-runtime.json"),
      `${JSON.stringify(runtimeMetadata, null, 2)}\n`,
      "utf8",
    );

    const assetName = `fased-hosted-linux-${arch}-v${version}.tar.gz`;
    const assetPath = path.join(outputDir, assetName);
    console.log(`hosted-artifact: writing ${assetName}`);
    await tar.c({ cwd: extractDir, file: assetPath, gzip: true, portable: true }, ["package"]);

    const digest = await writeChecksum(assetPath);

    const stat = await fs.stat(assetPath);
    console.log(
      `hosted-artifact: ready ${assetName} (${(stat.size / 1024 / 1024).toFixed(1)} MB, sha256 ${digest})`,
    );

    const unifiedAppAssetName = `fased-hosted-app-v2-linux-${arch}-v${version}.tar.gz`;
    const unifiedAppAssetPath = path.join(outputDir, unifiedAppAssetName);
    console.log(`hosted-artifact: writing ${unifiedAppAssetName}`);
    await tar.c(
      {
        cwd: extractDir,
        file: unifiedAppAssetPath,
        gzip: true,
        portable: true,
        filter: (entryPath) => !entryPath.startsWith("package/node_modules"),
      },
      ["package"],
    );
    const unifiedAppDigest = await writeChecksum(unifiedAppAssetPath);
    const unifiedAppStat = await fs.stat(unifiedAppAssetPath);
    console.log(
      `hosted-artifact: ready ${unifiedAppAssetName} (${(unifiedAppStat.size / 1024 / 1024).toFixed(1)} MB, sha256 ${unifiedAppDigest})`,
    );

    // v0.1.67 Local updaters request the historical fixed filename and cannot
    // fetch the unified release manifest before extraction. Keep a one-version
    // schema-v1 bridge at that name. Hosting and current clients select the
    // schema-v2 artifact above through the attested unified manifest.
    await fs.writeFile(
      path.join(packageRoot, ".fased-hosted-runtime.json"),
      `${JSON.stringify({ schemaVersion: 1, dependencyHash }, null, 2)}\n`,
      "utf8",
    );
    const legacyAppAssetName = `fased-hosted-app-linux-${arch}-v${version}.tar.gz`;
    const legacyAppAssetPath = path.join(outputDir, legacyAppAssetName);
    console.log(`hosted-artifact: writing ${legacyAppAssetName}`);
    await tar.c(
      {
        cwd: extractDir,
        file: legacyAppAssetPath,
        gzip: true,
        portable: true,
        filter: (entryPath) => !entryPath.startsWith("package/node_modules"),
      },
      ["package"],
    );
    const legacyAppDigest = await writeChecksum(legacyAppAssetPath);
    const legacyAppStat = await fs.stat(legacyAppAssetPath);
    console.log(
      `hosted-artifact: ready ${legacyAppAssetName} (${(legacyAppStat.size / 1024 / 1024).toFixed(1)} MB, sha256 ${legacyAppDigest})`,
    );
    await fs.writeFile(
      path.join(packageRoot, ".fased-hosted-runtime.json"),
      `${JSON.stringify(runtimeMetadata, null, 2)}\n`,
      "utf8",
    );

    const dependencyAssetName = `fased-hosted-deps-linux-${arch}-${dependencyHash}.tar.gz`;
    const dependencyAssetPath = path.join(outputDir, dependencyAssetName);
    console.log(`hosted-artifact: writing ${dependencyAssetName}`);
    await tar.c({ cwd: packageRoot, file: dependencyAssetPath, gzip: true, portable: true }, [
      "node_modules",
    ]);
    const dependencyDigest = await writeChecksum(dependencyAssetPath);
    const dependencyStat = await fs.stat(dependencyAssetPath);
    console.log(
      `hosted-artifact: ready ${dependencyAssetName} (${(dependencyStat.size / 1024 / 1024).toFixed(1)} MB, sha256 ${dependencyDigest})`,
    );
    await fs.writeFile(
      path.join(outputDir, `${legacyAppAssetName}.release.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          version,
          commit,
          architecture: arch,
          dependencyHash,
          app: { asset: unifiedAppAssetName, sha256: unifiedAppDigest },
          dependencies: { asset: dependencyAssetName, sha256: dependencyDigest },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
