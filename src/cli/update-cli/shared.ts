import { resolveFasedAgentPackageRoot } from "../../infra/fased-root.js";
import { defaultRuntime } from "../../runtime.js";

export type UpdateCommandOptions = {
  json?: boolean;
  verbose?: boolean;
  restart?: boolean;
  dryRun?: boolean;
  channel?: string;
  tag?: string;
  timeout?: string;
  yes?: boolean;
  safeFallback?: boolean;
};

export type UpdateStatusOptions = {
  json?: boolean;
  timeout?: string;
};

const INVALID_TIMEOUT_ERROR = "--timeout must be a positive integer (seconds)";

export function parseTimeoutMsOrExit(timeout?: string): number | undefined | null {
  const timeoutMs = timeout ? Number.parseInt(timeout, 10) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error(INVALID_TIMEOUT_ERROR);
    defaultRuntime.exit(1);
    return null;
  }
  return timeoutMs;
}

export async function resolveUpdateRoot(): Promise<string> {
  return (
    (await resolveFasedAgentPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd()
  );
}
