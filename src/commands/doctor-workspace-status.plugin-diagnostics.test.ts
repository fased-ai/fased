import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";

const loadFasedAgentPlugins = vi.hoisted(() => vi.fn());
const note = vi.hoisted(() => vi.fn());

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/fased-workspace"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: vi.fn(() => ({ skills: [] })),
}));

vi.mock("../plugins/loader.js", () => ({
  loadFasedAgentPlugins,
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("./doctor-workspace.js", () => ({
  detectLegacyWorkspaceDirs: vi.fn(() => ({ legacyDirs: [] })),
  formatLegacyWorkspaceWarning: vi.fn(() => ""),
}));

const { noteWorkspaceStatus } = await import("./doctor-workspace-status.js");

describe("doctor workspace plugin diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadFasedAgentPlugins.mockReturnValue({
      plugins: [],
      diagnostics: [
        {
          level: "warn",
          pluginId: "market-feed",
          source: "npm",
          message: "source integrity is not pinned",
        },
        {
          level: "error",
          pluginId: "wallet-risk",
          source: "path",
          message: "scanner warning: package declares postinstall",
        },
      ],
    });
  });

  it("keeps plugin source-trust and scanner diagnostics visible in doctor output", () => {
    noteWorkspaceStatus({} as FasedAgentConfig);

    expect(note).toHaveBeenCalledWith(expect.any(String), "Skills status");
    expect(note).toHaveBeenCalledWith(
      [
        "- WARN market-feed: source integrity is not pinned (npm)",
        "- ERROR wallet-risk: scanner warning: package declares postinstall (path)",
      ].join("\n"),
      "Plugin diagnostics",
    );
  });
});
