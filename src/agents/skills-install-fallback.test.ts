import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  hasBinaryMock,
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../security/skill-scanner.js", async () => ({
  ...(await vi.importActual<typeof import("../security/skill-scanner.js")>(
    "../security/skill-scanner.js",
  )),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

vi.mock("../shared/config-eval.js", async () => {
  const actual = await vi.importActual<typeof import("../shared/config-eval.js")>(
    "../shared/config-eval.js",
  );
  return {
    ...actual,
    hasBinary: (bin: string) => hasBinaryMock(bin),
  };
});

vi.mock("../infra/brew.js", () => ({
  resolveBrewExecutable: () => undefined,
}));

let installSkill: typeof import("./skills-install.js").installSkill;
let buildWorkspaceSkillStatus: typeof import("./skills-status.js").buildWorkspaceSkillStatus;

async function loadSkillsInstallModulesForTest() {
  ({ installSkill } = await import("./skills-install.js"));
  ({ buildWorkspaceSkillStatus } = await import("./skills-status.js"));
}

async function writeSkillWithInstallers(
  workspaceDir: string,
  name: string,
  installSpecs: Array<Record<string, string>>,
): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: ${JSON.stringify({ fased: { install: installSpecs } })}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

async function writeSkillWithInstaller(
  workspaceDir: string,
  name: string,
  kind: string,
  extra: Record<string, string>,
): Promise<string> {
  return writeSkillWithInstallers(workspaceDir, name, [{ id: "deps", kind, ...extra }]);
}

function mockAvailableBinaries(binaries: string[]) {
  const available = new Set(binaries);
  hasBinaryMock.mockImplementation((bin: string) => available.has(bin));
}

function assertNoAptGetFallbackCalls() {
  const aptCalls = runCommandWithTimeoutMock.mock.calls.filter(
    (call) => Array.isArray(call[0]) && (call[0] as string[]).includes("apt-get"),
  );
  expect(aptCalls).toHaveLength(0);
}

