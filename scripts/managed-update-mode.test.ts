import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  __testing,
  run,
  selectInstalledUpdateOwner,
  selectManagedUpdateMode,
} from "./fased-managed-updater-core.mjs";

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
    const entry = source.indexOf("async function updateManagedRuntime");
    const inspection = source.indexOf("inspectManagedInstallManifest", entry);
    const rejection = source.indexOf('if (initialUpdatePlan.operation === "repair") {', entry);
    const lock = source.indexOf("const releaseLock = await acquireUpdateLock", rejection);
    expect(inspection).toBeGreaterThan(entry);
    expect(rejection).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(rejection);
  });

  it("never lets a production installation fall back to the portable mutation engine", () => {
    const lifecycle = {
      instance: "0123456789abcdef",
      config: "/var/lib/fased-local/0123456789abcdef/lifecycle/platform.json",
      supervisor: "/opt/fased/lifecycle/supervisor-v1/fased-lifecycled",
    };

    expect(selectInstalledUpdateOwner({ profile: "protected-local", lifecycle })).toEqual({
      mode: "generation",
    });
    expect(selectInstalledUpdateOwner({ profile: "hosting", lifecycle })).toEqual({
      mode: "generation",
    });
    expect(selectInstalledUpdateOwner({ profile: "source", lifecycle: null })).toEqual({
      mode: "portable-development",
    });
    expect(selectInstalledUpdateOwner({ profile: "local", lifecycle: null })).toEqual({
      mode: "bootstrap-required",
      reason: "lifecycle_supervisor_missing",
    });
    for (const profile of ["protected-local", "hosting"]) {
      expect(selectInstalledUpdateOwner({ profile, lifecycle: null })).toEqual({
        mode: "repair-required",
        reason: "lifecycle_supervisor_missing",
      });
    }
  });

  it("uses the canonical hosted artifact base for generation updates", () => {
    const source = fs.readFileSync(
      new URL("./fased-managed-updater-core.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "process.env.FASED_HOSTED_ARTIFACT_BASE_URL || DEFAULT_RELEASE_BASE_URL",
    );
    expect(source).not.toContain("process.env.FASED_RELEASE_BASE_URL");
  });

  it("preserves the established Already current CLI contract", () => {
    const source = fs.readFileSync(
      new URL("./fased-managed-updater-core.mjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("Already current: ${result.version}");
    expect(source).not.toContain("Already current: Fased ${result.version}");
  });

  it("honors the direct administrator exit when a descendant retains its output pipe", async () => {
    const startedAt = Date.now();
    const result = await __testing.runInteractiveAdministrator(
      "/bin/sh",
      ["-c", "(sleep 5) & printf 'exact\\n'"],
      { timeoutMs: 4_000 },
    );
    expect(result).toMatchObject({ ok: true, code: 0, signal: null, timedOut: false });
    expect(result.stdout).toBe("exact\n");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("returns the one-time Local bootstrap without mutating pre-supervisor state", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-update-owner-"));
    const previousStateDir = process.env.FASED_STATE_DIR;
    try {
      process.env.FASED_STATE_DIR = root;
      const sentinel = path.join(root, "wallet-state-preserved");
      await fsp.writeFile(sentinel, "exact\n", { mode: 0o600 });
      await fsp.writeFile(
        path.join(root, "install.json"),
        `${JSON.stringify({
          schemaVersion: 2,
          profile: "local",
          updateChannel: "stable",
          runtime: { activeVersion: "1.0.0" },
        })}\n`,
        { mode: 0o600 },
      );

      await expect(run(["update"])).rejects.toThrow(
        "Lifecycle bootstrap required: run the official Local installer once",
      );
      await expect(fsp.readFile(sentinel, "utf8")).resolves.toBe("exact\n");
      await expect(fsp.stat(path.join(root, "update.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.FASED_STATE_DIR;
      } else {
        process.env.FASED_STATE_DIR = previousStateDir;
      }
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the offline protected Local fixture on the production generation initializer", () => {
    const fixture = fs.readFileSync(
      new URL("./docker/protected-local-systemd/run.sh", import.meta.url),
      "utf8",
    );
    const shim = fixture.slice(
      fixture.indexOf("cat >/usr/local/libexec/fased-fixture-protected-installer.sh"),
      fixture.indexOf("EOF_PROTECTED_INSTALLER", fixture.indexOf("EOF_PROTECTED_INSTALLER") + 1),
    );
    expect(shim).toContain("bootstrap_result=");
    expect(shim).toContain('NODE_PATH="$root_store/verified-dependencies/node_modules"');
    expect(shim).toContain('"$release_root/scripts/generation-updater.mjs" initialize');
    expect(shim.indexOf('generation-updater.mjs" initialize')).toBeGreaterThan(
      shim.indexOf("protected-local-bootstrap.mjs install"),
    );
    expect(shim).not.toContain(
      'exec "\\${values[--protected-local-node-binary]}" \\\n+  /repo/scripts/protected-local-bootstrap.mjs install',
    );
  });

  it("retries a controller socket handoff that closes during generation replacement", () => {
    for (const fixturePath of [
      "./docker/protected-local-systemd/run.sh",
      "./docker/hosting-systemd/run.sh",
    ]) {
      const fixture = fs.readFileSync(new URL(fixturePath, import.meta.url), "utf8");
      const closeHandler = fixture.slice(
        fixture.indexOf('socket.once("close"'),
        fixture.indexOf("async function requestWithRetry"),
      );
      expect(closeHandler).toContain('error.code = "ECONNRESET"');
      expect(fixture).toContain('new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"])');
    }
  });
});
