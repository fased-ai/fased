import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("signer-owned WebAuthn enrollment launchers", () => {
  it("installs a same-user Local launcher with a dedicated exact loopback origin", () => {
    const native = read("tools/fased-signerd/admin_webauthn_enrollment.go");
    const main = read("tools/fased-signerd/main.go");
    const installer = read("scripts/install-fased-signerd.sh");
    const updater = read("scripts/fased-managed-updater-core.mjs");
    const onboarding = read("src/wizard/onboarding.wallet.ts");

    expect(main).toContain('filepath.Base(os.Args[0]) == "fased-signer-enroll"');
    expect(main).toContain("os.Clearenv()");
    expect(native).toContain('ListenAddress: "127.0.0.1:18791"');
    expect(native).toContain('Origin:        "http://localhost:18791"');
    expect(native).toContain('"webauthn-enrollment.lock"');

    expect(installer).toContain('node "$UPDATER" "${args[@]}"');
    expect(updater).toContain("await copyStandaloneFile(paths.binaryPath, enrollTemporary, 0o700)");
    expect(updater).not.toContain("await fsp.link(paths.binaryPath, enrollTemporary)");
    expect(updater).toContain("await fsp.rename(enrollTemporary, paths.enrollmentPath)");
    expect(updater.indexOf("downloadVerifiedLocalSignerRelease")).toBeLessThan(
      updater.indexOf("atomicInstallSignerBinary"),
    );
    expect(onboarding).toContain('LOCAL_SIGNER_ENROLLMENT_ORIGIN = "http://localhost:18791"');
  });

  it("installs a root-owned Hosting launcher that restores the exact Tailscale route", () => {
    const launcher = read("scripts/fased-signer-enroll-hosting.sh");
    const installer = read("install.sh");

    expect(launcher).toContain('SIGNER_BIN="/opt/fased/signer/fased-signerd"');
    expect(launcher).toContain('CONTROL_SOCKET="/run/fased-signerd/control.sock"');
    expect(launcher).toContain('UPDATE_GATE="/var/lib/fased-signer-update-gate/active"');
    expect(launcher).toContain(
      'UPDATE_JOURNAL="/var/lib/fased-host-updater/active-signer-transaction.json"',
    );
    expect(launcher).toContain('"$TAILSCALE_BIN" serve get-config "$SNAPSHOT_PATH" --all');
    expect(launcher).toContain('"$TAILSCALE_BIN" serve set-config "$SNAPSHOT_PATH" --all');
    expect(launcher).toContain('--set-path "$PUBLIC_PATH"');
    expect(launcher).toContain("serve get-config --help");
    expect(launcher).toContain("trap cleanup EXIT INT TERM HUP");
    expect(launcher).toContain('"$RUNUSER_BIN" -u "$SIGNER_USER"');
    expect(launcher).toContain('"$ENV_BIN" -i');
    expect(launcher).toContain("ROUTE_CHANGED=1");
    expect(launcher).toContain('"$SYSTEMCTL_BIN" stop fased-host-updater.service');
    expect(launcher).toContain('"$SYSTEMCTL_BIN" start fased-host-updater.service');
    expect(launcher).toContain('UPDATER_STATE_DIR="/var/lib/fased-host-updater"');
    expect(launcher).toContain("Root updater state directory must be root-owned mode 0700");
    expect(launcher).toContain("Hosted enrollment process lock could not be secured");
    expect(launcher).toContain("refuses to run while any Tailscale Funnel route is active");
    expect(launcher).not.toMatch(/fased-gateway|sudoers|\/usr\/bin\/node|source ["']?\/etc\/fased/);

    expect(installer).toContain(
      'install -m 0755 -o root -g root "$FASED_DIR/scripts/fased-signer-enroll-hosting.sh" /usr/local/sbin/fased-signer-enroll',
    );
    expect(installer).toContain("sync -f /usr/local/sbin/fased-signer-enroll");
  });

  it("keeps the one-time secret out of paths, query strings, logs, and temporary files", () => {
    const native = read("tools/fased-signerd/admin_webauthn_enrollment.go");
    const hosting = read("scripts/fased-signer-enroll-hosting.sh");

    expect(native).toContain('io.WriteString(writer, s.origin+s.basePath+"#")');
    expect(native).toContain('request.Header.Get("Authorization")');
    expect(native).toContain("subtle.ConstantTimeCompare");
    expect(native).toContain('request.URL.RawQuery != ""');
    expect(native).toContain('response.Header().Set("Referrer-Policy", "no-referrer")');
    expect(native).toContain('response.Header().Set("Cache-Control", "no-store, max-age=0")');
    expect(hosting).toContain('read -r ENROLLMENT_URL <&"${SIGNER_ENROLLMENT_SERVER[0]}"');
    expect(hosting).toContain("unset ENROLLMENT_URL");
    expect(hosting).not.toMatch(/ENROLLMENT_URL.*>|echo .*ENROLLMENT_URL.*>/);
  });
});
