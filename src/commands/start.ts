import { spawn } from "node:child_process";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type StartCommandOptions = {
  mode?: "auto" | "gateway";
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

export async function startCommand(
  options: StartCommandOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  void options.mode;
  await runGatewayForeground(runtime);
}
