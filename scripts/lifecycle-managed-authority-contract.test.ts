import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  __testing,
  loadManagedAuthorityContract,
  validateManagedAuthorityContract,
} from "./lifecycle-managed-authority-contract.mjs";

function contract() {
  return JSON.parse(readFileSync(__testing.DEFAULT_CONTRACT, "utf8"));
}

describe("managed lifecycle authority contract", () => {
  it("leaves only owner-operated Hosting/Tailscale acceptance as retained blockers", () => {
    const result = loadManagedAuthorityContract();
    expect(result.profileCount).toBe(6);
    expect(result.retainedProfileCount).toBe(5);
    expect(result.deferredProfileCount).toBe(1);
    expect(result.capabilityCount).toBeGreaterThan(25);
    expect(result.blockers).toEqual([
      "hosting-tailscale-install-auth-and-identity",
      "hosting-private-serve",
      "hosting-provider-access-handoff",
      "hosting-firewall-ssh-fail2ban-updates",
      "hosting-root-receipt-and-recovery",
    ]);
    expect(result.blockers).not.toContain("first-install-stage-zero-trust");
    expect(result.blockers).not.toContain("root-owned-managed-runtime-detection");
    expect(result.blockers).not.toContain("managed-third-party-plugin-mutation-fence");
    expect(result.blockers).not.toContain("hosting-authentic-tailscale-h0");
    expect(result.blockers).not.toContain("managed-application-mutation-fence");
    expect(result.blockers).not.toContain("darwin-principals-services-and-peer-auth");
    expect(result.blockers).not.toContain("wsl2-preflight-and-systemd-convergence");
    expect(result.blockers).not.toContain("retained-platform-native-assets");
    expect(result.blockers).not.toContain("unsupported-profile-pre-mutation-enforcement");
  });

  it("binds local command closure to the four promoted managed capabilities", () => {
    const value = contract();
    const capabilities = new Map(
      value.capabilities.map((capability: { id: string; status: string; evidence: string[] }) => [
        capability.id,
        capability,
      ]),
    );
    const expected = {
      "retained-platform-command-acceptance": [
        "scripts/test-lifecycle-local-t2-systemd.sh",
        "tools/fased-lifecycled/platform/t2_systemd_test.go",
      ],
      "managed-repair": [
        "tools/fased-lifecycled/platform/repair_current_test.go",
        "tools/fased-lifecycled/daemon/service_test.go",
      ],
      "managed-uninstall": [
        "tools/fased-lifecycled/platform/managed_uninstall_test.go",
        "tools/fased-lifecycled/hostsecurity/participant_test.go",
      ],
      "authorized-rollback-and-pruning": [
        "scripts/test-lifecycle-local-t2-systemd.sh",
        "tools/fased-lifecycled/platform/t2_systemd_test.go",
      ],
    };

    for (const [id, evidence] of Object.entries(expected)) {
      expect(capabilities.get(id)).toMatchObject({ status: "implemented" });
      expect(capabilities.get(id)?.evidence).toEqual(expect.arrayContaining(evidence));
    }
  });

  it("locks the managed matrix to Linux, WSL2, macOS Local and x64 Hosting", () => {
    const value = contract();
    const retained = value.profiles.filter(
      ({ support }: { support: string }) => support === "retained",
    );
    const deferred = value.profiles.filter(
      ({ support }: { support: string }) => support === "deferred",
    );

    expect(retained).toEqual([
      {
        id: "linux-protected-local",
        support: "retained",
        platforms: ["linux-x64"],
        serviceManager: "systemd",
      },
      {
        id: "linux-arm64-protected-local",
        support: "retained",
        platforms: ["linux-arm64"],
        serviceManager: "systemd",
      },
      {
        id: "wsl2-protected-local",
        support: "retained",
        platforms: ["linux-x64"],
        serviceManager: "systemd",
      },
      {
        id: "linux-hosting",
        support: "retained",
        platforms: ["ubuntu-x64", "rocky-x64"],
        serviceManager: "systemd",
      },
      {
        id: "darwin-protected-local",
        support: "retained",
        platforms: ["darwin-x64", "darwin-arm64"],
        serviceManager: "launchd",
      },
    ]);
    expect(deferred.flatMap(({ platforms }: { platforms: string[] }) => platforms)).toEqual(
      expect.arrayContaining(["ubuntu-arm64", "rocky-arm64"]),
    );
  });

  it("does not mistake developer plugin mutation for a managed transaction", () => {
    const value = contract();
    const developerPlugin = value.capabilities.find(
      ({ id }: { id: string }) => id === "third-party-plugin-transaction",
    );
    const managedPlugin = value.capabilities.find(
      ({ id }: { id: string }) => id === "managed-third-party-plugin-mutation-fence",
    );
    const managedPluginTransaction = value.capabilities.find(
      ({ id }: { id: string }) => id === "managed-third-party-plugin-transaction",
    );

    expect(developerPlugin).toMatchObject({
      boundary: "separate-unprivileged",
      profiles: ["developer-source"],
      status: "separate",
    });
    expect(managedPlugin).toMatchObject({
      boundary: "managed",
      profiles: ["*"],
      status: "implemented",
    });
    expect(managedPluginTransaction).toMatchObject({
      boundary: "managed",
      profiles: ["linux-protected-local", "linux-arm64-protected-local", "linux-hosting"],
      owner: "go-lifecycle",
      status: "implemented",
    });
  });

  it("fails release verification while any managed capability is partial or missing", () => {
    expect(() => loadManagedAuthorityContract(undefined, { release: true })).toThrow(
      "release blockers",
    );
  });

  it("rejects an implemented claim without exact code and evidence paths", () => {
    const value = contract();
    const capability = value.capabilities.find(
      ({ id }: { id: string }) => id === "managed-uninstall",
    );
    capability.status = "implemented";
    capability.implementation = [];
    capability.evidence = [];
    expect(() => validateManagedAuthorityContract(value)).toThrow("lacks code or evidence");
  });

  it("rejects unknown retained profile claims", () => {
    const value = contract();
    value.capabilities[0].profiles = ["windows-native"];
    expect(() => validateManagedAuthorityContract(value)).toThrow("unknown profile");
  });
});
