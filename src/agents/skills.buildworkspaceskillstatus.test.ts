import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function makeEntry(params: {
  name: string;
  source?: string;
  os?: string[];
  requires?: { bins?: string[]; env?: string[]; config?: string[] };
  install?: Array<{
    id: string;
    kind: "brew" | "node" | "go" | "uv" | "download";
    bins?: string[];
    formula?: string;
    package?: string;
    module?: string;
    os?: string[];
    url?: string;
    label?: string;
    integrity?: string;
    sha256?: string;
    shasum?: string;
  }>;
}): SkillEntry {
  const filePath = `/tmp/${params.name}/SKILL.md`;
  const baseDir = `/tmp/${params.name}`;
  return {
    skill: createFixtureSkill({
      name: params.name,
      description: `desc:${params.name}`,
      filePath,
      baseDir,
      source: params.source ?? "fased-workspace",
    }),
    frontmatter: {},
    metadata: {
      ...(params.os ? { os: params.os } : {}),
      ...(params.requires ? { requires: params.requires } : {}),
      ...(params.install ? { install: params.install } : {}),
      ...(params.requires?.env?.[0] ? { primaryEnv: params.requires.env[0] } : {}),
    },
  };
}

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}

describe("buildWorkspaceSkillStatus", () => {
  it("reports missing requirements and install options", async () => {
    const entry = makeEntry({
      name: "status-skill",
      requires: {
        bins: ["fakebin"],
        env: ["ENV_KEY"],
        config: ["browser.enabled"],
      },
      install: [
        {
          id: "brew",
          kind: "brew",
          formula: "fakebin",
          bins: ["fakebin"],
          label: "Install fakebin",
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
        config: { browser: { enabled: false } },
      }),
    );
    const skill = report.skills.find((entry) => entry.name === "status-skill");

    expect(skill).toBeDefined();
    expect(skill?.eligible).toBe(false);
    expect(skill?.missing.bins).toContain("fakebin");
    expect(skill?.missing.env).toContain("ENV_KEY");
    expect(skill?.missing.config).toContain("browser.enabled");
    expect(skill?.install[0]?.id).toBe("brew");
  });
  it("respects OS-gated skills", async () => {
    const entry = makeEntry({
      name: "os-skill",
      os: ["darwin"],
    });

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills.find((entry) => entry.name === "os-skill");

    expect(skill).toBeDefined();
    if (process.platform === "darwin") {
      expect(skill?.eligible).toBe(true);
      expect(skill?.missing.os).toEqual([]);
    } else {
      expect(skill?.eligible).toBe(false);
      expect(skill?.missing.os).toEqual(["darwin"]);
    }
  });
  it("marks bundled skills blocked by allowlist", async () => {
    const entry = makeEntry({
      name: "peekaboo",
      source: "fased-bundled",
    });

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      config: { skills: { allowBundled: ["other-skill"] } },
    });
    const skill = report.skills.find((reportEntry) => reportEntry.name === "peekaboo");

    expect(skill).toBeDefined();
    expect(skill?.blockedByAllowlist).toBe(true);
    expect(skill?.eligible).toBe(false);
    expect(skill?.bundled).toBe(true);
  });

  it("does not mark an overridden workspace skill as bundled by bundled name alone", async () => {
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-bundled-"));
    tempDirs.push(bundledDir);
    await writeSkill({
      dir: path.join(bundledDir, "peekaboo"),
      name: "peekaboo",
      description: "Bundled peekaboo",
    });

    await withEnvAsync({ FASED_BUNDLED_SKILLS_DIR: bundledDir }, async () => {
      const report = buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [
          makeEntry({
            name: "peekaboo",
            source: "fased-workspace",
          }),
        ],
        config: { skills: { allowBundled: ["other-skill"] } },
      });
      const skill = report.skills.find((reportEntry) => reportEntry.name === "peekaboo");

      expect(skill).toBeDefined();
      expect(skill?.source).toBe("fased-workspace");
      expect(skill?.bundled).toBe(false);
      expect(skill?.blockedByAllowlist).toBe(false);
      expect(skill?.eligible).toBe(true);
    });
  });

  it("filters install options by OS", async () => {
    const entry = makeEntry({
      name: "install-skill",
      requires: {
        bins: ["missing-bin"],
      },
      install: [
        {
          id: "mac",
          kind: "download",
          os: ["darwin"],
          url: "https://example.com/mac.tar.bz2",
        },
        {
          id: "linux",
          kind: "download",
          os: ["linux"],
          url: "https://example.com/linux.tar.bz2",
        },
        {
          id: "win",
          kind: "download",
          os: ["win32"],
          url: "https://example.com/win.tar.bz2",
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
      }),
    );
    const skill = report.skills.find((reportEntry) => reportEntry.name === "install-skill");

    expect(skill).toBeDefined();
    if (process.platform === "darwin") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["mac"]);
    } else if (process.platform === "linux") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["linux"]);
    } else if (process.platform === "win32") {
      expect(skill?.install.map((opt) => opt.id)).toEqual(["win"]);
    } else {
      expect(skill?.install).toEqual([]);
    }
  });

  it("reports dependency install pinning and integrity trust metadata", async () => {
    const entry = makeEntry({
      name: "node-install-skill",
      requires: {
        bins: ["mcporter"],
      },
      install: [
        {
          id: "node",
          kind: "node",
          package: "mcporter",
          bins: ["mcporter"],
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
      }),
    );
    const install = report.skills.find((reportEntry) => reportEntry.name === "node-install-skill")
      ?.install[0];

    expect(install).toMatchObject({
      id: "node",
      kind: "node",
      external: true,
      pinned: false,
      integrityPinned: false,
    });
    expect(install?.trustWarnings).toContain(
      "package version is not pinned to an exact immutable version",
    );
    expect(install?.trustWarnings).toContain(
      "source integrity is not pinned with integrity, sha256, or shasum metadata",
    );
    expect(install?.plan).toMatchObject({
      manager: "npm",
      packageRef: "mcporter",
      commandPreview: "npm install -g --ignore-scripts mcporter",
      toolchainAvailable: false,
    });
    expect(install?.plan.bins[0]).toMatchObject({
      bin: "mcporter",
      available: false,
    });
    expect(install?.plan.pathTargets.some((target) => target.endsWith("/mcporter"))).toBe(true);
  });

  it("recognizes exact dependency pins with integrity metadata", async () => {
    const entry = makeEntry({
      name: "pinned-install-skill",
      requires: {
        bins: ["safe-tool"],
      },
      install: [
        {
          id: "node",
          kind: "node",
          package: "@fased/safe-tool@1.2.3",
          bins: ["safe-tool"],
          integrity: "sha512-test",
        },
      ],
    });

    const report = withEnv({ PATH: "" }, () =>
      buildWorkspaceSkillStatus("/tmp/ws", {
        entries: [entry],
      }),
    );
    const install = report.skills.find((reportEntry) => reportEntry.name === "pinned-install-skill")
      ?.install[0];

    expect(install).toMatchObject({
      pinned: true,
      integrityPinned: true,
    });
    expect(install?.trustWarnings).not.toContain(
      "package version is not pinned to an exact immutable version",
    );
    expect(install?.trustWarnings).not.toContain(
      "source integrity is not pinned with integrity, sha256, or shasum metadata",
    );
  });
});
