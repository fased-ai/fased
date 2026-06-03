import fs from "node:fs";
import path from "node:path";
import { resolveBrewExecutable } from "../infra/brew.js";
import { hasBinary, type SkillInstallSpec, type SkillsInstallPreferences } from "./skills.js";

const SAFE_BREW_FORMULA_RE = /^[A-Za-z0-9][A-Za-z0-9._@/+:-]*$/u;
const SAFE_NODE_PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._~^*:+-]+)?$/u;
const SAFE_TOOL_PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._@/:+~-]*$/u;

export type SkillInstallPlanBin = {
  bin: string;
  available: boolean;
  outsidePath?: string;
  pathTargets: string[];
};

export type SkillInstallPlan = {
  manager: string;
  packageRef: string;
  command: string[] | null;
  commandPreview: string;
  toolchainAvailable: boolean;
  toolchainMessage?: string;
  pathTargets: string[];
  bins: SkillInstallPlanBin[];
};

function quoteCommandPart(part: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(part)) {
    return part;
  }
  return JSON.stringify(part);
}

function formatCommand(argv: string[] | null): string {
  if (!argv || argv.length === 0) {
    return "handled internally";
  }
  return argv.map(quoteCommandPart).join(" ");
}

export function buildNodeInstallCommand(
  packageName: string,
  prefs: SkillsInstallPreferences,
): string[] {
  switch (prefs.nodeManager) {
    case "pnpm":
      return ["pnpm", "add", "-g", "--ignore-scripts", packageName];
    case "yarn":
      return ["yarn", "global", "add", "--ignore-scripts", packageName];
    case "bun":
      return ["bun", "add", "-g", "--ignore-scripts", packageName];
    default:
      return ["npm", "install", "-g", "--ignore-scripts", packageName];
  }
}

export function buildSkillInstallCommand(
  spec: SkillInstallSpec,
  prefs: SkillsInstallPreferences,
): {
  argv: string[] | null;
  error?: string;
} {
  switch (spec.kind) {
    case "brew": {
      if (!spec.formula) {
        return { argv: null, error: "missing brew formula" };
      }
      if (!SAFE_BREW_FORMULA_RE.test(spec.formula)) {
        return { argv: null, error: "unsafe brew formula" };
      }
      return { argv: ["brew", "install", spec.formula] };
    }
    case "node": {
      if (!spec.package) {
        return { argv: null, error: "missing node package" };
      }
      if (!SAFE_NODE_PACKAGE_RE.test(spec.package)) {
        return { argv: null, error: "unsafe node package" };
      }
      return {
        argv: buildNodeInstallCommand(spec.package, prefs),
      };
    }
    case "go": {
      if (!spec.module) {
        return { argv: null, error: "missing go module" };
      }
      if (!SAFE_TOOL_PACKAGE_RE.test(spec.module)) {
        return { argv: null, error: "unsafe go module" };
      }
      return { argv: ["go", "install", spec.module] };
    }
    case "uv": {
      if (!spec.package) {
        return { argv: null, error: "missing uv package" };
      }
      if (!SAFE_TOOL_PACKAGE_RE.test(spec.package)) {
        return { argv: null, error: "unsafe uv package" };
      }
      return { argv: ["uv", "tool", "install", spec.package] };
    }
    case "download": {
      return { argv: null, error: undefined };
    }
  }
}

export function candidateSkillBinPaths(bin: string): string[] {
  const home = process.env.HOME?.trim();
  const npmPrefixes = [
    process.env.NPM_CONFIG_PREFIX?.trim(),
    process.env.npm_config_prefix?.trim(),
  ].filter((prefix): prefix is string => Boolean(prefix));
  const candidates = [
    process.env.GOBIN ? path.join(process.env.GOBIN, bin) : "",
    home ? path.join(home, "go", "bin", bin) : "",
    home ? path.join(home, ".local", "bin", bin) : "",
    home ? path.join(home, ".npm-global", "bin", bin) : "",
    ...npmPrefixes.map((prefix) => path.join(prefix, "bin", bin)),
    "/home/linuxbrew/.linuxbrew/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
    .filter(Boolean)
    .map((candidate) => (candidate.endsWith(bin) ? candidate : path.join(candidate, bin)));
  return Array.from(new Set(candidates));
}

export function findSkillBinaryOutsidePath(bin: string): string | undefined {
  for (const candidate of candidateSkillBinPaths(bin)) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore unreadable candidate paths.
    }
  }
  return undefined;
}

function packageRefForInstallSpec(spec: SkillInstallSpec): string {
  switch (spec.kind) {
    case "brew":
      return spec.formula ?? "";
    case "go":
      return spec.module ?? "";
    case "node":
    case "uv":
      return spec.package ?? "";
    case "download":
      return spec.url ?? "";
  }
}

function managerForInstallSpec(spec: SkillInstallSpec, prefs: SkillsInstallPreferences): string {
  switch (spec.kind) {
    case "node":
      return prefs.nodeManager;
    case "brew":
      return "brew";
    case "go":
      return "go";
    case "uv":
      return "uv";
    case "download":
      return "download";
  }
}

function resolveToolchain(
  spec: SkillInstallSpec,
  argv: string[] | null,
): {
  available: boolean;
  message?: string;
} {
  if (spec.kind === "download") {
    return { available: true };
  }
  if (spec.kind === "brew") {
    if (hasBinary("brew") || resolveBrewExecutable()) {
      return { available: true };
    }
    return {
      available: false,
      message:
        process.platform === "linux"
          ? "Homebrew/Linuxbrew is not installed. Use a Linux package manager manually or install Homebrew first."
          : "Homebrew is not installed.",
    };
  }
  const executable = argv?.[0]?.trim();
  if (!executable) {
    return { available: false, message: "Installer command is not available." };
  }
  if (hasBinary(executable)) {
    return { available: true };
  }
  if (spec.kind === "node") {
    return {
      available: false,
      message: `${executable} is not installed or is not visible to the gateway PATH.`,
    };
  }
  if (spec.kind === "go") {
    return {
      available: false,
      message: "go is not installed or is not visible to the gateway PATH.",
    };
  }
  if (spec.kind === "uv") {
    return {
      available: false,
      message: "uv is not installed or is not visible to the gateway PATH.",
    };
  }
  return { available: false, message: `${executable} is not visible to the gateway PATH.` };
}

export function resolveSkillInstallPlan(
  spec: SkillInstallSpec,
  prefs: SkillsInstallPreferences,
): SkillInstallPlan {
  const command = buildSkillInstallCommand(spec, prefs);
  const bins = (spec.bins ?? []).map((bin) => ({
    bin,
    available: hasBinary(bin),
    outsidePath: findSkillBinaryOutsidePath(bin),
    pathTargets: candidateSkillBinPaths(bin),
  }));
  const pathTargets = Array.from(new Set(bins.flatMap((entry) => entry.pathTargets)));
  const toolchain = command.error
    ? { available: false, message: command.error }
    : resolveToolchain(spec, command.argv);
  return {
    manager: managerForInstallSpec(spec, prefs),
    packageRef: packageRefForInstallSpec(spec),
    command: command.argv,
    commandPreview:
      spec.kind === "download" && spec.url
        ? `download and verify ${spec.url}`
        : formatCommand(command.argv),
    toolchainAvailable: toolchain.available,
    toolchainMessage: toolchain.message,
    pathTargets,
    bins,
  };
}
