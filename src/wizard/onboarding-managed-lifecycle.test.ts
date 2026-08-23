import { describe, expect, it } from "vitest";
import {
  resolveInstallerOnboardingCwd,
  shouldDeferRootManagedGatewayActivation,
  shouldManageGatewayServiceDuringOnboarding,
} from "./onboarding-managed-lifecycle.js";

describe("managed lifecycle onboarding boundary", () => {
  it("keeps fresh Local and Hosting Gateway activation deferred through onboarding", () => {
    expect(
      shouldDeferRootManagedGatewayActivation({
        env: {
          FASED_INSTALLER_ONBOARD: "1",
          FASED_INSTALL_LIFECYCLE_COMMITTED: "1",
          FASED_PROTECTED_LOCAL: "1",
        },
        hostProfile: "local",
      }),
    ).toBe(true);
    expect(
      shouldDeferRootManagedGatewayActivation({
        env: {
          FASED_INSTALLER_ONBOARD: "1",
          FASED_INSTALL_LIFECYCLE_COMMITTED: "1",
          FASED_HOST_ROOT_PREPARED: "1",
        },
        hostProfile: "hosting",
      }),
    ).toBe(true);
  });

  it("binds installer-created shell processes to the operator home", () => {
    expect(
      resolveInstallerOnboardingCwd({
        env: { FASED_INSTALLER_ONBOARD: "1", HOME: "/home/app" },
        currentCwd: "/root",
      }),
    ).toBe("/home/app");
    expect(
      resolveInstallerOnboardingCwd({ env: { HOME: "/home/app" }, currentCwd: "/checkout" }),
    ).toBe("/checkout");
    expect(() =>
      resolveInstallerOnboardingCwd({
        env: { FASED_INSTALLER_ONBOARD: "1", HOME: "relative" },
        currentCwd: "/root",
      }),
    ).toThrow("absolute operator home");
  });

  it("keeps managed installer onboarding config-only until Go completes activation", () => {
    expect(
      shouldManageGatewayServiceDuringOnboarding({
        installDaemon: true,
        deferRootManagedActivation: true,
      }),
    ).toBe(false);
    expect(
      shouldManageGatewayServiceDuringOnboarding({
        installDaemon: true,
        deferRootManagedActivation: false,
      }),
    ).toBe(true);
  });
});
