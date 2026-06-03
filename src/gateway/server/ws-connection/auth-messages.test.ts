import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../protocol/client-info.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";

describe("formatGatewayAuthFailureMessage", () => {
  it("keeps CLI token mismatch guidance on gateway.remote.token", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "token",
        reason: "token_mismatch",
        client: { id: GATEWAY_CLIENT_IDS.CLI, mode: "cli" },
      }),
    ).toBe(
      "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
    );
  });

  it("keeps Control UI token mismatch guidance on dashboard settings", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "token",
        reason: "token_mismatch",
        client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: "ui" },
      }),
    ).toBe(
      "unauthorized: gateway token mismatch (open the dashboard URL and paste the token in Control UI settings)",
    );
  });

  it("keeps WebChat token mismatch guidance on dashboard settings", () => {
    expect(
      formatGatewayAuthFailureMessage({
        authMode: "token",
        authProvided: "token",
        reason: "token_mismatch",
        client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: "webchat" },
      }),
    ).toBe(
      "unauthorized: gateway token mismatch (open the dashboard URL and paste the token in Control UI settings)",
    );
  });

  it("does not leak CLI remote-token wording into Control UI missing-token errors", () => {
    const message = formatGatewayAuthFailureMessage({
      authMode: "token",
      authProvided: "none",
      client: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: "ui" },
    });

    expect(message).toContain("open the dashboard URL");
    expect(message).not.toContain("gateway.remote.token");
  });
});
