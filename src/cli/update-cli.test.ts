import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig, ConfigFileSnapshot } from "../config/types.fased.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { withEnvAsync } from "../test-utils/env.js";

const confirm = vi.fn();
const select = vi.fn();
const spinner = vi.fn(() => ({ start: vi.fn(), stop: vi.fn() }));
const isCancel = (value: unknown) => value === "cancel";

const readPackageName = vi.fn();
const readPackageVersion = vi.fn();
const resolveGlobalManager = vi.fn();
const serviceLoaded = vi.fn();
const prepareRestartScript = vi.fn();
const runRestartScript = vi.fn();
const mockedRunDaemonInstall = vi.fn();
const serviceReadRuntime = vi.fn();
const serviceRestart = vi.fn();
const resolveUpdateGatewayServiceTarget = vi.fn();
const inspectPortUsage = vi.fn();
const classifyPortListener = vi.fn();
const formatPortDiagnostics = vi.fn();
const syncPluginsForUpdateChannel = vi.fn();
const updatePinnedNpmPlugins = vi.fn();
const checkShellCompletionStatus = vi.fn();
const ensureCompletionCacheExists = vi.fn();
const installCompletion = vi.fn();
const probeGatewayStatus = vi.fn();
const finalizeUpdateTransaction = vi.fn();
const rollbackUpdateTransaction = vi.fn();
const probeGateway = vi.fn();
const probeRunningGatewayRuntimeIdentity = vi.fn();
const ensureOpenAICodexRuntimeComponent = vi.fn();
const hasConfiguredOpenAICodexProfile = vi.fn();
const ensureManagedRuntimeBootstrap = vi.fn();
const isLocalSourceSignerConfigured = vi.fn(async () => false);
const readLocalSourcePairedUpdateJournal = vi.fn(async () => null);
const recoverLocalSourcePairedUpdate = vi.fn(async () => "none");
const prepareLocalSourcePairedUpdate = vi.fn();
const markLocalSourceAppActive = vi.fn(async ({ journal }) => journal);
const activateLocalSourceSigner = vi.fn(async ({ journal }) => journal);
const verifyLocalSourceSigner = vi.fn(async () => undefined);
const markLocalSourceGatewayVerified = vi.fn(async (journal) => journal);
const commitLocalSourcePairedUpdate = vi.fn(async () => undefined);
const rollbackLocalSourcePairedUpdate = vi.fn(async () => undefined);

vi.mock("@clack/prompts", () => ({
  confirm,
  select,
  isCancel,
  spinner,
}));

vi.mock("../agents/openai-codex-runtime-component.js", () => ({
  ensureOpenAICodexRuntimeComponent,
  hasConfiguredOpenAICodexProfile,
  OPENAI_RUNTIME_COMPONENT_ID: "openai-runtime",
}));

// Mock the update-runner module
vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(),
  finalizeUpdateTransaction,
  rollbackUpdateTransaction,
}));

vi.mock("../infra/fased-root.js", () => ({
  resolveFasedAgentPackageRoot: vi.fn(),
}));

vi.mock("../infra/managed-runtime-bootstrap.js", () => ({
  ensureManagedRuntimeBootstrap,
}));

vi.mock("../infra/local-source-paired-update.js", () => ({
  isLocalSourceSignerConfigured,
  readLocalSourcePairedUpdateJournal,
  recoverLocalSourcePairedUpdate,
  prepareLocalSourcePairedUpdate,
  markLocalSourceAppActive,
  activateLocalSourceSigner,
  verifyLocalSourceSigner,
  markLocalSourceGatewayVerified,
  commitLocalSourcePairedUpdate,
  rollbackLocalSourcePairedUpdate,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(() => 18789),
  writeConfigFile: vi.fn(),
}));

vi.mock("../infra/update-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/update-check.js")>();
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    fetchNpmTagVersion: vi.fn(),
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    })),
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../plugins/update.js", () => ({
  syncPluginsForUpdateChannel,
  updatePinnedNpmPlugins,
}));

vi.mock("../commands/doctor-completion.js", () => ({
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
}));

vi.mock("./completion-cli.js", () => ({
  installCompletion,
}));

vi.mock("./update-cli/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./update-cli/shared.js")>();
  return {
    ...actual,
    readPackageName,
    readPackageVersion,
    resolveGlobalManager,
  };
});

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    isLoaded: (...args: unknown[]) => serviceLoaded(...args),
    readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
  })),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (...args: unknown[]) => inspectPortUsage(...args),
  classifyPortListener: (...args: unknown[]) => classifyPortListener(...args),
  formatPortDiagnostics: (...args: unknown[]) => formatPortDiagnostics(...args),
}));

vi.mock("./update-cli/restart-helper.js", () => ({
  prepareRestartScript: (...args: unknown[]) => prepareRestartScript(...args),
  runRestartScript: (...args: unknown[]) => runRestartScript(...args),
}));

vi.mock("./update-cli/service-target.js", () => ({
  resolveUpdateGatewayServiceTarget,
}));

