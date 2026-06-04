import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { isHostingProfile } from "./onboarding.types.js";
import type { HostSetupProfile } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

export type HostSecurityCheck = {
  name: "swap" | "tailscale" | "ufw" | "ssh" | "fail2ban" | "updates";
  ok: boolean;
  detail: string;
};

export type HostSecuritySummary = {
  profile: HostSetupProfile;
  checks: HostSecurityCheck[];
  enforced: boolean;
  logPath?: string;
};

function resolveHostSecurityLogPath(): string {
  const home = process.env.HOME?.trim() || os.homedir();
  const logDir = path.join(home, ".fased", "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  return path.join(logDir, "onboarding-host-security.log");
}

function appendHostSecurityLog(logPath: string, title: string, detail?: string) {
  const sanitizedTitle = sanitizeHostSecurityLogText(title);
  const sanitizedDetail = detail ? sanitizeHostSecurityLogText(detail) : undefined;
  const body = [
    `\n=== ${new Date().toISOString()} ${sanitizedTitle} ===`,
    sanitizedDetail?.trim() || "(no output)",
    "",
  ].join("\n");
  fs.appendFileSync(logPath, body, "utf8");
}

function sanitizeHostSecurityLogText(value: string): string {
  return redactSensitiveText(redactSensitiveUrlLikeString(value), { mode: "tools" })
    .replace(/--authkey(?:=|\s+)(["']?)([^\s"']+)\1/gi, "--authkey ***")
    .replace(/\btskey-auth-[A-Za-z0-9_-]+/g, "tskey-auth-***");
}

function hasCommand(name: string): boolean {
  const probe = spawnSync("bash", ["-lc", `command -v ${name}`], { stdio: "ignore" });
  return probe.status === 0;
}

type HostSecurityCommandRunner = (
  command: string,
  logPath?: string,
) => { ok: boolean; detail?: string };

function run(command: string, logPath?: string): { ok: boolean; detail?: string } {
  const proc = spawnSync("bash", ["-lc", command], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const detail = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`.trim();
  if (logPath) {
    appendHostSecurityLog(logPath, command, detail);
  }
  if (proc.status === 0) {
    return { ok: true, detail: detail || undefined };
  }
  return { ok: false, detail: detail || `${command} (exit=${proc.status ?? "unknown"})` };
}

function runInteractive(command: string, logPath?: string): { ok: boolean; detail?: string } {
  if (logPath) {
    appendHostSecurityLog(
      logPath,
      command,
      "interactive command started; output shown in terminal",
    );
  }
  const proc = spawnSync("bash", ["-lc", command], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const detail = `${command} (exit=${proc.status ?? "unknown"})`;
  if (logPath) {
    appendHostSecurityLog(logPath, command, detail);
  }
  if (proc.status === 0) {
    return { ok: true, detail };
  }
  return { ok: false, detail };
}

function isTailscaleLoggedIn(logPath?: string, runner: HostSecurityCommandRunner = run): boolean {
  return (
    runner("tailscale status >/dev/null 2>&1", logPath).ok ||
    runner("sudo -n tailscale status >/dev/null 2>&1", logPath).ok
  );
}

function hasTailscaleIp(logPath?: string, runner: HostSecurityCommandRunner = run): boolean {
  return (
    runner("tailscale ip -4 >/dev/null 2>&1", logPath).ok ||
    runner("sudo -n tailscale ip -4 >/dev/null 2>&1", logPath).ok
  );
}

function ensureTailscaleServe(port: number, logPath?: string): { ok: boolean; detail?: string } {
  // Prefer modern CLI syntax; fall back to legacy syntax for older tailscale versions.
  // Try unprivileged first, then sudo fallback for hosts where tailscale requires elevated rights.
  const modern = run(`tailscale serve --bg http://127.0.0.1:${port}`, logPath);
  if (modern.ok) {
    return { ok: true, detail: `tailscale serve --bg -> 127.0.0.1:${port}` };
  }
  const modernSudo = run(`sudo -n tailscale serve --bg http://127.0.0.1:${port}`, logPath);
  if (modernSudo.ok) {
    return { ok: true, detail: `sudo tailscale serve --bg -> 127.0.0.1:${port}` };
  }
  const legacy = run(`tailscale serve https / http://127.0.0.1:${port}`, logPath);
  if (legacy.ok) {
    return { ok: true, detail: `tailscale serve https / -> 127.0.0.1:${port}` };
  }
  const legacySudo = run(`sudo -n tailscale serve https / http://127.0.0.1:${port}`, logPath);
  if (legacySudo.ok) {
    return { ok: true, detail: `sudo tailscale serve https / -> 127.0.0.1:${port}` };
  }
  return {
    ok: false,
    detail:
      "serve setup failed (may require manual: sudo tailscale serve --bg http://127.0.0.1:" +
      port +
      ")",
  };
}

function isTailscaleServeReady(port: number): boolean {
  let probe = spawnSync("bash", ["-lc", "tailscale serve status"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if ((probe.status ?? 1) !== 0) {
    probe = spawnSync("bash", ["-lc", "sudo -n tailscale serve status"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  }
  if ((probe.status ?? 1) !== 0) {
    return false;
  }
  const out = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  return out.includes(`127.0.0.1:${port}`);
}

function runApt(command: string): { ok: boolean; detail?: string } {
  return run(
    `export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a PYTHONWARNINGS=ignore::SyntaxWarning; ${command}`,
    resolveHostSecurityLogPath(),
  );
}

function failOrContinue(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  step: string;
  detail?: string;
}) {
  const { opts, runtime, step, detail } = params;
  const body = detail ? `${step}: ${detail}` : step;
  const logPath = resolveHostSecurityLogPath();
  if (opts.allowInsecure === true) {
    runtime.error(`WARN insecure-continue: ${body}`);
    runtime.error(`Host hardening log: ${logPath}`);
    return;
  }
  runtime.error(`Hosting setup failed: ${body}`);
  runtime.error(`Host hardening log: ${logPath}`);
  runtime.error("Re-run with --allow-insecure to bypass (not recommended).");
  runtime.exit(1);
}

export async function applyHostingSecurity(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  prompter?: WizardPrompter;
}): Promise<HostSecuritySummary> {
  const { opts, runtime, prompter } = params;
  const checks: HostSecurityCheck[] = [];
  const logPath = resolveHostSecurityLogPath();
  const hostingProfile = isHostingProfile(opts.hostProfile);

  const profile: HostSetupProfile = hostingProfile ? "hosting" : "local";

  const maybeReauthenticateTailscaleInMaintenance = async (): Promise<{
    ok: boolean;
    detail: string;
  }> => {
    if (!prompter || opts.nonInteractive === true) {
      return {
        ok: true,
        detail: "post-bootstrap hosted maintenance session; skipping host hardening bootstrap",
      };
    }
    const switchAccount = await prompter.confirm({
      message: "Switch or re-authenticate Tailscale account on this VPS now?",
      initialValue: false,
    });
    if (!switchAccount) {
      return {
        ok: true,
        detail: "post-bootstrap hosted maintenance session; skipping host hardening bootstrap",
      };
    }

    let tsAuthkey = opts.tsAuthkey?.trim() ?? "";
    if (!tsAuthkey) {
      const useAuthkey = await prompter.confirm({
        message: "Use a Tailscale auth key instead of browser login? (advanced)",
        initialValue: false,
      });
      if (useAuthkey) {
        const keyValue =
          typeof prompter.secret === "function"
            ? await prompter.secret({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              })
            : await prompter.text({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              });
        tsAuthkey = keyValue.trim();
      } else {
        await prompter.note(
          [
            "Tailscale will print a login URL in this terminal.",
            "Open it, approve this VPS, then return here.",
            "Leave this command running until it finishes.",
          ].join("\n"),
          "Tailscale login",
        );
      }
    }

    const resetCommand = tsAuthkey
      ? `sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset --authkey ${JSON.stringify(tsAuthkey)}`
      : "sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset";
    const tsReset = tsAuthkey ? run(resetCommand, logPath) : runInteractive(resetCommand, logPath);
    if (!tsReset.ok) {
      return {
        ok: false,
        detail: tsReset.detail ?? "tailscale account switch failed",
      };
    }
    return {
      ok: true,
      detail: "tailscale re-authenticated in hosted maintenance session",
    };
  };

  if (!hostingProfile) {
    return { profile, checks, enforced: false, logPath };
  }
  if (opts.hostMaintenanceSession === true && opts.hostSecurityCapable !== true) {
    const maintenanceTailscale = await maybeReauthenticateTailscaleInMaintenance();
    return {
      profile,
      checks: [
        {
          name: "tailscale",
          ok: maintenanceTailscale.ok,
          detail: maintenanceTailscale.detail,
        },
      ],
      enforced: false,
      logPath,
    };
  }
  if (process.platform !== "linux") {
    checks.push({
      name: "tailscale",
      ok: false,
      detail: "hosting profile currently supports Linux only",
    });
    failOrContinue({
      opts,
      runtime,
      step: "hosting profile currently supports Linux only",
    });
    return { profile, checks, enforced: false, logPath };
  }

  if (!hasCommand("sudo")) {
    checks.push({ name: "ufw", ok: false, detail: "sudo is required for hosting setup" });
    failOrContinue({ opts, runtime, step: "sudo is required for hosting setup" });
    return { profile, checks, enforced: false, logPath };
  }

  // Hosting is fail-closed and always enforces hardening.

  const swapGb = Math.max(0, opts.swapGb ?? 2);
  if (swapGb > 0) {
    const hasSwap = run("swapon --show | tail -n +2 | grep -q .", logPath).ok;
    if (!hasSwap) {
      const swapCmd =
        `sudo fallocate -l ${swapGb}G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=$((` +
        `${swapGb}*1024)) status=none; ` +
        "sudo chmod 600 /swapfile; sudo mkswap /swapfile >/dev/null; sudo swapon /swapfile; " +
        "grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null";
      const swapRes = run(swapCmd, logPath);
      if (!swapRes.ok) {
        checks.push({ name: "swap", ok: false, detail: swapRes.detail ?? "swap setup failed" });
        failOrContinue({ opts, runtime, step: "swap setup failed", detail: swapRes.detail });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({ name: "swap", ok: true, detail: `configured ${swapGb}G swapfile` });
    } else {
      checks.push({ name: "swap", ok: true, detail: "existing swap detected" });
    }
  } else {
    checks.push({ name: "swap", ok: true, detail: "disabled (swap-gb=0)" });
  }

  if (!hasCommand("tailscale")) {
    const installTs = run(
      "curl -fsSL https://tailscale.com/install.sh | sudo -E env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a sh",
      logPath,
    );
    if (!installTs.ok) {
      checks.push({
        name: "tailscale",
        ok: false,
        detail: installTs.detail ?? "tailscale install failed",
      });
      failOrContinue({ opts, runtime, step: "tailscale install failed", detail: installTs.detail });
      return { profile, checks, enforced: false, logPath };
    }
  }

  let tsHealthy = isTailscaleLoggedIn(logPath);
  if (tsHealthy && prompter && opts.nonInteractive !== true) {
    const switchAccount = await prompter.confirm({
      message: "Switch or re-authenticate Tailscale account on this VPS now?",
      initialValue: false,
    });
    if (switchAccount) {
      if (prompter) {
        await prompter.note(
          [
            "Tailscale will print a login URL in this terminal.",
            "Open it, approve this VPS, then return here.",
            "Leave this command running until it finishes.",
          ].join("\n"),
          "Tailscale login",
        );
      }
      const tsReset = runInteractive(
        "sudo -n tailscale logout && sudo -n tailscale up --ssh --accept-routes --reset",
        logPath,
      );
      if (!tsReset.ok) {
        checks.push({
          name: "tailscale",
          ok: false,
          detail: tsReset.detail ?? "tailscale account switch failed",
        });
        failOrContinue({
          opts,
          runtime,
          step: "tailscale account switch failed",
          detail: tsReset.detail,
        });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({
        name: "tailscale",
        ok: true,
        detail: "tailscale re-authenticated via account switch/reset",
      });
      tsHealthy = isTailscaleLoggedIn(logPath);
    }
  }

  if (!tsHealthy) {
    let tsAuthkey = opts.tsAuthkey?.trim() ?? "";
    if (!tsAuthkey && opts.nonInteractive !== true && prompter) {
      const useAuthkey = await prompter.confirm({
        message: "Use a Tailscale auth key instead of browser login? (advanced)",
        initialValue: false,
      });
      if (useAuthkey) {
        const keyValue =
          typeof prompter.secret === "function"
            ? await prompter.secret({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              })
            : await prompter.text({
                message: "Paste Tailscale auth key (tskey-auth-...)",
                validate: (value) => (value.trim() ? undefined : "Required"),
              });
        tsAuthkey = keyValue.trim();
      }
    }

    if (tsAuthkey) {
      const tsUp = run(
        `sudo -n tailscale up --authkey ${JSON.stringify(tsAuthkey)} --ssh`,
        logPath,
      );
      if (!tsUp.ok) {
        checks.push({
          name: "tailscale",
          ok: false,
          detail: tsUp.detail ?? "tailscale up with auth key failed",
        });
        failOrContinue({
          opts,
          runtime,
          step: "tailscale up with auth key failed",
          detail: tsUp.detail,
        });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({ name: "tailscale", ok: true, detail: "tailscale up via auth key" });
    } else if (opts.nonInteractive === true) {
      checks.push({
        name: "tailscale",
        ok: false,
        detail: "non-interactive hosting setup requires --ts-authkey",
      });
      failOrContinue({
        opts,
        runtime,
        step: "non-interactive hosting setup requires --ts-authkey (or --allow-insecure)",
      });
      return { profile, checks, enforced: false, logPath };
    } else {
      if (prompter) {
        await prompter.note(
          [
            "Tailscale will print a login URL in this terminal.",
            "Open it, approve this VPS, then return here.",
            "Leave this command running until it finishes.",
          ].join("\n"),
          "Tailscale login",
        );
      }
      const tsUp = runInteractive("sudo -n tailscale up --ssh", logPath);
      if (!tsUp.ok) {
        checks.push({ name: "tailscale", ok: false, detail: tsUp.detail ?? "tailscale up failed" });
        failOrContinue({ opts, runtime, step: "tailscale up failed", detail: tsUp.detail });
        return { profile, checks, enforced: false, logPath };
      }
      checks.push({ name: "tailscale", ok: true, detail: "tailscale up via interactive login" });
    }
  } else {
    checks.push({ name: "tailscale", ok: true, detail: "tailscale already healthy" });
  }

  if (!hasTailscaleIp(logPath)) {
    checks.push({
      name: "tailscale",
      ok: false,
      detail: "tailscale network is not ready (no tailnet IP)",
    });
    failOrContinue({
      opts,
      runtime,
      step: "tailscale not ready; refusing to apply ssh/ufw lock-down",
    });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({
    name: "tailscale",
    ok: true,
    detail: "tailnet IP present; safe to harden SSH/UFW",
  });

  const operatorUser = run("id -u app >/dev/null 2>&1", logPath).ok
    ? "app"
    : process.env.SUDO_USER?.trim() || process.env.USER?.trim() || process.env.LOGNAME?.trim();
  if (operatorUser) {
    run(`sudo -n tailscale set --operator='${operatorUser}' >/dev/null 2>&1 || true`, logPath);
  }

  const servePort = Math.max(1, opts.gatewayPort ?? 18789);
  const serveRes = ensureTailscaleServe(servePort, logPath);
  if (!serveRes.ok || !isTailscaleServeReady(servePort)) {
    checks.push({
      name: "tailscale",
      ok: false,
      detail: serveRes.detail ?? `tailscale serve not ready for 127.0.0.1:${servePort}`,
    });
    failOrContinue({
      opts,
      runtime,
      step: "tailscale serve setup failed; refusing to apply ssh/ufw lock-down",
      detail: serveRes.detail,
    });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({
    name: "tailscale",
    ok: true,
    detail: `tailscale serve is active for 127.0.0.1:${servePort}`,
  });

  const ufwRes = runApt(
    "command -v ufw >/dev/null 2>&1 || (sudo -n apt-get update && sudo -n apt-get install -y ufw); " +
      "sudo -n ufw default deny incoming; sudo -n ufw default allow outgoing; " +
      "sudo -n ufw allow in on tailscale0 to any port 22 proto tcp; " +
      "sudo -n ufw allow in on tailscale0 to any port 443 proto tcp; " +
      "sudo -n ufw deny 22/tcp || true; sudo -n ufw --force enable",
  );
  if (!ufwRes.ok) {
    checks.push({ name: "ufw", ok: false, detail: ufwRes.detail ?? "ufw baseline failed" });
    failOrContinue({ opts, runtime, step: "ufw baseline failed", detail: ufwRes.detail });
    return { profile, checks, enforced: false };
  }
  checks.push({
    name: "ufw",
    ok: true,
    detail: "default-deny with tailnet SSH/HTTPS ingress only",
  });

  const sshRes = run(
    "sudo -n sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config; " +
      "sudo -n sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config; " +
      "sudo -n systemctl restart ssh || sudo -n systemctl restart sshd",
    logPath,
  );
  if (!sshRes.ok) {
    checks.push({ name: "ssh", ok: false, detail: sshRes.detail ?? "ssh hardening failed" });
    failOrContinue({ opts, runtime, step: "ssh hardening failed", detail: sshRes.detail });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({
    name: "ssh",
    ok: true,
    detail: "password auth/root login disabled and ssh restarted",
  });

  const f2bRes = runApt(
    "sudo -n apt-get install -y fail2ban && sudo -n systemctl enable --now fail2ban",
  );
  if (!f2bRes.ok) {
    checks.push({ name: "fail2ban", ok: false, detail: f2bRes.detail ?? "fail2ban setup failed" });
    failOrContinue({ opts, runtime, step: "fail2ban setup failed", detail: f2bRes.detail });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({ name: "fail2ban", ok: true, detail: "installed and enabled" });

  const updatesRes = runApt(
    "sudo -n apt-get install -y unattended-upgrades && " +
      "sudo -n systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true; " +
      "sudo -n systemctl enable --now apt-daily.timer apt-daily-upgrade.timer",
  );
  if (!updatesRes.ok) {
    checks.push({
      name: "updates",
      ok: false,
      detail: updatesRes.detail ?? "automatic security updates setup failed",
    });
    failOrContinue({
      opts,
      runtime,
      step: "automatic security updates setup failed",
      detail: updatesRes.detail,
    });
    return { profile, checks, enforced: false, logPath };
  }
  checks.push({ name: "updates", ok: true, detail: "unattended upgrades/timers enabled" });

  runtime.log("Hosting host hardening complete.");
  return { profile, checks, enforced: true, logPath };
}

export const __testing = {
  hasTailscaleIp,
  isTailscaleLoggedIn,
  sanitizeHostSecurityLogText,
};
