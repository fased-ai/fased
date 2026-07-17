import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing } from "./fased-managed-updater.mjs";

const root = path.resolve(import.meta.dirname, "..");
const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const managed = fs.readFileSync(path.join(root, "scripts/start-managed.sh"), "utf8");

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("root-coordinated Hosting lifecycle", () => {
  it("stages an app-side repair without requiring a helper, system unit mutation, or sudo", () => {
    const noOnboardStart = installer.lastIndexOf('if [[ "$RUN_ONBOARD" -eq 0 ]]');
    const noOnboardEnd = installer.indexOf('section "Interactive setup"', noOnboardStart);
    expect(noOnboardStart).toBeGreaterThanOrEqual(0);
    expect(noOnboardEnd).toBeGreaterThan(noOnboardStart);
    const noOnboard = installer.slice(noOnboardStart, noOnboardEnd);
    const hostedRepair = sliceBetween(
      noOnboard,
      'if [[ "$HOSTING_REPAIR_REQUESTED" -eq 1 ]]',
      "if ! prepare_existing_local_signer_after_runtime_install",
    );

    expect(hostedRepair).toContain("Hosted application runtime repair staged");
    expect(hostedRepair).not.toContain("fased-install-gateway-service");
    expect(hostedRepair).not.toContain("gateway install");
    expect(hostedRepair).not.toContain("systemctl");
    expect(hostedRepair).not.toContain("sudo");
    expect(noOnboard).not.toContain("gateway install --force --system");
  });

  it("orders fresh, repair, and pre-v2 completion through the same root restart and health gate", () => {
    const rootCoordinator = sliceBetween(installer, "reexec_as_app_user()", "go_modern_enough()");
    const childLaunch = rootCoordinator.indexOf("re-executing installer as");
    const rootRestart = rootCoordinator.indexOf("restart_root_managed_hosted_gateway");
    const pairedFinalize = rootCoordinator.indexOf("hosted-transaction finalize");
    const rootHealth = rootCoordinator.indexOf("verify_root_coordinated_hosted_gateway");

    expect(childLaunch).toBeGreaterThanOrEqual(0);
    expect(rootRestart).toBeGreaterThan(childLaunch);
    expect(pairedFinalize).toBeGreaterThan(rootRestart);
    expect(rootHealth).toBeGreaterThan(pairedFinalize);
    expect(rootCoordinator).toContain("hosted-transaction finalize --root-restarted");
    expect(rootCoordinator).not.toContain("fased-install-gateway-service");
    expect(rootCoordinator).not.toContain("gateway install --force --system");

    const rootFlow = sliceBetween(
      installer,
      'if [[ "$(id -u)" -eq 0 ]]; then\n  assert_verified_hosting_root_source',
      'if [[ ! -f "$FASED_DIR/package.json"',
    );
    expect(rootFlow.indexOf("migrate_legacy_hosted_signer_if_needed")).toBeLessThan(
      rootFlow.indexOf("reexec_as_app_user"),
    );
    expect(rootCoordinator.indexOf("verify_root_coordinated_hosted_gateway")).toBeLessThan(
      rootCoordinator.indexOf("finalize_legacy_hosted_signer_migration"),
    );
  });

  it.each(["fresh", "repair", "pre-v2 migration"])(
    "uses root-owned systemd restart and app health probing for %s Hosting",
    (scenario) => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-host-root-lifecycle-"));
      try {
        const calls = path.join(tempRoot, "calls.log");
        const restartFunction = sliceBetween(
          installer,
          "restart_root_managed_hosted_gateway()",
          "verify_root_coordinated_hosted_gateway()",
        );
        const verifyFunction = sliceBetween(
          installer,
          "verify_root_coordinated_hosted_gateway()",
          "runtime_assets_ready()",
        );
        const script = `
set -euo pipefail
CALLS=${JSON.stringify(calls)}
id() { if [[ "\${1:-}" == "-u" ]]; then printf '0\\n'; else command id "$@"; fi; }
systemctl() {
  printf 'systemctl %s\\n' "$*" >>"$CALLS"
  if [[ "\${1:-}" == "show" ]]; then printf '4242\\n'; fi
  return 0
}
runuser() { printf 'runuser %s\\n' "$*" >>"$CALLS"; return 0; }
journalctl() { return 0; }
sleep() { return 0; }
${restartFunction}
${verifyFunction}
mkdir -p ${JSON.stringify(path.join(tempRoot, "home", ".fased", "bin"))}
touch ${JSON.stringify(path.join(tempRoot, "home", ".fased", "bin", "fased"))}
chmod 700 ${JSON.stringify(path.join(tempRoot, "home", ".fased", "bin", "fased"))}
restart_root_managed_hosted_gateway
verify_root_coordinated_hosted_gateway app ${JSON.stringify(path.join(tempRoot, "home"))}
`;
        const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
        expect(result.status, `${scenario}: ${result.stderr}`).toBe(0);
        const log = fs.readFileSync(calls, "utf8");
        expect(log).toContain("systemctl daemon-reload");
        expect(log).toContain("systemctl restart fased-gateway.service");
        expect(log).toContain("systemctl is-active --quiet fased-gateway.service");
        expect(log).toContain("runuser -u app -- env");
        expect(log).toContain("health --json --timeout 3000");
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("lets only root-coordinated finalization skip an app-side hosted restart", () => {
    expect(
      __testing.parseHostedTransactionArgs([
        "hosted-transaction",
        "finalize",
        "--root-restarted",
        "--timeout",
        "45",
      ]),
    ).toEqual({
      action: "finalize",
      timeoutMs: 45_000,
      targetServiceAlreadyRestarted: true,
    });
    expect(() =>
      __testing.parseHostedTransactionArgs(["hosted-transaction", "rollback", "--root-restarted"]),
    ).toThrow("valid only with hosted-transaction finalize");

    const refresh = sliceBetween(
      fs.readFileSync(path.join(root, "scripts/fased-managed-updater.mjs"), "utf8"),
      "async function refreshGateway(",
      "async function updateStableComponents(",
    );
    expect(refresh).toContain('manifest.profile === "hosting" && !hostedServiceAlreadyRestarted');
    expect(refresh).toContain("targetServiceAlreadyRestarted");
    expect(refresh).toContain("refreshPrevious");
  });
});

describe("Hosting secret handling", () => {
  it("uses a root-only one-use file for Tailscale authentication and rejects raw argv secrets", () => {
    expect(installer).toContain("Refusing a Tailscale auth key in process arguments");
    expect(installer).toContain("--ts-authkey-file");
    expect(installer).toContain("mktemp /run/fased-tailscale-authkey.XXXXXXXX");
    expect(installer).toContain("install -m 0600 -o root -g root");
    expect(installer).toContain('--auth-key="file:${authkey_file}"');
    expect(installer).not.toContain('tailscale up --authkey "$authkey"');
    expect(installer).not.toContain('tailscale up --auth-key "$authkey"');
  });

  it("persists zrok reservations privately and suppresses all secret-bearing output", () => {
    expect(managed).toContain("write_private_zrok_reservation");
    expect(managed).toContain('chmod 0600 "$file"');
    expect(managed).toContain("provider output was suppressed because it may contain credentials");
    expect(managed).not.toContain("Found cached reservation: $RES_TOKEN");
    expect(managed).not.toContain("Recovered cached reservation: $RES_TOKEN");
    expect(managed).not.toContain("Recovered existing token: $EXISTING_TOKEN");
    expect(managed).not.toContain('cat "$ZROK_LOG"');
    expect(managed).not.toContain("Reservation failed or already reserved. Output: $OUT");
    expect(managed).not.toContain("Reservation token:   $RES_TOKEN_MASKED");
    expect(managed).not.toContain("zrokToken:           $FED_ZROK_TOKEN_MASKED");
  });

  it("writes mode-0600 reservation files and emits only fixed safe zrok diagnostics", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-zrok-secret-"));
    try {
      const readFunction = sliceBetween(
        managed,
        "read_private_zrok_reservation()",
        "write_private_zrok_reservation()",
      );
      const writeFunction = sliceBetween(
        managed,
        "write_private_zrok_reservation()",
        "filter_zrok_runtime_output()",
      );
      const filterFunction = sliceBetween(
        managed,
        "filter_zrok_runtime_output()",
        "is_gateway_listener_ready()",
      );
      const reservation = path.join(tempRoot, "agent.zrok-reservation");
      const script = `
set -euo pipefail
umask 022
${readFunction}
${writeFunction}
${filterFunction}
write_private_zrok_reservation ${JSON.stringify(reservation)} 'zrok-reservation-secret'
printf 'mode=%s\\n' "$(stat -c %a ${JSON.stringify(reservation)})"
printf 'token=%s\\n' "$(read_private_zrok_reservation ${JSON.stringify(reservation)})"
printf '%s\\n' 'provider zrok-reservation-secret output' 'issuedAt of token is in the future: zrok-reservation-secret' | filter_zrok_runtime_output
`;
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("mode=600");
      expect(result.stdout).toContain("token=zrok-reservation-secret");
      const diagnostics = result.stdout.split("token=zrok-reservation-secret\n")[1] ?? "";
      expect(diagnostics).toBe("[zrok] clock-skew-auth-failure\n");
      expect(diagnostics).not.toContain("zrok-reservation-secret");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
