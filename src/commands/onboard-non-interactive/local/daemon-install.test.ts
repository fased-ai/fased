import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";

const mocks = vi.hoisted(() => ({
  isSystemdUserServiceAvailable: vi.fn(),
  buildGatewayInstallPlan: vi.fn(),
  serviceInstall: vi.fn(),
  ensureSystemdUserLingerNonInteractive: vi.fn(),
}));

vi.mock("../../../daemon/systemd.js", () => ({
  isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
}));

vi.mock("../../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    install: mocks.serviceInstall,
  }),
}));

vi.mock("../../daemon-install-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../../daemon-install-helpers.js")>(
    "../../daemon-install-helpers.js",
  );
  return {
    ...actual,
    buildGatewayInstallPlan: mocks.buildGatewayInstallPlan,
  };
});

vi.mock("../../systemd-linger.js", () => ({
  ensureSystemdUserLingerNonInteractive: mocks.ensureSystemdUserLingerNonInteractive,
}));

import { installGatewayDaemonNonInteractive } from "./daemon-install.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("installGatewayDaemonNonInteractive", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("installs hosting with managed-up startup mode", async () => {
    mocks.isSystemdUserServiceAvailable.mockResolvedValue(true);
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["node", "dist/index.js", "managed", "up"],
      workingDirectory: "/home/app/agent",
      environment: { FASED_GATEWAY_PORT: "18789" },
    });
    mocks.serviceInstall.mockResolvedValue(undefined);
    mocks.ensureSystemdUserLingerNonInteractive.mockResolvedValue(undefined);

    await installGatewayDaemonNonInteractive({
      nextConfig: {},
      opts: {
        installDaemon: true,
        daemonRuntime: "node",
        hostProfile: "hosting",
      },
      runtime: createRuntime(),
      port: 18789,
      gatewayToken: "secret",
    });

    expect(mocks.buildGatewayInstallPlan).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startupMode: "managed-up",
      }),
    );
  });

  it("keeps local profiles on gateway startup mode", async () => {
    mocks.isSystemdUserServiceAvailable.mockResolvedValue(true);
    mocks.buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["node", "dist/index.js", "gateway", "--port", "18789"],
      workingDirectory: "/home/app/agent",
      environment: { FASED_GATEWAY_PORT: "18789" },
    });
    mocks.serviceInstall.mockResolvedValue(undefined);
    mocks.ensureSystemdUserLingerNonInteractive.mockResolvedValue(undefined);

    await installGatewayDaemonNonInteractive({
      nextConfig: {},
      opts: {
        installDaemon: true,
        daemonRuntime: "node",
        hostProfile: "local",
      },
      runtime: createRuntime(),
      port: 18789,
      gatewayToken: "secret",
    });

    expect(mocks.buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        startupMode: "gateway",
      }),
    );
  });
});
