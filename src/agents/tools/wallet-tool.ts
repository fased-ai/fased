import { Type } from "@sinclair/typebox";
import type { FasedAgentConfig } from "../../config/config.js";
import type { WalletProviderId } from "../../config/types.wallet.js";
import { assertValidSolanaAddress } from "../../wallet/solana-address.js";
import {
  fetchSolanaNativeBalanceViaRpc,
  fetchSolanaTokenBalanceViaRpc,
  fetchSolanaWalletAssetsViaRpc,
} from "../../wallet/solana-assets.js";
import {
  parseWalletHandle,
  resolveAgentWalletSelection,
} from "../../wallet/wallet-agent-selection.js";
import { incrementWalletObservabilityCounter } from "../../wallet/wallet-observability.js";
import {
  applyWalletPolicyConfig,
  isWalletToolAllowed,
  validateWalletTxPolicy,
} from "../../wallet/wallet-policy.js";
import {
  buildWalletProviderCapabilityMatrix,
  providerSupportsChainOperation,
} from "../../wallet/wallet-provider-capabilities.js";
import {
  readWalletProviderRegistry,
  resolveWalletSelection,
  resolveWalletUserRole,
  type WalletNamedWallet,
} from "../../wallet/wallet-provider-registry.js";
import {
  createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet,
} from "../../wallet/wallet-provider-resolver.js";
import { resolveWalletRuntimeConfig } from "../../wallet/wallet-runtime-config.js";
import type { WalletCreateSendResult } from "../../wallet/wallet-send-approvals.js";
import * as walletSendApprovals from "../../wallet/wallet-send-approvals.js";
import { resolveDefaultAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import {
  enforceWalletSkillAccessEnabled,
  enforceWalletSkillPolicy,
  readSkillWalletActionPermissions,
} from "./wallet-skill-policy.js";

const WALLET_ACTIONS = [
  "status",
  "list",
  "address",
  "balance",
  "balances",
  "assets",
  "prepare",
  "send",
] as const;
const WALLET_CHAINS = ["solana"] as const;
const WALLET_AMOUNT_FORMATS = ["base", "human"] as const;
const WALLET_PROVIDERS = ["local-socket-signer", "alchemy", "turnkey", "wallet-standard"] as const;

const WalletToolSchema = Type.Object({
  action: stringEnum(WALLET_ACTIONS),
  chain: optionalStringEnum(WALLET_CHAINS),
  to: Type.Optional(Type.String()),
  amount: Type.Optional(Type.String()),
  amountFormat: Type.Optional(optionalStringEnum(WALLET_AMOUNT_FORMATS)),
  contract: Type.Optional(Type.String()),
  program: Type.Optional(Type.String()),
  memo: Type.Optional(Type.String()),
  providerId: Type.Optional(optionalStringEnum(WALLET_PROVIDERS)),
  address: Type.Optional(Type.String()),
  walletHandle: Type.Optional(Type.String()),
  walletId: Type.Optional(Type.String()),
  walletName: Type.Optional(Type.String()),
  approvalToken: Type.Optional(Type.String()),
  approvalHost: Type.Optional(Type.String()),
});

type WalletSendPayload = {
  chain: "solana";
  to?: string;
  amount?: string;
  amountDisplay?: string;
  contract?: string;
  program?: string;
  memo?: string;
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
};

function resolveCreateOrExecuteWalletSend():
  | ((params: {
      payload: WalletSendPayload;
      requestedBy?: string;
      config: ReturnType<typeof resolveWalletRuntimeConfig>;
      runtimeConfig?: FasedAgentConfig;
      sendPath?: "policy" | "reviewed" | "automation";
      providerIdOverride?: string;
      approvalToken?: string;
      approvalHost?: string;
      env?: NodeJS.ProcessEnv;
    }) => Promise<WalletCreateSendResult>)
  | null {
  const mod = walletSendApprovals as Record<string, unknown>;
  const fn = mod.createOrExecuteWalletSend;
  return typeof fn === "function"
    ? (fn as (params: {
        payload: WalletSendPayload;
        requestedBy?: string;
        config: ReturnType<typeof resolveWalletRuntimeConfig>;
        runtimeConfig?: FasedAgentConfig;
        sendPath?: "policy" | "reviewed" | "automation";
        providerIdOverride?: string;
        approvalToken?: string;
        approvalHost?: string;
        env?: NodeJS.ProcessEnv;
      }) => Promise<WalletCreateSendResult>)
    : null;
}

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

function parseWalletProviderId(value: string | undefined): WalletProviderId | undefined {
  switch (value) {
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "wallet-standard":
      return value;
    default:
      return undefined;
  }
}

function normalizeWalletSendAmount(params: {
  amountRaw: string | undefined;
  chain: "solana";
  amountFormat: "base" | "human";
}): string | undefined {
  const raw = params.amountRaw?.trim();
  if (!raw) {
    return undefined;
  }
  if (params.amountFormat === "base") {
    try {
      const parsed = BigInt(raw);
      if (parsed < 0n) {
        throw new Error("negative");
      }
      return parsed.toString();
    } catch {
      throw new Error("amount must be a non-negative integer in base units");
    }
  }
  if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) {
    throw new Error("human amount must be a positive decimal number");
  }
  const decimals = 9;
  const [wholePart, fracPartRaw = ""] = raw.split(".");
  if (fracPartRaw.length > decimals) {
    throw new Error(
      `${params.chain.toUpperCase()} human amount supports at most ${String(decimals)} decimals`,
    );
  }
  const whole = BigInt(wholePart || "0");
  const fracPadded = fracPartRaw.padEnd(decimals, "0");
  const fraction = fracPadded ? BigInt(fracPadded) : 0n;
  const base = 10n ** BigInt(decimals);
  return (whole * base + fraction).toString();
}

