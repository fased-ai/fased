import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { isHostingProfile } from "./onboarding.types.js";
import type { HostSetupProfile } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

export type HostSecurityCheck = {
  name: "swap" | "tailscale" | "firewall" | "ssh" | "fail2ban" | "updates";
  ok: boolean;
  detail: string;
};

export type HostSecuritySummary = {
  profile: HostSetupProfile;
  checks: HostSecurityCheck[];
  enforced: boolean;
  logPath?: string;
};

type ReadOnlyProbe = (
  command: string,
  args: string[],
) => { ok: boolean; stdout?: string; detail?: string };

const HOSTING_PREREQUISITES_MARKER = "/etc/fased/hosting-prerequisites";
const EXPECTED_MARKER_KEYS = new Set([
  "schemaVersion",
  "release",
  "gatewayPort",
  "tailscaleDns",
  "tailnetSshConfirmed",
  "tailscaleServeReady",
  "firewallReady",
  "sshHardened",
  "fail2banReady",
  "automaticUpdatesReady",
  "signerReady",
  "appSudoDisabled",
  "preparedBy",
]);

function resolveHostSecurityLogPath(): string {
  const home = process.env.HOME?.trim() || os.homedir();
  return path.join(home, ".fased", "logs", "onboarding-host-security.log");
}

function runReadOnlyProbe(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5_000,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    detail: result.error?.message || result.stderr || undefined,
  };
}

function readRootPreparedMarker(markerPath: string, requiredUid = 0): Map<string, string> {
  const stat = fs.lstatSync(markerPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== requiredUid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o022) !== 0 ||
    stat.size <= 0 ||
    stat.size > 4_096
  ) {
    throw new Error("marker is not a safe root-owned, non-writable regular file");
  }
  const values = new Map<string, string>();
  for (const line of fs.readFileSync(markerPath, "utf8").split("\n")) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("marker contains an invalid field");
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!EXPECTED_MARKER_KEYS.has(key) || values.has(key)) {
      throw new Error("marker contains an unknown or duplicate field");
    }
    values.set(key, value);
  }
  return values;
}

function markerHasExpectedRootState(values: Map<string, string>): boolean {
  return (
    values.size === EXPECTED_MARKER_KEYS.size &&
    values.get("schemaVersion") === "2" &&
    /^\d+\.\d+\.\d+$/.test(values.get("release") || "") &&
    values.get("gatewayPort") === "18789" &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(values.get("tailscaleDns") || "") &&
    values.get("tailnetSshConfirmed") === "true" &&
    values.get("tailscaleServeReady") === "true" &&
    values.get("firewallReady") === "true" &&
    values.get("sshHardened") === "true" &&
    values.get("fail2banReady") === "true" &&
    values.get("automaticUpdatesReady") === "true" &&
    values.get("signerReady") === "true" &&
    values.get("appSudoDisabled") === "true" &&
    values.get("preparedBy") === "root"
  );
}

function verifyRootPreparedHostingPrerequisites(params?: {
  markerPath?: string;
  probe?: ReadOnlyProbe;
  requiredMarkerUid?: number;
}): HostSecurityCheck[] {
  const markerPath = params?.markerPath ?? HOSTING_PREREQUISITES_MARKER;
  const probe = params?.probe ?? runReadOnlyProbe;
  let markerReady = false;
  try {
    markerReady = markerHasExpectedRootState(
      readRootPreparedMarker(markerPath, params?.requiredMarkerUid ?? 0),
    );
  } catch {
    markerReady = false;
  }

  const tailscaleIp = probe("tailscale", ["ip", "-4"]);
  const tailnetReady =
    tailscaleIp.ok && /^100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\./m.test(tailscaleIp.stdout || "");
  const serve = probe("tailscale", ["serve", "status"]);
  const serveReady = serve.ok && (serve.stdout || "").includes("127.0.0.1:18789");
  const signerReady = probe("systemctl", ["is-active", "--quiet", "fased-signerd.service"]).ok;
  const fail2banReady = probe("systemctl", ["is-active", "--quiet", "fail2ban.service"]).ok;
  const groups = probe("id", ["-nG"]);
  const adminGroupPresent = /(?:^|\s)(?:sudo|wheel)(?:\s|$)/.test(groups.stdout || "");
  const appCanElevate = probe("sudo", ["-n", "true"]).ok;

  return [
    {
      name: "tailscale",
      ok: markerReady && tailnetReady && serveReady,
      detail:
        markerReady && tailnetReady && serveReady
          ? "root-prepared tailnet identity, private Serve route, and SSH confirmation verified"
          : "root-prepared Tailscale identity or private Serve route is unavailable",
    },
    {
      name: "firewall",
      ok: markerReady && groups.ok && !adminGroupPresent && !appCanElevate,
      detail:
        markerReady && groups.ok && !adminGroupPresent && !appCanElevate
          ? "root prepared host lock-down; app account has no sudo or admin-group access"
          : "root preparation is invalid or the app account can elevate",
    },
    {
      name: "ssh",
      ok: markerReady,
      detail: markerReady
        ? "tailnet SSH was confirmed before root applied SSH hardening"
        : "root SSH hardening marker is invalid",
    },
    {
      name: "fail2ban",
      ok: markerReady && fail2banReady,
      detail:
        markerReady && fail2banReady
          ? "root-managed fail2ban service is active"
          : "root-managed fail2ban service is inactive",
    },
    {
      name: "updates",
      ok: markerReady && signerReady,
      detail:
        markerReady && signerReady
          ? "root-managed signer and automatic-update prerequisites are active"
          : "root-managed signer service or prerequisite marker is unavailable",
    },
  ];
}

export async function applyHostingSecurity(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  prompter?: WizardPrompter;
}): Promise<HostSecuritySummary> {
  const { opts, runtime } = params;
  const profile: HostSetupProfile = isHostingProfile(opts.hostProfile) ? "hosting" : "local";
  const logPath = resolveHostSecurityLogPath();
  if (profile !== "hosting") {
    return { profile, checks: [], enforced: false, logPath };
  }
  if (process.platform !== "linux") {
    runtime.error("Hosting setup failed: the maintained Hosting profile requires Linux.");
    runtime.exit(1);
    return { profile, checks: [], enforced: false, logPath };
  }
  if (process.env.FASED_HOST_ROOT_PREPARED?.trim() !== "1") {
    runtime.error(
      "Hosting setup failed: start from the provider root console with an exact tagged, attested release.",
    );
    runtime.error(
      "The app account cannot repair host prerequisites and is never given sudo access.",
    );
    runtime.exit(1);
    return { profile, checks: [], enforced: false, logPath };
  }

  const checks = verifyRootPreparedHostingPrerequisites();
  const enforced = checks.every((check) => check.ok);
  if (!enforced) {
    runtime.error(
      "Hosting setup failed: root-prepared prerequisites could not be verified. Run the exact tagged repair from the provider root console.",
    );
    runtime.exit(1);
  }
  return { profile, checks, enforced, logPath };
}

export const __testing = {
  markerHasExpectedRootState,
  readRootPreparedMarker,
  verifyRootPreparedHostingPrerequisites,
};
