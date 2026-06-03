import { describe, expect, it } from "vitest";
import {
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
