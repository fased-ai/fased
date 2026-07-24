import { describe, expect, it } from "vitest";
import {
  isProtectedLocalSigner,
  resolveNativeSignerOperatorLifecycle,
} from "./native-signer-lifecycle-context.js";

describe("native signer operator lifecycle context", () => {
  it("keeps Hosting on its fixed root-managed binary and socket", () => {
    expect(resolveNativeSignerOperatorLifecycle({ FASED_HOST_PROFILE: "hosting" })).toEqual({
      profile: "hosting",
      signerBinPath: "/opt/fased/signer/fased-signerd",
      applicationSocketPath: "/run/fased-signerd/app.sock",
      operatorSocketPath: "/run/fased-signerd/operator.sock",
      controlSocketPath: "/run/fased-signerd/control.sock",
      ownerHelperPath: "/usr/local/sbin/fased-signer-owner",
    });
  });

  it("binds Protected Local paths to the root-controlled instance identity", () => {
    const instanceId = "0123456789abcdef";
    const env = {
      FASED_HOST_PROFILE: "local",
      FASED_PROTECTED_LOCAL: "1",
      FASED_PROTECTED_LOCAL_INSTANCE: instanceId,
      FASED_WALLET_LOCAL_SIGNER_SOCKET: `/run/fased-local/${instanceId}/application/app.sock`,
      FASED_WALLET_LOCAL_SIGNER_BIN: `/opt/fased/local/${instanceId}/signer/fased-signerd`,
    };
    expect(isProtectedLocalSigner(env)).toBe(true);
    expect(resolveNativeSignerOperatorLifecycle(env)).toEqual({
      profile: "protected-local",
      instanceId,
      signerBinPath: `/opt/fased/local/${instanceId}/signer/fased-signerd`,
      applicationSocketPath: `/run/fased-local/${instanceId}/application/app.sock`,
      operatorSocketPath: `/run/fased-local/${instanceId}/operator/operator.sock`,
      controlSocketPath: `/run/fased-local/${instanceId}/control/control.sock`,
      ownerHelperPath: `/usr/local/sbin/fased-local-signer-owner-${instanceId}`,
    });
  });

  it("rejects cross-instance socket or binary substitution", () => {
    expect(() =>
      resolveNativeSignerOperatorLifecycle({
        FASED_PROTECTED_LOCAL: "1",
        FASED_PROTECTED_LOCAL_INSTANCE: "0123456789abcdef",
        FASED_WALLET_LOCAL_SIGNER_SOCKET: "/run/fased-local/fedcba9876543210/operator.sock",
        FASED_WALLET_LOCAL_SIGNER_BIN: "/opt/fased/local/0123456789abcdef/signer/fased-signerd",
      }),
    ).toThrow(/socket does not match/);
  });
});
