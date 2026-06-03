import type { FasedAgentConfig } from "../config/config.js";
import type { WalletChain, WalletProviderId } from "../config/types.wallet.js";
import {
  checkWalletDailyCap,
  resolveWalletRoleForId,
  validateWalletTxPolicy,
} from "./wallet-policy.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

export type WalletPolicySimulationStatus = "pass" | "fail" | "warn" | "info";

export type WalletPolicySimulationCheck = {
  id: string;
  label: string;
  status: WalletPolicySimulationStatus;
  detail: string;
  code?: string;
};

export type WalletApprovalDiff = {
  fromWalletId?: string;
  fromWalletName?: string;
  fromRole: "mining" | "agent" | "vault";
  to?: string;
  chain: WalletChain;
  token?: string;
  mint?: string;
  amount?: string;
  amountDisplay?: string;
  providerId?: WalletProviderId;
  source: string;
  skillId?: string;
  taskId?: string;
  sessionId?: string;
};

export type WalletPolicySimulation = {
  ok: boolean;
  decision: "pass" | "fail" | "needs_approval";
  checks: WalletPolicySimulationCheck[];
  diff: WalletApprovalDiff;
};

export type WalletPolicySimulationPayload = {
  chain: WalletChain;
  walletId?: string;
  walletName?: string;
  providerId?: WalletProviderId;
  to?: string;
  amount?: string;
  amountDisplay?: string;
  assetSymbol?: string;
  inputSymbol?: string;
  outputSymbol?: string;
  contract?: string;
  program?: string;
};

function pass(id: string, label: string, detail: string): WalletPolicySimulationCheck {
  return { id, label, status: "pass", detail };
}

function fail(
  id: string,
  label: string,
  detail: string,
  code?: string,
): WalletPolicySimulationCheck {
  return { id, label, status: "fail", detail, ...(code ? { code } : {}) };
}

function info(id: string, label: string, detail: string): WalletPolicySimulationCheck {
  return { id, label, status: "info", detail };
}

export function simulateWalletPolicy(params: {
  cfg?: FasedAgentConfig;
  config: ResolvedWalletRuntimeConfig;
  payload: WalletPolicySimulationPayload;
  mode: "manual" | "autonomous";
  source: string;
  skillId?: string | null;
  taskId?: string;
  sessionId?: string;
  requireDirectSigning?: boolean;
  requireSolanaTokenCap?: boolean;
  skipNativeSolanaCaps?: boolean;
  env?: NodeJS.ProcessEnv;
}): WalletPolicySimulation {
  const env = params.env ?? process.env;
  const source = params.source.trim() || "unknown";
  const walletId = params.payload.walletId?.trim() || undefined;
  const role = resolveWalletRoleForId({ walletId, cfg: params.cfg, env });
  const token =
    params.payload.assetSymbol?.trim() ||
    (params.payload.inputSymbol && params.payload.outputSymbol
      ? `${params.payload.inputSymbol.trim()} -> ${params.payload.outputSymbol.trim()}`
      : undefined);
  const diff: WalletApprovalDiff = {
    fromWalletId: walletId,
    fromWalletName: params.payload.walletName?.trim() || undefined,
    fromRole: role,
    to: params.payload.to?.trim() || undefined,
    chain: params.payload.chain,
    token,
    mint: params.payload.program?.trim() || params.payload.contract?.trim() || undefined,
    amount: params.payload.amount?.trim() || undefined,
    amountDisplay: params.payload.amountDisplay?.trim() || undefined,
    providerId: params.payload.providerId,
    source,
    skillId: params.skillId?.trim() || undefined,
    taskId: params.taskId,
    sessionId: params.sessionId,
  };
  const checks: WalletPolicySimulationCheck[] = [];

  if (!params.config.enabled) {
    checks.push(
      fail("wallet.enabled", "Wallet runtime", "Wallet runtime is disabled.", "wallet_disabled"),
    );
    return { ok: false, decision: "fail", checks, diff };
  }
  checks.push(pass("wallet.enabled", "Wallet runtime", "Wallet runtime is enabled."));

  if (params.payload.chain !== "solana") {
    checks.push(
      fail(
        "wallet.chain",
        "Chain",
        "Fased wallet actions are Solana-only.",
        "wallet_chain_unsupported",
      ),
    );
    return { ok: false, decision: "fail", checks, diff };
  }
  checks.push(pass("wallet.chain", "Chain", "Solana wallet actions are enabled."));

  checks.push(pass("wallet.role", "Wallet role", `Source wallet role resolved as ${role}.`));
  if (params.skillId?.trim()) {
    checks.push(
      info(
        "wallet.skill",
        "Skill grant",
        "Skill wallet grants are enforced before wallet_action reaches approval.",
      ),
    );
  } else {
    checks.push(info("wallet.skill", "Skill grant", "Not a skill-triggered request."));
  }

  const txPolicy = validateWalletTxPolicy({
    config: params.config,
    action: "send",
    requireDirectSigning: params.requireDirectSigning ?? params.mode === "autonomous",
    chain: params.payload.chain,
    amount: params.payload.amount,
    contract: params.payload.contract,
    program: params.payload.program,
    skipNativeSolanaCaps: params.skipNativeSolanaCaps,
    requireSolanaTokenCap: params.requireSolanaTokenCap,
  });
  if (!txPolicy.ok) {
    checks.push(
      fail(
        "wallet.policy.transaction",
        "Transaction policy",
        txPolicy.message ?? "Wallet transaction policy rejected this action.",
        txPolicy.code,
      ),
    );
    return { ok: false, decision: "fail", checks, diff };
  }
  checks.push(
    pass(
      "wallet.policy.transaction",
      "Transaction policy",
      "Role, chain, program/mint, and per-transaction caps pass.",
    ),
  );

  const daily = checkWalletDailyCap({
    config: params.config,
    chain: params.payload.chain,
    amount: params.payload.amount,
    program: params.payload.program,
    walletId,
    env,
    skipNativeSolanaCaps: params.skipNativeSolanaCaps,
  });
  if (!daily.ok) {
    checks.push(
      fail(
        "wallet.policy.daily",
        "Daily cap",
        daily.message ?? "Wallet daily cap rejected this action.",
        daily.code,
      ),
    );
    return { ok: false, decision: "fail", checks, diff };
  }
  checks.push(
    pass(
      "wallet.policy.daily",
      "Daily cap",
      daily.limit
        ? `Projected spend ${daily.spentToday ?? "0"} / ${daily.limit}.`
        : "No daily cap applies.",
    ),
  );

  if (params.mode === "manual") {
    checks.push(
      info("wallet.approval", "Approval", "Operator approval is required before signing."),
    );
    return { ok: true, decision: "needs_approval", checks, diff };
  }
  checks.push(
    pass(
      "wallet.approval",
      "Approval",
      "Autonomous mode may sign after custody and approval gates.",
    ),
  );
  return { ok: true, decision: "pass", checks, diff };
}
