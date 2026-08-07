import { describe, expect, it } from "vitest";
import {
  legacyModeForManagedUpdatePlan,
  selectManagedUpdatePlan,
} from "./managed-update-contract.mjs";

describe("managed update ownership contract", () => {
  it.each([
    ["protected-local", "local-systemd"],
    ["hosting", "hosting-systemd"],
  ])("routes canonical %s through the target controller", (profile, adapter) => {
    const selected = selectManagedUpdatePlan({ profile });
    expect(selected).toMatchObject({
      adapter,
      operation: "update",
      mutationOwner: "target-controller",
    });
    expect(legacyModeForManagedUpdatePlan(selected)).toBe("root-managed");
  });

  it("routes a supported public Local topology through one protected bootstrap", () => {
    const selected = selectManagedUpdatePlan({
      profile: "local",
      migration: { required: true, supported: true },
      consistencyReasons: ["signer_manifest_missing"],
    });
    expect(selected).toMatchObject({
      adapter: "local-systemd",
      operation: "bootstrap-protected",
      mutationOwner: "target-controller",
      reason: "supported_local_bridge",
    });
  });

  it("routes mixed control and custody generations to explicit repair", () => {
    const selected = selectManagedUpdatePlan({
      profile: "local",
      migration: { required: true, supported: true },
      consistencyReasons: ["last_success_mismatch", "signer_version_mismatch"],
    });
    expect(selected).toMatchObject({
      operation: "repair",
      mutationOwner: "none",
      reason: "mixed_control_and_custody_generations",
    });
    expect(legacyModeForManagedUpdatePlan(selected)).toBe("repair-required");
  });

  it("does not infer a Local topology from an unknown profile", () => {
    expect(selectManagedUpdatePlan({ profile: "future-profile" })).toMatchObject({
      operation: "repair",
      adapter: null,
      mutationOwner: "none",
      reason: "unsupported_managed_profile",
    });
  });
});
