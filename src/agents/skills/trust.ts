import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SkillEntry, SkillSnapshot } from "./types.js";

const MARKETPLACE_ORIGIN_DIRS = [".clawhub", ".clawdhub"] as const;

function hasMarketplaceOriginMarker(root: string): boolean {
  return MARKETPLACE_ORIGIN_DIRS.some((dir) => fs.existsSync(path.join(root, dir, "origin.json")));
}

function isTrackedMarketplaceSkill(root: string): boolean {
  const skillsDir = path.dirname(root);
  if (path.basename(skillsDir) !== "skills") {
    return false;
  }
  const slug = path.basename(root);
  const workspaceDir = path.dirname(skillsDir);
  for (const directory of MARKETPLACE_ORIGIN_DIRS) {
    try {
      const lock = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, directory, "lock.json"), "utf8"),
      ) as { version?: unknown; skills?: Record<string, unknown> };
      if (lock.version === 1 && lock.skills?.[slug]) {
        return true;
      }
    } catch {
      // A missing or malformed central lock does not cancel a per-skill origin marker.
    }
  }
  return false;
}

export function computeSkillContentSha256Sync(skillDir: string): string | null {
  try {
    const digest = createHash("sha256");
    const queue = [path.resolve(skillDir)];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      const entries = fs
        .readdirSync(current, { withFileTypes: true })
        .toSorted((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          queue.push(fullPath);
          continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return null;
        }
        digest.update(path.relative(skillDir, fullPath).split(path.sep).join("/"));
        digest.update("\n");
        digest.update(fs.readFileSync(fullPath));
        digest.update("\n");
      }
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

export function marketplaceSkillProvenanceMatchesContent(skillDir: string): boolean {
  const root = skillDir.trim();
  if (!root) {
    return false;
  }
  for (const directory of MARKETPLACE_ORIGIN_DIRS) {
    try {
      const origin = JSON.parse(
        fs.readFileSync(path.join(root, directory, "origin.json"), "utf8"),
      ) as {
        version?: unknown;
        archiveSha256?: unknown;
        archiveIntegrityVerified?: unknown;
        contentSha256?: unknown;
      };
      if (
        origin.version === 1 &&
        origin.archiveIntegrityVerified === true &&
        typeof origin.archiveSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(origin.archiveSha256) &&
        typeof origin.contentSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(origin.contentSha256) &&
        computeSkillContentSha256Sync(root) === origin.contentSha256
      ) {
        return true;
      }
    } catch {
      // Invalid provenance remains untrusted and therefore Marketplace-isolated.
    }
  }
  return false;
}

export function isMarketplaceSkillDir(skillDir: string): boolean {
  const root = skillDir.trim();
  return Boolean(root && (hasMarketplaceOriginMarker(root) || isTrackedMarketplaceSkill(root)));
}

export function marketplaceSkillIdsFromEntries(entries: SkillEntry[]): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => isMarketplaceSkillDir(entry.skill.baseDir))
        .map((entry) => entry.skill.name.trim())
        .filter(Boolean),
    ),
  ].toSorted();
}

export function marketplaceSkillIdsFromSnapshot(snapshot?: SkillSnapshot): string[] {
  if (!snapshot) {
    return [];
  }
  if (snapshot.marketplaceSkillIds) {
    return [
      ...new Set(snapshot.marketplaceSkillIds.map((id) => id.trim()).filter(Boolean)),
    ].toSorted();
  }
  return [
    ...new Set(
      (snapshot.resolvedSkills ?? [])
        .filter((skill) => isMarketplaceSkillDir(skill.baseDir))
        .map((skill) => skill.name.trim())
        .filter(Boolean),
    ),
  ].toSorted();
}
