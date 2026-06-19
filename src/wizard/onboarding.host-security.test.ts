import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing } from "./onboarding.host-security.js";

function checkBashSyntax(script: string) {
  return spawnSync("bash", ["-n", "-c", script], {
    encoding: "utf8",
    timeout: 5000,
  });
}

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

  it("defaults hosted swap to 4G on 2 GB VPS nodes", () => {
    expect(__testing.resolveHostingSwapGb(undefined, 2048)).toBe(4);
  });

  it("keeps explicit hosted swap overrides", () => {
    expect(__testing.resolveHostingSwapGb(0, 2048)).toBe(0);
    expect(__testing.resolveHostingSwapGb(6, 2048)).toBe(6);
  });

  it("uses the smaller hosted swap default when memory is not constrained", () => {
    expect(__testing.resolveHostingSwapGb(undefined, 4096)).toBe(2);
  });

  it("explains the local device Tailscale requirement before hosted verification", () => {
    const note = __testing.formatLocalDeviceTailnetRequirementNote();

    expect(note).toContain("Hosted setup uses two machines");
    expect(note).toContain("This VPS runs Fased Agent");
    expect(note).toContain("Your own computer must have Tailscale installed");
    expect(note).toContain("Windows: use PowerShell");
    expect(note).toContain("macOS: use Terminal");
    expect(note).toContain("WSL: advanced only");
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
    expect(note).toContain("These commands run on your own computer");
    expect(note).toContain("must have Tailscale installed");
    expect(note).toContain("sudo dnf install -y tailscale");
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
    expect(commands[0]).toContain(
      "firewall-cmd --permanent --zone=trusted --add-interface=tailscale0",
    );
    expect(commands[0]).not.toContain("ufw allow 22/tcp");
    const syntax = checkBashSyntax(commands[0]);
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("generates portable package manager commands for hosted hardening", () => {
    const command = __testing.packageInstallCommand(["fail2ban"]);

    expect(command).toContain("apt-get install -y 'fail2ban'");
    expect(command).toContain("dnf install -y 'fail2ban'");
    expect(command).toContain("dnf5 install -y 'fail2ban'");
    expect(command).toContain("yum install -y 'fail2ban'");
    const syntax = checkBashSyntax(command);
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("generates hosted firewall hardening for ufw and firewalld", () => {
    const command = __testing.firewallBaselineCommand();

    expect(command).toContain("ufw default deny incoming");
    expect(command).toContain("firewall-cmd --permanent --zone=trusted --add-interface=tailscale0");
    expect(command).toContain("firewall-cmd --permanent --zone=public --remove-service=ssh");
    const syntax = checkBashSyntax(command);
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it("generates automatic update setup for apt and dnf families", () => {
    const command = __testing.automaticUpdatesCommand();

    expect(command).toContain("unattended-upgrades");
    expect(command).toContain("dnf5-plugin-automatic");
    expect(command).toContain("dnf5-automatic.timer");
    expect(command).toContain("dnf-automatic");
    expect(command).toContain("yum-cron");
    const syntax = checkBashSyntax(command);
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
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-host-security-reauth-"));
    const previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = stateDir;
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
    try {
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
        logPath: path.join(stateDir, "host-security.log"),
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
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("continues when Tailscale browser login times out after a tailnet IP appears", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-host-security-ts-timeout-"));
    const previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = stateDir;
    const confirms = [false, true, true, true];
    const commands: string[] = [];
    const interactiveCommands: string[] = [];
    const prompter = {
      intro: async () => {},
      outro: async () => {},
      note: async () => {},
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

    try {
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
        logPath: path.join(stateDir, "host-security.log"),
        target: {
          user: "app",
          host: "old.tailnet.ts.net",
          ipv4: "100.64.1.2",
          repoDir: "/home/app/fased",
        },
        runner: (command) => {
          commands.push(command);
          if (command.includes("tailscale ip -4")) {
            return { ok: true, detail: "100.64.1.9\n" };
          }
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
          return { ok: false, detail: "tailscale up timed out", timedOut: true };
        },
      });

      expect(result).toBe(true);
      expect(interactiveCommands).toEqual([
        "sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset",
      ]);
      expect(commands).toContain("tailscale ip -4 >/dev/null 2>&1");
      expect(commands).toContain("tailscale status --json");
      expect(confirms).toEqual([]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("skips repeated SSH verification after a previous successful confirmation", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-host-security-confirm-"));
    const previousStateDir = process.env.FASED_STATE_DIR;
    process.env.FASED_STATE_DIR = stateDir;
    fs.writeFileSync(
      path.join(stateDir, "hosting-tailnet-ssh-confirmed.json"),
      JSON.stringify({
        user: "app",
        repoDir: "/home/app/fased",
      }),
      "utf8",
    );

    try {
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
        prompter: {
          note: async () => {
            throw new Error("unexpected note");
          },
          confirm: async () => {
            throw new Error("unexpected confirm");
          },
        } as never,
        logPath: path.join(stateDir, "host-security.log"),
        target: {
          user: "app",
          host: "fased-vps.tailnet.ts.net",
          repoDir: "/home/app/fased",
        },
      });

      expect(result).toBe(true);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
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
