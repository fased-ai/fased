import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveBrewExecutable } from "../infra/brew.js";
import { runCommandWithTimeout, type CommandOptions } from "../process/exec.js";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";
import { resolveUserPath } from "../utils.js";
import { installDownloadSpec } from "./skills-install-download.js";
import { formatInstallFailureMessage } from "./skills-install-output.js";
import { summarizeSkillInstallTrust } from "./skills-install-trust.js";
import {
  clearHasBinaryCache,
  hasBinary,
  loadWorkspaceSkillEntries,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";

const SAFE_BREW_FORMULA_RE = /^[A-Za-z0-9][A-Za-z0-9._@/+:-]*$/u;
const SAFE_NODE_PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._~^*:+-]+)?$/u;
const SAFE_TOOL_PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._@/:+~-]*$/u;

export type SkillInstallRequest = {
  workspaceDir: string;
  skillName: string;
  installId: string;
  timeoutMs?: number;
  config?: FasedAgentConfig;
};

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
  warnings?: string[];
};

function withWarnings(result: SkillInstallResult, warnings: string[]): SkillInstallResult {
  if (warnings.length === 0) {
    return result;
  }
  return {
    ...result,
    warnings: warnings.slice(),
  };
}

function formatScanFindingDetail(
  rootDir: string,
  finding: { message: string; file: string; line: number },
): string {
  const relativePath = path.relative(rootDir, finding.file);
  const filePath =
    relativePath && relativePath !== "." && !relativePath.startsWith("..")
      ? relativePath
      : path.basename(finding.file);
  return `${finding.message} (${filePath}:${finding.line})`;
}

async function collectSkillInstallScanWarnings(
  entry: SkillEntry,
): Promise<{ warnings: string[]; blockedByScan: boolean }> {
  const warnings: string[] = [];
  let blockedByScan = false;
  const skillName = entry.skill.name;
  const skillDir = path.resolve(entry.skill.baseDir);

  try {
    const summary = await scanDirectoryWithSummary(skillDir);
    if (summary.critical > 0) {
      blockedByScan = true;
      const criticalDetails = summary.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => formatScanFindingDetail(skillDir, finding))
        .join("; ");
      warnings.push(`Skill "${skillName}" contains dangerous code patterns: ${criticalDetails}`);
    } else if (summary.warn > 0) {
      warnings.push(
        `Skill "${skillName}" has ${summary.warn} suspicious code pattern(s). Run "fased security audit --deep" for details.`,
      );
    }
  } catch (err) {
    warnings.push(
      `Skill "${skillName}" code safety scan failed (${String(err)}). Installation continues; run "fased security audit --deep" after install.`,
    );
  }

  return { warnings, blockedByScan };
}

export async function inspectSkillInstallRequest(params: {
  workspaceDir: string;
  skillName: string;
  installId: string;
}): Promise<{
  entry?: SkillEntry;
  spec?: SkillInstallSpec;
  warnings: string[];
  blockedByScan: boolean;
}> {
  const workspaceDir = resolveUserPath(params.workspaceDir);
  const entries = loadWorkspaceSkillEntries(workspaceDir);
  const entry = entries.find((item) => item.skill.name === params.skillName);
  if (!entry) {
    return { warnings: [], blockedByScan: false };
  }
  const scan = await collectSkillInstallScanWarnings(entry);
  return {
    entry,
    spec: findInstallSpec(entry, params.installId),
    warnings: scan.warnings,
    blockedByScan: scan.blockedByScan,
  };
}

function resolveInstallId(spec: SkillInstallSpec, index: number): string {
  return (spec.id ?? `${spec.kind}-${index}`).trim();
}

function findInstallSpec(entry: SkillEntry, installId: string): SkillInstallSpec | undefined {
  const specs = entry.metadata?.install ?? [];
  for (const [index, spec] of specs.entries()) {
    if (resolveInstallId(spec, index) === installId) {
      return spec;
    }
  }
  return undefined;
}

function buildNodeInstallCommand(packageName: string, prefs: SkillsInstallPreferences): string[] {
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

function buildInstallCommand(
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
      return { argv: null, error: "download install handled separately" };
    }
    default:
      return { argv: null, error: "unsupported installer" };
  }
}

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function createInstallFailure(params: {
  message: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
}): SkillInstallResult {
  return {
    ok: false,
    message: params.message,
    stdout: params.stdout?.trim() ?? "",
    stderr: params.stderr?.trim() ?? "",
    code: params.code ?? null,
  };
}

function createInstallSuccess(result: CommandResult): SkillInstallResult {
  return {
    ok: true,
    message: "Installed",
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    code: result.code,
  };
}

