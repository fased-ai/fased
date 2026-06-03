import { setTimeout as delay } from "node:timers/promises";
import type { FasedAgentConfig } from "../config/config.js";
import type { WalletChain, WalletProviderId } from "../config/types.wallet.js";
import { readWalletAuditEntries } from "./wallet-audit-log.js";
import { pollWalletInboundEvents } from "./wallet-inbound-events.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";
import { createWalletProviderAdapter } from "./wallet-provider-resolver.js";
import { redactWalletDiagnosticText, walletDiagnosticErrorString } from "./wallet-redaction.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";
import {
  approveWalletSendRequest,
  createWalletSendApprovalRequest,
  rejectWalletSendRequest,
} from "./wallet-send-approvals.js";
import { getWalletSettlementLinkByRequestId } from "./wallet-settlement-links.js";
import type { WalletStatusSnapshot } from "./wallet-status.js";

export type WalletCanaryCheck = {
  id: string;
  ok: boolean;
  required: boolean;
  message: string;
};

export type WalletCanaryReport = {
  ok: boolean;
  checkedAt: string;
  requireRealChain: boolean;
  checks: WalletCanaryCheck[];
};

export type WalletProviderCanaryStep = {
  id: string;
  ok: boolean;
  required: boolean;
  message: string;
};

export type WalletProviderCanaryResult = {
  providerId: WalletProviderId;
  ok: boolean;
  steps: WalletProviderCanaryStep[];
};

export type WalletProviderCanaryReport = {
  ok: boolean;
  checkedAt: string;
  executeLiveSend: boolean;
  providers: WalletProviderCanaryResult[];
};

function pushStep(
  steps: WalletProviderCanaryStep[],
  input: WalletProviderCanaryStep,
): WalletProviderCanaryStep {
  steps.push(input);
  return input;
}

function readCanaryTarget(
  chain: WalletChain,
  providerId: WalletProviderId,
  env: NodeJS.ProcessEnv,
): { to: string; amount: string } | null {
  const providerToken = String(providerId).replace(/-/g, "_").toUpperCase();
  const readValue = (...keys: string[]): string => {
    for (const key of keys) {
      const value = String(env?.[key] ?? "").trim();
      if (value) {
        return value;
      }
    }
    return "";
  };
  const to = readValue(
    `FASED_WALLET_CANARY_TO_SOLANA_${providerToken}`,
    "FASED_WALLET_CANARY_TO_SOLANA",
  );
  if (!to) {
    return null;
  }
  const amount =
    readValue(
      `FASED_WALLET_CANARY_AMOUNT_SOLANA_${providerToken}`,
      "FASED_WALLET_CANARY_AMOUNT_SOLANA",
    ) || "1";
  return { to, amount };
}

function parseNonNegativeBigInt(value: string | undefined): bigint | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return null;
  }
  try {
    const parsed = BigInt(normalized);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  options?: {
    attempts?: number;
    delayMs?: number;
  },
): Promise<boolean> {
  const attempts = Math.max(1, Math.min(8, options?.attempts ?? 3));
  const delayMs = Math.max(0, Math.min(10_000, options?.delayMs ?? 350));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await check()) {
      return true;
    }
    if (attempt < attempts && delayMs > 0) {
      await delay(delayMs * attempt);
    }
  }
  return false;
}

function requestIdFromAudit(
  entries: ReturnType<typeof readWalletAuditEntries>,
  action: "send_requested" | "send_rejected" | "send_executed" | "send_failed",
  providerId: WalletProviderId,
): string | undefined {
  const match = entries.find(
    (entry) => entry.action === action && entry.details?.providerId === providerId,
  );
  const requestId = match?.details?.requestId;
  return typeof requestId === "string" && requestId.trim() ? requestId : undefined;
}

