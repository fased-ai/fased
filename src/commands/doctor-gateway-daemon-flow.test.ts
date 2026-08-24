import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtraGatewayService } from "../daemon/inspect.js";
import { withEnvAsync } from "../test-utils/env.js";

const service = vi.hoisted(() => ({
  isLoaded: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  install: vi.fn(),
}));
const note = vi.hoisted(() => vi.fn());
const findSystemGatewayServices = vi.hoisted(() =>
  vi.fn<() => Promise<ExtraGatewayService[]>>(async () => []),
);
const inspectPortUsage = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    resolveGatewayPort: vi.fn(() => 18789),
  };
});

vi.mock("../daemon/constants.js", () => ({
  resolveGatewayLaunchAgentLabel: vi.fn(() => "ai.fased.gateway"),
  resolveNodeLaunchAgentLabel: vi.fn(() => "ai.fased.node"),
}));

vi.mock("../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: vi.fn(async () => null),
}));

vi.mock("../daemon/inspect.js", () => ({
  findSystemGatewayServices,
}));

vi.mock("../daemon/launchd.js", () => ({
  isLaunchAgentListed: vi.fn(async () => false),
  isLaunchAgentLoaded: vi.fn(async () => false),
  launchAgentPlistExists: vi.fn(async () => false),
  repairLaunchAgentBootstrap: vi.fn(async () => ({ ok: true, status: "repaired" })),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../daemon/systemd-hints.js", () => ({
  renderSystemdUnavailableHints: vi.fn(() => []),
}));

vi.mock("../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable: vi.fn(async () => true),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage,
  formatPortDiagnostics: vi.fn(() => []),
}));

vi.mock("../infra/wsl.js", () => ({
  isWSL: vi.fn(async () => false),
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    sleep: vi.fn(async () => {}),
  };
});

vi.mock("./daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan: vi.fn(),
  gatewayInstallErrorHint: vi.fn(() => "hint"),
}));

vi.mock("./doctor-format.js", () => ({
  buildGatewayRuntimeHints: vi.fn(() => []),
  formatGatewayRuntimeSummary: vi.fn(() => null),
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(() => "health failed"),
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(async () => {}),
}));

describe("maybeRepairGatewayDaemon", () => {
  let maybeRepairGatewayDaemon: typeof import("./doctor-gateway-daemon-flow.js").maybeRepairGatewayDaemon;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeAll(async () => {
    ({ maybeRepairGatewayDaemon } = await import("./doctor-gateway-daemon-flow.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service.isLoaded.mockResolvedValue(false);
    service.readRuntime.mockResolvedValue({ status: "stopped" });
    service.restart.mockResolvedValue({ outcome: "completed" });
    findSystemGatewayServices.mockResolvedValue([]);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", {
        ...originalPlatformDescriptor,
        value: "linux",
      });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("does not auto-install a user gateway when a system gateway service exists", async () => {
    findSystemGatewayServices.mockResolvedValue([
      {
        platform: "linux",
        label: "fased-gateway.service",
        detail: "unit: /etc/systemd/system/fased-gateway.service",
        scope: "system",
        marker: "fased",
        legacy: false,
      },
    ]);

    const prompter = {
      confirm: vi.fn(),
      confirmRepair: vi.fn(),
      confirmAggressive: vi.fn(),
      confirmSkipInNonInteractive: vi.fn().mockResolvedValue(true),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
    };

    await maybeRepairGatewayDaemon({
      cfg: { gateway: {} },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter,
      options: { deep: false },
      gatewayDetailsMessage: "details",
      healthOk: false,
    });

    expect(prompter.confirmSkipInNonInteractive).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Install gateway service now?" }),
    );
    expect(service.install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("System-level Fased gateway service detected"),
      "Gateway",
    );
  });

  it("routes an unhealthy managed gateway to lifecycle repair without service mutation", async () => {
    const prompter = {
      confirm: vi.fn(),
      confirmRepair: vi.fn(),
      confirmAggressive: vi.fn(),
      confirmSkipInNonInteractive: vi.fn(),
      select: vi.fn(),
      shouldRepair: false,
      shouldForce: false,
    };

    await withEnvAsync({ FASED_RUNTIME_SOURCE: "go-lifecycle" }, async () => {
      await maybeRepairGatewayDaemon({
        cfg: { gateway: {} },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        prompter,
        options: { deep: false },
        gatewayDetailsMessage: "details",
        healthOk: false,
      });
    });

    expect(service.isLoaded).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(expect.stringContaining("Run `fased repair`"), "Gateway");
  });
});
