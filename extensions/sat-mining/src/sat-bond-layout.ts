import fs from "node:fs";
import path from "node:path";
import { SAT_RUNTIME_DEFAULTS } from "fased/plugin-sdk/sat-runtime";

export type SatBondPositionLayoutSpec = {
  accountName: string;
  discriminator: number;
  accountHeaderSize: number;
  bodySize: number;
  accountSize: number;
  pdaSeed: string;
  thresholds?: {
    basicMinRaw: string;
    operatorMinRaw: string;
  };
  offsets: {
    version: number;
    status: number;
    tier: number;
    bump?: number;
    policyVersion?: number;
    authority: number;
    bondMint: number;
    bondVault: number;
    amountRaw: number;
    createdAtSlot: number;
    updatedAtSlot: number;
    unlockRequestedAtSlot: number;
    unlockAvailableAtSlot: number;
  };
  status: {
    inactive: number;
    active: number;
    unlocking: number;
    unlocked: number;
  };
  tier: {
    none: number;
    basic: number;
    operator: number;
  };
};

export type SatBondTierPolicyLayoutSpec = {
  accountName: string;
  discriminator: number;
  accountHeaderSize: number;
  bodySize: number;
  accountSize: number;
  pdaSeed: string;
  defaults: {
    basicMinRaw: string;
    operatorMinRaw: string;
    unlockDelaySlots: string;
  };
  offsets: {
    version: number;
    bump: number;
    policyVersion: number;
    basicMinRaw: number;
    operatorMinRaw: number;
    unlockDelaySlots: number;
    scheduledEffectiveSlot: number;
    lastUpdatedSlot: number;
    updateAuthority: number;
  };
};

export type SatBondStakingDistributorLayoutSpec = {
  accountName: string;
  discriminator: number;
  accountHeaderSize: number;
  bodySize: number;
  accountSize: number;
  pdaSeed: string;
  rewardIndexScale: string;
  offsets: {
    version: number;
    bump: number;
    status: number;
    policyVersion: number;
    rewardMint: number;
    rewardVault: number;
    updateAuthority: number;
    minStakeRaw: number;
    totalActiveStakeRaw: number;
    rewardIndexFp: number;
    observedRewardVaultRaw: number;
    lastSyncedSlot: number;
    unallocatedRewardRaw: number;
    fractionalRemainderFp: number;
  };
};

export type SatBondStakingPositionLayoutSpec = {
  accountName: string;
  discriminator: number;
  accountHeaderSize: number;
  bodySize: number;
  accountSize: number;
  pdaSeed: string;
  offsets: {
    version: number;
    status: number;
    bump: number;
    policyVersion: number;
    authority: number;
    bondPosition: number;
    activeStakeRaw: number;
    claimableRewardRaw: number;
    rewardDebtFp: number;
    lastSyncedSlot: number;
    fractionalRemainderFp: number;
  };
};

export type SatBondLayoutSpec = SatBondPositionLayoutSpec;

let cachedLayout: { mode: "legacy" | "dedicated"; value: SatBondPositionLayoutSpec } | null = null;
let cachedPolicyLayout: SatBondTierPolicyLayoutSpec | null = null;
let cachedStakingDistributorLayout: SatBondStakingDistributorLayoutSpec | null = null;
let cachedStakingPositionLayout: SatBondStakingPositionLayoutSpec | null = null;

const LEGACY_FALLBACK_LAYOUT: SatBondPositionLayoutSpec = {
  accountName: "SatBondPositionState",
  accountHeaderSize: 8,
  bodySize: 184,
  accountSize: 192,
  discriminator: 139,
  pdaSeed: "sat_bond_position",
  thresholds: {
    basicMinRaw: "2500000000000",
    operatorMinRaw: "50000000000000",
  },
  status: {
    inactive: 0,
    active: 1,
    unlocking: 2,
    unlocked: 3,
  },
  tier: {
    none: 0,
    basic: 1,
    operator: 2,
  },
  offsets: {
    version: 0,
    status: 1,
    tier: 2,
    authority: 8,
    bondMint: 40,
    bondVault: 72,
    amountRaw: 104,
    createdAtSlot: 112,
    updatedAtSlot: 120,
    unlockRequestedAtSlot: 128,
    unlockAvailableAtSlot: 136,
  },
};

