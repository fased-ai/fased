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
): Promise<void> {
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
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function findPackedTarball(dir: string): Promise<string> {
  const entries = await fs.readdir(dir);
  const filename = entries.find((entry) => entry.endsWith(".tgz"));
  if (!filename) {
    throw new Error("npm pack did not produce a tarball.");
  }
  return path.join(dir, filename);
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

async function smokeGateway(packageRoot: string, smokeEnv: NodeJS.ProcessEnv): Promise<void> {
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
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Hosted runtime gateway exited before listening.\n${output.join("").slice(-8_000)}`,
        );
      }
      if (await canConnect(port)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `Hosted runtime gateway did not listen within 20 seconds.\n${output.join("").slice(-8_000)}`,
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

    const smokeHome = path.join(tempRoot, "smoke-home");
    await fs.mkdir(smokeHome, { recursive: true });
    const smokeEnv = {
      HOME: smokeHome,
      FASED_STATE_DIR: path.join(smokeHome, ".fased"),
      FASED_CONFIG_PATH: path.join(smokeHome, ".fased", "fased.json"),
    };
    await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "--version"],
      packageRoot,
      smokeEnv,
    );
    await run(
      process.execPath,
      [path.join(packageRoot, "fased.mjs"), "plugins", "doctor"],
      packageRoot,
      smokeEnv,
    );
    console.log("hosted-artifact: starting isolated packaged gateway");
    await smokeGateway(packageRoot, smokeEnv);
    console.log("hosted-artifact: packaged gateway smoke passed");

    const assetName = `fased-hosted-linux-${arch}-v${version}.tar.gz`;
    const assetPath = path.join(outputDir, assetName);
    console.log(`hosted-artifact: writing ${assetName}`);
    await tar.c({ cwd: extractDir, file: assetPath, gzip: true, portable: true }, ["package"]);

    const digest = await sha256(assetPath);
    const checksumPath = `${assetPath}.sha256`;
    await fs.writeFile(checksumPath, `${digest}  ${assetName}\n`, "utf8");

    const stat = await fs.stat(assetPath);
    console.log(
      `hosted-artifact: ready ${assetName} (${(stat.size / 1024 / 1024).toFixed(1)} MB, sha256 ${digest})`,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
