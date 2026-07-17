import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./onboarding.host-security.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function marker(overrides: Record<string, string> = {}): string {
  const values = {
    schemaVersion: "2",
    release: "1.2.3",
    gatewayPort: "18789",
    tailscaleDns: "fased.tailnet.ts.net",
    tailnetSshConfirmed: "true",
    tailscaleServeReady: "true",
    firewallReady: "true",
    sshHardened: "true",
    fail2banReady: "true",
    automaticUpdatesReady: "true",
    signerReady: "true",
    appSudoDisabled: "true",
    preparedBy: "root",
    ...overrides,
  };
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function markerPath(contents = marker()): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-root-prerequisites-"));
  roots.push(root);
  const file = path.join(root, "hosting-prerequisites");
  fs.writeFileSync(file, contents, { mode: 0o644 });
  return file;
}

function healthyProbe(command: string, args: string[]) {
  const invocation = [command, ...args].join(" ");
  if (invocation === "tailscale ip -4") {
    return { ok: true, stdout: "100.64.1.2\n" };
  }
  if (invocation === "tailscale serve status") {
    return { ok: true, stdout: "https://fased.tailnet.ts.net -> 127.0.0.1:18789\n" };
  }
  if (invocation === "id -nG") {
    return { ok: true, stdout: "app fased-gateway\n" };
  }
  if (invocation === "sudo -n true") {
    return { ok: false };
  }
  return { ok: true };
}

describe("onboarding Hosting security verification", () => {
  it("accepts only the complete root-prepared schema", () => {
    const values = __testing.readRootPreparedMarker(markerPath(), process.getuid?.() ?? 0);
    expect(__testing.markerHasExpectedRootState(values)).toBe(true);

    const stale = __testing.readRootPreparedMarker(
      markerPath(marker({ schemaVersion: "1" })),
      process.getuid?.() ?? 0,
    );
    expect(__testing.markerHasExpectedRootState(stale)).toBe(false);
  });

  it("rejects unknown and duplicate marker fields", () => {
    expect(() =>
      __testing.readRootPreparedMarker(
        markerPath(`${marker()}unknown=true\n`),
        process.getuid?.() ?? 0,
      ),
    ).toThrow(/unknown or duplicate/);
    expect(() =>
      __testing.readRootPreparedMarker(
        markerPath(`${marker()}release=1.2.3\n`),
        process.getuid?.() ?? 0,
      ),
    ).toThrow(/unknown or duplicate/);
  });

  it("verifies root preparation without performing host mutations", () => {
    const commands: string[] = [];
    const checks = __testing.verifyRootPreparedHostingPrerequisites({
      markerPath: markerPath(),
      requiredMarkerUid: process.getuid?.() ?? 0,
      probe: (command, args) => {
        commands.push([command, ...args].join(" "));
        return healthyProbe(command, args);
      },
    });

    expect(checks.every((check) => check.ok)).toBe(true);
    expect(commands).toEqual([
      "tailscale ip -4",
      "tailscale serve status",
      "systemctl is-active --quiet fased-signerd.service",
      "systemctl is-active --quiet fail2ban.service",
      "id -nG",
      "sudo -n true",
    ]);
    expect(commands.join("\n")).not.toMatch(
      /\b(?:up|set|install|enable|restart|reload|serve reset)\b/,
    );
  });

  it("fails closed if the app account regains passwordless sudo", () => {
    const checks = __testing.verifyRootPreparedHostingPrerequisites({
      markerPath: markerPath(),
      requiredMarkerUid: process.getuid?.() ?? 0,
      probe: (command, args) => {
        if ([command, ...args].join(" ") === "sudo -n true") {
          return { ok: true };
        }
        return healthyProbe(command, args);
      },
    });

    expect(checks.find((check) => check.name === "firewall")).toMatchObject({ ok: false });
  });

  it("fails closed if the app account belongs to an admin group", () => {
    const checks = __testing.verifyRootPreparedHostingPrerequisites({
      markerPath: markerPath(),
      requiredMarkerUid: process.getuid?.() ?? 0,
      probe: (command, args) => {
        if ([command, ...args].join(" ") === "id -nG") {
          return { ok: true, stdout: "app fased-gateway sudo\n" };
        }
        return healthyProbe(command, args);
      },
    });

    expect(checks.find((check) => check.name === "firewall")).toMatchObject({ ok: false });
  });

  it("fails closed when the root-owned services are not active", () => {
    const checks = __testing.verifyRootPreparedHostingPrerequisites({
      markerPath: markerPath(),
      requiredMarkerUid: process.getuid?.() ?? 0,
      probe: (command, args) => {
        if ([command, ...args].join(" ").includes("fased-signerd.service")) {
          return { ok: false };
        }
        return healthyProbe(command, args);
      },
    });

    expect(checks.find((check) => check.name === "updates")).toMatchObject({ ok: false });
  });
});
