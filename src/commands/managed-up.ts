import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManagedFederationTokenSummary } from "../managed/federation.js";
import { readManagedReservationSummaries } from "../managed/tunnel.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type ManagedUpOptions = {
  json?: boolean;
};

const MANAGED_SCRIPT_BASENAMES = ["start-managed.sh", "start-vps.sh"] as const;

function appendManagedScriptCandidates(
  candidates: string[],
  seen: Set<string>,
  anchorFile: string | undefined,
): void {
  if (!anchorFile) {
    return;
  }
  const anchorDir = path.dirname(path.resolve(anchorFile));
  for (const depth of [0, 1, 2, 3]) {
    const rel = Array.from({ length: depth }, () => "..");
    for (const basename of MANAGED_SCRIPT_BASENAMES) {
      const candidate = path.resolve(anchorDir, ...rel, "scripts", basename);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      candidates.push(candidate);
    }
  }
}

export function resolveManagedScriptPath(): string {
  const candidates: string[] = [];
  const seen = new Set<string>();
  appendManagedScriptCandidates(candidates, seen, process.argv[1]);
  appendManagedScriptCandidates(candidates, seen, fileURLToPath(import.meta.url));
  for (const basename of MANAGED_SCRIPT_BASENAMES) {
    const cwdCandidate = path.resolve(process.cwd(), "scripts", basename);
    if (seen.has(cwdCandidate)) {
      continue;
    }
    seen.add(cwdCandidate);
    candidates.push(cwdCandidate);
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate scripts/start-managed.sh or scripts/start-vps.sh");
}

export async function managedUpCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: ManagedUpOptions = {},
): Promise<void> {
  const scriptPath = resolveManagedScriptPath();
  const fed = readManagedFederationTokenSummary(process.env);
  const reservations = readManagedReservationSummaries(process.env);

  if (options.json) {
    runtime.log(
      JSON.stringify(
        {
          ok: true,
          scriptPath,
          federation: fed,
          reservations,
        },
        null,
        2,
      ),
    );
    return;
  }

  const child = spawn("bash", [scriptPath], {
    env: { ...process.env, FASED_MANAGED_INTERNAL: "1" },
    stdio: "inherit",
    cwd: process.cwd(),
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`managed up interrupted by signal: ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`managed up failed (exit=${exitCode})`);
  }
}
