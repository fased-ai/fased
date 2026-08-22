import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
const LEGACY_MARKER_KEYS = new Set([
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
const CURRENT_MARKER_KEYS = new Set([
  "schemaVersion",
  "release",
  "updateChannel",
  "transactionId",
  "gatewayPort",
  "tailscaleDns",
  "tailscaleVersion",
  "tailscaleServeReady",
  "signerWebAuthnReady",
  "firewallReady",
  "sshHardened",
  "fail2banReady",
  "automaticUpdatesReady",
  "signerReady",
  "appSudoDisabled",
  "preparedBy",
]);
const KNOWN_MARKER_KEYS = new Set([...LEGACY_MARKER_KEYS, ...CURRENT_MARKER_KEYS]);

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
    if (!KNOWN_MARKER_KEYS.has(key) || values.has(key)) {
      throw new Error("marker contains an unknown or duplicate field");
    }
    values.set(key, value);
  }
  return values;
}

function markerHasExpectedRootState(values: Map<string, string>): boolean {
  const legacyReady =
    values.size === LEGACY_MARKER_KEYS.size &&
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
    values.get("preparedBy") === "root";
  if (legacyReady) {
    return true;
  }
  const release = values.get("release") || "";
  const channel = values.get("updateChannel") || "";
  const expectedRelease = process.env.FASED_HOSTING_RELEASE?.trim();
  const expectedChannel = process.env.FASED_UPDATE_CHANNEL?.trim();
  const lifecycleStates = [
    values.get("firewallReady"),
    values.get("sshHardened"),
    values.get("fail2banReady"),
    values.get("automaticUpdatesReady"),
  ];
  return (
    values.size === CURRENT_MARKER_KEYS.size &&
    values.get("schemaVersion") === "3" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(release) &&
    /^(stable|beta)$/.test(channel) &&
    (!release.includes("-") || channel === "beta") &&
    (!expectedRelease || release === expectedRelease) &&
    (!expectedChannel || channel === expectedChannel) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      values.get("transactionId") || "",
    ) &&
    values.get("gatewayPort") === "18789" &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(values.get("tailscaleDns") || "") &&
    /^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/.test(values.get("tailscaleVersion") || "") &&
    values.get("tailscaleServeReady") === "true" &&
    values.get("signerWebAuthnReady") === "true" &&
    lifecycleStates.every((value) => value === "pending" || value === "true") &&
    new Set(lifecycleStates).size === 1 &&
    values.get("signerReady") === "true" &&
    values.get("appSudoDisabled") === "true" &&
    values.get("preparedBy") === "root"
  );
}

export function hasRootPreparedHostingMarker(
  markerPath = HOSTING_PREREQUISITES_MARKER,
  requiredUid = 0,
): boolean {
  try {
    return markerHasExpectedRootState(readRootPreparedMarker(markerPath, requiredUid));
  } catch {
    return false;
  }
}

function verifyRootPreparedHostingPrerequisites(params?: {
  markerPath?: string;
  probe?: ReadOnlyProbe;
  requiredMarkerUid?: number;
}): HostSecurityCheck[] {
  const markerPath = params?.markerPath ?? HOSTING_PREREQUISITES_MARKER;
  const probe = params?.probe ?? runReadOnlyProbe;
  let markerReady = false;
  let markerValues: Map<string, string> | null = null;
  try {
    markerValues = readRootPreparedMarker(markerPath, params?.requiredMarkerUid ?? 0);
    markerReady = markerHasExpectedRootState(markerValues);
  } catch {
    markerReady = false;
  }

  const signerReady = probe("systemctl", ["is-active", "--quiet", "fased-signerd.service"]).ok;
  const fail2banReady = probe("systemctl", ["is-active", "--quiet", "fail2ban.service"]).ok;
  const groups = probe("id", ["-nG"]);
  const adminGroupPresent = /(?:^|\s)(?:sudo|wheel)(?:\s|$)/.test(groups.stdout || "");
  const appCanElevate = probe("sudo", ["-n", "true"]).ok;
  const hardeningPending = markerValues?.get("firewallReady") === "pending";

  return [
    {
      name: "tailscale",
      ok: markerReady,
      detail: markerReady
        ? "root-prepared tailnet identity and private Serve route verified by the bound marker"
        : "root-prepared Tailscale identity or private Serve route marker is unavailable",
    },
    {
      name: "firewall",
      ok: markerReady && groups.ok && !adminGroupPresent && !appCanElevate,
      detail:
        markerReady && groups.ok && !adminGroupPresent && !appCanElevate
          ? hardeningPending
            ? "app account has no elevation; root will finalize the host firewall after runtime health"
            : "root prepared host lock-down; app account has no sudo or admin-group access"
          : "root preparation is invalid or the app account can elevate",
    },
    {
      name: "ssh",
      ok: markerReady,
      detail: markerReady
        ? hardeningPending
          ? "root will apply SSH hardening after runtime health; no DNS-name confirmation is required"
          : "root applied SSH hardening after runtime health"
        : "root SSH hardening marker is invalid",
    },
    {
      name: "fail2ban",
      ok: markerReady && (hardeningPending || fail2banReady),
      detail:
        markerReady && (hardeningPending || fail2banReady)
          ? hardeningPending
            ? "root will enable fail2ban after runtime health"
            : "root-managed fail2ban service is active"
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
  if (profile !== "hosting") {
    return { profile, checks: [], enforced: false };
  }
  if (process.platform !== "linux") {
    runtime.error("Hosting setup failed: the maintained Hosting profile requires Linux.");
    runtime.exit(1);
    return { profile, checks: [], enforced: false };
  }
  if (process.env.FASED_HOST_ROOT_PREPARED?.trim() !== "1") {
    runtime.error(
      "Hosting setup failed: start from the provider root console with an exact tagged, attested release.",
    );
    runtime.error(
      "The app account cannot repair host prerequisites and is never given sudo access.",
    );
    runtime.exit(1);
    return { profile, checks: [], enforced: false };
  }

  const checks = verifyRootPreparedHostingPrerequisites();
  const enforced = checks.every((check) => check.ok);
  if (!enforced) {
    runtime.error(
      "Hosting setup failed: root-prepared prerequisites could not be verified. Run the exact tagged repair from the provider root console.",
    );
    runtime.exit(1);
  }
  return { profile, checks, enforced };
}

export const __testing = {
  hasRootPreparedHostingMarker,
  markerHasExpectedRootState,
  readRootPreparedMarker,
  verifyRootPreparedHostingPrerequisites,
};
