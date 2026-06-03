import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";

export function resolveFasedAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FASED_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  const defaultAgentDir = path.join(resolveStateDir(env), "agents", DEFAULT_AGENT_ID, "agent");
  return resolveUserPath(defaultAgentDir, env);
}

export function ensureFasedAgentEnv(): string {
  const dir = resolveFasedAgentDir();
  if (!process.env.FASED_AGENT_DIR) {
    process.env.FASED_AGENT_DIR = dir;
  }
  if (!process.env.PI_CODING_AGENT_DIR) {
    process.env.PI_CODING_AGENT_DIR = dir;
  }
  return dir;
}

export function resolveFasedAgentAgentDir(): string {
  return resolveFasedAgentDir(process.env);
}

export function ensureFasedAgentAgentEnv(): string {
  return ensureFasedAgentEnv();
}