const DEDICATED_FALLBACK_LAYOUT: SatBondPositionLayoutSpec = {
  accountName: "BondPositionState",
  accountHeaderSize: 8,
  bodySize: 184,
  accountSize: 192,
  discriminator: 140,
  pdaSeed: "sat_bond_position",
  status: {
    inactive: 0,
    active: 1,
    unlocking: 2,
    unlocked: 3,
  },
  tier: {
    none: 0,
    basic: 1,
    operator: 2,
  },
  offsets: {
    version: 0,
    status: 1,
    tier: 2,
    bump: 3,
    policyVersion: 4,
    authority: 8,
    bondMint: 40,
    bondVault: 72,
    amountRaw: 104,
    createdAtSlot: 112,
    updatedAtSlot: 120,
    unlockRequestedAtSlot: 128,
    unlockAvailableAtSlot: 136,
  },
};

const DEDICATED_FALLBACK_POLICY_LAYOUT: SatBondTierPolicyLayoutSpec = {
  accountName: "BondTierPolicyState",
  accountHeaderSize: 8,
  bodySize: 136,
  accountSize: 144,
  discriminator: 141,
  pdaSeed: "sat_bond_tier_policy",
  defaults: {
    basicMinRaw: "2500000000000",
    operatorMinRaw: "50000000000000",
    unlockDelaySlots: "216000",
  },
  offsets: {
    version: 0,
    bump: 1,
    policyVersion: 8,
    basicMinRaw: 16,
    operatorMinRaw: 24,
    unlockDelaySlots: 32,
    scheduledEffectiveSlot: 40,
    lastUpdatedSlot: 48,
    updateAuthority: 56,
  },
};

const DEDICATED_FALLBACK_STAKING_DISTRIBUTOR_LAYOUT: SatBondStakingDistributorLayoutSpec = {
  accountName: "BondStakingDistributorState",
  accountHeaderSize: 8,
  bodySize: 224,
  accountSize: 232,
  discriminator: 142,
  pdaSeed: "sat_bond_staking_distributor",
  rewardIndexScale: "1000000000000000000",
  offsets: {
    version: 0,
    bump: 1,
    status: 2,
    policyVersion: 8,
    rewardMint: 16,
    rewardVault: 48,
    updateAuthority: 80,
    minStakeRaw: 112,
    totalActiveStakeRaw: 120,
    rewardIndexFp: 128,
    observedRewardVaultRaw: 144,
    lastSyncedSlot: 152,
    unallocatedRewardRaw: 160,
    fractionalRemainderFp: 168,
  },
};

const DEDICATED_FALLBACK_STAKING_POSITION_LAYOUT: SatBondStakingPositionLayoutSpec = {
  accountName: "BondStakingPositionState",
  accountHeaderSize: 8,
  bodySize: 192,
  accountSize: 200,
  discriminator: 143,
  pdaSeed: "sat_bond_staking_position",
  offsets: {
    version: 0,
    status: 1,
    bump: 2,
    policyVersion: 8,
    authority: 16,
    bondPosition: 48,
    activeStakeRaw: 80,
    claimableRewardRaw: 88,
    rewardDebtFp: 96,
    lastSyncedSlot: 112,
    fractionalRemainderFp: 120,
  },
};

function hasDedicatedBondProgram(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    String(env.FASED_SAT_BOND_PROGRAM_ID ?? "").trim().length > 0 ||
    String(SAT_RUNTIME_DEFAULTS?.bondProgramId ?? "").length > 0
  );
}

function assertDedicatedBondProgramConfigured(env: NodeJS.ProcessEnv = process.env): void {
  if (!hasDedicatedBondProgram(env)) {
    throw new Error("legacy monolithic SAT bond mode is disabled; set FASED_SAT_BOND_PROGRAM_ID");
  }
}

