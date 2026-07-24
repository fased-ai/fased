import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { __testing } from "./fased-managed-updater.mjs";

const root = path.resolve(import.meta.dirname, "..");
const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8");
const managed = fs.readFileSync(path.join(root, "scripts/start-managed.sh"), "utf8");
const socatAvailable = spawnSync("socat", ["-V"], { encoding: "utf8" }).status === 0;

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("root-coordinated Hosting lifecycle", () => {
  it("authenticates the root-to-app installer phase instead of re-entering public bootstrap", () => {
    const rootCoordinator = sliceBetween(installer, "reexec_as_app_user()", "go_modern_enough()");
    const validator = sliceBetween(
      installer,
      "validate_verified_hosting_app_handoff()",
      "validate_install_platform()",
    );
    expect(rootCoordinator).toContain("create_verified_hosting_app_handoff");
    expect(rootCoordinator).toContain("--verified-hosting-app-handoff");
    expect(rootCoordinator).toContain("FASED_HOST_UPDATE_TRANSACTION_ID");
    expect(validator).toContain("/run/fased-installer/app-phase-");
    expect(validator).toContain('"$file_owner" == "0"');
    expect(validator).toContain('"$file_mode" == "440"');
    expect(validator).toContain('"$handoff_uid" == "$(id -u)"');
    expect(validator).toContain('"$handoff_repo" == "$canonical_repo"');
    expect(validator).toContain(
      '"$handoff_transaction" == "${FASED_HOST_UPDATE_TRANSACTION_ID:-}"',
    );
    expect(installer).toContain(
      '-z "$install_entry_verified_bundle" && -z "$install_entry_app_handoff"',
    );
  });

  it("binds only interactive root-to-app onboarding to the controlling terminal", () => {
    const appPhase = sliceBetween(installer, "run_hosting_app_phase()", "reexec_as_app_user()");
    const rootCoordinator = sliceBetween(installer, "reexec_as_app_user()", "go_modern_enough()");
    expect(appPhase).toContain('local app_phase_stdin="/dev/null"');
    expect(appPhase).toContain('if [[ "$interactive" -eq 1 ]]');
    expect(appPhase).toContain("( : < /dev/tty )");
    expect(appPhase).toContain('app_phase_stdin="/dev/tty"');
    expect(appPhase).toContain('<"$app_phase_stdin"');
    expect(appPhase).toContain("VPS Hosting onboarding requires an interactive terminal.");
    expect(rootCoordinator).toContain(
      'run_hosting_app_phase "$target_user" "$cmd" "$app_phase_interactive"',
    );
    expect(rootCoordinator).toContain('if pass_args_contains "--non-interactive"');
    expect(rootCoordinator).not.toContain('sudo -u "$target_user" -H bash -lc "$cmd"');
    expect(rootCoordinator).not.toContain('runuser -u "$target_user" -- bash -lc "$cmd"');
  });

  it("fails before the app phase when streamed Hosting has no controlling terminal", () => {
    const appPhase = sliceBetween(installer, "run_hosting_app_phase()", "reexec_as_app_user()");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${appPhase}
need_cmd() { return 1; }
run_hosting_app_phase app 'exit 91' 1
`,
      ],
      { encoding: "utf8", input: "" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VPS Hosting onboarding requires an interactive terminal.");
  });

  it.runIf(socatAvailable)(
    "preserves interactive onboarding input after a streamed bootstrap pipe is exhausted",
    () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-host-app-tty-"));
      try {
        const harness = path.join(tempRoot, "harness.sh");
        const streamedBootstrap = path.join(tempRoot, "streamed-bootstrap.sh");
        const appPhase = sliceBetween(installer, "run_hosting_app_phase()", "reexec_as_app_user()");
        fs.writeFileSync(
          harness,
          `#!/usr/bin/env bash
set -euo pipefail
${appPhase}
need_cmd() { return 1; }
runuser() {
  local command="\${!#}"
  bash -lc "$command"
}
IFS= read -r bootstrap
printf 'bootstrap=%s\\n' "$bootstrap"
run_hosting_app_phase app 'IFS= read -r answer; printf "answer=%s\\n" "$answer"' 1
`,
          { mode: 0o700 },
        );
        fs.writeFileSync(
          streamedBootstrap,
          `#!/usr/bin/env bash
set -euo pipefail
printf 'streamed-bootstrap\\n' | bash ${JSON.stringify(harness)}
`,
          { mode: 0o700 },
        );
        const result = spawnSync("socat", [`EXEC:${streamedBootstrap},pty,setsid,ctty`, "STDIO"], {
          encoding: "utf8",
          input: "operator-answer\n",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("bootstrap=streamed-bootstrap");
        expect(result.stdout).toContain("answer=operator-answer");
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("persists app.sock while typed native administration derives operator.sock", () => {
    const coordinator = sliceBetween(installer, "reexec_as_app_user()", "go_modern_enough()");
    const services = sliceBetween(
      installer,
      "install_host_signer_and_updater_services()",
      "migrate_legacy_hosted_signer_if_needed()",
    );
    expect(coordinator).toContain("FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock");
    expect(coordinator).toContain("FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external");
    expect(installer).toContain("Environment=FASED_WALLET_LOCAL_SIGNER_LIFECYCLE=external");
    expect(services).toContain("--socket-gid ${operator_gid}");
    expect(services).toContain("-socket /run/fased-signerd/app.sock");
    expect(services).toContain("-operator-socket /run/fased-signerd/operator.sock");
    expect(services).toContain("updater_socket_attempt < 150");
  });

  it("makes private Ubuntu and RHEL app homes traversable only by the runtime group", () => {
    const accounts = sliceBetween(
      installer,
      "ensure_host_boundary_accounts()",
      "install_host_signer_and_updater_services()",
    );
    const gateway = sliceBetween(
      installer,
      "install_fixed_host_gateway_service()",
      "reconcile_hosting_shared_state()",
    );
    expect(accounts).toContain('chgrp "$config_group" "$target_home"');
    expect(accounts).toContain('chmod 0710 "$target_home"');
    expect(gateway).toContain('chgrp "$config_group" "$target_home"');
    expect(gateway).toContain('chmod 0710 "$target_home"');
    expect(gateway).toContain('chgrp -R "$config_group" "$target_repo_dir"');
    expect(gateway).toContain('chmod -R g+rX,o-rwx "$target_repo_dir"');
    expect(gateway).toContain('find "$target_repo_dir" -type d -exec chmod g+s {} +');
    expect(gateway).toContain('chmod 2770 "$target_repo_dir"');
  });

  it("delays SSH and firewall hardening until runtime health and never asks for DNS retyping", () => {
    const prepare = sliceBetween(
      installer,
      "prepare_hosting_root_prerequisites()",
      "finalize_hosting_root_prerequisites()",
    );
    const finalize = sliceBetween(
      installer,
      "finalize_hosting_root_prerequisites()",
      "ensure_host_boundary_accounts()",
    );
    const coordinator = sliceBetween(installer, "reexec_as_app_user()", "go_modern_enough()");
    expect(prepare).not.toContain('"$helper" harden-ssh');
    expect(prepare).toContain('write_hosting_prerequisites_marker "$tailscale_dns" "pending"');
    expect(finalize).toContain('"$helper" firewall-baseline');
    expect(finalize).toContain('"$helper" harden-ssh');
    expect(installer).not.toContain("Type the Tailscale DNS name");
    expect(coordinator.indexOf("verify_root_coordinated_hosted_gateway")).toBeLessThan(
      coordinator.indexOf("finalize_hosting_root_prerequisites"),
    );
  });

  it("accepts delayed multiline Tailscale Serve output without closing the producer pipe", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-tailscale-serve-"));
    try {
      const calls = path.join(tempRoot, "calls");
      const routeHelpers = sliceBetween(
        installer,
        "tailscale_serve_route_ready()",
        "prepare_hosting_root_prerequisites()",
      );
      const prepare = sliceBetween(
        installer,
        "prepare_hosting_root_prerequisites()",
        "finalize_hosting_root_prerequisites()",
      );
      expect(prepare).toContain("wait_for_tailscale_serve_route 18789");
      expect(prepare).not.toMatch(/tailscale serve status[^\n]*\|[^\n]*grep -Fq/);
      const script = `
set -euo pipefail
CALLS=${JSON.stringify(calls)}
printf '0\\n' >"$CALLS"
tailscale() {
  local count
  count="$(<"$CALLS")"
  count=$((count + 1))
  printf '%s\\n' "$count" >"$CALLS"
  if ((count < 3)); then
    printf 'No serve config\\n'
    return 0
  fi
  printf '%s\\n' \
    'Success.' \
    'Available within your tailnet:' \
    '' \
    'https://ubuntu-utah-2gb-2.tail7bbde2.ts.net/' \
    '|-- proxy http://127.0.0.1:18789' \
    '' \
    'Serve started and running in the background.'
  for _ in {1..5000}; do
    printf 'trailing output after the matched route\\n'
  done
}
sleep() { return 0; }
${routeHelpers}
wait_for_tailscale_serve_route 18789 4 0
printf 'attempts=%s\\n' "$(<"$CALLS")"
`;
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("attempts=3");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds Tailscale Serve acknowledgment retries and rejects a missing route", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-tailscale-timeout-"));
    try {
      const calls = path.join(tempRoot, "calls");
      const routeHelpers = sliceBetween(
        installer,
        "tailscale_serve_route_ready()",
        "prepare_hosting_root_prerequisites()",
      );
      const script = `
set -euo pipefail
CALLS=${JSON.stringify(calls)}
printf '0\\n' >"$CALLS"
tailscale() {
  local count
  count="$(<"$CALLS")"
  printf '%s\\n' "$((count + 1))" >"$CALLS"
  printf 'https://wrong.tailnet.ts.net/\\n|-- proxy http://127.0.0.1:9999\\n'
}
sleep() { return 0; }
${routeHelpers}
if wait_for_tailscale_serve_route 18789 3 0; then
  exit 91
fi
printf 'attempts=%s\\n' "$(<"$CALLS")"
`;
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("attempts=3");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses complete Tailscale Serve output in the managed startup summary", () => {
    const routeHelper = sliceBetween(
      managed,
      "tailscale_serve_route_ready()",
      'TAILSCALE_DNS_NAME=""',
    );
    expect(routeHelper).toContain('status="$(tailscale serve status 2>/dev/null)"');
    expect(routeHelper).toContain('[[ "$status" =~ 127\\.0\\.0\\.1:${port}([^0-9]|$) ]]');
    expect(managed).toContain('if tailscale_serve_route_ready "$FASED_GATEWAY_PORT"; then');
    expect(managed).not.toMatch(/tailscale serve status[^\n]*\|[^\n]*grep -q/);

    const script = `
set -euo pipefail
tailscale() {
  printf '%s\\n' \
    'Available within your tailnet:' \
    'https://fased.tailnet.ts.net/' \
    '|-- proxy http://127.0.0.1:18789'
  for _ in {1..5000}; do
    printf 'trailing managed-status output\\n'
  done
}
${routeHelper}
tailscale_serve_route_ready 18789
`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

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
    expect(refresh).toContain("if (isRootManagedProfile(manifest.profile))");
    expect(refresh).toContain("if (!hostedServiceAlreadyRestarted)");
    expect(refresh).toContain("} else {\n    const installed = await runFile");
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
