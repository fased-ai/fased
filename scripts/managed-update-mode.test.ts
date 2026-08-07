import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { selectManagedUpdateMode } from "./fased-managed-updater-core.mjs";

describe("managed update mode", () => {
  const supportedMigration = {
    required: true,
    supported: true,
    reason: "target_controller_required",
  } as const;

  it("routes a clean public stable Local predecessor to the canonical migration", () => {
    expect(
      selectManagedUpdateMode({
        profile: "local",
        currentVersion: "0.1.75",
        migration: supportedMigration,
        consistencyReasons: ["signer_manifest_missing"],
      }),
    ).toEqual({ mode: "migrate-to-protected", reason: "supported_local_bridge" });
  });

  it("rejects mixed control and custody generations before product mutation", () => {
    expect(
      selectManagedUpdateMode({
        profile: "local",
        currentVersion: "0.1.76-rc.50",
        migration: supportedMigration,
        consistencyReasons: [
          "signer_version_mismatch",
          "signer_manifest_missing",
          "last_success_mismatch",
        ],
      }),
    ).toEqual({ mode: "repair-required", reason: "mixed_control_and_custody_generations" });
  });

  it("keeps canonical root-managed profiles on the target-owned transaction", () => {
    for (const profile of ["protected-local", "hosting"]) {
      expect(
        selectManagedUpdateMode({
          profile,
          currentVersion: "1.2.3",
          migration: { required: false, supported: false, reason: "profile_not_local" },
          consistencyReasons: [],
        }),
      ).toEqual({ mode: "root-managed", reason: "canonical_root_profile" });
    }
  });

  it("keeps the development source profile on its existing portable transaction", () => {
    expect(
      selectManagedUpdateMode({
        profile: "source",
        currentVersion: "1.2.3",
        migration: { required: false, supported: false, reason: "profile_not_local" },
        consistencyReasons: [],
      }),
    ).toEqual({ mode: "portable-managed", reason: "development_source_profile" });
  });

  it("fails closed when a required Local bridge is unavailable", () => {
    expect(
      selectManagedUpdateMode({
        profile: "local",
        currentVersion: "0.1.75",
        migration: { required: true, supported: false, reason: "runtime_missing" },
        consistencyReasons: [],
      }),
    ).toEqual({ mode: "repair-required", reason: "runtime_missing" });
  });

  it("enforces the selected repair before acquiring the update lock", () => {
    const source = fs.readFileSync(
      new URL("./fased-managed-updater-core.mjs", import.meta.url),
      "utf8",
    );
    const rejection = source.indexOf(
      'if (initialUpdateSelection.mode === "repair-required") {',
      source.indexOf("async function updateManagedRuntime"),
    );
    const lock = source.indexOf("const releaseLock = await acquireUpdateLock", rejection);
    expect(rejection).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(rejection);
  });
});