function resolveWalletSendAmountFormat(params: {
  amountRaw: string | undefined;
  amountFormatRaw: string | undefined;
}): "base" | "human" {
  if (params.amountFormatRaw === "human" || params.amountFormatRaw === "base") {
    return params.amountFormatRaw;
  }
  return params.amountRaw?.trim().includes(".") ? "human" : "base";
}

function formatSolanaLamports(lamportsRaw: string | undefined): string {
  const raw = lamportsRaw?.trim() || "0";
  let lamports: bigint;
  try {
    lamports = BigInt(raw);
  } catch {
    return "0";
  }
  const sign = lamports < 0n ? "-" : "";
  const abs = lamports < 0n ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const fraction = (abs % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

async function resolveWalletDestination(params: {
  cfg: FasedAgentConfig;
  wallet: ReturnType<typeof resolveWalletRuntimeConfig>;
  chain: "solana";
  toRaw: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const raw = params.toRaw?.trim();
  if (!raw) {
    return undefined;
  }
  if (!raw.toLowerCase().startsWith("@wallet:")) {
    if (params.chain === "solana") {
      assertValidSolanaAddress(raw, "Solana destination address");
    }
    return raw;
  }
  const destinationWalletId = parseWalletHandle(raw);
  const destination = resolveWalletSelection({
    walletId: destinationWalletId,
    env: params.env,
  });
  if (!destination.walletId) {
    throw new Error(`wallet destination not found: ${raw}`);
  }
  const destinationProvider = createWalletProviderAdapter({
    cfg: params.cfg,
    wallet: params.wallet,
    env: params.env,
    providerIdOverride: destination.providerId,
    walletId: destination.walletId,
  });
  const capabilities = buildWalletProviderCapabilityMatrix(destinationProvider);
  if (
    !providerSupportsChainOperation({
      matrix: capabilities,
      chain: params.chain,
      operation: "receiveAddress",
    })
  ) {
    throw new Error(
      `wallet destination provider ${destinationProvider.id} does not support ${params.chain} receive addresses`,
    );
  }
  const addresses = await destinationProvider.getAddresses({ walletId: destination.walletId });
  const address = addresses.solana;
  if (!address) {
    throw new Error(`wallet destination ${raw} has no ${params.chain} address`);
  }
  assertValidSolanaAddress(address, `wallet destination ${raw} Solana address`);
  return address;
}

async function resolveSolanaAssetBalance(params: {
  provider: ReturnType<typeof createWalletProviderAdapter>;
  walletId?: string;
  ownerAddress?: string;
  program?: string;
}): Promise<{
  ok: true;
  chain: "solana";
  address: string;
  balance: string;
  amountDisplay?: string;
  unit: string;
  program?: string;
  decimals?: number;
  tokenProgramId?: string;
}> {
  let ownerAddress = params.ownerAddress?.trim();
  if (!ownerAddress) {
    const addresses = await params.provider.getAddresses({ walletId: params.walletId });
    ownerAddress = addresses.solana?.trim();
  }
  if (!ownerAddress) {
    throw new Error("wallet has no Solana address");
  }
  assertValidSolanaAddress(ownerAddress, "wallet Solana address");
  const rpcUrl = resolveScopedRpcUrlForWallet({
    env: process.env,
    chains: ["solana"],
    walletId: params.walletId,
  });
  if (!rpcUrl) {
    throw new Error("Solana RPC is required for wallet asset balance");
  }
  const program = params.program?.trim();
  if (!program) {
    const balance = await fetchSolanaNativeBalanceViaRpc({
      rpcUrl,
      ownerAddress,
    });
    const amountDisplay = formatSolanaLamports(balance ?? "0");
    return {
      ok: true,
      chain: "solana",
      address: ownerAddress,
      balance: amountDisplay,
      amountDisplay,
      unit: "SOL",
    };
  }
  assertValidSolanaAddress(program, "SPL mint address");
  const tokenBalance = await fetchSolanaTokenBalanceViaRpc({
    rpcUrl,
    ownerAddress,
    mint: program,
  });
  return {
    ok: true,
    chain: "solana",
    address: ownerAddress,
    balance: tokenBalance?.amountRaw ?? "0",
    unit: "raw",
    program,
    decimals: tokenBalance?.decimals,
    tokenProgramId: tokenBalance?.tokenProgramId,
  };
}

function walletHandleForId(walletId: string | undefined): string | undefined {
  const id = walletId?.trim();
  return id ? `@wallet:${id}` : undefined;
}

function summarizeNamedWallet(wallet: WalletNamedWallet) {
  return {
    walletId: wallet.id,
    walletHandle: walletHandleForId(wallet.id),
    walletName: wallet.name,
    providerId: wallet.providerId,
    role: resolveWalletUserRole(wallet) ?? "agent",
    addresses: wallet.addresses,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

function summarizeNamedWalletForBalance(wallet: WalletNamedWallet) {
  const { walletHandle: _walletHandle, ...summary } = summarizeNamedWallet(wallet);
  return summary;
}

function resolveWalletBalanceChains(params: {
  requestedChain?: "solana";
  addresses?: { solana?: string };
}): Array<(typeof WALLET_CHAINS)[number]> {
  if (params.requestedChain === "solana") {
    return [params.requestedChain];
  }
  return ["solana"];
}

async function collectWalletBalanceEntry(params: {
  cfg: FasedAgentConfig;
  walletConfig: ReturnType<typeof resolveWalletRuntimeConfig>;
  namedWallet: WalletNamedWallet;
  chain?: "solana";
}) {
  const provider = createWalletProviderAdapter({
    cfg: params.cfg,
    wallet: params.walletConfig,
    env: process.env,
    providerIdOverride: params.namedWallet.providerId,
    walletId: params.namedWallet.id,
  });
  let addresses: { solana?: string } | undefined = params.namedWallet.addresses;
  try {
    addresses = await provider.getAddresses({ walletId: params.namedWallet.id });
  } catch {
    // Stored addresses are enough for listing; balance reads below report per-chain errors.
  }

  const balances: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const requestedChains = resolveWalletBalanceChains({
    requestedChain: params.chain,
    addresses,
  });

  for (const _chain of requestedChains) {
    try {
      const ownerAddress = addresses?.solana?.trim();
      if (!ownerAddress) {
        throw new Error("wallet has no Solana address");
      }
      assertValidSolanaAddress(ownerAddress, "wallet Solana address");
      const rpcUrl = resolveScopedRpcUrlForWallet({
        env: process.env,
        chains: ["solana"],
        walletId: params.namedWallet.id,
      });
      if (!rpcUrl) {
        throw new Error("Solana RPC is required for wallet asset list");
      }
      balances.solana = {
        ok: true,
        chain: "solana",
        address: ownerAddress,
        assets: await fetchSolanaWalletAssetsViaRpc({
          rpcUrl,
          ownerAddress,
        }),
      };
    } catch (error) {
      errors.solana = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...summarizeNamedWalletForBalance(params.namedWallet),
    addresses,
    balances,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
  };
}

async function resolveSolanaAssetsResult(params: {
  walletId?: string;
  ownerAddress: string;
  external: boolean;
}): Promise<{
  ok: true;
  chain: "solana";
  target: { kind: "external_solana_address" | "wallet"; address: string; walletId?: string };
  address: string;
  assets: unknown[];
}> {
  const ownerAddress = params.ownerAddress.trim();
  assertValidSolanaAddress(
    ownerAddress,
    params.external ? "external Solana address" : "wallet Solana address",
  );
  const rpcUrl = resolveScopedRpcUrlForWallet({
    env: process.env,
    chains: ["solana"],
    walletId: params.walletId,
  });
  if (!rpcUrl) {
    throw new Error("Solana RPC is required for wallet asset list");
  }
  return {
    ok: true,
    chain: "solana",
    target: {
      kind: params.external ? "external_solana_address" : "wallet",
      address: ownerAddress,
      ...(params.walletId ? { walletId: params.walletId } : {}),
    },
    address: ownerAddress,
    assets: await fetchSolanaWalletAssetsViaRpc({
      rpcUrl,
      ownerAddress,
    }),
  };
}

export function createWalletTool(opts?: {
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
  const requestSource = opts?.requestSource?.trim() || "agent-tool";
  const access = isWalletToolAllowed({
    config: wallet,
    requesterAgentId,
    ownerAgentId,
    requesterSkillId: opts?.requesterSkillId,
    requestSource,
  });

  return {
    label: "Wallet",
    name: "wallet",
    description:
      'Query wallet status/list/balance/assets/address and prepare/send policy-limited Solana transactions via configured wallet provider. If the user asks for one exact @wallet handle or one external Solana address, call only that exact read action; do not also call balances/list. Use action="list" to list local wallets with handles and action="balances" only when the user asks for every/all local wallet balances. Use walletHandle="@wallet:<walletId>" to select exact local wallets for read-only balance/assets/status/address and risky actions. Use action="assets" for all visible Solana native and SPL balances, or address="<solana-address>" for read-only external Solana balance/assets. For address/balance reads, omit chain when the user does not specify it; the tool returns the available Solana address or balance set. Risky prepare/send actions require an Agent wallet via walletHandle, structured walletId, or default Agent wallet. For normal SOL amounts such as 0.1, pass amountFormat="human"; decimal amounts without amountFormat are treated as human units. Destination wallet handles like @wallet:vault are resolved to receive addresses.',
    parameters: WalletToolSchema,
    execute: async (_toolCallId, args) => {
      if (!access.ok) {
        incrementWalletObservabilityCounter({
          kind: "policyReject",
          key: access.code ?? "wallet_access_denied",
          env: process.env,
        });
        throw new Error(access.code ?? "wallet access denied");
      }
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const chainParam = readStringParam(params, "chain");
      if (chainParam && chainParam !== "solana") {
        throw new Error("wallet chain must be solana");
      }
      const chain = chainParam === "solana" ? chainParam : undefined;
      const rawProviderId = readStringParam(params, "providerId");
      const explicitProviderId = parseWalletProviderId(rawProviderId);
      if (rawProviderId && !explicitProviderId) {
        throw new Error(`invalid providerId: ${rawProviderId}`);
      }
      const riskyWalletAction = action === "prepare" || action === "send";
      const explicitWalletHandle = readStringParam(params, "walletHandle");
      const explicitWalletId = readStringParam(params, "walletId");
      const walletIdFromHandle = explicitWalletHandle
        ? parseWalletHandle(explicitWalletHandle)
        : undefined;
      const selectedWalletId = walletIdFromHandle ?? explicitWalletId;
      const explicitWalletName = readStringParam(params, "walletName");
      const walletSelection = riskyWalletAction
        ? resolveAgentWalletSelection({
            config: cfg,
            providerId: explicitProviderId,
            walletHandle: explicitWalletHandle,
            walletId: explicitWalletId,
            walletName: explicitWalletName,
            agentId: requesterAgentId ?? ownerAgentId ?? undefined,
            env: process.env,
          })
        : resolveWalletSelection({
            providerId: explicitProviderId,
            walletId: selectedWalletId,
            walletName: selectedWalletId ? undefined : explicitWalletName,
            agentId: requesterAgentId ?? ownerAgentId ?? undefined,
            env: process.env,
          });
      incrementWalletObservabilityCounter({
        kind: "selectionSource",
        key: walletSelection.source ?? "unknown",
        env: process.env,
      });
      const provider = createWalletProviderAdapter({
        cfg,
        wallet,
        env: process.env,
        providerIdOverride: walletSelection.providerId,
        walletId: walletSelection.walletId,
      });
      const effectiveWallet = applyWalletPolicyConfig({
        config: wallet,
        cfg,
        env: process.env,
        walletId: walletSelection.walletId,
      });
      enforceWalletSkillAccessEnabled({
        wallet: effectiveWallet,
        requesterSkillId: opts?.requesterSkillId,
      });
      const providerCapabilities = buildWalletProviderCapabilityMatrix(provider);

      if (action === "list") {
        const registry = readWalletProviderRegistry(process.env);
        return jsonResult({
          ok: true,
          defaultWalletId: registry.defaultWalletId,
          assignments: registry.assignments,
          wallets: registry.wallets.map(summarizeNamedWallet),
        });
      }

      if (action === "balances") {
        const registry = readWalletProviderRegistry(process.env);
        const entries = [];
        for (const namedWallet of registry.wallets) {
          entries.push(
            await collectWalletBalanceEntry({
              cfg,
              walletConfig: wallet,
              namedWallet,
              chain,
            }),
          );
        }
        return jsonResult({
          ok: true,
          chain: chain ?? "all",
          defaultWalletId: registry.defaultWalletId,
          wallets: entries,
        });
      }

      if (action === "status") {
        const health = await provider.health();
        let addresses: { solana?: string } | undefined;
        try {
          addresses = await provider.getAddresses({ walletId: walletSelection.walletId });
        } catch {
          addresses = undefined;
        }
        return jsonResult({
          ok: true,
          health,
          provider: {
            id: provider.id,
            name: provider.displayName,
            capabilities: provider.capabilities,
            operationMatrix: providerCapabilities,
          },
          walletRoute: walletSelection.walletId
            ? {
                walletId: walletSelection.walletId,
                walletName: walletSelection.walletName,
                providerId: walletSelection.providerId,
                source: walletSelection.source,
              }
            : {
                providerId: walletSelection.providerId ?? provider.id,
                source: walletSelection.source,
              },
          assignment: walletSelection.walletId
            ? {
                walletId: walletSelection.walletId,
                walletName: walletSelection.walletName,
                providerId: walletSelection.providerId,
              }
            : null,
          addresses,
          policy: {
            executionMode: effectiveWallet.execution.mode,
            directSigning: effectiveWallet.policy.directSigning,
            toolAccess: wallet.toolAccess,
          },
        });
      }
      if (action === "address") {
        const addresses = await provider.getAddresses({ walletId: walletSelection.walletId });
        if (!chain) {
          return jsonResult({
            ok: true,
            result: {
              ok: true,
              walletId: walletSelection.walletId,
              walletName: walletSelection.walletName,
              providerId: walletSelection.providerId,
              addresses,
            },
          });
        }
        if (
          !providerSupportsChainOperation({
            matrix: providerCapabilities,
            chain,
            operation: "receiveAddress",
          })
        ) {
          throw new Error(
            `wallet provider ${provider.id} does not support address on chain: ${chain}`,
          );
        }
        const address = addresses.solana;
        if (!address) {
          throw new Error(`wallet provider did not return ${chain} address`);
        }
        const result = { ok: true, chain, address };
        return jsonResult({ ok: true, result });
      }
      if (action === "balance") {
        const program = readStringParam(params, "program");
        const externalAddress = readStringParam(params, "address");
        if (!chain && externalAddress) {
          return jsonResult({
            ok: true,
            result: await resolveSolanaAssetsResult({
              ownerAddress: externalAddress,
              external: true,
            }),
          });
        }
        if (!chain) {
          const registry = readWalletProviderRegistry(process.env);
          const namedWallet =
            registry.wallets.find((entry) => entry.id === walletSelection.walletId) ??
            (walletSelection.walletId
              ? ({
                  id: walletSelection.walletId,
                  name: walletSelection.walletName ?? walletSelection.walletId,
                  providerId: walletSelection.providerId ?? provider.id,
                } as WalletNamedWallet)
              : null);
          if (!namedWallet) {
            throw new Error("walletHandle, walletId, walletName, providerId, or chain required");
          }
          return jsonResult({
            ok: true,
            result: await collectWalletBalanceEntry({
              cfg,
              walletConfig: wallet,
              namedWallet,
            }),
          });
        }
        if (externalAddress && chain !== "solana") {
          throw new Error("external wallet address balance currently supports solana only");
        }
        if (chain === "solana" && (program || externalAddress)) {
          const result = await resolveSolanaAssetBalance({
            provider,
            walletId: walletSelection.walletId,
            ownerAddress: externalAddress,
            program,
          });
          return jsonResult({ ok: true, result });
        }
        if (
          !providerSupportsChainOperation({
            matrix: providerCapabilities,
            chain,
            operation: "getBalance",
          })
        ) {
          throw new Error(
            `wallet provider ${provider.id} does not support balance on chain: ${chain}`,
          );
        }
        const result = await provider.getBalance(chain, { walletId: walletSelection.walletId });
        return jsonResult({ ok: true, result });
      }
      if (action === "assets") {
        if (chain && chain !== "solana") {
          throw new Error("wallet assets currently supports solana only");
        }
        const externalAddress = readStringParam(params, "address");
        let ownerAddress = externalAddress?.trim();
        if (!ownerAddress) {
          const addresses = await provider.getAddresses({ walletId: walletSelection.walletId });
          ownerAddress = addresses.solana?.trim();
        }
        if (!ownerAddress) {
          throw new Error("wallet has no Solana address");
        }
        const result = await resolveSolanaAssetsResult({
          walletId: walletSelection.walletId,
          ownerAddress,
          external: Boolean(externalAddress),
        });
        return jsonResult({
          ok: true,
          result,
        });
      }
      if (action !== "prepare" && action !== "send") {
        throw new Error(`unknown action: ${action}`);
      }
      if (!chain) {
        throw new Error("chain required for prepare/send");
      }
      if (chain !== "solana") {
        throw new Error(`wallet ${action} currently supports only solana`);
      }
      const amountRaw = readStringParam(params, "amount");
      const amountFormatRaw = readStringParam(params, "amountFormat");
      const amountFormat = resolveWalletSendAmountFormat({ amountRaw, amountFormatRaw });
      const normalizedAmount = normalizeWalletSendAmount({
        amountRaw,
        chain,
        amountFormat,
      });

      const payload: WalletSendPayload = {
        chain,
        to: await resolveWalletDestination({
          cfg,
          wallet,
          chain,
          toRaw: readStringParam(params, "to"),
          env: process.env,
        }),
        amount: normalizedAmount,
        amountDisplay: amountFormat === "human" ? amountRaw?.trim() : undefined,
        contract: readStringParam(params, "contract"),
        program: readStringParam(params, "program"),
        memo: readStringParam(params, "memo"),
        providerId: walletSelection.providerId,
        walletId: walletSelection.walletId,
        walletName: walletSelection.walletName,
      };
      if (chain === "solana" && payload.program) {
        assertValidSolanaAddress(payload.program, "SPL mint address");
      }
      const approvalToken = readStringParam(params, "approvalToken");
      const approvalHost = readStringParam(params, "approvalHost");
      const requesterSkillId = opts?.requesterSkillId?.trim() || null;
      const permissions = readSkillWalletActionPermissions(cfg, requesterSkillId);
      await enforceWalletSkillPolicy({
        cfg,
        permissions,
        requesterAgentId,
        requesterSkillId,
        action,
        role: riskyWalletAction ? "agent" : undefined,
        walletId: walletSelection.walletId,
        chain,
        inputMint: chain === "solana" ? payload.program : undefined,
        amount: payload.amount,
        autonomous: action === "send",
        scheduled: false,
        requireManifest: Boolean(requesterSkillId),
        env: process.env,
      });
      const policy = validateWalletTxPolicy({
        config: effectiveWallet,
        action,
        requireDirectSigning: false,
        chain,
        amount: payload.amount,
        contract: payload.contract,
        program: payload.program,
      });
      if (!policy.ok) {
        throw new Error(policy.message ?? policy.code ?? "wallet policy rejected");
      }
      if (
        !providerSupportsChainOperation({
          matrix: providerCapabilities,
          chain,
          operation: action,
        })
      ) {
        throw new Error(
          `wallet provider ${provider.id} does not support ${action} on chain: ${chain}`,
        );
      }

      if (action === "prepare") {
        if (!provider.prepareTx) {
          throw new Error(`wallet provider ${provider.id} does not support prepare`);
        }
        const result = await provider.prepareTx(payload);
        return jsonResult({ ok: true, result });
      }

      const createOrExecute = resolveCreateOrExecuteWalletSend();
      if (!createOrExecute) {
        throw new Error(
          "wallet send runtime unavailable: createOrExecuteWalletSend is missing in wallet-send-approvals module",
        );
      }

      const result = await createOrExecute({
        payload,
        requestedBy: requesterAgentId ?? ownerAgentId,
        sendPath: "automation",
        config: effectiveWallet,
        runtimeConfig: cfg,
        providerIdOverride: walletSelection.providerId,
        approvalToken,
        approvalHost,
        env: process.env,
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      if (result.mode === "manual") {
        return jsonResult({
          ok: false,
          approvalRequired: true,
          code: "wallet_send_approval_required",
          message: "wallet send requires operator approval in Control UI",
          requestId: result.request.id,
          expiresAt: result.request.expiresAt,
        });
      }
      return jsonResult({
        ok: true,
        executed: true,
        mode: "autonomous",
        sent: {
          chain,
          fromWalletId: walletSelection.walletId,
          fromWalletName: walletSelection.walletName,
          to: payload.to,
          amount: payload.amount,
          ...(payload.amountDisplay ? { amountDisplay: payload.amountDisplay } : {}),
          unit: chain === "solana" && !payload.program ? "SOL" : undefined,
          program: payload.program,
        },
        tx: result.tx,
      });
    },
  };
}
