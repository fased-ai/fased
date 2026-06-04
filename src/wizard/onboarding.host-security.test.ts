import { spawnSync } from "node:child_process";
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
    expect(note).toContain("tailscale ping fased-vps.tailnet.ts.net");
    expect(note).toContain("tailscale ping 100.64.1.2");
    expect(note).toContain('"no matching peer"');
    expect(note).toContain("not in the same tailnet");
    expect(note).toContain("ssh app@fased-vps.tailnet.ts.net");
    expect(note).toContain("ssh app@100.64.1.2");
    expect(note).not.toContain("tailscale ssh");
    expect(note).toContain("/home/app/fased");
  });

  it("checks app SSH prerequisites before hosted lock-down", () => {
    const commands: string[] = [];
    const result = __testing.verifyTailnetSshServerPrerequisites({
      target: {
        user: "app",
        host: "fased-vps.tailnet.ts.net",
        repoDir: "/home/app/fased",
      },
      runner: (command) => {
        commands.push(command);
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("repo directory ready: /home/app/fased");
    expect(result.detail).toContain("SSH keys ready: /home/app/.ssh/authorized_keys");
    expect(result.detail).toContain("OS SSH service active");
    expect(commands).toContain("test -d '/home/app/fased'");
    expect(commands).toContain("test -s '/home/app/.ssh/authorized_keys'");
  });

  it("stops hosted lock-down when app SSH keys are missing", () => {
    const result = __testing.verifyTailnetSshServerPrerequisites({
      target: {
        user: "app",
        host: "fased-vps.tailnet.ts.net",
        repoDir: "/home/app/fased",
      },
      runner: (command) => {
        if (command.includes("authorized_keys")) {
          return { ok: false };
        }
        return { ok: true };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("missing SSH public keys for app");
    expect(result.detail).toContain("/home/app/.ssh/authorized_keys");
  });

  it("prepares tailnet-only SSH ingress before the external SSH check", () => {
    const commands: string[] = [];
    const result = __testing.ensureTailnetSshIngressForVerification({
      runner: (command) => {
        commands.push(command);
        return { ok: true };
      },
    });

    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("ufw insert 1 allow in on tailscale0 to any port 22");
    expect(commands[0]).not.toContain("ufw allow 22/tcp");
    expect(commands[0]).not.toContain("then;");
    expect(commands[0]).not.toContain("else;");
    const syntax = spawnSync("bash", ["-n"], {
      input: commands[0],
      encoding: "utf8",
    });
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("fails verification setup when tailnet SSH ingress cannot be prepared", () => {
    const result = __testing.ensureTailnetSshIngressForVerification({
      runner: () => ({ ok: false, detail: "sudo refused" }),
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("sudo refused");
  });

  it("offers VPS Tailscale re-auth when local tailnet ping does not see the VPS", async () => {
    const confirms = [false, true, true, true];
    const notes: string[] = [];
    const commands: string[] = [];
    const interactiveCommands: string[] = [];
    const prompter = {
      intro: async () => {},
      outro: async () => {},
      note: async (message: string) => {
        notes.push(message);
      },
      select: async () => "",
      multiselect: async () => [],
      text: async () => "",
      confirm: async () => {
        const next = confirms.shift();
        if (next === undefined) {
          throw new Error("unexpected confirm");
        }
        return next;
      },
      progress: () => ({
        update: () => {},
        stop: () => {},
      }),
    };
    const result = await __testing.confirmTailnetSshBeforeLockdown({
      opts: { hostProfile: "hosting" } as never,
      runtime: {
        error: (message: string) => {
          throw new Error(message);
        },
        exit: (code?: number) => {
          throw new Error(`exit ${code ?? 0}`);
        },
      } as never,
      prompter: prompter as never,
      logPath: `/tmp/fased-host-security-test-${process.pid}.log`,
      target: {
        user: "app",
        host: "old.tailnet.ts.net",
        ipv4: "100.64.1.2",
        repoDir: "/home/app/fased",
      },
      runner: (command) => {
        commands.push(command);
        if (command === "tailscale status --json") {
          return {
            ok: true,
            detail: JSON.stringify({
              Self: {
                DNSName: "new.tailnet.ts.net.",
                TailscaleIPs: ["100.64.1.9"],
              },
            }),
          };
        }
        return { ok: true, detail: "ok" };
      },
      interactiveRunner: (command) => {
        interactiveCommands.push(command);
        return { ok: true, detail: "reauth ok" };
      },
    });

    expect(result).toBe(true);
    expect(interactiveCommands).toEqual([
      "sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset",
    ]);
    expect(notes.some((note) => note.includes("old.tailnet.ts.net"))).toBe(true);
    expect(notes.some((note) => note.includes("new.tailnet.ts.net"))).toBe(true);
    expect(commands).toContain("tailscale status --json");
    expect(confirms).toEqual([]);
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
