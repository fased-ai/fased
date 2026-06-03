import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardLinkCommand } from "./dashboard-link.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("dashboardLinkCommand", () => {
  const prevGatewayToken = process.env.FASED_GATEWAY_TOKEN;
  const prevStateDir = process.env.FASED_STATE_DIR;
  const tempDirs: string[] = [];

  beforeEach(() => {
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
    delete process.env.FASED_GATEWAY_TOKEN;
    delete process.env.FASED_STATE_DIR;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: { gateway: { auth: { token: "gateway-token-123" } } },
      issues: [],
      legacyIssues: [],
    });
  });

  it("emits a one-time login URL", async () => {
    await dashboardLinkCommand(runtime, {
      publicUrl: "https://fasedagent7f1b9b93ccfdb.agents.fased.app",
      onboarding: true,
    });
    const firstLog = String(runtime.log.mock.calls[0]?.[0] ?? "");
    expect(
      firstLog.startsWith(
        "Dashboard login URL: https://fasedagent7f1b9b93ccfdb.agents.fased.app/#",
      ),
    ).toBe(true);
    const outUrl = new URL(firstLog.replace("Dashboard login URL: ", ""));
    const hash = new URLSearchParams(outUrl.hash.startsWith("#") ? outUrl.hash.slice(1) : "");
    expect(hash.get("login")).toBeTruthy();
    expect(hash.get("onboarding")).toBe("1");
    expect(String(runtime.log.mock.calls[2]?.[0] ?? "")).toContain("Gateway token source:");
  });

  it("rejects non-https URL", async () => {
    await expect(
      dashboardLinkCommand(runtime, {
        publicUrl: "http://fasedagent7f1b9b93ccfdb.agents.fased.app",
      }),
    ).rejects.toThrow("public URL must use https://");
  });

  it("rejects non-agents host unless allow-custom-host is set", async () => {
    await expect(
      dashboardLinkCommand(runtime, {
        publicUrl: "https://example.com",
      }),
    ).rejects.toThrow("public URL host must be under *.agents.fased.app");

    await expect(
      dashboardLinkCommand(runtime, {
        publicUrl: "https://example.com",
        allowCustomHost: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails fast when gateway token sources disagree", async () => {
    process.env.FASED_GATEWAY_TOKEN = "env-token";
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: { gateway: { auth: { token: "config-token" } } },
      issues: [],
      legacyIssues: [],
    });
    await expect(
      dashboardLinkCommand(runtime, {
        publicUrl: "https://fasedagent7f1b9b93ccfdb.agents.fased.app",
      }),
    ).rejects.toThrow("gateway token mismatch across sources");
  });

  it("uses state file token when env/config are missing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fased-dashboard-link-test-"));
    tempDirs.push(dir);
    process.env.FASED_STATE_DIR = dir;
    writeFileSync(path.join(dir, "gateway-secret"), "state-file-token\n", "utf8");
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: { gateway: { auth: {} } },
      issues: [],
      legacyIssues: [],
    });
    await dashboardLinkCommand(runtime, {
      publicUrl: "https://fasedagent7f1b9b93ccfdb.agents.fased.app",
    });
    expect(String(runtime.log.mock.calls[2]?.[0] ?? "")).toContain(
      "Gateway token source: state-file",
    );
  });

  it("accepts explicit --token override when other sources are empty", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: { gateway: { auth: {} } },
      issues: [],
      legacyIssues: [],
    });
    await dashboardLinkCommand(runtime, {
      publicUrl: "https://fasedagent7f1b9b93ccfdb.agents.fased.app",
      token: "override-token",
    });
    expect(String(runtime.log.mock.calls[2]?.[0] ?? "")).toContain("Gateway token source: option");
  });

  it("uses explicit --token even when env/state/config disagree", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fased-dashboard-link-test-"));
    tempDirs.push(dir);
    process.env.FASED_STATE_DIR = dir;
    process.env.FASED_GATEWAY_TOKEN = "env-token";
    writeFileSync(path.join(dir, "gateway-secret"), "state-file-token\n", "utf8");
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: { gateway: { auth: { token: "config-token" } } },
      issues: [],
      legacyIssues: [],
    });
    await expect(
      dashboardLinkCommand(runtime, {
        publicUrl: "https://fasedagent7f1b9b93ccfdb.agents.fased.app",
        token: "override-token",
      }),
    ).resolves.toBeUndefined();
    expect(String(runtime.log.mock.calls[2]?.[0] ?? "")).toContain("Gateway token source: option");
  });

  afterEach(() => {
    if (prevGatewayToken === undefined) {
      delete process.env.FASED_GATEWAY_TOKEN;
    } else {
      process.env.FASED_GATEWAY_TOKEN = prevGatewayToken;
    }
    if (prevStateDir === undefined) {
      delete process.env.FASED_STATE_DIR;
    } else {
      process.env.FASED_STATE_DIR = prevStateDir;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
