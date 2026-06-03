import { spawn } from "node:child_process";
import { loadConfig } from "../config/config.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveGatewayStartupMode } from "./daemon-install-helpers.js";
import { managedUpCommand } from "./managed-up.js";

export type StartCommandOptions = {
  mode?: "auto" | "managed" | "gateway";
};

async function runGatewayForeground(runtime: RuntimeEnv): Promise<void> {
  const entryScript = process.argv[1];
  if (!entryScript) {
    throw new Error("Unable to resolve CLI entry script for gateway start.");
  }

  const child = spawn(
    process.execPath,
    [entryScript, "gateway", "--allow-unconfigured", "--force"],
    {
      env: process.env,
      stdio: "inherit",
      cwd: process.cwd(),
    },
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`gateway start interrupted by signal: ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`gateway start failed (exit=${exitCode})`);
  }
  runtime.log("Gateway stopped.");
}

function resolveStartMode(input: StartCommandOptions["mode"]): "managed" | "gateway" {
  if (input === "managed") {
    return "managed";
  }
  if (input === "gateway") {
    return "gateway";
  }
  const config = loadConfig();
  const startupMode = resolveGatewayStartupMode({
    env: process.env,
    config,
  });
  return startupMode === "managed-up" ? "managed" : "gateway";
}

export async function startCommand(
  options: StartCommandOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const mode = resolveStartMode(options.mode);
  if (mode === "managed") {
    await managedUpCommand(runtime, { json: false });
    return;
  }
  await runGatewayForeground(runtime);
}
