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

  it("accepts an existing sudo-managed Tailscale login", () => {
    const commands: string[] = [];
    const loggedIn = __testing.isTailscaleLoggedIn(undefined, (command) => {
      commands.push(command);
      return { ok: command.startsWith("sudo -n tailscale status") };
    });

    expect(loggedIn).toBe(true);
    expect(commands).toEqual([
      "tailscale status >/dev/null 2>&1",
      "sudo -n tailscale status >/dev/null 2>&1",
    ]);
  });

  it("accepts a sudo-readable tailnet IP during hosted bootstrap", () => {
    const commands: string[] = [];
    const hasIp = __testing.hasTailscaleIp(undefined, (command) => {
      commands.push(command);
      return { ok: command.startsWith("sudo -n tailscale ip") };
    });

    expect(hasIp).toBe(true);
    expect(commands).toEqual([
      "tailscale ip -4 >/dev/null 2>&1",
      "sudo -n tailscale ip -4 >/dev/null 2>&1",
    ]);
  });
});
