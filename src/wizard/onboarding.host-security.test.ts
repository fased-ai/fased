import { describe, expect, it } from "vitest";
import { __testing } from "./onboarding.host-security.js";

describe("onboarding host security", () => {
  it("redacts Tailscale auth keys from host hardening log text", () => {
    const sanitized = __testing.sanitizeHostSecurityLogText(
      "sudo tailscale up --authkey tskey-auth-super-secret-token --ssh",
    );

    expect(sanitized).toContain("--authkey ***");
    expect(sanitized).not.toContain("super-secret-token");
  });
});
