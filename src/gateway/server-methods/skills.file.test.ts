import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({
  config: {} as unknown,
}));

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => configState.config,
    writeConfigFile: async () => undefined,
  };
});

const { skillsHandlers } = await import("./skills.js");

async function callSkillMethod(
  method: "skills.copy" | "skills.create" | "skills.file.get" | "skills.file.set",
  params: Record<string, unknown>,
) {
  let ok: boolean | null = null;
  let result: unknown = null;
  let error: unknown = null;
  await skillsHandlers[method]({
    params,
    req: {} as never,
    client: null as never,
    isWebchatConnect: () => false,
    context: {} as never,
    respond: (success, value, err) => {
      ok = success;
      result = value;
      error = err;
    },
  });
  return { ok, result, error };
}

describe("skills.file", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skill-file-"));
    configState.config = {
      agents: {
        list: [{ id: "main", default: true, workspace: tempDir }],
      },
      skills: {
        entries: {},
        load: {
          extraDirs: [path.join(tempDir, "extra-skills")],
        },
      },
    };
    await fs.mkdir(path.join(tempDir, "skills", "repo"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "skills", "repo", "SKILL.md"),
      [
        "---",
        "name: Repo Skill",
        "description: Skill description",
        "metadata:",
        '  { "fased": { "skillKey": "repo-skill" } }',
        "---",
        "# Repo Skill",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.mkdir(path.join(tempDir, "extra-skills", "readonly"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "extra-skills", "readonly", "SKILL.md"),
      [
        "---",
        "name: Read Only Skill",
        "description: Read-only skill description",
        "metadata:",
        '  { "fased": { "skillKey": "readonly-skill" } }',
        "---",
        "# Read Only Skill",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.mkdir(path.join(tempDir, "extra-skills", "readonly", "references"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tempDir, "extra-skills", "readonly", "references", "notes.md"),
      "Reference notes.\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads and writes editable workspace skill files", async () => {
    const readResult = await callSkillMethod("skills.file.get", { skillKey: "repo-skill" });

    expect(readResult.ok).toBe(true);
    expect(readResult.result).toMatchObject({
      skillKey: "repo-skill",
      name: "Repo Skill",
      source: "fased-workspace",
    });

    const writeResult = await callSkillMethod("skills.file.set", {
      skillKey: "repo-skill",
      content: "# Repo Skill\nUpdated.\n",
    });

    expect(writeResult.ok).toBe(true);
    expect(await fs.readFile(path.join(tempDir, "skills", "repo", "SKILL.md"), "utf8")).toBe(
      "# Repo Skill\nUpdated.\n",
    );
  });

  it("creates a new workspace skill file", async () => {
    const createResult = await callSkillMethod("skills.create", {
      name: "Research Helper",
      description: "Use for source review.",
      agentId: "main",
      template: "research",
    });

    expect(createResult.ok).toBe(true);
    expect(createResult.result).toMatchObject({
      ok: true,
      skillKey: "research-helper",
      name: "Research Helper",
    });
    const created = await fs.readFile(
      path.join(tempDir, "skills", "research-helper", "SKILL.md"),
      "utf8",
    );
    expect(created).toContain('name: "Research Helper"');
    expect(created).toContain('description: "Use for source review."');
    expect(created).toContain('"skillKey": "research-helper"');
    expect(created).toContain("Prefer primary sources");
  });

  it("copies read-only skills into the agent workspace before editing", async () => {
    const directRead = await callSkillMethod("skills.file.get", { skillKey: "readonly-skill" });
    expect(directRead.ok).toBe(false);

    const copyResult = await callSkillMethod("skills.copy", {
      skillKey: "readonly-skill",
      agentId: "main",
    });

    expect(copyResult.ok).toBe(true);
    expect(copyResult.result).toMatchObject({
      ok: true,
      skillKey: "readonly-skill",
      name: "Read Only Skill",
      source: "fased-workspace",
      copiedFiles: 2,
    });
    expect(
      await fs.readFile(
        path.join(tempDir, "skills", "readonly-skill", "references", "notes.md"),
        "utf8",
      ),
    ).toBe("Reference notes.\n");

    const copiedRead = await callSkillMethod("skills.file.get", { skillKey: "readonly-skill" });
    expect(copiedRead.ok).toBe(true);
    expect(copiedRead.result).toMatchObject({
      skillKey: "readonly-skill",
      name: "Read Only Skill",
      source: "fased-workspace",
    });

    const duplicateCopy = await callSkillMethod("skills.copy", { skillKey: "readonly-skill" });
    expect(duplicateCopy.ok).toBe(false);
  });
});
