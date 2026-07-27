import { describe, expect, it } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.fased.js";
import { isProtectedLocalInstallerScaffold } from "./onboarding-existing-config.js";

function snapshot(config: ConfigFileSnapshot["config"]): ConfigFileSnapshot {
  return {
    path: "/home/test/.fased/fased.json",
    exists: true,
    raw: JSON.stringify(config),
    parsed: config,
    resolved: config,
    valid: true,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

const installerEnv = {
  FASED_INSTALLER_ONBOARD: "1",
  FASED_PROTECTED_LOCAL: "1",
};

describe("isProtectedLocalInstallerScaffold", () => {
  it("treats the root-prepared internal environment as fresh setup", () => {
    expect(
      isProtectedLocalInstallerScaffold(
        snapshot({
          env: {
            vars: {
              FASED_HOST_PROFILE: "local",
              FASED_PROTECTED_LOCAL: "1",
              FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
              FASED_WALLET_LOCAL_SIGNER_LIFECYCLE: "external",
              FASED_WALLET_LOCAL_SIGNER_BIN: "/opt/fased/local/signer",
              FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-local/application/app.sock",
              FASED_HOST_UPDATER_SOCKET: "/run/fased-local-controller/request.sock",
              FASED_HOST_UPDATERCTL_STATE: "/home/test/.fased/controller.json",
              FASED_UPDATE_CHANNEL: "beta",
            },
          },
        }),
        installerEnv,
      ),
    ).toBe(true);
  });

  it("preserves a real existing config even during protected onboarding", () => {
    expect(
      isProtectedLocalInstallerScaffold(
        snapshot({
          env: {
            vars: {
              FASED_PROTECTED_LOCAL: "1",
              OPENAI_API_KEY: "configured",
            },
          },
          gateway: { port: 18789 },
        }),
        installerEnv,
      ),
    ).toBe(false);
  });

  it("never suppresses existing setup outside installer-owned protected onboarding", () => {
    expect(
      isProtectedLocalInstallerScaffold(
        snapshot({
          env: { vars: { FASED_PROTECTED_LOCAL: "1" } },
        }),
        {},
      ),
    ).toBe(false);
  });
});