function resolveLayoutPath(env: NodeJS.ProcessEnv = process.env): string | null {
  assertDedicatedBondProgramConfigured(env);
  const explicit = String(env.FASED_SAT_BOND_LAYOUT_PATH ?? "").trim();
  const candidates = explicit
    ? [explicit]
    : [
        path.resolve(
          process.cwd(),
          "..",
          "..",
          "token",
          "sat",
          "bond-api",
          "bond-position-layout.json",
        ),
        path.resolve(process.cwd(), "token", "sat", "bond-api", "bond-position-layout.json"),
        path.resolve(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "..",
          "..",
          "token",
          "sat",
          "bond-api",
          "bond-position-layout.json",
        ),
      ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePolicyLayoutPath(env: NodeJS.ProcessEnv = process.env): string | null {
  assertDedicatedBondProgramConfigured(env);
  const explicit = String(env.FASED_SAT_BOND_POLICY_LAYOUT_PATH ?? "").trim();
  const candidates = [
    explicit,
    path.resolve(
      process.cwd(),
      "..",
      "..",
      "token",
      "sat",
      "bond-api",
      "bond-tier-policy-layout.json",
    ),
    path.resolve(process.cwd(), "token", "sat", "bond-api", "bond-tier-policy-layout.json"),
    path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "token",
      "sat",
      "bond-api",
      "bond-tier-policy-layout.json",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveStakingDistributorLayoutPath(env: NodeJS.ProcessEnv = process.env): string | null {
  assertDedicatedBondProgramConfigured(env);
  const explicit = String(env.FASED_SAT_BOND_STAKING_DISTRIBUTOR_LAYOUT_PATH ?? "").trim();
  const candidates = [
    explicit,
    path.resolve(
      process.cwd(),
      "..",
      "..",
      "token",
      "sat",
      "bond-api",
      "bond-staking-distributor-layout.json",
    ),
    path.resolve(process.cwd(), "token", "sat", "bond-api", "bond-staking-distributor-layout.json"),
    path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "token",
      "sat",
      "bond-api",
      "bond-staking-distributor-layout.json",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveStakingPositionLayoutPath(env: NodeJS.ProcessEnv = process.env): string | null {
  assertDedicatedBondProgramConfigured(env);
  const explicit = String(env.FASED_SAT_BOND_STAKING_POSITION_LAYOUT_PATH ?? "").trim();
  const candidates = [
    explicit,
    path.resolve(
      process.cwd(),
      "..",
      "..",
      "token",
      "sat",
      "bond-api",
      "bond-staking-position-layout.json",
    ),
    path.resolve(process.cwd(), "token", "sat", "bond-api", "bond-staking-position-layout.json"),
    path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "..",
      "token",
      "sat",
      "bond-api",
      "bond-staking-position-layout.json",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function loadSatBondLayout(env: NodeJS.ProcessEnv = process.env): SatBondPositionLayoutSpec {
  assertDedicatedBondProgramConfigured(env);
  const mode = "dedicated";
  if (cachedLayout?.mode === mode) {
    return cachedLayout.value;
  }
  const layoutPath = resolveLayoutPath(env);
  if (layoutPath) {
    const loaded = JSON.parse(fs.readFileSync(layoutPath, "utf-8")) as SatBondPositionLayoutSpec;
    cachedLayout = { mode, value: loaded };
    return loaded;
  }
  cachedLayout = { mode, value: DEDICATED_FALLBACK_LAYOUT };
  return DEDICATED_FALLBACK_LAYOUT;
}

export function loadSatBondPolicyLayout(
  env: NodeJS.ProcessEnv = process.env,
): SatBondTierPolicyLayoutSpec {
  assertDedicatedBondProgramConfigured(env);
  if (cachedPolicyLayout) {
    return cachedPolicyLayout;
  }
  const layoutPath = resolvePolicyLayoutPath(env);
  if (layoutPath) {
    cachedPolicyLayout = JSON.parse(
      fs.readFileSync(layoutPath, "utf-8"),
    ) as SatBondTierPolicyLayoutSpec;
    return cachedPolicyLayout;
  }
  cachedPolicyLayout = DEDICATED_FALLBACK_POLICY_LAYOUT;
  return cachedPolicyLayout;
}

export function loadSatBondStakingDistributorLayout(
  env: NodeJS.ProcessEnv = process.env,
): SatBondStakingDistributorLayoutSpec {
  assertDedicatedBondProgramConfigured(env);
  if (cachedStakingDistributorLayout) {
    return cachedStakingDistributorLayout;
  }
  const layoutPath = resolveStakingDistributorLayoutPath(env);
  if (layoutPath) {
    cachedStakingDistributorLayout = JSON.parse(
      fs.readFileSync(layoutPath, "utf-8"),
    ) as SatBondStakingDistributorLayoutSpec;
    return cachedStakingDistributorLayout;
  }
  cachedStakingDistributorLayout ??= DEDICATED_FALLBACK_STAKING_DISTRIBUTOR_LAYOUT;
  return cachedStakingDistributorLayout;
}

export function loadSatBondStakingPositionLayout(
  env: NodeJS.ProcessEnv = process.env,
): SatBondStakingPositionLayoutSpec {
  assertDedicatedBondProgramConfigured(env);
  if (cachedStakingPositionLayout) {
    return cachedStakingPositionLayout;
  }
  const layoutPath = resolveStakingPositionLayoutPath(env);
  if (layoutPath) {
    cachedStakingPositionLayout = JSON.parse(
      fs.readFileSync(layoutPath, "utf-8"),
    ) as SatBondStakingPositionLayoutSpec;
    return cachedStakingPositionLayout;
  }
  cachedStakingPositionLayout ??= DEDICATED_FALLBACK_STAKING_POSITION_LAYOUT;
  return cachedStakingPositionLayout;
}
