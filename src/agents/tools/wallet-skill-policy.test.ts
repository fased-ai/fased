import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../../config/config.js";
import {
  enforceWalletSkillAccessEnabled,
  enforceWalletSkillPolicy,
  readSkillWalletActionPermissions,
} from "./wallet-skill-policy.js";

async function writeClawHubOrigin(params: {
  workspaceDir: string;
  skillId: string;
  registry: string;
}) {
  const dir = path.join(params.workspaceDir, "skills", params.skillId, ".clawhub");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "origin.json"),
    `${JSON.stringify(
      {
        version: 1,
        registry: params.registry,
        slug: params.skillId,
        installedVersion: "1.0.0",
        installedAt: Date.now(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function cfgWithWalletGrant(skillId: string, extra?: Partial<FasedAgentConfig>): FasedAgentConfig {
  return {
    agents: {
      list: [{ id: "owner", default: true, workspace: extra?.agents?.list?.[0]?.workspace }],
    },
    skills: {
      marketplace: extra?.skills?.marketplace,
      entries: {
        [skillId]: {
          config: {
            walletActions: {
              actions: ["quote", "swap"],
              roles: ["agent"],
              walletIds: ["agent-1"],
              chains: ["solana"],
              inputMints: ["So11111111111111111111111111111111111111112"],
              outputMints: ["TokenMint1111111111111111111111111111111111"],
              maxAmount: "100000000",
              maxSlippageBps: 50,
              autonomous: true,
            },
          },
        },
      },
    },
  } as FasedAgentConfig;
}

function enforce(params: {
  cfg?: FasedAgentConfig;
  skillId: string;
  autonomous?: boolean;
  scheduled?: boolean;
  amount?: string;
}) {
  return enforceWalletSkillPolicy({
    cfg: params.cfg,
    permissions: readSkillWalletActionPermissions(params.cfg, params.skillId),
    requesterAgentId: "owner",
    requesterSkillId: params.skillId,
    action: "swap",
    role: "agent",
    walletId: "agent-1",
    chain: "solana",
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "TokenMint1111111111111111111111111111111111",
    amount: params.amount ?? "100000000",
    slippageBps: 50,
    autonomous: params.autonomous ?? true,
    scheduled: params.scheduled ?? false,
    requireManifest: true,
  });
}

describe("wallet skill policy", () => {
  it("requires the selected wallet policy to allow skill access", () => {
    const wallet = {
      policy: { skillsEnabled: false },
    } as never;

    expect(() =>
      enforceWalletSkillAccessEnabled({ wallet, requesterSkillId: "daily-dca" }),
    ).toThrow("wallet_action_skill_wallet_disabled");
    expect(() =>
      enforceWalletSkillAccessEnabled({
        wallet: { policy: { skillsEnabled: true } } as never,
        requesterSkillId: "daily-dca",
      }),
    ).not.toThrow();
    expect(() => enforceWalletSkillAccessEnabled({ wallet, requesterSkillId: null })).not.toThrow();
  });

  it("requires an explicit walletActions grant for skill wallet actions", async () => {
    await expect(enforce({ cfg: {}, skillId: "daily-dca" })).rejects.toThrow(
      "wallet_action_skill_manifest_required",
    );
  });

  it("rejects invalid skill IDs before checking origin metadata", async () => {
    const cfg = cfgWithWalletGrant("../daily-dca");
    await expect(enforce({ cfg, skillId: "../daily-dca" })).rejects.toThrow(
      "wallet_action_skill_invalid_id",
    );
  });

  it("allows custom local skills only after an explicit narrow walletActions grant", async () => {
    const cfg = cfgWithWalletGrant("daily-dca");
    await expect(enforce({ cfg, skillId: "daily-dca" })).resolves.toBeUndefined();
  });

  it("rejects agent wallets that are outside the skill wallet allowlist", async () => {
    const cfg = cfgWithWalletGrant("daily-dca");
    await expect(
      enforceWalletSkillPolicy({
        cfg,
        permissions: readSkillWalletActionPermissions(cfg, "daily-dca"),
        requesterAgentId: "owner",
        requesterSkillId: "daily-dca",
        action: "swap",
        role: "agent",
        walletId: "agent-2",
        chain: "solana",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "TokenMint1111111111111111111111111111111111",
        amount: "1",
        slippageBps: 50,
        autonomous: true,
        scheduled: false,
        requireManifest: true,
      }),
    ).rejects.toThrow("wallet_action_skill_wallet_not_allowed");
  });

  it("requires each skill wallet grant to name allowed agent wallet ids", async () => {
    const cfg = cfgWithWalletGrant("daily-dca");
    const grant = cfg.skills?.entries?.["daily-dca"]?.config?.walletActions as
      | Record<string, unknown>
      | undefined;
    if (grant) {
      delete grant.walletIds;
    }
    await expect(enforce({ cfg, skillId: "daily-dca" })).rejects.toThrow(
      "wallet_action_skill_wallet_required",
    );
  });

  it("allows installed ClawHub skills from the default trusted registry", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skill-origin-"));
    try {
      await writeClawHubOrigin({
        workspaceDir,
        skillId: "daily-dca",
        registry: "https://clawhub.com/",
      });
      const cfg = cfgWithWalletGrant("daily-dca", {
        agents: { list: [{ id: "owner", default: true, workspace: workspaceDir }] },
      });
      await expect(enforce({ cfg, skillId: "daily-dca" })).resolves.toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects installed skills from registries outside the configured source allowlist", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-skill-origin-"));
    try {
      await writeClawHubOrigin({
        workspaceDir,
        skillId: "daily-dca",
        registry: "https://evil.example.com",
      });
      const cfg = cfgWithWalletGrant("daily-dca", {
        agents: { list: [{ id: "owner", default: true, workspace: workspaceDir }] },
        skills: { marketplace: { allowRegistries: ["https://clawhub.com"] } },
      });
      await expect(enforce({ cfg, skillId: "daily-dca" })).rejects.toThrow(
        "wallet_action_skill_registry_not_allowlisted",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("enforces skill action, amount, slippage, and autonomous caps", async () => {
    const cfg = cfgWithWalletGrant("daily-dca");

    await expect(enforce({ cfg, skillId: "daily-dca", amount: "100000001" })).rejects.toThrow(
      "wallet_action_skill_amount_cap_exceeded",
    );
    await expect(
      enforceWalletSkillPolicy({
        cfg,
        permissions: readSkillWalletActionPermissions(cfg, "daily-dca"),
        requesterAgentId: "owner",
        requesterSkillId: "daily-dca",
        action: "send",
        role: "agent",
        walletId: "agent-1",
        chain: "solana",
        amount: "1",
        autonomous: true,
        scheduled: false,
        requireManifest: true,
      }),
    ).rejects.toThrow("wallet_action_skill_action_not_allowed");
    await expect(
      enforceWalletSkillPolicy({
        cfg,
        permissions: readSkillWalletActionPermissions(cfg, "daily-dca"),
        requesterAgentId: "owner",
        requesterSkillId: "daily-dca",
        action: "swap",
        role: "agent",
        walletId: "agent-1",
        chain: "solana",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "TokenMint1111111111111111111111111111111111",
        amount: "1",
        slippageBps: 51,
        autonomous: true,
        scheduled: false,
        requireManifest: true,
      }),
    ).rejects.toThrow("wallet_action_skill_slippage_cap_exceeded");
  });
});
