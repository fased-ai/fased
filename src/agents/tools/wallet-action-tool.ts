import { Type } from "@sinclair/typebox";
import type { FasedAgentConfig } from "../../config/config.js";
import { assertValidSolanaAddress } from "../../wallet/solana-address.js";
import {
  executeSolanaSwapApprovalPayload,
  fetchJupiterSwapOrder,
  inspectAndValidateSolanaSwapOrder,
  prepareSolanaSwapSignerReview,
  SOLANA_NATIVE_MINT,
  validateSolanaSwapIntentPolicy,
} from "../../wallet/solana-swap.js";
import {
  normalizeTokenAmountToBaseUnits,
  resolveSolanaToken,
} from "../../wallet/solana-token-resolver.js";
import {
  cancelJupiterTriggerOrder,
  createJupiterTriggerLimitOrder,
  listJupiterTriggerOrders,
  readJupiterTriggerPositiveNumber,
  validateJupiterTriggerLimitOrderIntent,
} from "../../wallet/solana-trigger.js";
import { resolveAgentWalletSelection } from "../../wallet/wallet-agent-selection.js";
import { appendWalletAuditEntry } from "../../wallet/wallet-audit-log.js";
import { simulateWalletPolicy } from "../../wallet/wallet-policy-simulation.js";
import {
  applyWalletPolicyConfig,
  isWalletToolAllowed,
  resolveWalletRecurringTransferPolicy,
  upsertWalletPolicyConfig,
  validateWalletTxPolicy,
  type WalletRecurringTransferPolicyPatch,
} from "../../wallet/wallet-policy.js";
import {
  createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet,
} from "../../wallet/wallet-provider-resolver.js";
import { resolveWalletRuntimeConfig } from "../../wallet/wallet-runtime-config.js";
import { createWalletSendApprovalRequest } from "../../wallet/wallet-send-approvals.js";
import { resolveDefaultAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import {
  enforceWalletSkillAccessEnabled,
  enforceWalletSkillPolicy,
  readSkillWalletActionPermissions,
} from "./wallet-skill-policy.js";

const WALLET_ACTION_TOOL_ACTIONS = [
  "plan",
  "quote",
  "swap",
  "schedule_plan",
  "schedule_send",
  "limit_order",
  "limit_cancel",
  "limit_history",
] as const;
const WALLET_ACTION_MODES = ["manual", "autonomous"] as const;
const WALLET_ACTION_AMOUNT_FORMATS = ["base", "human"] as const;
const WALLET_ACTION_SEND_CHAINS = ["solana"] as const;
const WALLET_ACTION_SEND_AMOUNT_MODES = ["fixed", "percentage"] as const;
const WALLET_ACTION_TRIGGER_CONDITIONS = ["above", "below"] as const;
const WALLET_ACTION_LIMIT_HISTORY_STATES = ["active", "past"] as const;

const WalletActionToolSchema = Type.Object({
  action: stringEnum(WALLET_ACTION_TOOL_ACTIONS),
  walletHandle: Type.Optional(Type.String()),
  walletId: Type.Optional(Type.String()),
  inputToken: Type.Optional(Type.String()),
  outputToken: Type.Optional(Type.String()),
  inputMint: Type.Optional(Type.String()),
  outputMint: Type.Optional(Type.String()),
  inputSymbol: Type.Optional(Type.String()),
  outputSymbol: Type.Optional(Type.String()),
  amount: Type.Optional(Type.String()),
  amountFormat: Type.Optional(optionalStringEnum(WALLET_ACTION_AMOUNT_FORMATS)),
  amountMode: Type.Optional(optionalStringEnum(WALLET_ACTION_SEND_AMOUNT_MODES)),
  percentage: Type.Optional(Type.Number()),
  minAmount: Type.Optional(Type.String()),
  keepAmount: Type.Optional(Type.String()),
  chain: Type.Optional(optionalStringEnum(WALLET_ACTION_SEND_CHAINS)),
  to: Type.Optional(Type.String()),
  program: Type.Optional(Type.String()),
  memo: Type.Optional(Type.String()),
  savePolicy: Type.Optional(Type.Boolean()),
  slippageBps: Type.Optional(Type.Number()),
  mode: Type.Optional(optionalStringEnum(WALLET_ACTION_MODES)),
  triggerMint: Type.Optional(Type.String()),
  triggerToken: Type.Optional(Type.String()),
  triggerSymbol: Type.Optional(Type.String()),
  triggerCondition: Type.Optional(optionalStringEnum(WALLET_ACTION_TRIGGER_CONDITIONS)),
  triggerPriceUsd: Type.Optional(Type.Number()),
  expiresAt: Type.Optional(Type.Number()),
  expirySeconds: Type.Optional(Type.Number()),
  orderId: Type.Optional(Type.String()),
  state: Type.Optional(optionalStringEnum(WALLET_ACTION_LIMIT_HISTORY_STATES)),
  mint: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  offset: Type.Optional(Type.Number()),
  schedule: Type.Optional(Type.Object({}, { additionalProperties: true })),
  name: Type.Optional(Type.String()),
});

function resolveRequesterAgentId(params: {
  config?: FasedAgentConfig;
  requesterAgentIdOverride?: string;
  sessionKey?: string;
}): string | null {
  const override = params.requesterAgentIdOverride?.trim();
  if (override) {
    return override;
  }
  if (!params.sessionKey) {
    return null;
  }
  const parts = params.sessionKey.split(":");
  if (parts[0] === "agent" && parts[1]) {
    return parts[1];
  }
  const fallback = resolveDefaultAgentId(params.config ?? {});
  return fallback || null;
}

function scheduleMessageForPlan(plan: Record<string, unknown>): string {
  return [
    "Run this approved Fased wallet action plan exactly as structured.",
    "Use the wallet_action tool. Do not substitute display wallet names for handles.",
    "If quote or policy fails, report the failure and do not retry with different mints or wallets.",
    "",
    "walletActionPlan:",
    JSON.stringify(plan, null, 2),
  ].join("\n");
}

function canonicalRecurringTransferPolicy(
  value: WalletRecurringTransferPolicyPatch | Record<string, unknown> | null | undefined,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const schedule =
    value.schedule && typeof value.schedule === "object" && !Array.isArray(value.schedule)
      ? (value.schedule as Record<string, unknown>)
      : undefined;
  return JSON.stringify({
    enabled: value.enabled === true,
    chain: value.chain === "solana" ? "solana" : undefined,
    to: typeof value.to === "string" ? value.to.trim() : "",
    program: typeof value.program === "string" ? value.program.trim() : undefined,
    amountMode: value.amountMode === "percentage" ? "percentage" : "fixed",
    amount: typeof value.amount === "string" ? value.amount.trim() : undefined,
    percentage: typeof value.percentage === "number" ? value.percentage : undefined,
    minAmount: typeof value.minAmount === "string" ? value.minAmount.trim() : undefined,
    keepAmount: typeof value.keepAmount === "string" ? value.keepAmount.trim() : undefined,
    schedule: schedule ? JSON.parse(JSON.stringify(schedule)) : undefined,
    name: typeof value.name === "string" ? value.name.trim() : undefined,
  });
}

function scheduleMessageForTransferPlan(plan: Record<string, unknown>): string {
  return [
    "Run this approved Fased wallet transfer schedule exactly as structured.",
    "Use the wallet tool only. Do not use raw signing tools or substitute display wallet names for handles.",
    "If amountMode is fixed, call wallet.send with amountFormat=base and the exact base-unit amount.",
    "If amountMode is percentage, first call wallet.balance for the source wallet and asset, subtract keepAmount, apply percentage, skip when below minAmount, then call wallet.send with amountFormat=base.",
    "If balance, policy, custody, signer, or send fails, report the failure and do not retry with different wallets, destinations, mints, or amounts.",
    "",
    "walletTransferSchedule:",
    JSON.stringify(plan, null, 2),
  ].join("\n");
}

function readPositivePercent(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : 100;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}

function publicJupiterTriggerOrder(order: { id?: string; txSignature?: string }) {
  return {
    id: order.id,
    txSignature: order.txSignature,
  };
}

function publicJupiterTriggerVault(vault: Record<string, unknown>) {
  return {
    userPubkey: typeof vault.userPubkey === "string" ? vault.userPubkey : undefined,
    vaultPubkey: typeof vault.vaultPubkey === "string" ? vault.vaultPubkey : undefined,
  };
}

function normalizeScheduleDestination(toRaw: string | undefined): string {
  const to = toRaw?.trim();
  if (!to) {
    throw new Error("destination required");
  }
  if (!to.toLowerCase().startsWith("@wallet:")) {
    assertValidSolanaAddress(to, "Solana destination address");
  }
  return to;
}

function normalizeScheduleTransferAmount(params: {
  amountRaw: string | undefined;
  amountFormat: "base" | "human";
  decimals: number;
  symbol: string;
}): string {
  return normalizeTokenAmountToBaseUnits({
    amountRaw: params.amountRaw,
    amountFormat: params.amountFormat,
    decimals: params.decimals,
    symbol: params.symbol,
  });
}

function validateScheduledSplTokenCap(params: {
  config: ReturnType<typeof applyWalletPolicyConfig>;
  mint: string;
  amount?: string;
}): void {
  if (params.mint === SOLANA_NATIVE_MINT) {
    return;
  }
  const cap = params.config.policy.solana.tokenCaps[params.mint];
  if (!cap) {
    throw new Error("SPL token spend requires an explicit per-mint token cap");
  }
  if (params.amount && BigInt(params.amount) > cap.maxPerTx) {
    throw new Error("SPL token per-transaction cap exceeded");
  }
}

export function createWalletActionTool(opts?: {
  config?: FasedAgentConfig;
  requesterAgentIdOverride?: string;
  agentSessionKey?: string;
  requesterSkillId?: string | null;
  requestSource?: string | null;
}): AnyAgentTool | null {
  const cfg = opts?.config ?? {};
  const wallet = resolveWalletRuntimeConfig(cfg, process.env);
  if (!wallet.enabled) {
    return null;
  }

  const ownerAgentId = resolveDefaultAgentId(cfg);
  const requesterAgentId = resolveRequesterAgentId({
    config: cfg,
    requesterAgentIdOverride: opts?.requesterAgentIdOverride,
    sessionKey: opts?.agentSessionKey,
  });
  const requestSource = opts?.requestSource?.trim() || "agent-wallet-action";
  const access = isWalletToolAllowed({
    config: wallet,
    requesterAgentId,
    ownerAgentId,
    requesterSkillId: opts?.requesterSkillId,
    requestSource,
  });

  return {
    label: "Wallet Action",
    name: "wallet_action",
    description:
      "Plan, quote, execute Solana swaps, schedule sends, and manage Jupiter Trigger limit orders through Fased policy. Use Agent wallets only. For normal SOL/token decimal amounts like 0.01, pass amountFormat=human; decimal amounts are treated as human units when amountFormat is omitted. For scheduled actions, create the schedule with cron using the schedule_plan or schedule_send output.",
    parameters: WalletActionToolSchema,
    execute: async (_toolCallId, args) => {
      if (!access.ok) {
        throw new Error(access.code ?? "wallet action access denied");
      }
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const walletHandle = readStringParam(params, "walletHandle");
      const walletId = readStringParam(params, "walletId");
      const amountRawForFormat = readStringParam(params, "amount");
      const amountFormatRaw = readStringParam(params, "amountFormat");
      const amountFormat =
        amountFormatRaw === "human" || (!amountFormatRaw && amountRawForFormat?.includes("."))
          ? "human"
          : "base";
      const slippageBps =
        typeof params.slippageBps === "number" && Number.isFinite(params.slippageBps)
          ? Math.floor(params.slippageBps)
          : 50;
      const mode = readStringParam(params, "mode") === "manual" ? "manual" : "autonomous";
      const autonomous = mode === "autonomous";
      const scheduled = action === "schedule_plan";
      const requesterSkillId = opts?.requesterSkillId?.trim() || null;
      const permissions = readSkillWalletActionPermissions(cfg, requesterSkillId);
      const selection = resolveAgentWalletSelection({
        config: cfg,
        walletHandle,
        walletId,
        agentId: requesterAgentId ?? ownerAgentId ?? undefined,
        env: process.env,
      });
      const rpcUrl = resolveScopedRpcUrlForWallet({
        env: process.env,
        chains: ["solana"],
        walletId: selection.walletId,
      });
      const provider = createWalletProviderAdapter({
        cfg,
        wallet,
        env: process.env,
        providerIdOverride: selection.providerId,
        walletId: selection.walletId,
      });
      const addresses = await provider.getAddresses({ walletId: selection.walletId });
      const taker = addresses.solana?.trim();
      if (!taker) {
        throw new Error("wallet has no Solana address");
      }
      const effectiveWallet = applyWalletPolicyConfig({
        config: wallet,
        cfg,
        env: process.env,
        walletId: selection.walletId,
      });
      enforceWalletSkillAccessEnabled({
        wallet: effectiveWallet,
        requesterSkillId,
      });

      if (action === "schedule_send") {
        const chain = readStringParam(params, "chain") === "solana" ? "solana" : "solana";
        const to = normalizeScheduleDestination(readStringParam(params, "to"));
        const program = readStringParam(params, "program");
        if (program) {
          assertValidSolanaAddress(program, "SPL mint address");
        }
        const amountMode =
          readStringParam(params, "amountMode") === "percentage" ? "percentage" : "fixed";
        const asset =
          program && program !== SOLANA_NATIVE_MINT
            ? await resolveSolanaToken({
                mint: program,
                query: program,
                rpcUrl,
              })
            : {
                mint: SOLANA_NATIVE_MINT,
                symbol: "SOL",
                name: "Solana",
                decimals: 9,
                source: "native" as const,
              };
        const fixedAmount =
          amountMode === "fixed"
            ? normalizeScheduleTransferAmount({
                amountRaw: readStringParam(params, "amount"),
                amountFormat,
                decimals: asset.decimals,
                symbol: asset.symbol,
              })
            : undefined;
        const minAmount = params.minAmount
          ? normalizeScheduleTransferAmount({
              amountRaw: readStringParam(params, "minAmount"),
              amountFormat,
              decimals: asset.decimals,
              symbol: asset.symbol,
            })
          : "0";
        const keepAmount = params.keepAmount
          ? normalizeScheduleTransferAmount({
              amountRaw: readStringParam(params, "keepAmount"),
              amountFormat,
              decimals: asset.decimals,
              symbol: asset.symbol,
            })
          : "0";
        validateScheduledSplTokenCap({
          config: effectiveWallet,
          mint: asset.mint,
          amount: fixedAmount,
        });
        const percentage = readPositivePercent(params.percentage);
        await enforceWalletSkillPolicy({
          cfg,
          permissions,
          requesterAgentId,
          requesterSkillId,
          action: "schedule_send",
          role: selection.role,
          walletId: selection.walletId,
          chain,
          inputMint: asset.mint,
          amount: fixedAmount,
          autonomous: true,
          scheduled: true,
          requireManifest: Boolean(requesterSkillId),
          env: process.env,
        });
        const policy = validateWalletTxPolicy({
          config: effectiveWallet,
          action: "send",
          requireDirectSigning: true,
          chain,
          amount: fixedAmount ?? "0",
          program: program || undefined,
          requireSolanaTokenCap: Boolean(program),
        });
        if (!policy.ok) {
          throw new Error(policy.message ?? policy.code ?? "wallet send policy rejected");
        }
        const name = readStringParam(params, "name") || `Wallet send ${selection.walletHandle}`;
        const plan = {
          kind: "solana_transfer",
          walletHandle: selection.walletHandle,
          walletId: selection.walletId,
          walletName: selection.walletName,
          chain,
          to,
          program: program || undefined,
          assetSymbol: asset.symbol,
          assetName: asset.name,
          assetDecimals: asset.decimals,
          amountMode,
          amount: fixedAmount,
          amountFormat: fixedAmount ? "base" : undefined,
          percentage: amountMode === "percentage" ? percentage : undefined,
          minAmount: amountMode === "percentage" ? minAmount : undefined,
          keepAmount: amountMode === "percentage" ? keepAmount : undefined,
          memo: readStringParam(params, "memo"),
          mode: "autonomous",
          schedule: params.schedule,
        };
        const cronJob = {
          name,
          schedule: params.schedule,
          sessionTarget: "isolated",
          payload: {
            kind: "agentTurn",
            message: scheduleMessageForTransferPlan(plan),
          },
          delivery: { mode: "announce", bestEffort: true },
          enabled: false,
        };
        const recurringTransferPatch: WalletRecurringTransferPolicyPatch = {
          enabled: true,
          chain,
          to,
          program: program || undefined,
          amountMode,
          amount: fixedAmount,
          percentage: amountMode === "percentage" ? percentage : undefined,
          minAmount: amountMode === "percentage" ? minAmount : undefined,
          keepAmount: amountMode === "percentage" ? keepAmount : undefined,
          schedule:
            params.schedule && typeof params.schedule === "object"
              ? (params.schedule as Record<string, unknown>)
              : undefined,
          name,
        };
        const existingRecurringPolicy =
          params.savePolicy === true
            ? resolveWalletRecurringTransferPolicy({
                cfg,
                env: process.env,
                walletId: selection.walletId,
              })
            : null;
        const savedPolicyStatus =
          params.savePolicy === true && existingRecurringPolicy
            ? canonicalRecurringTransferPolicy(existingRecurringPolicy) ===
              canonicalRecurringTransferPolicy(recurringTransferPatch)
              ? "unchanged"
              : "updated"
            : params.savePolicy === true
              ? "created"
              : undefined;
        const savedPolicy =
          params.savePolicy === true
            ? upsertWalletPolicyConfig({
                cfg,
                env: process.env,
                walletId: selection.walletId,
                patch: {
                  recurringTransfer: recurringTransferPatch,
                },
              })
            : null;
        return jsonResult({
          ok: true,
          plan,
          cronJob,
          savedPolicy: savedPolicy
            ? {
                walletId: savedPolicy.walletId,
                role: savedPolicy.role,
                recurringTransfer: true,
                status: savedPolicyStatus,
                message:
                  savedPolicyStatus === "created"
                    ? "Saved this recurring transfer policy to the Agent wallet."
                    : savedPolicyStatus === "updated"
                      ? "Updated the existing Agent wallet recurring transfer policy."
                      : "The Agent wallet already had this recurring transfer policy.",
              }
            : undefined,
          reviewChecklist: [
            "Agent wallet handle",
            "destination wallet handle or external Solana address",
            "asset mint",
            "fixed amount or percentage rule",
            "minimum and keep balance for percentage schedules",
            "per-wallet SOL caps or per-mint token caps",
            "Agent automation and custody state",
          ],
          message:
            "Review this scheduled transfer, then create it with the cron tool. It is disabled by default and runtime caps are enforced on every run.",
        });
      }

      if (action === "limit_history") {
        await enforceWalletSkillPolicy({
          cfg,
          permissions,
          requesterAgentId,
          requesterSkillId,
          action: "limit_history",
          role: "agent",
          walletId: selection.walletId,
          chain: "solana",
          slippageBps,
          autonomous: false,
          scheduled: false,
          requireManifest: Boolean(requesterSkillId),
          env: process.env,
        });
        const mintQuery = readStringParam(params, "mint");
        const mint = mintQuery
          ? (
              await resolveSolanaToken({
                mint: mintQuery,
                query: mintQuery,
                rpcUrl,
              })
            ).mint
          : undefined;
        const history = await listJupiterTriggerOrders({
          provider,
          walletId: selection.walletId,
          walletAddress: taker,
          state: readStringParam(params, "state") === "past" ? "past" : "active",
          mint,
          limit:
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? Math.floor(params.limit)
              : 20,
          offset:
            typeof params.offset === "number" && Number.isFinite(params.offset)
              ? Math.floor(params.offset)
              : 0,
          rpcUrl,
          env: process.env,
        });
        return jsonResult({
          ok: true,
          walletHandle: selection.walletHandle,
          walletId: selection.walletId,
          history: {
            orders: history.orders,
            pagination: history.pagination,
          },
        });
      }

      if (action === "limit_cancel") {
        await enforceWalletSkillPolicy({
          cfg,
          permissions,
          requesterAgentId,
          requesterSkillId,
          action: "limit_cancel",
          role: "agent",
          walletId: selection.walletId,
          chain: "solana",
          slippageBps,
          autonomous,
          scheduled: false,
          requireManifest: Boolean(requesterSkillId),
          env: process.env,
        });
        if (autonomous && !effectiveWallet.policy.directSigning) {
          throw new Error("automated execution disabled by wallet policy");
        }
        const orderId = readStringParam(params, "orderId", { required: true });
        if (!autonomous) {
          return jsonResult({
            ok: true,
            live: false,
            plan: {
              kind: "solana_limit_cancel",
              walletHandle: selection.walletHandle,
              walletId: selection.walletId,
              orderId,
              mode,
            },
            message:
              "Review this cancellation, then execute it through the signer-owned reviewed authorization flow.",
          });
        }
        appendWalletAuditEntry({
          action: "send_requested",
          actor: requesterAgentId ?? ownerAgentId ?? "agent",
          details: {
            actionKind: "solana_limit_cancel",
            walletHandle: selection.walletHandle,
            walletId: selection.walletId,
            orderId,
            mode,
            requestSource,
            requesterSkillId: opts?.requesterSkillId ?? undefined,
          },
          env: process.env,
        });
        const cancelled = await cancelJupiterTriggerOrder({
          provider,
          walletId: selection.walletId,
          walletAddress: taker,
          orderId,
          rpcUrl,
          env: process.env,
        });
        appendWalletAuditEntry({
          action: "send_executed",
          actor: requesterAgentId ?? ownerAgentId ?? "agent",
          details: {
            actionKind: "solana_limit_cancel",
            walletHandle: selection.walletHandle,
            walletId: selection.walletId,
            orderId,
            mode,
            txHash: cancelled.tx.txHash,
          },
          env: process.env,
        });
        return jsonResult({
          ok: true,
          cancelled: true,
          walletHandle: selection.walletHandle,
          orderId,
          tx: cancelled.tx,
        });
      }

      const inputToken = await resolveSolanaToken({
        mint: readStringParam(params, "inputMint"),
        query:
          readStringParam(params, "inputToken") ||
          readStringParam(params, "inputSymbol") ||
          SOLANA_NATIVE_MINT,
        rpcUrl,
      });
      const outputTokenQuery =
        readStringParam(params, "outputMint") ||
        readStringParam(params, "outputToken") ||
        readStringParam(params, "outputSymbol");
      if (!outputTokenQuery) {
        throw new Error("output token required");
      }
      const outputToken = await resolveSolanaToken({
        mint: readStringParam(params, "outputMint"),
        query: outputTokenQuery,
        rpcUrl,
      });
      const amount = normalizeTokenAmountToBaseUnits({
        amountRaw: readStringParam(params, "amount", { required: true }),
        amountFormat,
        decimals: inputToken.decimals,
        symbol: inputToken.symbol,
      });
      const inputMint = inputToken.mint;
      const outputMint = outputToken.mint;
      const requestedWalletAction =
        action === "schedule_plan"
          ? "schedule_plan"
          : action === "limit_order"
            ? "limit_order"
            : action === "swap"
              ? "swap"
              : action === "plan"
                ? "plan"
                : "quote";
      await enforceWalletSkillPolicy({
        cfg,
        permissions,
        requesterAgentId,
        requesterSkillId,
        action: requestedWalletAction,
        role: "agent",
        walletId: selection.walletId,
        chain: "solana",
        inputMint,
        outputMint,
        amount,
        slippageBps,
        autonomous: (action === "swap" || action === "limit_order") && autonomous,
        scheduled,
        requireManifest: Boolean(requesterSkillId),
        env: process.env,
      });
      const policy = validateSolanaSwapIntentPolicy({
        config: effectiveWallet,
        inputMint,
        outputMint,
        amount,
        autonomous,
      });
      if (!policy.ok) {
        throw new Error(policy.message ?? policy.code ?? "wallet action policy rejected");
      }

      const plan = {
        kind: "solana_swap",
        walletHandle: selection.walletHandle,
        walletId: selection.walletId,
        inputMint,
        outputMint,
        inputSymbol: inputToken.symbol,
        outputSymbol: outputToken.symbol,
        inputName: inputToken.name,
        outputName: outputToken.name,
        inputDecimals: inputToken.decimals,
        outputDecimals: outputToken.decimals,
        amount,
        amountFormat: "base",
        slippageBps,
        mode,
      };

      if (action === "limit_order") {
        const triggerCondition = readStringParam(params, "triggerCondition");
        if (triggerCondition !== "above" && triggerCondition !== "below") {
          throw new Error("limit order triggerCondition must be above or below");
        }
        const triggerPriceUsd = readJupiterTriggerPositiveNumber(params.triggerPriceUsd);
        if (triggerPriceUsd === undefined) {
          throw new Error("limit order triggerPriceUsd must be positive");
        }
        const triggerTokenQuery =
          readStringParam(params, "triggerMint") ||
          readStringParam(params, "triggerToken") ||
          readStringParam(params, "triggerSymbol");
        const triggerToken = triggerTokenQuery
          ? await resolveSolanaToken({
              mint: readStringParam(params, "triggerMint"),
              query: triggerTokenQuery,
              rpcUrl,
            })
          : inputToken;
        const expiresAt =
          typeof params.expiresAt === "number" && Number.isFinite(params.expiresAt)
            ? Math.floor(params.expiresAt)
            : undefined;
        const expirySeconds =
          typeof params.expirySeconds === "number" && Number.isFinite(params.expirySeconds)
            ? Math.floor(params.expirySeconds)
            : undefined;
        const limitPolicy = validateJupiterTriggerLimitOrderIntent({
          config: effectiveWallet,
          inputMint,
          outputMint,
          amount,
          triggerCondition,
          triggerPriceUsd,
          slippageBps,
          autonomous,
        });
        if (!limitPolicy.ok) {
          throw new Error(limitPolicy.message);
        }
        const limitPlan = {
          ...plan,
          kind: "solana_limit_order",
          chain: "solana",
          actionKind: "solana_limit_order",
          program: inputMint === SOLANA_NATIVE_MINT ? undefined : inputMint,
          assetSymbol: inputToken.symbol,
          assetName: inputToken.name,
          assetDecimals: inputToken.decimals,
          amountDisplay: amountFormat === "human" ? readStringParam(params, "amount") : undefined,
          triggerMint: triggerToken.mint,
          triggerSymbol: triggerToken.symbol,
          triggerName: triggerToken.name,
          triggerCondition,
          triggerPriceUsd,
          expiresAt,
          expirySeconds,
          externalVault: "jupiter-trigger-v2",
        };
        if (!autonomous) {
          return jsonResult({
            ok: true,
            live: false,
            plan: limitPlan,
            reviewChecklist: [
              "wallet handle",
              "input and output mints",
              "deposit amount and per-mint cap",
              "trigger price and condition",
              "expiry",
              "Jupiter Trigger vault custody while order is active",
            ],
            message:
              "Review this limit order plan, then rerun with mode=autonomous to create the live Jupiter Trigger order.",
          });
        }
        appendWalletAuditEntry({
          action: "send_requested",
          actor: requesterAgentId ?? ownerAgentId ?? "agent",
          details: {
            ...limitPlan,
            mode,
            requestSource,
            requesterSkillId: opts?.requesterSkillId ?? undefined,
          },
          env: process.env,
        });
        try {
          const created = await createJupiterTriggerLimitOrder({
            provider,
            walletId: selection.walletId,
            walletAddress: taker,
            config: effectiveWallet,
            inputMint,
            outputMint,
            amount,
            triggerCondition,
            triggerPriceUsd,
            triggerMint: triggerToken.mint,
            slippageBps,
            expiresAt,
            expirySeconds,
            autonomous,
            rpcUrl,
            env: process.env,
          });
          const order = publicJupiterTriggerOrder(created.order);
          const vault = publicJupiterTriggerVault(created.vault);
          appendWalletAuditEntry({
            action: "send_executed",
            actor: requesterAgentId ?? ownerAgentId ?? "agent",
            details: {
              ...limitPlan,
              mode,
              orderId: order.id,
              txHash: order.txSignature,
              vaultPubkey: vault.vaultPubkey,
            },
            env: process.env,
          });
          return jsonResult({
            ok: true,
            live: true,
            plan: limitPlan,
            order,
            vault,
            message:
              "Jupiter Trigger limit order created. Deposited funds sit in the Jupiter Trigger vault until fill, expiry, or cancellation.",
          });
        } catch (err) {
          appendWalletAuditEntry({
            action: "send_failed",
            actor: requesterAgentId ?? ownerAgentId ?? "agent",
            details: {
              ...limitPlan,
              mode,
              reason: String(err),
            },
            env: process.env,
          });
          throw err;
        }
      }

      if (action === "plan") {
        return jsonResult({ ok: true, plan });
      }

      if (action === "schedule_plan") {
        const name = readStringParam(params, "name") || `Wallet action ${selection.walletHandle}`;
        const strategy = {
          kind: "recurring_swap",
          walletHandle: selection.walletHandle,
          inputMint,
          outputMint,
          inputSymbol: inputToken.symbol,
          outputSymbol: outputToken.symbol,
          amount,
          amountFormat: "base",
          slippageBps,
          mode,
          schedule: params.schedule,
        };
        const cronJob = {
          name,
          schedule: params.schedule,
          sessionTarget: "isolated",
          payload: {
            kind: "agentTurn",
            message: scheduleMessageForPlan(plan),
          },
          delivery: { mode: "announce", bestEffort: true },
          enabled: false,
        };
        return jsonResult({
          ok: true,
          plan,
          strategy,
          cronJob,
          reviewChecklist: [
            "wallet handle",
            "input mint and output mint",
            "amount per run",
            "slippage",
            "manual vs autonomous mode",
            "Agent wallet caps and token caps",
          ],
          message:
            "Review this scheduled task, then create it with the task tool. It is disabled by default.",
        });
      }

      const order = await fetchJupiterSwapOrder({
        inputMint,
        outputMint,
        amount,
        slippageBps,
        taker,
        env: process.env,
      });
      const inspection = await inspectAndValidateSolanaSwapOrder({
        order,
        expectedSigner: taker,
        rpcUrl,
        config: effectiveWallet,
      });
      if (!inspection.ok) {
        throw new Error(inspection.message);
      }

      const payload = {
        chain: "solana" as const,
        actionKind: "solana_swap" as const,
        walletHandle: selection.walletHandle,
        walletId: selection.walletId,
        walletName: selection.walletName,
        providerId: selection.providerId,
        amount,
        amountDisplay: amountFormat === "human" ? readStringParam(params, "amount") : undefined,
        inputMint,
        outputMint,
        assetSymbol: inputToken.symbol,
        assetName: inputToken.name,
        assetDecimals: inputToken.decimals,
        inputSymbol: inputToken.symbol,
        outputSymbol: outputToken.symbol,
        inputName: inputToken.name,
        outputName: outputToken.name,
        inputDecimals: inputToken.decimals,
        outputDecimals: outputToken.decimals,
        inputLogoUri: inputToken.logoUri,
        outputLogoUri: outputToken.logoUri,
        outAmount: order.outAmount,
        otherAmountThreshold: order.otherAmountThreshold,
        slippageBps: order.slippageBps ?? slippageBps,
        priceImpactPct: order.priceImpactPct,
        routeLabel: order.routeLabel,
        programIds: inspection.programIds,
        routeProgramIds: inspection.routeProgramIds,
        writableAccounts: inspection.writableAccounts,
        usesAddressLookupTables: inspection.usesAddressLookupTables,
        jupiterRequestId: order.requestId,
        serializedTxBase64: order.transaction,
      };

      if (action === "quote") {
        return jsonResult({
          ok: true,
          plan,
          quote: {
            inputMint: order.inputMint,
            outputMint: order.outputMint,
            inputSymbol: inputToken.symbol,
            outputSymbol: outputToken.symbol,
            inputName: inputToken.name,
            outputName: outputToken.name,
            inputDecimals: inputToken.decimals,
            outputDecimals: outputToken.decimals,
            inputLogoUri: inputToken.logoUri,
            outputLogoUri: outputToken.logoUri,
            inAmount: order.inAmount,
            outAmount: order.outAmount,
            otherAmountThreshold: order.otherAmountThreshold,
            slippageBps: order.slippageBps,
            priceImpactPct: order.priceImpactPct,
            routeLabel: order.routeLabel,
            programIds: inspection.programIds,
            routeProgramIds: inspection.routeProgramIds,
            usesAddressLookupTables: inspection.usesAddressLookupTables,
            requestId: order.requestId,
          },
        });
      }

      if (action !== "swap") {
        throw new Error(`unknown wallet action: ${action}`);
      }

      appendWalletAuditEntry({
        action: "send_requested",
        actor: requesterAgentId ?? ownerAgentId ?? "agent",
        details: {
          ...payload,
          mode,
          requestSource,
          requesterSkillId: opts?.requesterSkillId ?? undefined,
        },
        env: process.env,
      });

      if (!autonomous) {
        const simulation = simulateWalletPolicy({
          cfg,
          config: effectiveWallet,
          payload,
          mode: "manual",
          source: requestSource,
          skillId: requesterSkillId,
          requireDirectSigning: false,
          requireSolanaTokenCap: "program" in payload && Boolean(payload.program),
          env: process.env,
        });
        if (!simulation.ok) {
          const failed = simulation.checks.find((check) => check.status === "fail");
          throw new Error(failed?.detail ?? "wallet policy rejected");
        }
        if (!rpcUrl?.trim()) {
          throw new Error("Solana RPC is required to prepare a signer-owned swap review");
        }
        const signerReview = await prepareSolanaSwapSignerReview({
          provider,
          walletId: selection.walletId,
          owner: taker,
          order,
          inspection,
          rpcUrl,
          mode: "reviewed",
          env: process.env,
        });
        Object.assign(payload, {
          signerReviewId: signerReview.review.requestId,
          signerPolicyHash: signerReview.review.policyHash,
          signerIntentDigest: signerReview.review.intentDigest,
          signerTransactionDigest: signerReview.review.transactionDigest,
          signerReviewExpiresAt: signerReview.review.expiresAt,
        });
        const request = createWalletSendApprovalRequest({
          payload,
          requestedBy: requesterAgentId ?? ownerAgentId ?? "agent",
          simulation,
          approvalDiff: simulation.diff,
          env: process.env,
        });
        return jsonResult({
          ok: false,
          approvalRequired: true,
          code: "wallet_swap_approval_required",
          message: "Solana swap requires operator approval in Control UI",
          requestId: request.id,
          expiresAt: request.expiresAt,
          quote: {
            inAmount: order.inAmount,
            outAmount: order.outAmount,
            otherAmountThreshold: order.otherAmountThreshold,
            slippageBps: order.slippageBps,
            priceImpactPct: order.priceImpactPct,
            routeLabel: order.routeLabel,
          },
        });
      }

      const executed = await executeSolanaSwapApprovalPayload({
        payload,
        config: wallet,
        runtimeConfig: cfg,
        providerIdOverride: selection.providerId,
        autonomous: true,
        env: process.env,
      });
      if (!executed.ok) {
        appendWalletAuditEntry({
          action: "send_failed",
          actor: requesterAgentId ?? ownerAgentId ?? "agent",
          details: { ...payload, mode, reason: executed.message, code: executed.code },
          env: process.env,
        });
        throw new Error(executed.message);
      }
      appendWalletAuditEntry({
        action: "send_executed",
        actor: requesterAgentId ?? ownerAgentId ?? "agent",
        details: {
          ...payload,
          mode,
          txHash: executed.tx.txHash,
          outAmount: executed.order.outAmount ?? payload.outAmount,
          routeLabel: executed.order.routeLabel ?? payload.routeLabel,
          jupiterRequestId: executed.order.requestId ?? payload.jupiterRequestId,
        },
        env: process.env,
      });
      return jsonResult({ ok: true, executed: true, mode: "autonomous", tx: executed.tx });
    },
  };
}
