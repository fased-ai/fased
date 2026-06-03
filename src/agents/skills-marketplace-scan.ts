import fs from "node:fs/promises";
import path from "node:path";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";

const BLOCKED_DIR_NAMES = new Set([".git", ".hg", ".svn", "node_modules"]);
const BLOCKED_PACKAGE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
]);
const DEPENDENCY_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
]);
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BLOCKED_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
  "service-account.json",
]);
const BLOCKED_FILE_EXTENSIONS = new Set([
  ".dll",
  ".dylib",
  ".exe",
  ".key",
  ".node",
  ".p12",
  ".pem",
  ".pfx",
  ".so",
]);
const BLOCKED_INSTALL_SCRIPT_NAMES = new Set([
  "bootstrap.sh",
  "install.bat",
  "install.cmd",
  "install.ps1",
  "install.sh",
  "postinstall.sh",
  "setup.bat",
  "setup.cmd",
  "setup.ps1",
  "setup.sh",
]);
const SUSPICIOUS_SCRIPT_EXTENSIONS = new Set([
  ".bash",
  ".bat",
  ".cmd",
  ".fish",
  ".ps1",
  ".sh",
  ".zsh",
]);
const DEPENDENCY_MANIFEST_FILE_NAMES = new Set(
  [
    "Cargo.toml",
    "Gemfile",
    "Pipfile",
    "composer.json",
    "go.mod",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "pyproject.toml",
    "requirements.txt",
    "uv.lock",
    "yarn.lock",
  ].map((name) => name.toLowerCase()),
);

export type SkillMarketplaceArchiveFinding = {
  severity: "block" | "warn";
  code: string;
  path: string;
  message: string;
};

export type SkillMarketplaceArchiveScan = {
  version: 1;
  fileCount: number;
  totalBytes: number;
  files?: string[];
  filesTruncated?: boolean;
  findings: SkillMarketplaceArchiveFinding[];
  blocked: boolean;
};

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addFinding(
  findings: SkillMarketplaceArchiveFinding[],
  finding: SkillMarketplaceArchiveFinding,
): void {
  findings.push(finding);
}

function inspectMarketplaceFilePath(params: {
  path: string;
  findings: SkillMarketplaceArchiveFinding[];
}): void {
  const basename = path.posix.basename(params.path).toLowerCase();
  const ext = path.posix.extname(basename);

  if (BLOCKED_FILE_NAMES.has(basename)) {
    addFinding(params.findings, {
      severity: "block",
      code: "sensitive_file",
      path: params.path,
      message: `skill archive contains sensitive file "${basename}"`,
    });
  }

  if (BLOCKED_FILE_EXTENSIONS.has(ext)) {
    addFinding(params.findings, {
      severity: "block",
      code: "blocked_binary_or_secret_file",
      path: params.path,
      message: `skill archive contains blocked file type "${ext}"`,
    });
  }

  if (BLOCKED_INSTALL_SCRIPT_NAMES.has(basename)) {
    addFinding(params.findings, {
      severity: "block",
      code: "install_script_file",
      path: params.path,
      message: `skill archive contains installer script "${basename}"`,
    });
  } else if (SUSPICIOUS_SCRIPT_EXTENSIONS.has(ext)) {
    addFinding(params.findings, {
      severity: "warn",
      code: "script_file",
      path: params.path,
      message: `skill archive contains script file "${basename}"`,
    });
  }

  if (DEPENDENCY_MANIFEST_FILE_NAMES.has(basename)) {
    addFinding(params.findings, {
      severity: "warn",
      code: "dependency_manifest",
      path: params.path,
      message:
        "skill archive contains a dependency manifest; marketplace installs do not run dependency install steps automatically",
    });
  }
}

