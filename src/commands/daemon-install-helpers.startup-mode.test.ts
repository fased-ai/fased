import { describe, expect, it } from "vitest";
import {
  buildGatewayInstallPlan,
  resolveGatewayStartupMode,
  resolveHostedOnboardingGatewayStartupMode,
} from "./daemon-install-helpers.js";

describe("resolveGatewayStartupMode", () => {
  it("routes an old managed mode request to the Go lifecycle boundary", () => {
    expect(resolveGatewayStartupMode({ env: { FASED_GATEWAY_MODE: "managed" } })).toBe(
      "go-lifecycle",
    );
  });

  it("keeps local installs on plain gateway when wallet runtime is external", () => {
    expect(
      resolveGatewayStartupMode({
        env: {},
        config: {
          wallet: {
            runtime: {
              enabled: true,
              mode: "external",
              runtime: "external-docker",
            },
          },
        },
      }),
    ).toBe("gateway");
  });

  it("keeps federation auto-connect on plain gateway unless managed mode is explicit", () => {
    expect(resolveGatewayStartupMode({ env: { FASED_FEDERATION_AUTO_CONNECT: "1" } })).toBe(
      "gateway",
    );
  });

  it("defaults to gateway when no managed signal is present", () => {
    expect(resolveGatewayStartupMode({ env: {} })).toBe("gateway");
  });
});

describe("resolveHostedOnboardingGatewayStartupMode", () => {
  it("uses the Go lifecycle boundary for hosting onboarding", () => {
    expect(resolveHostedOnboardingGatewayStartupMode("hosting")).toBe("go-lifecycle");
  });

  it("keeps local onboarding on gateway mode", () => {
    expect(resolveHostedOnboardingGatewayStartupMode("local")).toBe("gateway");
    expect(resolveHostedOnboardingGatewayStartupMode(undefined)).toBe("gateway");
  });
});

describe.runIf(process.platform === "linux")("hosted gateway install plan", () => {
  it("refuses to install a managed service from Node", async () => {
    await expect(
      buildGatewayInstallPlan({
        env: { FASED_GATEWAY_MODE: "managed" },
        port: 18789,
        runtime: "node",
        nodePath: "/usr/bin/node",
        devMode: false,
        startupMode: "go-lifecycle",
      }),
    ).rejects.toThrow("verified Go lifecycle installer");
  });
});
