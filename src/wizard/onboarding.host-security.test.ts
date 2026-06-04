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

  it("formats the pre-lockdown SSH over Tailscale check", () => {
    const note = __testing.formatTailnetSshVerificationNote({
      user: "app",
      host: "fased-vps.tailnet.ts.net",
      dns: "fased-vps.tailnet.ts.net",
      ipv4: "100.64.1.2",
      repoDir: "/home/app/fased",
    });

    expect(note).toContain("Before Fased locks down public SSH/root/password access");
    expect(note).toContain("ssh app@fased-vps.tailnet.ts.net");
    expect(note).toContain("tailscale ssh app@fased-vps.tailnet.ts.net");
    expect(note).toContain("/home/app/fased");
  });

  it("uses Tailscale DNS for the SSH verification target", () => {
    const target = __testing.resolveTailnetSshTarget({
      user: "app",
      repoDir: "/home/app/fased",
      runner: (command) => {
        if (command === "tailscale status --json") {
          return {
            ok: true,
            detail: JSON.stringify({
              Self: {
                DNSName: "fased-vps.tailnet.ts.net.",
                TailscaleIPs: ["100.64.1.2"],
              },
            }),
          };
        }
        return { ok: false };
      },
    });

    expect(target.host).toBe("fased-vps.tailnet.ts.net");
    expect(target.ipv4).toBe("100.64.1.2");
    expect(target.repoDir).toBe("/home/app/fased");
  });

  it("falls back to the Tailscale IPv4 when status JSON is unavailable", () => {
    const target = __testing.resolveTailnetSshTarget({
      user: "app",
      runner: (command) => {
        if (command === "tailscale ip -4") {
          return { ok: true, detail: "100.64.1.9\n" };
        }
        return { ok: false };
      },
    });

    expect(target.host).toBe("100.64.1.9");
  });

  it("allows explicit non-interactive SSH confirmation by env", () => {
    expect(
      __testing.hasExplicitTailnetSshConfirmation({
        FASED_HOSTING_TAILNET_SSH_CONFIRMED: "yes",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      __testing.hasExplicitTailnetSshConfirmation({
        FASED_HOSTING_TAILNET_SSH_CONFIRMED: "",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
