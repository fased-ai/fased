import { describe, expect, it } from "vitest";
import { resolveWalletRuntimeConfig } from "../../wallet/wallet-runtime-config.js";
import {
  enforceWalletSkillAccessEnabled,
  enforceWalletSkillPolicy,
  readSkillWalletActionPermissions,
} from "./wallet-skill-policy.js";

describe("removed skill wallet authority", () => {
  it("ignores every legacy walletActions grant", () => {
    expect(
      readSkillWalletActionPermissions(
        {
          skills: {
            entries: {
              local: {
                config: {
                  walletActions: {
                    actions: ["send"],
                    roles: ["agent"],
                    walletIds: ["agent"],
                  },
                },
              },
            },
          },
        },
        "local",
      ),
    ).toBeNull();
  });

  it("denies wallet access whenever a skill-file identity is present", async () => {
    const wallet = resolveWalletRuntimeConfig({
      wallet: {
        enabled: true,
        runtime: {
          policy: { skillsEnabled: true },
          toolAccess: { mode: "all", allowSkills: ["local"] },
        },
      },
    });
    expect(() => enforceWalletSkillAccessEnabled({ wallet, requesterSkillId: "local" })).toThrow(
      "wallet_action_skill_authority_removed",
    );
    await expect(
      enforceWalletSkillPolicy({
        permissions: null,
        requesterSkillId: "local",
        action: "send",
        autonomous: false,
        scheduled: false,
        requireManifest: false,
      }),
    ).rejects.toThrow("wallet_action_skill_authority_removed");
  });

  it("leaves non-skill owner and typed-adapter paths to their own policies", async () => {
    const wallet = resolveWalletRuntimeConfig({ wallet: { enabled: true } });
    expect(() => enforceWalletSkillAccessEnabled({ wallet, requesterSkillId: null })).not.toThrow();
    await expect(
      enforceWalletSkillPolicy({
        permissions: null,
        requesterSkillId: null,
        action: "prepare",
        autonomous: false,
        scheduled: false,
        requireManifest: false,
      }),
    ).resolves.toBeUndefined();
  });
});