function candidateBinPaths(bin: string): string[] {
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

function findBinaryOutsidePath(bin: string): string | undefined {
  for (const candidate of candidateBinPaths(bin)) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function verifyInstalledBins(
  spec: SkillInstallSpec,
  result: SkillInstallResult,
): SkillInstallResult {
  if (!result.ok) {
    return result;
  }
  const bins = spec.bins ?? [];
  if (bins.length === 0) {
    return result;
  }
  const missing = bins.filter((bin) => !hasBinary(bin));
  if (missing.length === 0) {
    return result;
  }
  const foundOutsidePath = missing
    .map((bin) => ({ bin, path: findBinaryOutsidePath(bin) }))
    .filter((entry): entry is { bin: string; path: string } => Boolean(entry.path));
  const hint =
    foundOutsidePath.length > 0
      ? ` Found ${foundOutsidePath.map((entry) => `${entry.bin} at ${entry.path}`).join(", ")}, but that directory is not in the gateway PATH. Add it to PATH and restart the gateway.`
      : " Add the installed binary directory to the gateway PATH, then restart the gateway.";
  return createInstallFailure({
    message: `Install command completed, but ${missing.map((bin) => `"${bin}"`).join(", ")} is still not visible to the gateway PATH.${hint}`,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  });
}

async function runCommandSafely(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<CommandResult> {
  try {
    const result = await runCommandWithTimeout(argv, optionsOrTimeout);
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      code: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveBrewMissingFailure(spec: SkillInstallSpec): SkillInstallResult {
  const formula = spec.formula ?? "this package";
  const hint =
    process.platform === "linux"
      ? `Homebrew is not installed. Install it from https://brew.sh or install "${formula}" manually using your system package manager (e.g. apt, dnf, pacman).`
      : "Homebrew is not installed. Install it from https://brew.sh";
  return createInstallFailure({ message: `brew not installed — ${hint}` });
}

async function executeInstallCommand(params: {
  argv: string[] | null;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillInstallResult> {
  if (!params.argv || params.argv.length === 0) {
    return createInstallFailure({ message: "invalid install command" });
  }

  const result = await runCommandSafely(params.argv, {
    timeoutMs: params.timeoutMs,
    env: params.env,
  });
  if (result.code === 0) {
    return createInstallSuccess(result);
  }

  return createInstallFailure({
    message: formatInstallFailureMessage(result),
    ...result,
  });
}

function resolveMissingInstallerBinaryFailure(params: {
  spec: SkillInstallSpec;
  argv: string[] | null;
  prefs: SkillsInstallPreferences;
}): SkillInstallResult | undefined {
  const executable = params.argv?.[0]?.trim();
  if (!executable || hasBinary(executable)) {
    return undefined;
  }

  switch (params.spec.kind) {
    case "node":
      return createInstallFailure({
        message: `${executable} not installed — install Node.js/${executable} or set skills.install.nodeManager to an installed manager (${params.prefs.nodeManager} is selected).`,
      });
    case "go":
      return createInstallFailure({
        message: "go not installed — install Go manually: https://go.dev/doc/install",
      });
    case "uv":
      return createInstallFailure({
        message:
          "uv not installed — install manually: https://docs.astral.sh/uv/getting-started/installation/",
      });
    case "brew":
    case "download":
      return undefined;
    default:
      return createInstallFailure({
        message: `${executable} not installed — install it, then retry the skill dependency install.`,
      });
  }
}

export async function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 300_000, 1_000), 900_000);
  const inspection = await inspectSkillInstallRequest({
    workspaceDir: params.workspaceDir,
    skillName: params.skillName,
    installId: params.installId,
  });
  const entry = inspection.entry;
  if (!entry) {
    return {
      ok: false,
      message: `Skill not found: ${params.skillName}`,
      stdout: "",
      stderr: "",
      code: null,
    };
  }

  const spec = inspection.spec;
  const warnings = spec
    ? [...inspection.warnings, ...summarizeSkillInstallTrust(spec).warnings]
    : inspection.warnings;
  if (!spec) {
    return withWarnings(
      {
        ok: false,
        message: `Installer not found: ${params.installId}`,
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }
  if (inspection.blockedByScan) {
    return withWarnings(
      createInstallFailure({
        message:
          warnings.find((warning) => warning.includes("dangerous code patterns")) ??
          `Skill "${entry.skill.name}" contains dangerous code patterns`,
      }),
      warnings,
    );
  }
  if (spec.kind === "download") {
    const downloadResult = await installDownloadSpec({ entry, spec, timeoutMs });
    return withWarnings(downloadResult, warnings);
  }

  const prefs = resolveSkillsInstallPreferences(params.config);
  const command = buildInstallCommand(spec, prefs);
  if (command.error) {
    return withWarnings(
      {
        ok: false,
        message: command.error,
        stdout: "",
        stderr: "",
        code: null,
      },
      warnings,
    );
  }

  const brewExe = hasBinary("brew") ? "brew" : resolveBrewExecutable();
  if (spec.kind === "brew" && !brewExe) {
    return withWarnings(resolveBrewMissingFailure(spec), warnings);
  }

  const argv = command.argv ? [...command.argv] : null;
  if (spec.kind === "brew" && brewExe && argv?.[0] === "brew") {
    argv[0] = brewExe;
  }

  const missingInstallerBinary = resolveMissingInstallerBinaryFailure({ spec, argv, prefs });
  if (missingInstallerBinary) {
    return withWarnings(missingInstallerBinary, warnings);
  }

  const installResult = await executeInstallCommand({ argv, timeoutMs });
  clearHasBinaryCache();
  return withWarnings(verifyInstalledBins(spec, installResult), warnings);
}
