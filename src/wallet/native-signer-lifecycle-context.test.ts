import { describe, expect, it } from "vitest";
import {
  isProtectedLocalSigner,
  resolveNativeSignerOperatorLifecycle,
} from "./native-signer-lifecycle-context.js";

describe("native signer operator lifecycle context", () => {
  it("binds Hosting to its immutable current generation and fixed sockets", () => {
    expect(
      resolveNativeSignerOperatorLifecycle({ FASED_HOST_PROFILE: "hosting", HOME: "/home/app" }),
    ).toEqual({
      profile: "hosting",
      signerBinPath: "/opt/fased/current/payload/bin/fased-signerd",
      applicationSocketPath: "/run/fased-signerd/app.sock",
      operatorSocketPath: "/run/fased-signerd/operator.sock",
      controlSocketPath: "/run/fased-signerd/control.sock",
      ownerHelperPath: "/home/app/.fased/bin/fased-signer-owner",
    });
  });

  it("binds Protected Local paths to the root-controlled instance identity", () => {
    const instanceId = "0123456789abcdef";
    const env = {
      HOME: "/home/alice",
      FASED_HOST_PROFILE: "local",
      FASED_PROTECTED_LOCAL: "1",
      FASED_PROTECTED_LOCAL_INSTANCE: instanceId,
      FASED_LIFECYCLE_INSTALL_ROOT: `/opt/fased/local/${instanceId}`,
      FASED_WALLET_LOCAL_SIGNER_SOCKET: `/run/fased-local/${instanceId}/application/app.sock`,
      FASED_WALLET_LOCAL_SIGNER_BIN: `/opt/fased/local/${instanceId}/current/payload/bin/fased-signerd`,
    };
    expect(isProtectedLocalSigner(env)).toBe(true);
    expect(resolveNativeSignerOperatorLifecycle(env)).toEqual({
      profile: "protected-local",
      instanceId,
      signerBinPath: `/opt/fased/local/${instanceId}/current/payload/bin/fased-signerd`,
      applicationSocketPath: `/run/fased-local/${instanceId}/application/app.sock`,
      operatorSocketPath: `/run/fased-local/${instanceId}/operator/operator.sock`,
      controlSocketPath: `/run/fased-local/${instanceId}/control/control.sock`,
      ownerHelperPath: "/home/alice/.fased/bin/fased-signer-owner",
    });
  });

  it("rejects cross-instance socket or binary substitution", () => {
    expect(() =>
      resolveNativeSignerOperatorLifecycle({
        HOME: "/home/alice",
        FASED_PROTECTED_LOCAL: "1",
        FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
        FASED_LIFECYCLE_INSTALL_ROOT: "/opt/fased/local/0123456789abcdef",
        FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-local/fedcba9876543210/operator.sock", // pragma: allowlist secret
        FASED_WALLET_LOCAL_SIGNER_BIN:
          "/opt/fased/local/0123456789abcdef/current/payload/bin/fased-signerd", // pragma: allowlist secret
      }),
    ).toThrow(/socket does not match/);
  });
});