vi.mock("./daemon-cli/probe.js", () => ({
  probeGatewayStatus,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway,
}));

vi.mock("./lightweight/gateway-runtime-probe.js", () => ({
  probeRunningGatewayRuntimeIdentity,
}));

// Mock doctor (heavy module; should not run in unit tests)
vi.mock("../commands/doctor.js", () => ({
  doctorCommand: vi.fn(),
}));
// Mock the daemon-cli module
vi.mock("./daemon-cli.js", () => ({
  runDaemonInstall: mockedRunDaemonInstall,
  runDaemonRestart: vi.fn(),
}));

// Mock the runtime
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const { runGatewayUpdate } = await import("../infra/update-runner.js");
const { resolveFasedAgentPackageRoot } = await import("../infra/fased-root.js");
const { readConfigFileSnapshot, writeConfigFile } = await import("../config/config.js");
const { checkUpdateStatus, fetchNpmTagVersion, resolveNpmChannelTag } =
  await import("../infra/update-check.js");
const { runCommandWithTimeout } = await import("../process/exec.js");
const { runDaemonRestart, runDaemonInstall } = await import("./daemon-cli.js");
const { doctorCommand } = await import("../commands/doctor.js");
const { defaultRuntime } = await import("../runtime.js");
const { updateCommand, registerUpdateCli, updateStatusCommand, updateWizardCommand } =
  await import("./update-cli.js");

