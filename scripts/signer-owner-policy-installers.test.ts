import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("signer owner-policy package and installers", () => {
  it("ships every helper, fixed-profile wrapper, and inactive template", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[] };
    const releaseCheck = read("scripts/release-check.ts");
    const requiredScripts = [
      "scripts/fased-signer-owner-policy.mjs",
      "scripts/fased-signer-policy-local.sh",
      "scripts/fased-signer-policy-hosting.sh",
    ];

    expect(pkg.files).toContain("config/");
    for (const script of requiredScripts) {
      expect(pkg.files).toContain(script);
      expect(releaseCheck).toContain(`"${script}"`);
    }
    for (const role of ["agent", "mining", "vault"]) {
      const template = read(`config/signer-policies/${role}.json.template`);
      expect(template).toContain("REPLACE_WITH_");
    }
  });

  it("installs Local owner tools only after the signer artifact is authenticated", () => {
    const installer = read("scripts/install-fased-signerd.sh");
    const updater = read("scripts/fased-managed-updater.mjs");
    const signerInstall = installer.indexOf('node "$UPDATER" "${args[@]}"');
    const policyInstall = installer.indexOf(
      'install -m 0700 "$POLICY_HELPER_SOURCE" "$POLICY_HELPER_PATH"',
    );

    expect(updater).toContain("downloadVerifiedLocalSignerRelease");
    expect(updater).toContain("atomicInstallSignerBinary");
    expect(updater).toContain("await verifyOfficialAsset(candidatePath, targetVersion, timeoutMs)");
    expect(updater).toContain("await verifyOfficialAsset(manifestPath, targetVersion, timeoutMs)");
    expect(signerInstall).toBeGreaterThan(0);
    expect(policyInstall).toBeGreaterThan(signerInstall);
    expect(installer).toContain('POLICY_LAUNCHER_PATH="${INSTALL_DIR}/fased-signer-policy"');
    expect(installer).toContain('install -m 0700 "$POLICY_LAUNCHER_SOURCE"');
    expect(installer).toContain("for template in README.md agent.json.template");
    expect(updater).toContain("await fsp.link(paths.binaryPath, enrollTemporary)");
    expect(installer).toContain("Fresh signer-owned wallets receive their versioned Agent");
    expect(installer).toContain("copying a template never applies it");
    expect(installer.match(/--initial-install/gu) ?? []).toHaveLength(0);
  });

  it("installs Hosting owner tools at root-owned fixed paths without Gateway delegation", () => {
    const installer = read("install.sh");

    expect(installer).toContain(
      'install -m 0700 -o root -g root "$FASED_DIR/scripts/fased-signer-owner-policy.mjs" /usr/local/libexec/fased-signer-owner-policy.mjs',
    );
    expect(installer).toContain(
      'install -m 0755 -o root -g root "$FASED_DIR/scripts/fased-signer-policy-hosting.sh" /usr/local/sbin/fased-signer-policy',
    );
    expect(installer).toContain(
      "install -d -m 0755 -o root -g root /usr/local/share/fased/signer-policies",
    );
    expect(installer).toContain("sync -f /usr/local/sbin/fased-signer-policy");
    expect(installer).toContain("Normal setup does not require a");
    expect(installer).toContain("root policy or network helper");
    expect(installer).not.toMatch(/sudoers[^\n]*fased-signer-policy/u);
    expect(installer.match(/--initial-install/gu) ?? []).toHaveLength(0);
  });

  it("pins each installed wrapper to one profile and rejects caller-selected profiles", () => {
    const local = read("scripts/fased-signer-policy-local.sh");
    const hosting = read("scripts/fased-signer-policy-hosting.sh");

    expect(local).toContain('exec node "$HELPER" --profile local "$@"');
    expect(local).toContain('if [[ "${EUID}" == "0" ]]');
    expect(local).not.toContain("FASED_SIGNER_POLICY_PROFILE");
    expect(hosting).toContain('HELPER="/usr/local/libexec/fased-signer-owner-policy.mjs"');
    expect(hosting).toContain('exec "$NODE_BIN" "$HELPER" --profile hosting "$@"');
    expect(hosting).toContain('if [[ "${EUID}" != "0" ]]');
    expect(hosting).toContain(
      'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    );
    expect(hosting).toContain("single-link root-owned non-writable file");
    expect(hosting).not.toMatch(/FASED_SIGNER_POLICY_PROFILE|fased-gateway|sudoers/u);
  });

  it("keeps the Local control socket and durable signer state across managed restarts", () => {
    const startup = read("scripts/start-managed.sh");

    expect(startup).toContain(
      'SIGNERD_CONTROL_SOCKET="${FASED_WALLET_LOCAL_SIGNER_CONTROL_SOCKET:-$SIGNERD_MATERIAL_DIR/local-signer-control.sock}"',
    );
    expect(startup).toContain(
      'SIGNERD_STATE_DB="${FASED_WALLET_LOCAL_SIGNER_STATE_DB:-$SIGNERD_MATERIAL_DIR/signerd-v2.db}"',
    );
    expect(startup).toContain(
      'SIGNERD_MASTER_KEY="${FASED_WALLET_LOCAL_SIGNER_MASTER_KEY:-$SIGNERD_MATERIAL_DIR/signerd-v2.master.key}"',
    );
    expect(startup).toContain('-control-socket "$SIGNERD_CONTROL_SOCKET"');
    expect(startup).toContain('-state-db "$SIGNERD_STATE_DB"');
    expect(startup).toContain('-master-key "$SIGNERD_MASTER_KEY"');
    expect(startup).toContain(
      '[[ "$active_count" == "1" && -S "$SIGNERD_SOCKET" && -S "$SIGNERD_CONTROL_SOCKET" ]]',
    );
  });
});
