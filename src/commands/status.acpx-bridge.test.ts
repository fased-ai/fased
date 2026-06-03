import { describe, expect, it } from "vitest";
import { resolveAcpxMcpBridgeStatus } from "./status.acpx-bridge.js";

describe("resolveAcpxMcpBridgeStatus", () => {
  it("reports the bridge as disabled by default", () => {
    expect(resolveAcpxMcpBridgeStatus({ plugins: undefined })).toMatchObject({
      enabled: false,
      mode: "disabled",
      configuredMode: "status-only",
      fasedPushTestRequest: {
        enabled: false,
        reason: "mcpBridge.disabled",
      },
    });
  });

  it("reports read-only mode without enabling the mutating push-test wrapper", () => {
    expect(
      resolveAcpxMcpBridgeStatus({
        plugins: {
          entries: {
            acpx: {
              config: {
                mcpBridge: {
                  enabled: true,
                  mode: "read-only-tools",
                  allowTools: ["fased_gateway_identity", "fased_push_test_request"],
                },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      enabled: true,
      mode: "read-only-tools",
      fasedPushTestRequest: {
        enabled: false,
        allowed: true,
        denied: false,
        reason: "mcpBridge.not-mutating-mode",
      },
    });
  });

  it("reports operator-approved mode with fased_push_test_request enabled only when allowlisted", () => {
    expect(
      resolveAcpxMcpBridgeStatus({
        plugins: {
          entries: {
            acpx: {
              config: {
                mcpBridge: {
                  enabled: true,
                  mode: "operator-approved-mutating-tools",
                  allowTools: ["fased_push_test_request"],
                },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      enabled: true,
      mode: "operator-approved-mutating-tools",
      fasedPushTestRequest: {
        enabled: true,
        allowed: true,
        denied: false,
        reason: "enabled",
      },
    });
  });

  it("lets denyTools win over the push-test allowlist", () => {
    expect(
      resolveAcpxMcpBridgeStatus({
        plugins: {
          entries: {
            acpx: {
              config: {
                mcpBridge: {
                  enabled: true,
                  mode: "operator-approved-mutating-tools",
                  allowTools: ["fased_push_test_request"],
                  denyTools: ["fased_push_test_request"],
                },
              },
            },
          },
        },
      }).fasedPushTestRequest,
    ).toMatchObject({
      enabled: false,
      allowed: true,
      denied: true,
      reason: "mcpBridge.denyTools",
    });
  });
});