export function buildWalletCanaryReport(params: {
  status: WalletStatusSnapshot;
  requireRealChain?: boolean;
  parity?: ({ ok: boolean } & Record<string, unknown>) | null;
}): WalletCanaryReport {
  const requireRealChain = params.requireRealChain ?? true;
  const status = params.status;
  const checks: WalletCanaryCheck[] = [];

  checks.push({
    id: "wallet.enabled",
    ok: status.enabled,
    required: true,
    message: "wallet is enabled",
  });
  checks.push({
    id: "wallet.service.healthy",
    ok: status.service.healthy,
    required: true,
    message: "wallet service is healthy",
  });

  const runtimeIsReal =
    status.runtime === "external-docker" || status.runtime === "external-custom";
  checks.push({
    id: "wallet.runtime.real_chain_source",
    ok: runtimeIsReal,
    required: requireRealChain,
    message: "wallet runtime is external-docker or external-custom",
  });
  checks.push({
    id: "wallet.settlement.real_chain_ready",
    ok: status.settlement.realChainReady,
    required: requireRealChain,
    message: "settlement reports real-chain ready",
  });

  if (status.runtime === "external-docker") {
    checks.push({
      id: "wallet.stack.configured",
      ok: Boolean(status.stack?.configured),
      required: true,
      message: "external docker stack is configured",
    });
    checks.push({
      id: "wallet.stack.healthy",
      ok: Boolean(status.stack?.healthy),
      required: true,
      message: "external docker stack services are healthy",
    });
    if (params.parity) {
      checks.push({
        id: "wallet.stack.parity",
        ok: params.parity.ok,
        required: true,
        message: "external stack docker profile parity checks pass",
      });
    }
  }

  checks.push({
    id: "wallet.policy.tool_access_owner_only",
    ok: status.policy.toolAccessMode === "owner-only",
    required: status.managedMode,
    message: "managed canary uses owner-only tool access",
  });

  const approvalReadyRequired = status.approvalAuth.mode === "webauthn";
  checks.push({
    id: "wallet.approval_auth.ready",
    ok: status.approvalAuth.ready,
    required: approvalReadyRequired,
    message: approvalReadyRequired
      ? "webauthn approval auth has enrolled passkey(s)"
      : "approval auth mode is none (passkey readiness not required)",
  });

  const ok = checks.every((check) => (check.required ? check.ok : true));
  return {
    ok,
    checkedAt: new Date().toISOString(),
    requireRealChain,
    checks,
  };
}