describe("skills-install fallback edge cases", () => {
  let workspaceDir: string;

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-fallback-test-"));
    await writeSkillWithInstaller(workspaceDir, "go-tool-single", "go", {
      module: "example.com/tool@latest",
    });
    await writeSkillWithInstallers(workspaceDir, "go-tool-multi", [
      { id: "brew", kind: "brew", formula: "go" },
      { id: "go", kind: "go", module: "example.com/tool@latest" },
    ]);
    await writeSkillWithInstallers(workspaceDir, "go-tool-bin-missing", [
      {
        id: "deps",
        kind: "go",
        module: "example.com/tool@latest",
        bins: ["missingtool"],
      } as unknown as Record<string, string>,
    ]);
    await writeSkillWithInstallers(workspaceDir, "node-tool-bin-missing", [
      {
        id: "deps",
        kind: "node",
        package: "example-package",
        bins: ["missingnode"],
      } as unknown as Record<string, string>,
    ]);
    await writeSkillWithInstaller(workspaceDir, "py-tool", "uv", {
      package: "example-package",
    });
    await loadSkillsInstallModulesForTest();
  });

  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    hasBinaryMock.mockClear();
    scanDirectoryWithSummaryMock.mockResolvedValue({ critical: 0, warn: 0, findings: [] });
  });

  afterAll(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("reports missing go without apt or sudo fallback", async () => {
    mockAvailableBinaries(["apt-get", "sudo"]);

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-single",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("go not installed");
    expect(result.message).toContain("https://go.dev/doc/install");
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    assertNoAptGetFallbackCalls();
  });

  it("status-selected go installer fails gracefully when go is missing", async () => {
    mockAvailableBinaries(["apt-get", "sudo"]);

    const status = buildWorkspaceSkillStatus(workspaceDir);
    const skill = status.skills.find((entry) => entry.name === "go-tool-multi");
    expect(skill?.install[0]?.id).toBe("go");

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-multi",
      installId: skill?.install[0]?.id ?? "",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("go not installed");
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("uv not installed returns helpful error without brew or curl auto-install", async () => {
    mockAvailableBinaries(["brew", "curl"]);

    const result = await installSkill({
      workspaceDir,
      skillName: "py-tool",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("https://docs.astral.sh/uv/getting-started/installation/");

    // Verify NO brew/curl command was attempted (no manager auto-install).
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("does not report success when a go install leaves the binary outside gateway PATH", async () => {
    mockAvailableBinaries(["go"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      stdout: "installed",
      stderr: "",
      signal: null,
      killed: false,
    });

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-bin-missing",
      installId: "deps",
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Install command completed");
    expect(result.message).toContain("missingtool");
    expect(result.message).toContain("gateway PATH");
  });

  it("does not report success when an npm install leaves the binary outside gateway PATH", async () => {
    mockAvailableBinaries(["npm"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      stdout: "added 1 package",
      stderr: "",
      signal: null,
      killed: false,
    });

    const result = await installSkill({
      workspaceDir,
      skillName: "node-tool-bin-missing",
      installId: "deps",
      timeoutMs: 10_000,
    });

    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["npm", "install", "-g", "--ignore-scripts", "example-package"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Install command completed");
    expect(result.message).toContain("missingnode");
    expect(result.message).toContain("gateway PATH");
  });

  it("uses the gateway user's HOME when reporting npm binaries outside PATH", async () => {
    const envSnapshot = captureEnv(["HOME", "NPM_CONFIG_PREFIX", "npm_config_prefix", "GOBIN"]);
    const profiles = [
      { label: "local", homeName: "alice" },
      { label: "hosting", homeName: "fased" },
      { label: "root", homeName: "root" },
    ];
    try {
      delete process.env.NPM_CONFIG_PREFIX;
      delete process.env.npm_config_prefix;
      delete process.env.GOBIN;
      for (const profile of profiles) {
        runCommandWithTimeoutMock.mockClear();
        mockAvailableBinaries(["npm"]);
        const home = path.join(workspaceDir, "homes", profile.homeName);
        const binDir = path.join(home, ".npm-global", "bin");
        await fs.mkdir(binDir, { recursive: true });
        const binPath = path.join(binDir, "missingnode");
        await fs.writeFile(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        process.env.HOME = home;
        runCommandWithTimeoutMock.mockResolvedValueOnce({
          code: 0,
          stdout: `added for ${profile.label}`,
          stderr: "",
          signal: null,
          killed: false,
        });

        const result = await installSkill({
          workspaceDir,
          skillName: "node-tool-bin-missing",
          installId: "deps",
          timeoutMs: 10_000,
        });

        expect(result.ok, profile.label).toBe(false);
        expect(result.message, profile.label).toContain(binPath);
        expect(result.message, profile.label).toContain("gateway PATH");
      }
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses NPM_CONFIG_PREFIX when reporting npm binaries outside PATH", async () => {
    const envSnapshot = captureEnv(["HOME", "NPM_CONFIG_PREFIX", "npm_config_prefix", "GOBIN"]);
    try {
      mockAvailableBinaries(["npm"]);
      delete process.env.npm_config_prefix;
      delete process.env.GOBIN;
      const prefix = path.join(workspaceDir, "npm-prefixes", "hosted");
      const binDir = path.join(prefix, "bin");
      await fs.mkdir(binDir, { recursive: true });
      const binPath = path.join(binDir, "missingnode");
      await fs.writeFile(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.HOME = path.join(workspaceDir, "homes", "service");
      process.env.NPM_CONFIG_PREFIX = prefix;
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "added 1 package",
        stderr: "",
        signal: null,
        killed: false,
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "node-tool-bin-missing",
        installId: "deps",
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain(binPath);
      expect(result.message).toContain("gateway PATH");
    } finally {
      envSnapshot.restore();
    }
  });

  it("runs go installers as the gateway user without forcing a Homebrew GOBIN", async () => {
    mockAvailableBinaries(["brew", "go"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      stdout: "installed",
      stderr: "",
      signal: null,
      killed: false,
    });

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-single",
      installId: "deps",
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["go", "install", "example.com/tool@latest"],
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
    const firstCall = runCommandWithTimeoutMock.mock.calls[0] as
      | [string[], { timeoutMs?: number; env?: Record<string, string | undefined> }]
      | undefined;
    expect(firstCall?.[1]?.env).toBeUndefined();
  });

  it("preserves system uv/python env vars when running uv installs", async () => {
    mockAvailableBinaries(["uv"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });

    const envSnapshot = captureEnv([
      "UV_PYTHON",
      "UV_INDEX_URL",
      "PIP_INDEX_URL",
      "PYTHONPATH",
      "VIRTUAL_ENV",
    ]);
    try {
      process.env.UV_PYTHON = "/tmp/attacker-python";
      process.env.UV_INDEX_URL = "https://example.invalid/simple";
      process.env.PIP_INDEX_URL = "https://example.invalid/pip";
      process.env.PYTHONPATH = "/tmp/attacker-pythonpath";
      process.env.VIRTUAL_ENV = "/tmp/attacker-venv";

      const result = await installSkill({
        workspaceDir,
        skillName: "py-tool",
        installId: "deps",
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["uv", "tool", "install", "example-package"],
        expect.objectContaining({
          timeoutMs: 10_000,
        }),
      );
      const firstCall = runCommandWithTimeoutMock.mock.calls[0] as
        | [string[], { timeoutMs?: number; env?: Record<string, string | undefined> }]
        | undefined;
      const envArg = firstCall?.[1]?.env;
      expect(envArg).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
