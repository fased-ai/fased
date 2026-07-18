import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { __testing } from "./migrate-hosted-signer-v2.mjs";

const source = fs.readFileSync(new URL("./migrate-hosted-signer-v2.mjs", import.meta.url), "utf8");

describe("hosted signer v2 migration wrapper", () => {
  it("executes only the fixed verified native signer command", () => {
    expect(__testing.SIGNER_BINARY).toBe("/opt/fased/signer/fased-signerd");
    expect(__testing.FIXED_ARGS).toEqual([
      "admin",
      "migration",
      "hosted-v1",
      "--control-socket",
      "/run/fased-signerd/control.sock",
      "--policy-file",
      "/etc/fased/signer-migration-policies.json",
      "--app-home",
      "/home/app",
      "--legacy-signer-home",
      "/home/fased-signer",
      "--state-dir",
      "/var/lib/fased-signerd",
      "--marker-file",
      "/var/lib/fased-host-updater/signer-v1-migration.pending",
    ]);
  });

  it("accepts only the non-secret prepare or commit phase", () => {
    expect(__testing.resolvePhase(["node", "script", "prepare"])).toBe("prepare");
    expect(__testing.resolvePhase(["node", "script", "commit"])).toBe("commit");
    expect(() => __testing.resolvePhase(["node", "script", "/home/app/.fased/wallet/x"])).toThrow(
      "usage",
    );
    expect(() => __testing.resolvePhase(["node", "script", "prepare", "extra"])).toThrow("usage");
  });

  it("cannot open, copy, read, quarantine, or transport legacy key material", () => {
    expect(source).not.toContain('from "node:fs"');
    expect(source).not.toContain('from "node:fs/promises"');
    expect(source).not.toContain('from "node:net"');
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("copyFile");
    expect(source).not.toContain("openVerifiedSourceFile");
    expect(source).not.toContain("quarantineLegacyFile");
    expect(source).not.toContain("passphrasePath");
    expect(source).not.toContain("keystorePath");
  });
});
