#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function createDockerSignerEnrollmentProxy(options = {}) {
  const backendHost = options.backendHost ?? "127.0.0.1";
  const backendPort = options.backendPort ?? 18791;
  return net.createServer((browser) => {
    const enrollment = net.createConnection({ host: backendHost, port: backendPort });
    browser.on("error", () => enrollment.destroy());
    enrollment.on("error", () => browser.destroy());
    browser.pipe(enrollment);
    enrollment.pipe(browser);
  });
}

function prepareEnrollmentHome(env = process.env) {
  const home = String(env.HOME ?? "").trim();
  if (!home.startsWith("/")) {
    throw new Error("Docker signer enrollment requires an absolute temporary HOME");
  }
  const lockDirectory = path.join(home, ".fased", "wallet");
  fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(lockDirectory, 0o700);
}

export async function runDockerSignerEnrollment(args = process.argv.slice(2)) {
  prepareEnrollmentHome();
  const proxy = createDockerSignerEnrollmentProxy();
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen({ host: "0.0.0.0", port: 18792 }, resolve);
  });

  return await new Promise((resolve) => {
    const child = spawn("/usr/local/bin/fased-signer-enroll", args, {
      env: process.env,
      stdio: "inherit",
    });
    let finalized = false;
    const finalize = (result) => {
      if (finalized) {
        return;
      }
      finalized = true;
      proxy.close(() => resolve(result));
    };
    const stop = (signal) => {
      if (!finalized) {
        child.kill(signal);
      }
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    child.once("error", (error) => {
      process.stderr.write(
        `Could not start signer enrollment: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      finalize({ code: 1 });
    });
    child.once("exit", (code, signal) => finalize({ code: code ?? 1, signal }));
  });
}

async function main() {
  const result = await runDockerSignerEnrollment();
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `Docker signer enrollment failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