describe("update-cli", () => {
  const fixtureRoot = "/tmp/fased-update-tests";
  let fixtureCount = 0;

  const createCaseDir = (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    // Tests only need a stable path; the directory does not have to exist because all I/O is mocked.
    return dir;
  };

  const baseConfig = {} as FasedAgentConfig;
  const baseSnapshot: ConfigFileSnapshot = {
    path: "/tmp/fased-config.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: baseConfig,
    valid: true,
    config: baseConfig,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };

  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdin, "isTTY", {
      value,
      configurable: true,
    });
  };

  const setStdoutTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
    });
  };

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(resolveFasedAgentPackageRoot).mockResolvedValue(root);
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
      deps: {
        manager: "npm",
        status: "ok",
        lockfilePath: null,
        markerPath: null,
      },
    });
  };

  const expectUpdateCallChannel = (channel: string) => {
    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe(channel);
    return call;
  };

  const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult =>
    ({
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
      ...overrides,
    }) as UpdateRunResult;

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    if (params.daemonInstall === "fail") {
      vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("refresh failed"));
    } else {
      vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    }
    prepareRestartScript.mockResolvedValue(null);
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(runDaemonRestart).toHaveBeenCalled();
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = createCaseDir("fased-update");
    setTty(false);
    readPackageVersion.mockResolvedValue("2.0.0");

    mockPackageInstallStatus(tempDir);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.0.1",
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "npm",
      steps: [],
      durationMs: 100,
    });
    probeGateway.mockResolvedValue({
      ok: true,
      error: null,
      server: { version: "0.0.1", runtimeSource: "managed-package" },
    });
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    return tempDir;
  };

  beforeEach(() => {
    confirm.mockClear();
    select.mockClear();
    vi.mocked(runGatewayUpdate).mockClear();
    vi.mocked(resolveFasedAgentPackageRoot).mockClear();
    vi.mocked(readConfigFileSnapshot).mockClear();
    vi.mocked(writeConfigFile).mockClear();
    vi.mocked(checkUpdateStatus).mockClear();
    vi.mocked(fetchNpmTagVersion).mockClear();
    vi.mocked(resolveNpmChannelTag).mockClear();
    vi.mocked(runCommandWithTimeout).mockClear();
    vi.mocked(runDaemonRestart).mockClear();
    vi.mocked(mockedRunDaemonInstall).mockClear();
    vi.mocked(doctorCommand).mockClear();
    vi.mocked(defaultRuntime.log).mockClear();
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();
    readPackageName.mockClear();
    readPackageVersion.mockClear();
    resolveGlobalManager.mockClear();
    serviceLoaded.mockClear();
    serviceReadRuntime.mockClear();
    serviceRestart.mockClear();
    resolveUpdateGatewayServiceTarget.mockReset();
    prepareRestartScript.mockClear();
    runRestartScript.mockClear();
    inspectPortUsage.mockClear();
    classifyPortListener.mockClear();
    formatPortDiagnostics.mockClear();
    syncPluginsForUpdateChannel.mockClear();
    updatePinnedNpmPlugins.mockClear();
    checkShellCompletionStatus.mockReset();
    ensureCompletionCacheExists.mockReset();
    installCompletion.mockReset();
    probeGatewayStatus.mockReset();
    probeGateway.mockReset();
    probeRunningGatewayRuntimeIdentity.mockReset();
    ensureOpenAICodexRuntimeComponent.mockReset();
    hasConfiguredOpenAICodexProfile.mockReset();
    ensureManagedRuntimeBootstrap.mockReset();
    isLocalSourceSignerConfigured.mockReset();
    readLocalSourcePairedUpdateJournal.mockReset();
    recoverLocalSourcePairedUpdate.mockReset();
    prepareLocalSourcePairedUpdate.mockReset();
    markLocalSourceAppActive.mockReset();
    activateLocalSourceSigner.mockReset();
    verifyLocalSourceSigner.mockReset();
    markLocalSourceGatewayVerified.mockReset();
    commitLocalSourcePairedUpdate.mockReset();
    rollbackLocalSourcePairedUpdate.mockReset();
    isLocalSourceSignerConfigured.mockResolvedValue(false);
    readLocalSourcePairedUpdateJournal.mockResolvedValue(null);
    recoverLocalSourcePairedUpdate.mockResolvedValue("none");
    markLocalSourceAppActive.mockImplementation(async ({ journal }) => journal);
    activateLocalSourceSigner.mockImplementation(async ({ journal }) => journal);
    verifyLocalSourceSigner.mockResolvedValue(undefined);
    markLocalSourceGatewayVerified.mockImplementation(async (journal) => journal);
    commitLocalSourcePairedUpdate.mockResolvedValue(undefined);
    rollbackLocalSourcePairedUpdate.mockResolvedValue(undefined);
    hasConfiguredOpenAICodexProfile.mockReturnValue(false);
    ensureManagedRuntimeBootstrap.mockResolvedValue({
      installed: false,
      manifestPath: null,
      updaterPath: null,
    });
    vi.mocked(resolveFasedAgentPackageRoot).mockResolvedValue(process.cwd());
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(baseSnapshot);
    vi.mocked(fetchNpmTagVersion).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "9999.0.0",
    });
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/test/path",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/test/path",
        sha: "abcdef1234567890",
        tag: "v1.2.3",
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "/test/path/pnpm-lock.yaml",
        markerPath: "/test/path/node_modules",
      },
      registry: {
        latestVersion: "1.2.3",
      },
    });
    vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    readPackageName.mockResolvedValue("fased");
    readPackageVersion.mockResolvedValue("1.0.0");
    resolveGlobalManager.mockResolvedValue("npm");
    serviceLoaded.mockResolvedValue(false);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: 4242,
      state: "running",
    });
    serviceRestart.mockResolvedValue(undefined);
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "platform",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });
    prepareRestartScript.mockResolvedValue("/tmp/fased-restart-test.sh");
    runRestartScript.mockResolvedValue(undefined);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4242, command: "fased-gateway" }],
      hints: [],
    });
    classifyPortListener.mockReturnValue("gateway");
    formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runDaemonRestart).mockResolvedValue(true);
    vi.mocked(doctorCommand).mockResolvedValue(undefined);
    syncPluginsForUpdateChannel.mockImplementation(async ({ config }) => ({
      config,
      changed: false,
      summary: {
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
    }));
    updatePinnedNpmPlugins.mockImplementation(async ({ config }) => ({
      config,
      changed: false,
      outcomes: [],
    }));
    checkShellCompletionStatus.mockResolvedValue({
      shell: "bash",
      profileInstalled: true,
      cacheExists: true,
      cachePath: "/tmp/fased-completion-cache",
      usesSlowPattern: false,
    });
    ensureCompletionCacheExists.mockResolvedValue(true);
    probeGatewayStatus.mockResolvedValue({ ok: true });
    probeGateway.mockResolvedValue({
      ok: true,
      error: null,
      server: { version: "9999.0.0", runtimeSource: "managed-package" },
    });
    probeRunningGatewayRuntimeIdentity.mockResolvedValue({
      reachable: false,
      version: null,
      runtimeSource: null,
    });
    confirm.mockResolvedValue(false);
    select.mockResolvedValue("stable");
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    setTty(false);
    setStdoutTty(false);
  });

  it("exports updateCommand and registerUpdateCli", async () => {
    expect(typeof updateCommand).toBe("function");
    expect(typeof registerUpdateCli).toBe("function");
    expect(typeof updateWizardCommand).toBe("function");
  }, 20_000);

  it("updateCommand runs update and outputs result", async () => {
    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      root: "/test/path",
      before: { sha: "abc123", version: "1.0.0" },
      after: { sha: "def456", version: "1.0.1" },
      steps: [
        {
          name: "git fetch",
          command: "git fetch",
          cwd: "/test/path",
          durationMs: 100,
          exitCode: 0,
        },
      ],
      durationMs: 500,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);

    await updateCommand({ json: false });

    expect(runGatewayUpdate).toHaveBeenCalled();
    expect(defaultRuntime.log).toHaveBeenCalled();
  });

  it("fails closed before preparing a protected source-checkout mutation", async () => {
    isLocalSourceSignerConfigured.mockResolvedValue(true);

    await updateCommand({});

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Protected source-checkout updates are disabled"),
    );
    expect(prepareLocalSourcePairedUpdate).not.toHaveBeenCalled();
    expect(activateLocalSourceSigner).not.toHaveBeenCalled();
    expect(rollbackLocalSourcePairedUpdate).not.toHaveBeenCalled();
    expect(commitLocalSourcePairedUpdate).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps core update separate from plugin updates and reports core timing", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({ restart: false, verbose: true });

    expect(syncPluginsForUpdateChannel).not.toHaveBeenCalled();
    expect(updatePinnedNpmPlugins).not.toHaveBeenCalled();
    const logs = vi
      .mocked(defaultRuntime.log)
      .mock.calls.map(([value]) => String(value))
      .join("\n");
    expect(logs).toContain("Post-update timing");
    expect(logs).toContain("transaction cleanup");
  });

  it("reconciles the OpenAI sign-in runtime to the completed core version", async () => {
    const config = {
      auth: {
        profiles: {
          "openai-codex:test": { provider: "openai-codex", mode: "oauth" },
        },
      },
    } as FasedAgentConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      parsed: config,
      resolved: config,
      config,
    });
    hasConfiguredOpenAICodexProfile.mockReturnValue(true);
    ensureOpenAICodexRuntimeComponent.mockResolvedValue({
      config,
      executable: "/managed/openai-runtime/codex",
      installed: false,
      slotWarnings: [],
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({ after: { version: "0.1.57" } }),
    );

    await updateCommand({ restart: false });

    expect(ensureOpenAICodexRuntimeComponent).toHaveBeenCalledWith({
      config,
      version: "0.1.57",
    });
  });

  it("returns immediately when a packaged install already matches the target version", async () => {
    const root = createCaseDir("fased-current-package");
    mockPackageInstallStatus(root);
    readPackageVersion.mockResolvedValue("0.1.40");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.1.40",
    });

    await updateCommand({});

    expect(defaultRuntime.log).toHaveBeenCalledWith("Already current: 0.1.40");
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(resolveUpdateGatewayServiceTarget).not.toHaveBeenCalled();
    expect(syncPluginsForUpdateChannel).not.toHaveBeenCalled();
    expect(updatePinnedNpmPlugins).not.toHaveBeenCalled();
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
    expect(serviceRestart).not.toHaveBeenCalled();
  });

  it("hands a Go-managed packaged update to its immutable updater", async () => {
    const root = createCaseDir("fased-managed-transition");
    mockPackageInstallStatus(root);
    ensureManagedRuntimeBootstrap.mockResolvedValue({
      installed: false,
      manifestPath: null,
      updaterPath: "/opt/fased/local/id/current/payload/runtime/scripts/fased-managed-updater.mjs",
    });

    await updateCommand({ channel: "stable", timeout: "45", yes: true });

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        process.execPath,
        "/opt/fased/local/id/current/payload/runtime/scripts/fased-managed-updater.mjs",
        "--channel",
        "stable",
      ],
      expect.objectContaining({
        cwd: "/opt/fased/local/id/current/payload/runtime/scripts",
        timeoutMs: 45_000,
      }),
    );
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(resolveNpmChannelTag).not.toHaveBeenCalled();
  });

  it("keeps a Go-managed runtime on its immutable updater even when cwd is a git checkout", async () => {
    createCaseDir("fased-managed-from-git-cwd");
    ensureManagedRuntimeBootstrap.mockResolvedValue({
      installed: false,
      manifestPath: null,
      updaterPath: "/opt/fased/local/id/current/payload/runtime/scripts/fased-managed-updater.mjs",
    });

    await withEnvAsync(
      {
        FASED_RUNTIME_SOURCE: "go-lifecycle",
        FASED_MANAGED_RUNTIME_ROOT: "/opt/fased/local/id/current/payload/runtime",
      },
      () => updateCommand({ timeout: "45" }),
    );

    expect(ensureManagedRuntimeBootstrap).toHaveBeenCalledWith({
      packageRoot: "/opt/fased/local/id/current/payload/runtime",
      env: expect.any(Object),
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        process.execPath,
        "/opt/fased/local/id/current/payload/runtime/scripts/fased-managed-updater.mjs",
        "--channel",
        "stable",
      ],
      expect.objectContaining({
        cwd: "/opt/fased/local/id/current/payload/runtime/scripts",
        timeoutMs: 45_000,
      }),
    );
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("repairs a missing version-matched provider runtime on a same-version update", async () => {
    const root = createCaseDir("fased-current-provider-runtime");
    mockPackageInstallStatus(root);
    readPackageVersion.mockResolvedValue("0.1.40");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.1.40",
    });
    const config = {
      auth: {
        profiles: {
          "openai-codex:test": { provider: "openai-codex", mode: "oauth" },
        },
      },
    } as FasedAgentConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      parsed: config,
      resolved: config,
      config,
    });
    hasConfiguredOpenAICodexProfile.mockReturnValue(true);
    ensureOpenAICodexRuntimeComponent.mockResolvedValue({
      config: {
        ...config,
        plugins: { entries: { "openai-runtime": { enabled: true } } },
      },
      executable: "/managed/openai-runtime/codex",
      installed: true,
      slotWarnings: [],
    });

    await updateCommand({});

    expect(ensureOpenAICodexRuntimeComponent).toHaveBeenCalledWith({
      config,
      version: "0.1.40",
    });
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: { entries: { "openai-runtime": { enabled: true } } },
      }),
    );
    expect(defaultRuntime.log).toHaveBeenCalledWith("Already current: 0.1.40");
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("reports an already-current packaged install as JSON without mutations", async () => {
    const root = createCaseDir("fased-current-package-json");
    mockPackageInstallStatus(root);
    readPackageVersion.mockResolvedValue("0.1.40");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.1.40",
    });

    await updateCommand({ json: true });

    const currentResult = vi
      .mocked(defaultRuntime.log)
      .mock.calls.map(([value]) => String(value))
      .map((value) => {
        try {
          return JSON.parse(value) as { status?: string; currentVersion?: string };
        } catch {
          return null;
        }
      })
      .find((value) => value?.status === "current");
    expect(currentResult).toMatchObject({ status: "current", currentVersion: "0.1.40" });
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(resolveUpdateGatewayServiceTarget).not.toHaveBeenCalled();
  });

  it("repairs a stale running gateway even when installed files are already current", async () => {
    const root = createCaseDir("fased-current-stale-gateway");
    mockPackageInstallStatus(root);
    readPackageVersion.mockResolvedValue("0.1.40");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.1.40",
    });
    probeRunningGatewayRuntimeIdentity.mockResolvedValue({
      reachable: true,
      version: "0.1.39",
      runtimeSource: "managed-package",
    });
    probeGateway.mockResolvedValue({
      ok: true,
      error: null,
      server: { version: "0.1.40", runtimeSource: "managed-package" },
    });
    serviceLoaded.mockResolvedValue(true);
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "system",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });

    await updateCommand({});

    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(serviceRestart).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalled();
    expect(defaultRuntime.log).toHaveBeenCalledWith("Gateway runtime refreshed: 0.1.40");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("repairs a source-checkout gateway even when its reported version matches", async () => {
    const root = createCaseDir("fased-current-source-gateway");
    mockPackageInstallStatus(root);
    readPackageVersion.mockResolvedValue("0.1.40");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.1.40",
    });
    probeRunningGatewayRuntimeIdentity.mockResolvedValue({
      reachable: true,
      version: "0.1.40",
      runtimeSource: "source-checkout",
    });
    probeGateway.mockResolvedValue({
      ok: true,
      error: null,
      server: { version: "0.1.40", runtimeSource: "managed-package" },
    });
    serviceLoaded.mockResolvedValue(true);
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "system",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({ force: true, json: undefined });
    expect(serviceRestart).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.log).toHaveBeenCalledWith("Gateway runtime refreshed: 0.1.40");
    expect(defaultRuntime.log).not.toHaveBeenCalledWith("Already current: 0.1.40");
  });

  it("does not restart a same-version stale gateway when service refresh fails", async () => {
    const root = createCaseDir("fased-current-stale-service-refresh-failed");
    mockPackageInstallStatus(root);
    readPackageVersion.mockResolvedValue("0.1.40");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.1.40",
    });
    probeRunningGatewayRuntimeIdentity.mockResolvedValue({
      reachable: true,
      version: "0.1.23",
      runtimeSource: "source-checkout",
    });
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("service refresh failed"));
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "system",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({ force: true, json: undefined });
    expect(serviceRestart).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service refresh failed"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not report success when a managed gateway remains on the stale version", async () => {
    const root = createCaseDir("fased-current-unrepaired-gateway");
    mockPackageInstallStatus(root);
    readPackageVersion.mockResolvedValue("0.1.40");
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "0.1.40",
    });
    probeRunningGatewayRuntimeIdentity.mockResolvedValue({
      reachable: true,
      version: null,
      runtimeSource: null,
    });
    probeGateway.mockResolvedValue({
      ok: true,
      error: null,
      server: { version: "0.1.39", runtimeSource: "managed-package" },
    });
    serviceLoaded.mockResolvedValue(true);
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "system",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });

    await updateCommand({});

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "running gateway version 0.1.39 does not match installed version 0.1.40",
      ),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("accepts the default shell completion install without prompting when --yes is set", async () => {
    setTty(true);
    checkShellCompletionStatus.mockResolvedValue({
      shell: "bash",
      profileInstalled: false,
      cacheExists: false,
      cachePath: "/tmp/fased-completion-cache",
      usesSlowPattern: false,
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({ yes: true, restart: false });

    expect(confirm).not.toHaveBeenCalled();
    expect(ensureCompletionCacheExists).toHaveBeenCalled();
    expect(installCompletion).toHaveBeenCalledWith("bash", true, expect.any(String));
  });

  it("updateCommand --dry-run previews without mutating", async () => {
    vi.mocked(defaultRuntime.log).mockClear();
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({ dryRun: true, channel: "beta" });

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();

    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.join("\n")).toContain("Update dry-run");
    expect(logs.join("\n")).toContain("No changes were applied.");
  });

  it("updateStatusCommand prints table output", async () => {
    await updateStatusCommand({ json: false });

    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => call[0]);
    expect(logs.join("\n")).toContain("Fased Agent update status");
  });

  it("updateStatusCommand emits JSON", async () => {
    await updateStatusCommand({ json: true });

    const last = vi.mocked(defaultRuntime.log).mock.calls.at(-1)?.[0];
    expect(typeof last).toBe("string");
    const parsed = JSON.parse(String(last));
    expect(parsed.channel.value).toBe("stable");
  });

  it.each([
    {
      name: "defaults to stable channel for git installs when unset",
      mode: "git" as const,
      options: {},
      prepare: async () => {},
      expectedChannel: "stable" as const,
      expectedTag: undefined as string | undefined,
    },
    {
      name: "defaults to stable channel for package installs when unset",
      mode: "npm" as const,
      options: { yes: true },
      prepare: async () => {
        const tempDir = createCaseDir("fased-update");
        mockPackageInstallStatus(tempDir);
      },
      expectedChannel: "stable" as const,
      expectedTag: "9999.0.0",
    },
    {
      name: "uses stored beta channel when configured",
      mode: "git" as const,
      options: {},
      prepare: async () => {
        vi.mocked(readConfigFileSnapshot).mockResolvedValue({
          ...baseSnapshot,
          config: { update: { channel: "beta" } } as FasedAgentConfig,
        });
      },
      expectedChannel: "beta" as const,
      expectedTag: undefined as string | undefined,
    },
  ])("$name", async ({ mode, options, prepare, expectedChannel, expectedTag }) => {
    await prepare();
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult({ mode }));

    await updateCommand(options);

    const call = expectUpdateCallChannel(expectedChannel);
    if (expectedTag !== undefined) {
      expect(call?.tag).toBe(expectedTag);
    }
  });

  it("falls back to latest when beta tag is older than release", async () => {
    const tempDir = createCaseDir("fased-update");

    mockPackageInstallStatus(tempDir);
    vi.mocked(readConfigFileSnapshot).mockResolvedValue({
      ...baseSnapshot,
      config: { update: { channel: "beta" } } as FasedAgentConfig,
    });
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "1.2.3-1",
    });
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({
        mode: "npm",
      }),
    );

    await updateCommand({});

    const call = expectUpdateCallChannel("beta");
    expect(call?.tag).toBe("1.2.3-1");
  });

  it("honors --tag override", async () => {
    const tempDir = createCaseDir("fased-update");

    vi.mocked(resolveFasedAgentPackageRoot).mockResolvedValue(tempDir);
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({
        mode: "npm",
      }),
    );

    await updateCommand({ tag: "next" });

    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.tag).toBe("next");
  });

  it("passes safe fallback only when explicitly requested", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({ channel: "dev", safeFallback: true });

    const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
    expect(call?.channel).toBe("dev");
    expect(call?.allowDevFallback).toBe(true);
  });

  it("updateCommand outputs JSON when --json is set", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    vi.mocked(defaultRuntime.log).mockClear();

    await updateCommand({ json: true });

    const logCalls = vi.mocked(defaultRuntime.log).mock.calls;
    const jsonOutput = logCalls.find((call) => {
      try {
        JSON.parse(call[0] as string);
        return true;
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
  });

  it("updateCommand exits with error on failure", async () => {
    const mockResult: UpdateRunResult = {
      status: "error",
      mode: "git",
      reason: "rebase-failed",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateCommand({});

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateCommand restarts daemon by default", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    vi.mocked(runDaemonRestart).mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonRestart).toHaveBeenCalled();
  });

  it("restarts a hosted root service without installing a duplicate user service", async () => {
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "system",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({});

    expect(serviceRestart).toHaveBeenCalled();
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("cleans a stale hosted listener and performs only one recovery restart", async () => {
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "system",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });
    serviceLoaded.mockResolvedValue(true);
    inspectPortUsage
      .mockResolvedValueOnce({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 999_999, ppid: 999_998, commandLine: "fased-gateway" }],
        hints: [],
      })
      .mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 4243, ppid: 4242, commandLine: "fased-gateway" }],
        hints: [],
      });
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({});

    expect(serviceRestart).toHaveBeenCalledTimes(2);
    expect(inspectPortUsage).toHaveBeenCalledTimes(2);
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("rolls back an artifact transaction when a JSON-mode hosted restart fails", async () => {
    const transaction = {
      kind: "package-root-swap" as const,
      packageRoot: "/runtime/current",
      backupRoot: "/runtime/backup",
    };
    resolveUpdateGatewayServiceTarget.mockResolvedValue({
      scope: "system",
      service: {
        isLoaded: (...args: unknown[]) => serviceLoaded(...args),
        readRuntime: (...args: unknown[]) => serviceReadRuntime(...args),
        restart: (...args: unknown[]) => serviceRestart(...args),
      },
    });
    serviceLoaded.mockResolvedValue(true);
    serviceRestart.mockRejectedValue(new Error("hosted restart failed"));
    vi.mocked(runGatewayUpdate).mockResolvedValue(
      makeOkUpdateResult({
        transaction,
        before: { version: "1.0.0" },
        after: { version: "2.0.0" },
      }),
    );

    await updateCommand({ json: true });

    expect(rollbackUpdateTransaction).toHaveBeenCalledWith(transaction);
    expect(finalizeUpdateTransaction).not.toHaveBeenCalledWith(transaction);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateCommand refreshes gateway service env when service is already installed", async () => {
    const mockResult: UpdateRunResult = {
      status: "ok",
      mode: "git",
      steps: [],
      durationMs: 100,
    };

    vi.mocked(runGatewayUpdate).mockResolvedValue(mockResult);
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    expect(runRestartScript).toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("updateCommand refreshes service env from updated install root when available", async () => {
    const root = createCaseDir("fased-updated-root");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "entry.js"), "console.log('ok');\n", "utf8");

    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "npm",
      root,
      steps: [],
      durationMs: 100,
    });
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({});

    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        expect.stringMatching(/node/),
        path.join(root, "dist", "entry.js"),
        "gateway",
        "install",
        "--force",
      ],
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).toHaveBeenCalled();
  });

  it("tries the next updated install entrypoint when the first refresh candidate fails", async () => {
    const root = createCaseDir("fased-updated-root");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "entry.js"), "stale\n", "utf8");
    await fs.writeFile(path.join(root, "dist", "index.js"), "fresh\n", "utf8");

    vi.mocked(runCommandWithTimeout)
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "old entry failed",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "npm",
      root,
      steps: [],
      durationMs: 100,
    });
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({});

    expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
      1,
      [
        expect.stringMatching(/node/),
        path.join(root, "dist", "entry.js"),
        "gateway",
        "install",
        "--force",
      ],
      expect.objectContaining({ cwd: root, timeoutMs: 60_000 }),
    );
    expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
      2,
      [
        expect.stringMatching(/node/),
        path.join(root, "dist", "index.js"),
        "gateway",
        "install",
        "--force",
      ],
      expect.objectContaining({ cwd: root, timeoutMs: 60_000 }),
    );
    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).toHaveBeenCalled();
  });

  it("falls back to daemon install when updated install entrypoints all fail", async () => {
    const root = createCaseDir("fased-updated-root");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "entry.js"), "bad\n", "utf8");

    vi.mocked(runCommandWithTimeout).mockResolvedValueOnce({
      stdout: "refresh stdout",
      stderr: "refresh stderr",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
    vi.mocked(runDaemonInstall).mockResolvedValue(undefined);
    vi.mocked(runGatewayUpdate).mockResolvedValue({
      status: "ok",
      mode: "npm",
      root,
      steps: [],
      durationMs: 100,
    });
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(defaultRuntime.log).mockClear();

    await updateCommand({});

    expect(runDaemonInstall).toHaveBeenCalledWith({
      force: true,
      json: undefined,
    });
    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.join("\n")).toContain("daemon installer fallback");
    expect(logs.join("\n")).toContain("refresh stderr");
    expect(runRestartScript).toHaveBeenCalled();
  });

  it("marks update partial and skips quip when service repair fails", async () => {
    const root = createCaseDir("fased-updated-root");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "entry.js"), "bad\n", "utf8");
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    try {
      vi.mocked(runCommandWithTimeout).mockResolvedValueOnce({
        stdout: "",
        stderr: "refresh failed",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
      });
      vi.mocked(runDaemonInstall).mockRejectedValueOnce(new Error("daemon install failed"));
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "npm",
        root,
        steps: [],
        durationMs: 100,
      });
      serviceLoaded.mockResolvedValue(true);
      vi.mocked(defaultRuntime.log).mockClear();

      await updateCommand({});

      const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
      expect(logs.join("\n")).toContain("Update installed, but gateway service repair failed");
      expect(logs.join("\n")).toContain("Repair manually:");
      expect(
        logs.some((line) => line.includes("Leveled up! New skills unlocked. You're welcome.")),
      ).toBe(false);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("updateCommand falls back to restart when env refresh install fails", async () => {
    await runRestartFallbackScenario({ daemonInstall: "fail" });
  });

  it("updateCommand falls back to restart when no detached restart script is available", async () => {
    await runRestartFallbackScenario({ daemonInstall: "ok" });
  });

  it("updateCommand does not refresh service env when --no-restart is set", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    serviceLoaded.mockResolvedValue(true);

    await updateCommand({ restart: false });

    expect(runDaemonInstall).not.toHaveBeenCalled();
    expect(runRestartScript).not.toHaveBeenCalled();
    expect(runDaemonRestart).not.toHaveBeenCalled();
  });

  it("updateCommand continues after doctor sub-step and clears update flag", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      await withEnvAsync({ FASED_UPDATE_IN_PROGRESS: undefined }, async () => {
        vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
        vi.mocked(runDaemonRestart).mockResolvedValue(true);
        vi.mocked(doctorCommand).mockResolvedValue(undefined);
        vi.mocked(defaultRuntime.log).mockClear();

        await updateCommand({});

        expect(doctorCommand).toHaveBeenCalledWith(
          defaultRuntime,
          expect.objectContaining({ nonInteractive: true }),
        );
        expect(process.env.FASED_UPDATE_IN_PROGRESS).toBeUndefined();

        const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
        expect(
          logLines.some((line) =>
            line.includes("Leveled up! New skills unlocked. You're welcome."),
          ),
        ).toBe(true);
      });
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("updateCommand skips success message when restart does not run", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());
    vi.mocked(runDaemonRestart).mockResolvedValue(false);
    vi.mocked(defaultRuntime.log).mockClear();

    await updateCommand({ restart: true });

    const logLines = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logLines.some((line) => line.includes("Daemon restarted successfully."))).toBe(false);
  });

  it.each([
    {
      name: "update command",
      run: async () => await updateCommand({ timeout: "invalid" }),
      requireTty: false,
    },
    {
      name: "update status command",
      run: async () => await updateStatusCommand({ timeout: "invalid" }),
      requireTty: false,
    },
    {
      name: "update wizard command",
      run: async () => await updateWizardCommand({ timeout: "invalid" }),
      requireTty: true,
    },
  ])("validates timeout option for $name", async ({ run, requireTty }) => {
    setTty(requireTty);
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    await run();

    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("persists update channel when --channel is set", async () => {
    vi.mocked(runGatewayUpdate).mockResolvedValue(makeOkUpdateResult());

    await updateCommand({ channel: "beta" });

    expect(writeConfigFile).toHaveBeenCalled();
    const call = vi.mocked(writeConfigFile).mock.calls[0]?.[0] as {
      update?: { channel?: string };
    };
    expect(call?.update?.channel).toBe("beta");
  });

  it("diagnoses doctor-owned legacy repair before persisting an update channel", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce({
      ...baseSnapshot,
      valid: false,
      parsed: {
        channels: {
          slack: {
            streaming: "partial",
          },
        },
      },
      issues: [
        {
          path: "channels.slack.streaming",
          message: "Invalid input: expected object, received string",
        },
      ],
      legacyIssues: [
        {
          path: "channels.slack",
          message: "legacy slack streaming keys",
        },
      ],
    });

    await updateCommand({ channel: "beta", yes: true });

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const error = vi
      .mocked(defaultRuntime.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(error).toContain("Config is invalid; cannot set update channel.");
    expect(error).toContain("channels.slack.streaming");
    expect(error).toContain("Run `fased doctor --fix`");
    expect(error).toContain("channels.slack: legacy slack streaming keys");
  });

  it("keeps dry-run read-only when legacy config blocks an update channel switch", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce({
      ...baseSnapshot,
      valid: false,
      parsed: {
        $include: "./channels.json5",
        channels: {
          slack: {
            streaming: "partial",
          },
        },
      },
      issues: [
        {
          path: "channels.slack.streaming",
          message: "Invalid input: expected object, received string",
        },
      ],
      legacyIssues: [
        {
          path: "channels.slack",
          message: "legacy slack streaming keys",
        },
      ],
    });

    await updateCommand({ dryRun: true, channel: "beta", yes: true });

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    const error = vi
      .mocked(defaultRuntime.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(error).toContain("Run `fased doctor --fix`");
    expect(error).toContain("channels.slack: legacy slack streaming keys");
  });

  it.each([
    {
      name: "requires confirmation without --yes",
      options: {},
      shouldExit: true,
      shouldRunUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunUpdate }) => {
    await setupNonInteractiveDowngrade();
    await updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    expect(vi.mocked(defaultRuntime.exit).mock.calls.some((call) => call[0] === 1)).toBe(
      shouldExit,
    );
    expect(vi.mocked(runGatewayUpdate).mock.calls.length > 0).toBe(shouldRunUpdate);
  });

  it("dry-run bypasses downgrade confirmation checks in non-interactive mode", async () => {
    await setupNonInteractiveDowngrade();
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateCommand({ dryRun: true });

    expect(vi.mocked(defaultRuntime.exit).mock.calls.some((call) => call[0] === 1)).toBe(false);
    expect(runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("updateWizardCommand requires a TTY", async () => {
    setTty(false);
    vi.mocked(defaultRuntime.error).mockClear();
    vi.mocked(defaultRuntime.exit).mockClear();

    await updateWizardCommand({});

    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Update wizard requires a TTY"),
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("updateWizardCommand offers dev checkout and forwards selections", async () => {
    const tempDir = createCaseDir("fased-update-wizard");
    await withEnvAsync({ FASED_GIT_DIR: tempDir }, async () => {
      setTty(true);

      vi.mocked(checkUpdateStatus).mockResolvedValue({
        root: "/test/path",
        installKind: "package",
        packageManager: "npm",
        deps: {
          manager: "npm",
          status: "ok",
          lockfilePath: null,
          markerPath: null,
        },
      });
      select.mockResolvedValue("dev");
      confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      vi.mocked(runGatewayUpdate).mockResolvedValue({
        status: "ok",
        mode: "git",
        steps: [],
        durationMs: 100,
      });

      await updateWizardCommand({});

      const call = vi.mocked(runGatewayUpdate).mock.calls[0]?.[0];
      expect(call?.channel).toBe("dev");
    });
  });
});
