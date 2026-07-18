import fs from "node:fs";
import { describe, expect, it } from "vitest";

const updater = fs.readFileSync(new URL("./docker-signer-update.sh", import.meta.url), "utf8");

describe("Docker signer update recovery set", () => {
  it("snapshots and verifies every wallet and Gateway persistence domain", () => {
    expect(updater).toContain('SECRETS_ARCHIVE_NAME="signer-secrets.tar"');
    expect(updater).toContain('CONFIG_ARCHIVE_NAME="gateway-config.tar"');
    expect(updater).toContain('WORKSPACE_ARCHIVE_NAME="gateway-workspace.tar"');
    expect(updater).toContain("format=fased-docker-signer-snapshot-v4");
    expect(updater).toMatch(/snapshot_state_archive\s+\\?\s*"\$secrets_volume"/u);
    expect(updater).toContain('snapshot_bind_archive "$config_dir"');
    expect(updater).toMatch(/snapshot_bind_archive\s+\\?\s*"\$workspace_dir"/u);
  });

  it("restores all four persistence domains before restarting the old runtime", () => {
    expect(updater).toMatch(/restore_state_archive\s+\\?\s*"\$secrets_volume"/u);
    expect(updater).toMatch(/restore_bind_archive\s+\\?\s*"\$config_dir"/u);
    expect(updater).toMatch(/restore_bind_archive\s+\\?\s*"\$workspace_dir"/u);
    const workspaceRestore = updater.search(/restore_bind_archive\s+\\?\s*"\$workspace_dir"/u);
    const restart = updater.search(/activate_current_runtime\s+\\?\s*"\$old_version"/u);
    expect(workspaceRestore).toBeGreaterThan(0);
    expect(workspaceRestore).toBeLessThan(restart);
  });
});
