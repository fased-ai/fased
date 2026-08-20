import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { writeBundledPluginLock } from "./assemble-lifecycle-generation.mjs";
import { resolveManagedRuntimeImplementationPaths } from "./build-hosted-component-packs.js";
import {
  assertHostedCoreBudgets,
  enforceHostedApplicationAllowlist,
  measureRegularFiles,
  pruneHostedDependencies,
  readHostedComponentContract,
  retainHostedCoreExtensions,
} from "./hosted-component-contract.js";
import { writeReleaseArchive } from "./release-archive.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..");
const tsxLoader = import.meta.resolve("tsx");

type PackageJson = {
  name?: string;
  version?: string;
};

type HostedRuntimeMetadata = {
  schemaVersion: 2;
  version: string;
  commit: string;
  dependencyHash: string;
  componentContractDigest: string;
  coreExtensions: string[];
  loadedPlugins: string[];
};

type RunResult = {
  durationMs: number;
  stdout: string;
  stderr: string;
};

const HOSTED_DEPENDENCY_LAYER_SCHEMA = 2;

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
  const captureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-command-output-"));
  const stdoutPath = path.join(captureRoot, "stdout");
  const stderrPath = path.join(captureRoot, "stderr");
  const stdoutHandle = await fs.open(stdoutPath, "w", 0o600);
  const stderrHandle = await fs.open(stderrPath, "w", 0o600);
  let stdout = "";
  let stderr = "";
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          CI: "1",
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          ...extraEnv,
        },
        stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(`${command} exited with ${code ?? "no status"}${signal ? ` (${signal})` : ""}`),
        );
      });
    });
  } catch (error) {
    failure = error;
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    [stdout, stderr] = await Promise.all([
      fs.readFile(stdoutPath, "utf8"),
      fs.readFile(stderrPath, "utf8"),
    ]);
    await fs.rm(captureRoot, { recursive: true, force: true });
  }
  if (stdout.trim()) {
    process.stdout.write(stdout);
  }
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
  if (failure) {
    throw failure;
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

async function releaseCreatedAt(commit: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["show", "-s", "--format=%cI", commit], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024,
  });
  const timestamp = Date.parse(stdout.trim());
  if (!Number.isFinite(timestamp)) {
    throw new Error("Hosted runtime commit timestamp is invalid.");
  }
  return new Date(timestamp).toISOString();
}

async function activePnpmStore(): Promise<string> {
  const { stdout } = await execFileAsync("pnpm", ["store", "path"], {
    cwd: rootDir,
    maxBuffer: 1024 * 1024,
  });
  const reported = stdout.trim();
  if (!path.isAbsolute(reported)) {
    throw new Error("pnpm store path is not absolute");
  }
  const canonical = await fs.realpath(reported);
  if (!(await fs.stat(canonical)).isDirectory()) {
    throw new Error("pnpm store path is not a directory");
  }
  return canonical;
}