export async function runWalletProviderCanaryReport(params: {
  cfg: FasedAgentConfig;
  wallet: ResolvedWalletRuntimeConfig;
  env?: NodeJS.ProcessEnv;
  providers?: WalletProviderId[];
  executeLiveSend?: boolean;
}): Promise<WalletProviderCanaryReport> {
  const env = params.env ?? process.env;
  const executeLiveSend = Boolean(params.executeLiveSend);
  const registry = readWalletProviderRegistry(env);
  const enabledProviders = (
    params.providers?.length
      ? params.providers
      : Object.entries(registry.providers)
          .filter(([, config]) => config.enabled)
          .map(([providerId]) => providerId as WalletProviderId)
  ).filter((providerId, idx, list) => list.indexOf(providerId) === idx);

  const providerReports: WalletProviderCanaryResult[] = [];
  for (const providerId of enabledProviders) {
    const steps: WalletProviderCanaryStep[] = [];
    let provider: ReturnType<typeof createWalletProviderAdapter>;
    try {
      provider = createWalletProviderAdapter({
        cfg: params.cfg,
        wallet: params.wallet,
        providerIdOverride: providerId,
        env,
      });
      pushStep(steps, {
        id: "provider.adapter",
        ok: true,
        required: true,
        message: "provider adapter resolved",
      });
    } catch (err) {
      pushStep(steps, {
        id: "provider.adapter",
        ok: false,
        required: true,
        message: `provider adapter failed: ${walletDiagnosticErrorString(err)}`,
      });
      providerReports.push({
        providerId,
        ok: false,
        steps,
      });
      continue;
    }

    const health = await provider.health();
    pushStep(steps, {
      id: "provider.health",
      ok: health.ok,
      required: true,
      message: health.details
        ? redactWalletDiagnosticText(health.details)
        : "provider health check",
    });

    try {
      if (provider.capabilities.supportsCreateWallet && provider.createWallet) {
        const created = await provider.createWallet();
        pushStep(steps, {
          id: "provider.create_wallet",
          ok: created.ok && Boolean(created.walletId),
          required: true,
          message: created.walletId ? `walletId=${created.walletId}` : "walletId missing",
        });
      } else {
        pushStep(steps, {
          id: "provider.create_wallet",
          ok: true,
          required: false,
          message: "provider does not expose createWallet",
        });
      }
    } catch (err) {
      pushStep(steps, {
        id: "provider.create_wallet",
        ok: false,
        required: provider.capabilities.supportsCreateWallet,
        message: `create wallet failed: ${walletDiagnosticErrorString(err)}`,
      });
    }

    try {
      const addresses = await provider.getAddresses();
      const hasAddress = Boolean(addresses.solana);
      pushStep(steps, {
        id: "provider.addresses",
        ok: hasAddress,
        required: true,
        message: hasAddress ? `solana=${addresses.solana ?? "n/a"}` : "no addresses returned",
      });
    } catch (err) {
      pushStep(steps, {
        id: "provider.addresses",
        ok: false,
        required: true,
        message: `address lookup failed: ${walletDiagnosticErrorString(err)}`,
      });
    }

    for (const chain of provider.capabilities.supportedChains) {
      try {
        const balance = await provider.getBalance(chain);
        pushStep(steps, {
          id: `provider.balance.${chain}`,
          ok: balance.ok,
          required: true,
          message: `${balance.address}=${balance.balance}${balance.unit ? ` ${balance.unit}` : ""}`,
        });
      } catch (err) {
        pushStep(steps, {
          id: `provider.balance.${chain}`,
          ok: false,
          required: true,
          message: `balance lookup failed: ${walletDiagnosticErrorString(err)}`,
        });
      }
    }

    const rejectProbe = createWalletSendApprovalRequest({
      payload: {
        chain: "solana",
        amount: "0",
        to: "11111111111111111111111111111111",
        providerId,
      },
      requestedBy: "wallet-canary",
      settlementContext: {
        taskId: `canary-reject-${providerId}-${Date.now()}`,
        invoiceId: `canary-reject-${providerId}`,
        senderHandle: "@wallet-canary@local",
      },
      env,
    });
    const rejected = rejectWalletSendRequest({
      requestId: rejectProbe.id,
      actor: "wallet-canary",
      reason: "canary reject path",
      env,
    });
    pushStep(steps, {
      id: "approval.reject_flow",
      ok: rejected.ok,
      required: true,
      message: rejected.ok ? `request=${rejectProbe.id}` : rejected.message,
    });
    const rejectAudit = readWalletAuditEntries({ env, limit: 200 });
    pushStep(steps, {
      id: "approval.reject_audit",
      ok: Boolean(requestIdFromAudit(rejectAudit, "send_rejected", providerId)),
      required: true,
      message: "audit contains send_rejected for canary provider",
    });
    const rejectSettlement = getWalletSettlementLinkByRequestId({
      requestId: rejectProbe.id,
      env,
    });
    pushStep(steps, {
      id: "approval.reject_settlement",
      ok: rejectSettlement?.status === "rejected",
      required: true,
      message: rejectSettlement
        ? `settlement status=${rejectSettlement.status}`
        : "missing settlement link for reject flow",
    });

    for (const chain of provider.capabilities.supportedChains) {
      const target = readCanaryTarget(chain, providerId, env);
      if (!executeLiveSend) {
        pushStep(steps, {
          id: `send.${chain}`,
          ok: true,
          required: false,
          message: "live send skipped (--execute-live-send not enabled)",
        });
        continue;
      }
      if (!target) {
        pushStep(steps, {
          id: `send.${chain}`,
          ok: false,
          required: true,
          message: `missing canary target env for chain=${chain}`,
        });
        continue;
      }
      const amountBaseUnits = parseNonNegativeBigInt(target.amount);
      const preBalance = await provider.getBalance(chain).catch((err: unknown) => ({
        ok: false as const,
        error: walletDiagnosticErrorString(err),
      }));
      const preBalanceValue =
        preBalance && typeof preBalance === "object" && "ok" in preBalance && preBalance.ok
          ? parseNonNegativeBigInt(String(preBalance.balance))
          : null;
      const funded =
        amountBaseUnits !== null && preBalanceValue !== null
          ? preBalanceValue >= amountBaseUnits
          : false;
      pushStep(steps, {
        id: `send.${chain}.funded`,
        ok: funded,
        required: true,
        message:
          amountBaseUnits === null
            ? `invalid canary amount for chain=${chain}: ${target.amount}`
            : preBalanceValue === null
              ? `cannot parse provider balance for chain=${chain}`
              : `balance=${preBalanceValue.toString(10)} required=${amountBaseUnits.toString(10)}`,
      });
      if (!funded) {
        continue;
      }
      const request = createWalletSendApprovalRequest({
        payload: {
          chain,
          providerId,
          to: target.to,
          amount: target.amount,
        },
        requestedBy: "wallet-canary",
        settlementContext: {
          taskId: `canary-send-${providerId}-${chain}-${Date.now()}`,
          invoiceId: `canary-send-${providerId}-${chain}`,
          senderHandle: "@wallet-canary@local",
        },
        env,
      });
      const approved = await approveWalletSendRequest({
        requestId: request.id,
        actor: "wallet-canary",
        config: params.wallet,
        providerIdOverride: providerId,
        approvalHost: "127.0.0.1",
        env,
      });
      pushStep(steps, {
        id: `send.${chain}`,
        ok: approved.ok,
        required: true,
        message: approved.ok ? `txHash=${approved.tx.txHash}` : approved.message,
      });
      const hasAudit = await waitFor(() => {
        const sendAudit = readWalletAuditEntries({ env, limit: 300 });
        return (
          Boolean(requestIdFromAudit(sendAudit, "send_executed", providerId)) ||
          Boolean(requestIdFromAudit(sendAudit, "send_failed", providerId))
        );
      });
      pushStep(steps, {
        id: `send.${chain}.audit`,
        ok: hasAudit,
        required: true,
        message: "audit contains send_executed or send_failed entry",
      });
      let settlement = getWalletSettlementLinkByRequestId({
        requestId: request.id,
        env,
      });
      if (!settlement) {
        await waitFor(
          () => {
            settlement = getWalletSettlementLinkByRequestId({
              requestId: request.id,
              env,
            });
            return Boolean(settlement);
          },
          { attempts: 4, delayMs: 400 },
        );
      }
      const settlementOk = approved.ok
        ? settlement?.status === "executed" && settlement.txHash === approved.tx.txHash
        : settlement?.status === "failed";
      pushStep(steps, {
        id: `send.${chain}.settlement`,
        ok: Boolean(settlementOk),
        required: true,
        message: settlement
          ? `settlement status=${settlement.status}${settlement.txHash ? ` tx=${settlement.txHash}` : ""}`
          : "missing settlement link for send flow",
      });
      const postHealth = await provider.health();
      pushStep(steps, {
        id: `send.${chain}.provider_health_post`,
        ok: postHealth.ok,
        required: true,
        message: postHealth.details
          ? redactWalletDiagnosticText(postHealth.details)
          : "provider health check after send",
      });
      const inbound = await pollWalletInboundEvents({
        cfg: params.cfg,
        wallet: params.wallet,
        env,
        providerId,
        walletId: request.payload.walletId,
        walletName: request.payload.walletName,
        chain,
        actor: "wallet-canary",
      }).catch((err: unknown) => ({
        ok: false as const,
        error: walletDiagnosticErrorString(err),
      }));
      const inboundOk =
        inbound && typeof inbound === "object" && "ok" in inbound && inbound.ok
          ? inbound.reconciliation.reconciled >= 0
          : false;
      pushStep(steps, {
        id: `send.${chain}.inbound_poll`,
        ok: inboundOk,
        required: false,
        message:
          inbound && typeof inbound === "object" && "ok" in inbound && inbound.ok
            ? `detected=${inbound.detected.length} reconciled=${inbound.reconciliation.reconciled}`
            : `inbound poll failed: ${(inbound as { error?: string }).error ?? "unknown error"}`,
      });
    }

    providerReports.push({
      providerId,
      ok: steps.every((step) => (step.required ? step.ok : true)),
      steps,
    });
  }

  return {
    ok: providerReports.every((report) => report.ok),
    checkedAt: new Date().toISOString(),
    executeLiveSend,
    providers: providerReports,
  };
}
