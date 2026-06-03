import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchClawHubSkillDetailMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const listClawHubSkillsMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.com");
const searchClawHubSkillsMock = vi.fn();
const archiveCleanupMock = vi.fn();
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const fileExistsMock = vi.fn();

vi.mock("../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  listClawHubSkills: listClawHubSkillsMock,
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
  searchClawHubSkills: searchClawHubSkillsMock,
}));

vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: withExtractedArchiveRootMock,
}));

vi.mock("../infra/install-package-dir.js", () => ({
  installPackageDir: installPackageDirMock,
}));

vi.mock("../infra/archive.js", () => ({
  fileExists: fileExistsMock,
}));

const {
  installSkillFromClawHub,
  previewSkillsUpdateFromClawHub,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} = await import("./skills-clawhub.js");

describe("skills-clawhub", () => {
  const extractedRoot = path.join(os.tmpdir(), "fased-skills-clawhub-extracted");

  async function writeExtractedSkill(metadata = '{"fased":{}}') {
    await fs.rm(extractedRoot, { recursive: true, force: true });
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.writeFile(
      path.join(extractedRoot, "SKILL.md"),
      `---\nname: agentreceipt\ndescription: AgentReceipt\nmetadata: ${metadata}\n---\n# AgentReceipt\n`,
      "utf8",
    );
  }

  beforeEach(async () => {
    fetchClawHubSkillDetailMock.mockReset();
    downloadClawHubSkillArchiveMock.mockReset();
    listClawHubSkillsMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset();
    searchClawHubSkillsMock.mockReset();
    archiveCleanupMock.mockReset();
    withExtractedArchiveRootMock.mockReset();
    installPackageDirMock.mockReset();
    fileExistsMock.mockReset();

    resolveClawHubBaseUrlMock.mockImplementation(
      (baseUrl?: string) => baseUrl ?? "https://clawhub.com",
    );
    await writeExtractedSkill();
    fileExistsMock.mockImplementation(async (input: string) => input.endsWith("SKILL.md"));
    fetchClawHubSkillDetailMock.mockResolvedValue({
      skill: {
        slug: "agentreceipt",
        displayName: "AgentReceipt",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
      },
    });
    downloadClawHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: "sha256-test",
      cleanup: archiveCleanupMock,
    });
    archiveCleanupMock.mockResolvedValue(undefined);
    searchClawHubSkillsMock.mockResolvedValue([]);
    withExtractedArchiveRootMock.mockImplementation(async (params) => {
      expect(params.rootMarkers).toEqual(["SKILL.md"]);
      return await params.onExtracted(extractedRoot);
    });
    installPackageDirMock.mockResolvedValue({
      ok: true,
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
  });

  it("installs ClawHub skills from flat-root archives", async () => {
    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(downloadClawHubSkillArchiveMock).toHaveBeenCalledWith({
      slug: "agentreceipt",
      version: "1.0.0",
      baseUrl: undefined,
    });
    expect(installPackageDirMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir: extractedRoot,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
    expect(archiveCleanupMock).toHaveBeenCalledTimes(1);
  });

  it("writes ClawHub tracking metadata for new installs", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skills-clawhub-"));
    const targetDir = path.join(workspaceDir, "skills", "agentreceipt");
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir,
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
      });

      expect(result).toMatchObject({ ok: true });
      await expect(
        fs.readFile(path.join(targetDir, ".clawhub", "origin.json"), "utf8"),
      ).resolves.toContain('"registry": "https://clawhub.com"');
      await expect(
        fs.readFile(path.join(workspaceDir, ".clawhub", "lock.json"), "utf8"),
      ).resolves.toContain('"agentreceipt"');
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects new installs from registries outside the allowlist", async () => {
    resolveClawHubBaseUrlMock.mockReturnValueOnce("https://example.invalid");

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
      baseUrl: "https://example.invalid",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "ClawHub registry is not allowlisted: https://example.invalid",
    });
    expect(fetchClawHubSkillDetailMock).not.toHaveBeenCalled();
    expect(downloadClawHubSkillArchiveMock).not.toHaveBeenCalled();
  });

  it("records requested marketplace wallet permissions without granting them", async () => {
    await writeExtractedSkill(
      '{"fased":{"permissions":{"walletActions":{"actions":["quote","swap"],"roles":["agent"],"chains":["solana"],"maxAmount":"1000000","autonomous":true}}}}',
    );
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skills-clawhub-"));
    const targetDir = path.join(workspaceDir, "skills", "agentreceipt");
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir,
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
      });

      expect(result).toMatchObject({
        ok: true,
        sourceTrust: {
          registry: "https://clawhub.com",
          mode: "allowlist",
        },
        installScan: {
          blocked: false,
          findings: [],
        },
        permissions: {
          walletActions: {
            actions: ["quote", "swap"],
            roles: ["agent"],
            chains: ["solana"],
            maxAmount: "1000000",
            autonomous: true,
          },
          risky: true,
        },
      });
      const origin = JSON.parse(
        await fs.readFile(path.join(targetDir, ".clawhub", "origin.json"), "utf8"),
      ) as { permissions?: { walletActions?: { actions?: string[] }; risky?: boolean } };
      expect(origin.permissions?.walletActions?.actions).toEqual(["quote", "swap"]);
      expect(origin.permissions?.risky).toBe(true);
      expect((origin as { installScan?: { blocked?: boolean } }).installScan?.blocked).toBe(false);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects marketplace skills that request mining wallet roles", async () => {
    await writeExtractedSkill(
      '{"fased":{"walletActions":{"actions":["quote"],"roles":["mining"],"chains":["solana"]}}}',
    );

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("invalid marketplace wallet role: mining"),
    });
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub archives with package lifecycle scripts", async () => {
    await fs.writeFile(
      path.join(extractedRoot, "package.json"),
      JSON.stringify({ scripts: { postinstall: "node install.js" } }, null, 2),
      "utf8",
    );

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("package_lifecycle_script"),
    });
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub archives with package dependencies", async () => {
    await fs.writeFile(
      path.join(extractedRoot, "package.json"),
      JSON.stringify({ dependencies: { leftpad: "1.0.0" } }, null, 2),
      "utf8",
    );

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("package_dependencies"),
    });
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub archives with sensitive files", async () => {
    await fs.writeFile(path.join(extractedRoot, ".env"), "TOKEN=secret\n", "utf8");

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("sensitive_file"),
    });
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub archives with installer script files", async () => {
    await fs.writeFile(path.join(extractedRoot, "install.sh"), "#!/bin/sh\n", "utf8");

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("install_script_file"),
    });
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("rejects ClawHub archives with dangerous source patterns", async () => {
    await fs.writeFile(path.join(extractedRoot, "index.js"), 'eval("1+1");\n', "utf8");

    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("dangerous_code"),
    });
    expect(installPackageDirMock).not.toHaveBeenCalled();
  });

  it("records dependency manifest and helper script warnings without granting permissions", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skills-clawhub-"));
    const targetDir = path.join(workspaceDir, "skills", "agentreceipt");
    await fs.writeFile(path.join(extractedRoot, "helper.sh"), "#!/bin/sh\n", "utf8");
    await fs.writeFile(path.join(extractedRoot, "requirements.txt"), "requests\n", "utf8");
    installPackageDirMock.mockResolvedValueOnce({
      ok: true,
      targetDir,
    });

    try {
      const result = await installSkillFromClawHub({
        workspaceDir,
        slug: "agentreceipt",
      });

      expect(result).toMatchObject({
        ok: true,
        installScan: {
          blocked: false,
          findings: expect.arrayContaining([
            expect.objectContaining({ severity: "warn", code: "script_file" }),
            expect.objectContaining({ severity: "warn", code: "dependency_manifest" }),
          ]),
        },
      });
      const origin = JSON.parse(
        await fs.readFile(path.join(targetDir, ".clawhub", "origin.json"), "utf8"),
      ) as { installScan?: { findings?: Array<{ code: string }> } };
      expect(origin.installScan?.findings?.map((finding) => finding.code)).toEqual(
        expect.arrayContaining(["script_file", "dependency_manifest"]),
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  describe("legacy tracked slugs remain updatable", () => {
    async function createLegacyTrackedSkillFixture(slug: string) {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skills-clawhub-"));
      const skillDir = path.join(workspaceDir, "skills", slug);
      await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
      await fs.writeFile(
        path.join(skillDir, ".clawhub", "origin.json"),
        `${JSON.stringify(
          {
            version: 1,
            registry: "https://legacy.clawhub.com",
            slug,
            installedVersion: "0.9.0",
            installedAt: 123,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, ".clawhub", "lock.json"),
        `${JSON.stringify(
          {
            version: 1,
            skills: {
              [slug]: {
                version: "0.9.0",
                installedAt: 123,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return { workspaceDir, skillDir };
    }

    it("updates all tracked legacy Unicode slugs in place", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createLegacyTrackedSkillFixture(slug);
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
        });

        expect(fetchClawHubSkillDetailMock).toHaveBeenCalledWith({
          slug,
          baseUrl: "https://legacy.clawhub.com",
        });
        expect(downloadClawHubSkillArchiveMock).toHaveBeenCalledWith({
          slug,
          version: "1.0.0",
          baseUrl: "https://legacy.clawhub.com",
        });
        expect(results).toMatchObject([
          {
            ok: true,
            slug,
            previousVersion: "0.9.0",
            version: "1.0.0",
            targetDir: path.join(workspaceDir, "skills", slug),
            sourceTrust: {
              registry: "https://legacy.clawhub.com",
              mode: "tracked-legacy",
            },
          },
        ]);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("updates a legacy Unicode slug when requested explicitly", async () => {
      const slug = "re\u0430ct";
      const { workspaceDir } = await createLegacyTrackedSkillFixture(slug);
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", slug),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          slug,
        });

        expect(results).toMatchObject([
          {
            ok: true,
            slug,
            previousVersion: "0.9.0",
            version: "1.0.0",
            targetDir: path.join(workspaceDir, "skills", slug),
          },
        ]);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("still rejects an untracked Unicode slug passed to update", async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skills-clawhub-"));

      try {
        await expect(
          updateSkillsFromClawHub({
            workspaceDir,
            slug: "re\u0430ct",
          }),
        ).rejects.toThrow("Invalid skill slug");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("blocks updates that add risky wallet permissions without explicit approval", async () => {
      await writeExtractedSkill(
        '{"fased":{"walletActions":{"actions":["swap"],"roles":["agent"],"chains":["solana"],"maxAmount":"1000000"}}}',
      );
      const { workspaceDir } = await createLegacyTrackedSkillFixture("agentreceipt");

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(results).toMatchObject([
          {
            ok: false,
            error: expect.stringContaining("requires permission review"),
          },
        ]);
        expect(installPackageDirMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("allows risky permission-changing updates only with explicit approval", async () => {
      await writeExtractedSkill(
        '{"fased":{"walletActions":{"actions":["swap"],"roles":["agent"],"chains":["solana"],"maxAmount":"1000000"}}}',
      );
      const { workspaceDir } = await createLegacyTrackedSkillFixture("agentreceipt");
      installPackageDirMock.mockResolvedValueOnce({
        ok: true,
        targetDir: path.join(workspaceDir, "skills", "agentreceipt"),
      });

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          slug: "agentreceipt",
          allowPermissionChanges: true,
        });

        expect(results).toMatchObject([
          {
            ok: true,
            permissions: {
              walletActions: {
                actions: ["swap"],
                roles: ["agent"],
                chains: ["solana"],
                maxAmount: "1000000",
              },
              risky: true,
            },
            updateReview: {
              approvalRequired: true,
              reasons: ["requested permissions changed"],
              permissionDiff: {
                added: [
                  "wallet action: swap",
                  "wallet chain: solana",
                  "wallet max amount: 1000000",
                  "wallet role: agent",
                ],
                removed: [],
              },
            },
          },
        ]);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("previews risky permission-changing updates without installing", async () => {
      await writeExtractedSkill(
        '{"fased":{"walletActions":{"actions":["swap"],"roles":["agent"],"chains":["solana"],"maxAmount":"1000000"}}}',
      );
      const { workspaceDir } = await createLegacyTrackedSkillFixture("agentreceipt");

      try {
        const results = await previewSkillsUpdateFromClawHub({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(results).toMatchObject([
          {
            ok: true,
            slug: "agentreceipt",
            previousVersion: "0.9.0",
            version: "1.0.0",
            changed: true,
            sourceTrust: {
              registry: "https://legacy.clawhub.com",
              mode: "tracked-legacy",
            },
            updateReview: {
              approvalRequired: true,
              reasons: ["requested permissions changed"],
              permissionDiff: {
                added: [
                  "wallet action: swap",
                  "wallet chain: solana",
                  "wallet max amount: 1000000",
                  "wallet role: agent",
                ],
                removed: [],
              },
            },
          },
        ]);
        expect(installPackageDirMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("blocks updates that add reviewable archive warnings without explicit approval", async () => {
      const { workspaceDir } = await createLegacyTrackedSkillFixture("agentreceipt");
      await fs.writeFile(path.join(extractedRoot, "helper.sh"), "#!/bin/sh\n", "utf8");

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(results).toMatchObject([
          {
            ok: false,
            error: expect.stringContaining("archive scan added reviewable findings"),
          },
        ]);
        expect(installPackageDirMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("blocks updates that add tool access without explicit approval", async () => {
      await writeExtractedSkill('{"fased":{"permissions":{"tools":["web.fetch"]}}}');
      const { workspaceDir } = await createLegacyTrackedSkillFixture("agentreceipt");

      try {
        const results = await updateSkillsFromClawHub({
          workspaceDir,
          slug: "agentreceipt",
        });

        expect(results).toMatchObject([
          {
            ok: false,
            error: expect.stringContaining("requested permissions changed"),
          },
        ]);
        expect(installPackageDirMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  describe("normalizeSlug rejects non-ASCII homograph slugs", () => {
    it("rejects Cyrillic homograph 'а' (U+0430) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "re\u0430ct",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects Cyrillic homograph 'е' (U+0435) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "r\u0435act",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects Cyrillic homograph 'о' (U+043E) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "t\u043Edo",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug with mixed Unicode and ASCII", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "cаlеndаr",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug with non-Latin scripts", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "技能",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects Unicode that case-folds to ASCII (Kelvin sign U+212A)", async () => {
      // "\u212A" (Kelvin sign) lowercases to "k" — must be caught before lowercasing
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "\u212Aalendar",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug starting with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "-calendar",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug ending with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("accepts uppercase ASCII slugs (preserves original casing behavior)", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "React",
      });
      expect(result).toMatchObject({ ok: true });
    });

    it("accepts valid lowercase ASCII slugs", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-2",
      });
      expect(result).toMatchObject({ ok: true });
    });
  });

  it("uses search for browse-all skill discovery", async () => {
    searchClawHubSkillsMock.mockResolvedValueOnce([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);

    await expect(searchSkillsFromClawHub({ limit: 20 })).resolves.toEqual([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);
    expect(searchClawHubSkillsMock).toHaveBeenCalledWith({
      query: "*",
      limit: 20,
      baseUrl: undefined,
    });
    expect(listClawHubSkillsMock).not.toHaveBeenCalled();
  });
});
