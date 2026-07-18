import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSkillContentSha256Sync,
  isMarketplaceSkillDir,
  marketplaceSkillProvenanceMatchesContent,
} from "./trust.js";

describe("Marketplace skill provenance", () => {
  it("keeps a centrally tracked skill isolated when its per-skill marker is removed", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fased-skill-trust-"));
    const skillDir = path.join(workspace, "skills", "reviewed-skill");
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(path.join(workspace, ".clawhub"), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, ".clawhub", "lock.json"),
        `${JSON.stringify({ version: 1, skills: { "reviewed-skill": { version: "1.0.0" } } })}\n`,
      );
      expect(isMarketplaceSkillDir(skillDir)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("detects installed content changes against the recorded digest", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fased-skill-trust-"));
    const skillDir = path.join(workspace, "skills", "reviewed-skill");
    try {
      fs.mkdirSync(path.join(skillDir, ".clawhub"), { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Reviewed\n");
      const contentSha256 = computeSkillContentSha256Sync(skillDir);
      expect(contentSha256).toMatch(/^[a-f0-9]{64}$/u);
      fs.writeFileSync(
        path.join(skillDir, ".clawhub", "origin.json"),
        `${JSON.stringify({
          version: 1,
          archiveSha256: "a".repeat(64),
          archiveIntegrityVerified: true,
          contentSha256,
        })}\n`,
      );
      expect(marketplaceSkillProvenanceMatchesContent(skillDir)).toBe(true);
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Changed\n");
      expect(marketplaceSkillProvenanceMatchesContent(skillDir)).toBe(false);
      expect(isMarketplaceSkillDir(skillDir)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