async function inspectMarketplaceSourceCode(params: {
  rootDir: string;
  findings: SkillMarketplaceArchiveFinding[];
}): Promise<void> {
  try {
    const summary = await scanDirectoryWithSummary(params.rootDir, {
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
    });
    for (const finding of summary.findings) {
      const relativePath = toPosix(path.relative(params.rootDir, finding.file));
      addFinding(params.findings, {
        severity: finding.severity === "critical" ? "block" : "warn",
        code: finding.severity === "critical" ? "dangerous_code" : "suspicious_code",
        path: relativePath,
        message: `${finding.message} (${finding.ruleId}, line ${finding.line})`,
      });
    }
  } catch (err) {
    addFinding(params.findings, {
      severity: "block",
      code: "code_scan_failed",
      path: ".",
      message: `failed to scan marketplace skill code: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

async function inspectPackageJson(params: {
  rootDir: string;
  relativePath: string;
  findings: SkillMarketplaceArchiveFinding[];
}): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(params.rootDir, params.relativePath), "utf8"));
  } catch {
    addFinding(params.findings, {
      severity: "block",
      code: "invalid_package_json",
      path: toPosix(params.relativePath),
      message: "package.json is not valid JSON",
    });
    return;
  }
  if (!isObjectRecord(parsed)) {
    return;
  }
  const scripts = isObjectRecord(parsed.scripts) ? parsed.scripts : {};
  for (const scriptName of Object.keys(scripts)) {
    if (BLOCKED_PACKAGE_SCRIPTS.has(scriptName)) {
      addFinding(params.findings, {
        severity: "block",
        code: "package_lifecycle_script",
        path: toPosix(params.relativePath),
        message: `package.json contains lifecycle script "${scriptName}"`,
      });
    }
  }
  for (const field of Object.keys(parsed)) {
    if (DEPENDENCY_FIELDS.has(field) && isObjectRecord(parsed[field])) {
      addFinding(params.findings, {
        severity: "block",
        code: "package_dependencies",
        path: toPosix(params.relativePath),
        message: `package.json contains ${field}; declare skill installers in metadata.fased.install instead`,
      });
    }
  }
}

export async function scanSkillMarketplaceArchive(
  rootDir: string,
): Promise<SkillMarketplaceArchiveScan> {
  const findings: SkillMarketplaceArchiveFinding[] = [];
  const queue = [""];
  const files: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  while (queue.length > 0) {
    const relativeDir = queue.shift() ?? "";
    const fullDir = path.join(rootDir, relativeDir);
    const entries = await fs.readdir(fullDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      const posixPath = toPosix(relativePath);

      if (entry.isSymbolicLink()) {
        addFinding(findings, {
          severity: "block",
          code: "symlink",
          path: posixPath,
          message: "skill archives may not contain symlinks",
        });
        continue;
      }

      if (entry.isDirectory()) {
        if (BLOCKED_DIR_NAMES.has(entry.name)) {
          addFinding(findings, {
            severity: "block",
            code: "blocked_directory",
            path: posixPath,
            message: `skill archive contains blocked directory "${entry.name}"`,
          });
          continue;
        }
        queue.push(relativePath);
        continue;
      }

      if (!entry.isFile()) {
        addFinding(findings, {
          severity: "block",
          code: "special_file",
          path: posixPath,
          message: "skill archives may contain only regular files and directories",
        });
        continue;
      }

      fileCount += 1;
      if (files.length < 80) {
        files.push(posixPath);
      }
      if (fileCount > MAX_FILES) {
        addFinding(findings, {
          severity: "block",
          code: "too_many_files",
          path: posixPath,
          message: `skill archive exceeds ${MAX_FILES} files`,
        });
      }

      const stat = await fs.stat(path.join(rootDir, relativePath));
      totalBytes += stat.size;
      if (stat.size > MAX_FILE_BYTES) {
        addFinding(findings, {
          severity: "block",
          code: "file_too_large",
          path: posixPath,
          message: `file exceeds ${MAX_FILE_BYTES} bytes`,
        });
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        addFinding(findings, {
          severity: "block",
          code: "archive_too_large",
          path: posixPath,
          message: `skill archive exceeds ${MAX_TOTAL_BYTES} bytes`,
        });
      }

      if (entry.name === "package.json") {
        await inspectPackageJson({ rootDir, relativePath, findings });
      }
      inspectMarketplaceFilePath({ path: posixPath, findings });
    }
  }

  await inspectMarketplaceSourceCode({ rootDir, findings });

  return {
    version: 1,
    fileCount,
    totalBytes,
    files: files.toSorted(),
    filesTruncated: fileCount > files.length,
    findings,
    blocked: findings.some((finding) => finding.severity === "block"),
  };
}

export function formatArchiveScanFindings(scan: SkillMarketplaceArchiveScan): string {
  if (scan.findings.length === 0) {
    return `archive scan: ${scan.fileCount} files, ${scan.totalBytes} bytes, no issues`;
  }
  return scan.findings
    .map((finding) => `${finding.severity}: ${finding.code} at ${finding.path}: ${finding.message}`)
    .join("; ");
}
