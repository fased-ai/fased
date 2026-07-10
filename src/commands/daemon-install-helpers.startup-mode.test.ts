import { describe, expect, it } from "vitest";
import {
  buildGatewayInstallPlan,
  resolveGatewayStartupMode,
  resolveHostedOnboardingGatewayStartupMode,
} from "./daemon-install-helpers.js";

describe("resolveGatewayStartupMode", () => {
  it("chooses managed-up when FASED_GATEWAY_MODE=managed", () => {
    expect(resolveGatewayStartupMode({ env: { FASED_GATEWAY_MODE: "managed" } })).toBe(
      "managed-up",
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
  it("uses managed-up for hosting onboarding", () => {
    expect(resolveHostedOnboardingGatewayStartupMode("hosting")).toBe("managed-up");
  });

  it("keeps local onboarding on gateway mode", () => {
    expect(resolveHostedOnboardingGatewayStartupMode("local")).toBe("gateway");
    expect(resolveHostedOnboardingGatewayStartupMode(undefined)).toBe("gateway");
  });
});

describe.runIf(process.platform === "linux")("hosted gateway install plan", () => {
  it("keeps the managed runtime flags required by the root service helper", async () => {
    const plan = await buildGatewayInstallPlan({
      env: { FASED_GATEWAY_MODE: "managed" },
      port: 18789,
      runtime: "node",
      nodePath: "/usr/bin/node",
      devMode: false,
      startupMode: "managed-up",
    });

    expect(plan.programArguments[0]).toBe("/bin/bash");
    expect(plan.programArguments[1]).toMatch(/scripts\/start-managed\.sh$/);
    expect(plan.environment).toMatchObject({
      FASED_GATEWAY_MODE: "managed",
      FASED_MANAGED_INTERNAL: "1",
      FASED_GATEWAY_PORT: "18789",
      FASED_NODE_BIN: "/usr/bin/node",
    });
  });
});
