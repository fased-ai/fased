import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkUpdateStatus: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runDaemonRestart: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../infra/update-check.js", () => ({
  checkUpdateStatus: mocks.checkUpdateStatus,
}));
vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));
vi.mock("../daemon-cli.js", () => ({ runDaemonRestart: mocks.runDaemonRestart }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.runtime }));
vi.mock("./shared.js", () => ({
  parseTimeoutMsOrExit: () => undefined,
  resolveUpdateRoot: async () => "/repo",
}));

beforeEach(() => {
  vi.unstubAllEnvs();
  mocks.checkUpdateStatus.mockReset();
  mocks.runCommandWithTimeout.mockReset();
  mocks.runDaemonRestart.mockReset();
  mocks.runtime.log.mockClear();
  mocks.runtime.error.mockClear();
  mocks.runtime.exit.mockClear();
});

describe("developer source-update boundary", () => {
  it("refuses every managed runtime before inspecting the checkout", async () => {
    vi.stubEnv("FASED_RUNTIME_SOURCE", "go-lifecycle");
    const { runDeveloperSourceUpdate } = await import("./source-update-command.js");

    await runDeveloperSourceUpdate({});

    expect(mocks.checkUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("refuses package installs instead of entering a package-manager updater", async () => {
    mocks.checkUpdateStatus.mockResolvedValue({ installKind: "package" });
    const { runDeveloperSourceUpdate } = await import("./source-update-command.js");

    await runDeveloperSourceUpdate({});

    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Git source checkout"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps dry-run confined to a Git source checkout", async () => {
    mocks.checkUpdateStatus.mockResolvedValue({ installKind: "git" });
    const { runDeveloperSourceUpdate } = await import("./source-update-command.js");

    await runDeveloperSourceUpdate({ channel: "dev", dryRun: true });

    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("Developer source update dry-run"),
    );
  });

  it("reports Already current without running pnpm", async () => {
    mocks.checkUpdateStatus.mockResolvedValue({ installKind: "git" });
    for (const stdout of ["main\n", "", "a".repeat(40), "", "a".repeat(40)]) {
      mocks.runCommandWithTimeout.mockResolvedValueOnce({ code: 0, stdout, stderr: "" });
    }
    const { runDeveloperSourceUpdate } = await import("./source-update-command.js");

    await runDeveloperSourceUpdate({ channel: "dev" });

    expect(mocks.runtime.log).toHaveBeenCalledWith(expect.stringContaining("Already current"));
    expect(mocks.runCommandWithTimeout.mock.calls.some(([argv]) => argv[0] === "pnpm")).toBe(false);
  });
});
