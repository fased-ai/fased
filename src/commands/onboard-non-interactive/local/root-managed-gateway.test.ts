import { describe, expect, it } from "vitest";
import { shouldDeferRootManagedGatewayActivation } from "./root-managed-gateway.js";

describe("root-managed onboarding Gateway activation", () => {
  it("defers Protected Local activation during installer onboarding", () => {
    expect(
      shouldDeferRootManagedGatewayActivation({
        env: {
          FASED_INSTALLER_ONBOARD: "1",
          FASED_PROTECTED_LOCAL: "1",
        },
        hostProfile: "local",
      }),
    ).toBe(true);
  });

  it("defers Hosting activation to the prepared root coordinator", () => {
    expect(
      shouldDeferRootManagedGatewayActivation({
        env: {
          FASED_INSTALLER_ONBOARD: "1",
          FASED_HOST_ROOT_PREPARED: "1",
        },
        hostProfile: "hosting",
      }),
    ).toBe(true);
  });

  it("keeps ordinary Local and unprepared Hosting onboarding unchanged", () => {
    expect(
      shouldDeferRootManagedGatewayActivation({
        env: {},
        hostProfile: "local",
      }),
    ).toBe(false);
    expect(
      shouldDeferRootManagedGatewayActivation({
        env: {
          FASED_INSTALLER_ONBOARD: "1",
        },
        hostProfile: "hosting",
      }),
    ).toBe(false);
  });
});
