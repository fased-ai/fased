import os from "node:os";
import path from "node:path";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { isValidProfileName } from "./profile-utils.js";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

function takeValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const trimmed = (next ?? "").trim();
  return { value: trimmed || null, consumedNext: Boolean(next) };
}

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) {
    return { ok: true, profile: null, argv };
  }

  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawDev = false;
  let sawCommand = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (sawCommand) {
      out.push(arg);
      continue;
    }

    if (arg === "--dev") {
      if (profile && profile !== "dev") {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (sawDev) {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      const next = args[i + 1];
      const { value, consumedNext } = takeValue(arg, next);
      if (consumedNext) {
        i += 1;
      }
      if (!value) {
        return { ok: false, error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          ok: false,
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      continue;
    }

    if (!arg.startsWith("-")) {
      sawCommand = true;
      out.push(arg);
      continue;
    }

    out.push(arg);
  }

  return { ok: true, profile, argv: out };
}

function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
  return path.join(resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir), `.fased${suffix}`);
}

export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  // Convenience only: fill defaults, never override explicit env values.
  env.FASED_PROFILE = profile;

  const stateDir = env.FASED_STATE_DIR?.trim() || resolveProfileStateDir(profile, env, homedir);
  if (!env.FASED_STATE_DIR?.trim()) {
    env.FASED_STATE_DIR = stateDir;
  }

  if (!env.FASED_CONFIG_PATH?.trim()) {
    env.FASED_CONFIG_PATH = path.join(stateDir, "fased.json");
  }

  if (profile === "dev" && !env.FASED_GATEWAY_PORT?.trim()) {
    env.FASED_GATEWAY_PORT = "19001";
  }

  if (profile === "vps-lite") {
    const defaults: Record<string, string> = {
      FASED_SKIP_CHANNELS: "1",
      FASED_SKIP_PROVIDERS: "1",
      FASED_SKIP_GMAIL_WATCHER: "1",
      FASED_SKIP_CRON: "1",
      FASED_SKIP_CANVAS_HOST: "1",
      FASED_SKIP_BROWSER_CONTROL_SERVER: "1",
      FASED_WALLET_BASELINE_TIMEOUT_SECONDS: "10",
    };
    for (const [key, value] of Object.entries(defaults)) {
      if (!env[key]?.trim()) {
        env[key] = value;
      }
    }
  }
}
