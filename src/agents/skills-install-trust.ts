import type { SkillInstallSpec } from "./skills/types.js";

export type SkillInstallTrustSummary = {
  external: boolean;
  pinned: boolean;
  integrityPinned: boolean;
  warnings: string[];
};

const EXACT_VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const UV_EXACT_PIN_RE = /^[A-Za-z0-9_.-]+==[A-Za-z0-9][A-Za-z0-9._!+~-]*$/u;

function trim(value: string | undefined): string {
  return value?.trim() ?? "";
}

function hasIntegrity(spec: SkillInstallSpec): boolean {
  return Boolean(trim(spec.integrity) || trim(spec.sha256) || trim(spec.shasum));
}

function extractNodeVersion(spec: string): string {
  const value = spec.trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("@")) {
    const slashIndex = value.indexOf("/");
    if (slashIndex < 0) {
      return "";
    }
    const versionIndex = value.indexOf("@", slashIndex + 1);
    return versionIndex >= 0 ? value.slice(versionIndex + 1).trim() : "";
  }
  const versionIndex = value.lastIndexOf("@");
  return versionIndex > 0 ? value.slice(versionIndex + 1).trim() : "";
}

function isNodePinned(spec: string): boolean {
  return EXACT_VERSION_RE.test(extractNodeVersion(spec));
}

function isGoPinned(moduleSpec: string): boolean {
  const value = moduleSpec.trim();
  const versionIndex = value.lastIndexOf("@");
  if (versionIndex < 0) {
    return false;
  }
  return EXACT_VERSION_RE.test(value.slice(versionIndex + 1).trim());
}

function isUvPinned(packageSpec: string): boolean {
  return UV_EXACT_PIN_RE.test(packageSpec.trim());
}

export function summarizeSkillInstallTrust(spec: SkillInstallSpec): SkillInstallTrustSummary {
  const integrityPinned = hasIntegrity(spec);
  let pinned = false;
  const warnings: string[] = [];

  switch (spec.kind) {
    case "node":
      pinned = isNodePinned(trim(spec.package));
      warnings.push(
        "external package manager install: review the npm package source before running",
      );
      break;
    case "go":
      pinned = isGoPinned(trim(spec.module));
      warnings.push("external package manager install: review the Go module source before running");
      break;
    case "uv":
      pinned = isUvPinned(trim(spec.package));
      warnings.push(
        "external package manager install: review the Python package source before running",
      );
      break;
    case "brew":
      pinned = false;
      warnings.push("external package manager install: review the Homebrew formula before running");
      break;
    case "download":
      pinned = integrityPinned;
      warnings.push("external download install: review the archive source before running");
      break;
  }

  if (!pinned) {
    warnings.push("package version is not pinned to an exact immutable version");
  }
  if (!integrityPinned) {
    warnings.push("source integrity is not pinned with integrity, sha256, or shasum metadata");
  }

  return {
    external: true,
    pinned,
    integrityPinned,
    warnings,
  };
}