async function writeChecksum(assetPath: string): Promise<string> {
  const digest = await sha256(assetPath);
  await fs.writeFile(`${assetPath}.sha256`, `${digest}  ${path.basename(assetPath)}\n`, "utf8");
  return digest;
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
  const createdAt = await releaseCreatedAt(commit);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fased-hosted-runtime-"));
  const extractDir = path.join(tempRoot, "extract");
  const packageRoot = path.join(extractDir, "package");

  try {
    await fs.mkdir(extractDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });

    console.log(`hosted-artifact: deploying @fased/fased@${version} with pnpm`);
    const pnpmStore = await activePnpmStore();
    const deployment = await run(
      "pnpm",
      [
        "--store-dir",
        pnpmStore,
        "--offline",
        "--filter",
        "@fased/fased",
        "deploy",
        "--prod",
        "--no-optional",
        packageRoot,
      ],
      rootDir,
      { npm_config_ignore_scripts: "true" },
    );
    const componentContract = await readHostedComponentContract(
      path.join(rootDir, "config", "hosted-component-packs.json"),
    );
    const componentContractDigest = await sha256(
      path.join(rootDir, "config", "hosted-component-packs.json"),
    );
    const removedApplicationPaths = await enforceHostedApplicationAllowlist({
      packageRoot,
      contract: componentContract,
    });
    const candidateManagedRuntimeImplementationPaths =
      await resolveManagedRuntimeImplementationPaths(["line", "runtime-browser"]);
    const managedRuntimeImplementationPaths: string[] = [];
    for (const relative of candidateManagedRuntimeImplementationPaths) {
      const target = path.join(packageRoot, relative);
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`managed runtime implementation is not a regular file: ${relative}`);
      }
      await fs.rm(target);
      managedRuntimeImplementationPaths.push(relative);
    }
    const removedExtensions = await retainHostedCoreExtensions({
      extensionsRoot: path.join(packageRoot, "extensions"),
      contract: componentContract,
    });
    console.log(
      `hosted-artifact: excluded ${removedExtensions.length} optional/test extension directories`,
    );
    await run(
      process.execPath,
      [
        path.join(rootDir, "scripts", "release-component-sbom.mjs"),
        "node",
        "--node-modules",
        path.join(packageRoot, "node_modules"),
        "--architecture",
        arch,
        "--version",
        version,
        "--created",
        createdAt,
        "--output",
        path.join(outputDir, `fased-hosted-components-linux-${arch}-v${version}.spdx.json`),
      ],
      rootDir,
    );

    console.log("hosted-artifact: pruning runtime-irrelevant dependency files");
    const dependencyBudget = await pruneHostedDependencies(
      path.join(packageRoot, "node_modules"),
      arch,
    );
    console.log(
      `hosted-artifact: dependency budget ${dependencyBudget.files} files, ${(dependencyBudget.bytes / 1024 / 1024).toFixed(1)} MB`,
    );
    const applicationBudget = await measureRegularFiles(packageRoot, {
      excludeTopLevel: new Set(["node_modules"]),
    });
    assertHostedCoreBudgets({
      contract: componentContract,
      application: applicationBudget,
      dependencies: dependencyBudget,
    });
    console.log(
      `hosted-artifact: core application budget ${applicationBudget.files} files, ${(applicationBudget.bytes / 1024 / 1024).toFixed(1)} MB`,
    );

    console.log("hosted-artifact: compiling core runtime plugins");
    await run(
      process.execPath,
      [
        "--import",
        tsxLoader,
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
    const smokePluginCodeRoot = path.join(smokeStateDir, "plugin-code");
    const smokePluginDataRoot = path.join(smokeStateDir, "plugin-data");
    const smokePluginLockPath = path.join(smokeStateDir, "plugin.lock.json");
    await Promise.all([
      fs.mkdir(smokePluginCodeRoot, { recursive: true }),
      fs.mkdir(smokePluginDataRoot, { recursive: true }),
    ]);
    await writeBundledPluginLock(packageRoot);
    await fs.copyFile(path.join(packageRoot, "plugin.lock.json"), smokePluginLockPath);
    await fs.rm(path.join(packageRoot, "plugin.lock.json"));
    await fs.writeFile(
      path.join(smokeStateDir, "fased.json"),
      `${JSON.stringify(
        {
          plugins: {
            allow: componentContract.core.loadedPluginIds,
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
      FASED_MANAGED_INTERNAL: "1",
      FASED_PLUGIN_CODE_ROOT: smokePluginCodeRoot,
      FASED_PLUGIN_DATA_ROOT: smokePluginDataRoot,
      FASED_PLUGIN_LOCK_PATH: smokePluginLockPath,
      // Vitest suppresses defaultRuntime.log unless this explicit test boundary
      // requests output. Artifact validation must not depend on ambient VITEST.
      FASED_TEST_RUNTIME_LOG: "1",
      VITEST: "",
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
    const enabledPlugins = await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "plugins", "list", "--enabled", "--json"],
      packageRoot,
      smokeEnv,
    );
    const enabledPluginIds =
      (
        JSON.parse(enabledPlugins.stdout) as {
          plugins?: Array<{ id?: unknown; status?: unknown }>;
        }
      ).plugins
        ?.filter((plugin) => plugin.status === "loaded" && typeof plugin.id === "string")
        .map((plugin) => plugin.id as string)
        .toSorted() ?? [];
    if (
      JSON.stringify(enabledPluginIds) !==
      JSON.stringify(componentContract.core.loadedPluginIds.toSorted())
    ) {
      throw new Error(
        `Hosted core loaded plugins differ (actual ${enabledPluginIds.join(", ") || "none"}; expected ${componentContract.core.loadedPluginIds.join(", ")}).`,
      );
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
      componentContractDigest,
      coreExtensions: componentContract.core.extensionDirectories.toSorted(),
      loadedPlugins: componentContract.core.loadedPluginIds.toSorted(),
    };
    await fs.writeFile(
      path.join(packageRoot, ".fased-hosted-runtime.json"),
      `${JSON.stringify(runtimeMetadata, null, 2)}\n`,
      "utf8",
    );
    const unifiedAppAssetName = `fased-hosted-app-v2-linux-${arch}-v${version}.tar.gz`;
    const unifiedAppAssetPath = path.join(outputDir, unifiedAppAssetName);
    console.log(`hosted-artifact: writing ${unifiedAppAssetName}`);
    await writeReleaseArchive({
      cwd: extractDir,
      destination: unifiedAppAssetPath,
      entries: ["package"],
      filter: (entryPath) => !entryPath.startsWith("package/node_modules"),
      requiredEntryPrefix: "package/",
    });
    const unifiedAppDigest = await writeChecksum(unifiedAppAssetPath);
    const unifiedAppStat = await fs.stat(unifiedAppAssetPath);
    console.log(
      `hosted-artifact: ready ${unifiedAppAssetName} (${(unifiedAppStat.size / 1024 / 1024).toFixed(1)} MB, sha256 ${unifiedAppDigest})`,
    );

    const dependencyAssetName = `fased-hosted-deps-linux-${arch}-${dependencyHash}.tar.gz`;
    const dependencyAssetPath = path.join(outputDir, dependencyAssetName);
    console.log(`hosted-artifact: writing ${dependencyAssetName}`);
    await writeReleaseArchive({
      cwd: packageRoot,
      destination: dependencyAssetPath,
      entries: ["node_modules"],
      noMtime: true,
      requiredEntryPrefix: "node_modules/",
    });
    const dependencyDigest = await writeChecksum(dependencyAssetPath);
    const dependencyStat = await fs.stat(dependencyAssetPath);
    console.log(
      `hosted-artifact: ready ${dependencyAssetName} (${(dependencyStat.size / 1024 / 1024).toFixed(1)} MB, sha256 ${dependencyDigest})`,
    );
    await fs.writeFile(
      path.join(outputDir, `${unifiedAppAssetName}.core-receipt.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          type: "fased-hosted-core-receipt",
          version,
          commit,
          architecture: arch,
          componentContractDigest,
          retainedExtensions: componentContract.core.extensionDirectories.toSorted(),
          loadedPlugins: componentContract.core.loadedPluginIds.toSorted(),
          excludedExtensions: removedExtensions.toSorted(),
          excludedApplicationPaths: removedApplicationPaths.toSorted(),
          excludedManagedRuntimePaths: managedRuntimeImplementationPaths,
          applicationBudget,
          dependencyBudget,
          dependencyCache: {
            mode: "offline-pnpm-store",
            downloads: 0,
            durationMs: deployment.durationMs,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(outputDir, `${unifiedAppAssetName}.release.json`),
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
