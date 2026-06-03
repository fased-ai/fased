import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";

async function writeSkill(params: { dir: string; name: string; description: string }) {
  await fs.mkdir(params.dir, { recursive: true });
  await fs.writeFile(
    path.join(params.dir, "SKILL.md"),
    `---
name: ${params.name}
description: ${params.description}
---

# ${params.name}
`,
    "utf8",
  );
}

describe("buildWorkspaceSkillStatus marketplace status", () => {
  it("surfaces ClawHub origin, scan, and update review state", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-"));
    const skillDir = path.join(workspaceDir, "skills", "market-skill");

    await writeSkill({
      dir: skillDir,
      name: "market-skill",
      description: "Marketplace skill",
    });
    await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, ".clawhub", "origin.json"),
      `${JSON.stringify(
        {
          version: 1,
          registry: "https://clawhub.com",
          slug: "market-skill",
          installedVersion: "1.2.3",
          installedAt: 1_700_000_000,
          permissions: {
            version: 1,
            walletActions: { actions: ["swap"], roles: ["agent"] },
            toolAccess: ["web.fetch"],
            install: { kinds: ["node"] },
            risky: true,
            digest: "digest",
          },
          installScan: {
            version: 1,
            fileCount: 2,
            totalBytes: 512,
            blocked: false,
            findings: [
              {
                severity: "warn",
                code: "script_file",
                path: "bin/setup.sh",
                message: "contains script file",
              },
            ],
          },
          lastUpdateReview: {
            version: 1,
            approvalRequired: true,
            reasons: ["permission digest changed"],
            permissionDigestChanged: true,
            nextPermissionDigest: "next",
            addedScanFindings: [],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const report = buildWorkspaceSkillStatus(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
    });
    const skill = report.skills.find((entry) => entry.name === "market-skill");

    expect(skill?.marketplace).toMatchObject({
      source: "clawhub",
      registry: "https://clawhub.com",
      slug: "market-skill",
      installedVersion: "1.2.3",
      requestedRisky: true,
      requestedWalletActions: true,
      requestedToolAccess: ["web.fetch"],
      requestedInstallKinds: ["node"],
      scanWarnings: 1,
      scanBlocks: 0,
      updateApprovalRequired: true,
      updateReviewReasons: ["permission digest changed"],
    });
  });
});
