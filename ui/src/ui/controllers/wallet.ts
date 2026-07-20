import type { FasedAgentApp } from "../app.js";
import { getMiningProfile, getMiningReadiness, getMiningStatus } from "../mining-api.js";
import { looksLikeRpcFailure, looksLikeRpcQuotaError } from "../notifications.ts";
import {
  getWalletApprovals,
  getWalletAuditFor,
  getWalletBalances,
  getWalletNamedWallets,
  getWalletProviders,
  getWalletSettings,
  getWalletSignerDoctor,
  getWalletStatus,
  type WalletNamedWallet,
} from "../wallet-api.js";

const walletLoadTokens = new WeakMap<FasedAgentApp, number>();
const walletBalanceCache = new WeakMap<
  FasedAgentApp,
  Map<
    string,
    {
      addresses?: WalletNamedWallet["addresses"];
      balances?: WalletNamedWallet["balances"];
      rpcReady: boolean;
    }
  >
>();

function compactWalletAddresses(input: {
  solana?: string | undefined;
}): WalletNamedWallet["addresses"] {
  return input.solana === undefined ? {} : { solana: input.solana };
}

function compactWalletBalances(input: {
  solana?: string | undefined;
}): WalletNamedWallet["balances"] {
  return input.solana === undefined ? {} : { solana: input.solana };
}

function emitAppNotification(
  host: FasedAgentApp,
  input: Parameters<FasedAgentApp["enqueueAppNotification"]>[0],
) {
  (
    host as unknown as { enqueueAppNotification?: (payload: typeof input) => void }
  ).enqueueAppNotification?.(input);
}

function readSuccessfulBalance(
  result:
    | {
        ok?: boolean;
        balance?: string;
      }
    | undefined,
): string | undefined {
  if (!result?.ok) {
    return undefined;
  }
  if (typeof result.balance !== "string") {
    return undefined;
  }
  return result.balance.trim() ? result.balance : undefined;
}

function normalizeWalletRouteId(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function getWalletBalanceCache(host: FasedAgentApp) {
  let cache = walletBalanceCache.get(host);
  if (!cache) {
    cache = new Map();
    walletBalanceCache.set(host, cache);
  }
  return cache;
}

function mergeCachedWalletData(
  wallet: WalletNamedWallet,
  cached:
    | {
        addresses?: WalletNamedWallet["addresses"];
        balances?: WalletNamedWallet["balances"];
        rpcReady: boolean;
      }
    | undefined,
) {
  if (!cached) {
    return wallet;
  }
  return {
    ...wallet,
    addresses: compactWalletAddresses({
      solana: cached.addresses?.solana ?? wallet.addresses?.solana,
    }),
    ...((cached.balances ?? wallet.balances)
      ? { balances: cached.balances ?? wallet.balances }
      : {}),
    readiness: {
      ...wallet.readiness,
      keystore: Boolean(wallet.readiness?.keystore),
      rpc: Boolean(wallet.readiness?.rpc || cached.rpcReady),
    },
  } satisfies WalletNamedWallet;
}

function signerDoctorIsHealthy(
  report:
    | {
        ok?: boolean;
        running?: boolean;
        checks?: Array<{ check: string; ok: boolean; detail?: string }>;
      }
    | undefined,
): boolean {
  if (!report) {
    return false;
  }
  if (report.ok && report.running) {
    return true;
  }
  return Boolean(
    report.running && report.checks?.some((check) => check.ok && check.check === "socket.health"),
  );
}

function looksLikeTransientLocalSignerSocketError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return (
    /local-signer\.sock/.test(message) && /(ENOENT|ECONNREFUSED|connect|not found)/i.test(message)
  );
}

function buildWalletBalanceCacheEntry(
  result: Awaited<ReturnType<typeof getWalletBalances>>,
  fallback?: WalletNamedWallet,
) {
  const solBalance = readSuccessfulBalance(result.balances.solana);
  const balances =
    solBalance !== undefined ? compactWalletBalances({ solana: solBalance }) : fallback?.balances;
  return {
    addresses: compactWalletAddresses({
      solana: result.addresses?.solana ?? fallback?.addresses?.solana,
    }),
    ...(balances ? { balances } : {}),
    rpcReady: Boolean(fallback?.readiness?.rpc || result.balances.solana?.ok),
  };
}

type WalletBalanceRefreshResult = {
  walletId: string;
  result?: Awaited<ReturnType<typeof getWalletBalances>>;
  error?: unknown;
};

type WalletAuditRefreshResult =
  | {
      status: "fulfilled";
      value: Awaited<ReturnType<typeof getWalletAuditFor>>;
    }
  | {
      status: "rejected";
      reason: unknown;
    };

function getWalletAuditRefreshResult(): Promise<WalletAuditRefreshResult> {
  return getWalletAuditFor(500).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  );
}

function applyWalletAuditResult(host: FasedAgentApp, result: WalletAuditRefreshResult) {
  if (result.status === "fulfilled") {
    host.walletAuditEntries = result.value.entries;
    host.walletActivityPage = 1;
  } else {
    host.walletAuditEntries = [];
    host.walletAuditError = String(result.reason);
    host.walletActivityPage = 1;
  }
  host.walletAuditLoading = false;
}

function mergeWalletBalanceRefreshResults(
  host: FasedAgentApp,
  results: WalletBalanceRefreshResult[],
) {
  const cache = getWalletBalanceCache(host);
  let updated = false;
  for (const entry of results) {
    if (!entry.result) {
      continue;
    }
    const fallback = host.walletNamedWallets.find((wallet) => wallet.id === entry.walletId);
    cache.set(entry.walletId, buildWalletBalanceCacheEntry(entry.result, fallback));
    updated = true;
  }
  if (!updated) {
    return;
  }
  host.walletNamedWallets = host.walletNamedWallets.map((wallet) =>
    mergeCachedWalletData(wallet, cache.get(wallet.id)),
  );
}

function findChainWalletEntry(
  entries:
    | Array<{
        walletId: string;
        decryptReady: boolean;
        rpcConfigured: boolean;
      }>
    | undefined,
  walletId: string,
) {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const normalized = normalizeWalletRouteId(walletId);
  return entries.find((entry) => {
    const id = String(entry.walletId ?? "").trim();
    return id === walletId || normalizeWalletRouteId(id) === normalized;
  });
}

function mergeWalletReadiness(
  wallet: WalletNamedWallet,
  solanaDoctor:
    | {
        decryptReady: boolean;
        rpcConfigured: boolean;
        rpcDetail?: string;
      }
    | undefined,
): NonNullable<WalletNamedWallet["readiness"]> {
  const signerKeystoreReady = Boolean(solanaDoctor?.decryptReady);
  return {
    keystore:
      wallet.providerId === "local-socket-signer"
        ? signerKeystoreReady
        : Boolean(wallet.readiness?.keystore || signerKeystoreReady),
    rpc: Boolean(wallet.readiness?.rpc || solanaDoctor?.rpcConfigured),
    ...(wallet.readiness?.ready === undefined ? {} : { ready: wallet.readiness.ready }),
    ...(wallet.readiness?.error === undefined ? {} : { error: wallet.readiness.error }),
    ...(wallet.readiness?.signer === undefined ? {} : { signer: wallet.readiness.signer }),
    ...(wallet.readiness?.api === undefined ? {} : { api: wallet.readiness.api }),
    ...(wallet.readiness?.ata === undefined ? {} : { ata: wallet.readiness.ata }),
  };
}

function queueWalletMiningSummaryRefresh(host: FasedAgentApp, loadToken: number) {
  const isStale = () => walletLoadTokens.get(host) !== loadToken;
  void (async () => {
    const [profileResult, statusResult] = await Promise.allSettled([
      getMiningProfile(),
      getMiningStatus(),
    ]);
    if (isStale()) {
      return;
    }
    if (profileResult.status === "fulfilled") {
      host.miningProfile = profileResult.value.profile;
    }
    if (statusResult.status === "fulfilled") {
      host.miningStatus = statusResult.value.status;
    }
    const walletId = host.miningProfile?.walletId || undefined;
    if (!walletId) {
      return;
    }
    try {
      const readinessResponse = await getMiningReadiness(walletId);
      if (isStale()) {
        return;
      }
      host.miningReadiness = readinessResponse.readiness;
    } catch {
      // Best effort; wallet page should still load without mining readiness.
    }
  })().catch(() => {});
}

function notifyWalletRpcHealth(host: FasedAgentApp) {
  const rpcMessages = [
    host.walletError,
    host.walletBalancesError,
    host.walletStatus?.error ?? null,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (rpcMessages.length === 0) {
    return;
  }
  const firstQuota = rpcMessages.find((value) => looksLikeRpcQuotaError(value));
  if (firstQuota) {
    emitAppNotification(host, {
      code: "wallet.rpc_quota",
      category: "wallet",
      level: "error",
      title: "Wallet RPC quota or provider issue",
      message: firstQuota,
      dedupeKey: `wallet-rpc-quota:${firstQuota}`,
      cooldownMs: 30 * 60 * 1000,
    });
    return;
  }
  const firstRpcFailure = rpcMessages.find((value) => looksLikeRpcFailure(value));
  if (!firstRpcFailure) {
    return;
  }
  emitAppNotification(host, {
    code: "wallet.rpc_degraded",
    category: "wallet",
    level: "warning",
    title: "Wallet RPC degraded",
    message: firstRpcFailure,
    dedupeKey: `wallet-rpc-degraded:${firstRpcFailure}`,
    cooldownMs: 30 * 60 * 1000,
  });
}

function queueBackgroundWalletBalanceRefresh(
  host: FasedAgentApp,
  loadToken: number,
  walletIds: string[],
) {
  if (walletIds.length === 0) {
    return;
  }
  const isStale = () => walletLoadTokens.get(host) !== loadToken;
  void Promise.all(
    walletIds.map(async (walletId) => {
      try {
        return {
          walletId,
          result: await getWalletBalances("all", { walletId }),
        } satisfies WalletBalanceRefreshResult;
      } catch (error) {
        return {
          walletId,
          error,
        } satisfies WalletBalanceRefreshResult;
      }
    }),
  )
    .then((results) => {
      if (isStale()) {
        return;
      }
      mergeWalletBalanceRefreshResults(host, results);
    })
    .catch(() => {});
}

export async function loadWallet(host: FasedAgentApp) {
  const loadToken = (walletLoadTokens.get(host) ?? 0) + 1;
  walletLoadTokens.set(host, loadToken);
  const isStale = () => walletLoadTokens.get(host) !== loadToken;
  host.walletLoading = true;
  host.walletSettingsLoading = true;
  host.walletApprovalsLoading = true;
  host.walletAuditLoading = true;
  host.walletBalancesLoading = true;
  host.walletProvidersLoading = true;
  host.walletError = null;
  host.walletSettingsError = null;
  host.walletApprovalsError = null;
  host.walletAuditError = null;
  host.walletBalancesError = null;
  const requestedStatusWalletId =
    host.walletDetailsWalletId.trim() || host.walletSendCreateForm.walletId?.trim() || undefined;
  const auditResultPromise = getWalletAuditRefreshResult();
  void auditResultPromise.then((auditResult) => {
    if (isStale()) {
      return;
    }
    applyWalletAuditResult(host, auditResult);
  });
  try {
    const [
      statusResult,
      settingsResult,
      approvalsResult,
      providersResult,
      namedWalletsResult,
      signerDoctorResult,
    ] = await Promise.allSettled([
      getWalletStatus(),
      getWalletSettings(requestedStatusWalletId),
      getWalletApprovals({
        status: host.walletApprovalsFilter,
        limit: 100,
      }),
      getWalletProviders(),
      getWalletNamedWallets(),
      getWalletSignerDoctor(),
    ]);
    if (isStale()) {
      return;
    }

    if (statusResult.status === "fulfilled") {
      host.walletStatus = statusResult.value.status;
      if (signerDoctorResult.status === "fulfilled") {
        host.walletStatus = {
          ...host.walletStatus,
          signerDaemon: signerDoctorResult.value.report,
          chainWallets: signerDoctorResult.value.chainWallets,
        };
      }
      if (!statusResult.value.status.service.healthy) {
        const signerDoctorRecovered =
          signerDoctorResult.status === "fulfilled" &&
          signerDoctorIsHealthy(signerDoctorResult.value.report) &&
          looksLikeTransientLocalSignerSocketError(statusResult.value.status.error);
        if (signerDoctorRecovered && host.walletStatus) {
          host.walletStatus = {
            ...host.walletStatus,
            error: undefined,
            service: {
              ...host.walletStatus.service,
              healthy: true,
            },
            startupState:
              host.walletStatus.startupState === "unreachable"
                ? "healthy"
                : host.walletStatus.startupState,
          };
          host.walletError = null;
        } else {
          host.walletError =
            statusResult.value.status.error ||
            (signerDoctorResult.status === "fulfilled"
              ? signerDoctorResult.value.report.checks
                  .filter((check) => !check.ok)
                  .slice(0, 3)
                  .map((check) => check.detail || check.check)
                  .join("; ") || "Wallet signer is not healthy."
              : "Wallet signer is not healthy.");
        }
      }
    } else {
      host.walletStatus = null;
      host.walletError = String(statusResult.reason);
    }

    if (settingsResult.status === "fulfilled") {
      host.walletSettings = settingsResult.value.settings;
    } else {
      host.walletSettings = null;
      host.walletSettingsError = String(settingsResult.reason);
    }

    if (approvalsResult.status === "fulfilled") {
      host.walletApprovals = approvalsResult.value.requests;
    } else {
      host.walletApprovals = [];
      host.walletApprovalsError = String(approvalsResult.reason);
    }

    if (namedWalletsResult.status === "fulfilled") {
      const previousDetailsWalletId = host.walletDetailsWalletId.trim();
      const namedWallets = namedWalletsResult.value.wallets.filter(
        (wallet) => !wallet.id.startsWith("auto_") && !wallet.id.startsWith("status_"),
      );
      const cachedBalances = getWalletBalanceCache(host);
      const chainWallets = host.walletStatus?.chainWallets;
      const liveStatusWallets = new Map(
        (host.walletStatus?.wallets ?? []).map((wallet) => [wallet.id, wallet]),
      );
      const immediateWallets = namedWallets.map((wallet) => {
        const solanaDoctor = findChainWalletEntry(chainWallets?.solana, wallet.id);
        const liveStatusWallet = liveStatusWallets.get(wallet.id);
        return mergeCachedWalletData(
          {
            ...wallet,
            readiness: mergeWalletReadiness(
              {
                ...wallet,
                readiness: liveStatusWallet?.readiness ?? wallet.readiness,
              },
              solanaDoctor,
            ),
          } satisfies WalletNamedWallet,
          cachedBalances.get(wallet.id),
        );
      });
      host.walletNamedWallets = immediateWallets;
      host.walletAssignments = namedWalletsResult.value.assignments;
      host.walletDefaultWalletId = namedWalletsResult.value.defaultWalletId ?? null;
      const walletIds = new Set(immediateWallets.map((wallet) => wallet.id));
      if (host.walletDetailsWalletId.trim() && !walletIds.has(host.walletDetailsWalletId.trim())) {
        host.walletDetailsWalletId = "";
      }
      const currentBalanceWalletId = String(host.walletBalanceWalletId ?? "").trim();
      if (currentBalanceWalletId && !walletIds.has(currentBalanceWalletId)) {
        host.walletBalanceWalletId = "";
      }
      const currentExpandedWalletId = String(host.walletExpandedPanelWalletId ?? "").trim();
      if (currentExpandedWalletId && !walletIds.has(currentExpandedWalletId)) {
        host.walletExpandedPanelWalletId = "";
        host.walletExpandedPanel = "";
      }
      if (!host.walletDetailsWalletId) {
        host.walletDetailsWalletId =
          host.walletDefaultWalletId && walletIds.has(host.walletDefaultWalletId)
            ? host.walletDefaultWalletId
            : (immediateWallets[0]?.id ?? "");
      }
      if (host.walletDetailsWalletId !== previousDetailsWalletId) {
        host.walletRpcUrl = "";
      }
      const sendWalletId = host.walletSendCreateForm.walletId?.trim() ?? "";
      if (sendWalletId && !walletIds.has(sendWalletId)) {
        host.walletSendCreateForm = { ...host.walletSendCreateForm, walletId: "" };
      }
      if (!host.walletSendCreateForm.walletId?.trim()) {
        host.walletSendCreateForm = {
          ...host.walletSendCreateForm,
          walletId: host.walletDetailsWalletId || immediateWallets[0]?.id || "",
        };
      }
      const selectedWallet = immediateWallets.find(
        (wallet) => wallet.id === host.walletDetailsWalletId,
      );
      if (selectedWallet) {
        host.walletProviderSelection = selectedWallet.providerId;
        host.walletProviderTab = selectedWallet.providerId;
      }
    } else {
      host.walletNamedWallets = [];
      host.walletAssignments = {};
      host.walletDefaultWalletId = null;
    }

    if (providersResult.status === "fulfilled") {
      host.walletProviders = providersResult.value.providers;
    } else {
      host.walletProviders = [];
      host.walletSettingsError ??= `Loading wallet providers failed: ${String(providersResult.reason)}`;
    }

    const auditWalletId =
      host.walletDetailsWalletId.trim() || host.walletSendCreateForm.walletId?.trim() || undefined;
    const selectedWalletId = String(host.walletBalanceWalletId ?? "").trim() || auditWalletId;
    const backgroundWalletIds = host.walletNamedWallets
      .map((wallet) => wallet.id)
      .filter((walletId) => walletId !== selectedWalletId);
    queueWalletMiningSummaryRefresh(host, loadToken);
    queueBackgroundWalletBalanceRefresh(host, loadToken, backgroundWalletIds);

    const balancesResultPromise = (
      selectedWalletId
        ? getWalletBalances("all", { walletId: selectedWalletId, includeAssets: true })
        : Promise.resolve(null)
    ).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );

    const auditResult = await auditResultPromise;
    if (isStale()) {
      return;
    }

    applyWalletAuditResult(host, auditResult);

    const balancesResult = await balancesResultPromise;
    if (isStale()) {
      return;
    }

    if (balancesResult.status === "fulfilled") {
      host.walletBalances = balancesResult.value;
      if (selectedWalletId && balancesResult.value) {
        const fallback = host.walletNamedWallets.find((wallet) => wallet.id === selectedWalletId);
        const cache = getWalletBalanceCache(host);
        cache.set(selectedWalletId, buildWalletBalanceCacheEntry(balancesResult.value, fallback));
        host.walletNamedWallets = host.walletNamedWallets.map((wallet) =>
          wallet.id === selectedWalletId
            ? mergeCachedWalletData(wallet, cache.get(selectedWalletId))
            : wallet,
        );
      }
    } else {
      host.walletBalances = null;
      host.walletBalancesError = String(balancesResult.reason);
    }
    host.walletBalancesLoading = false;
    notifyWalletRpcHealth(host);
  } catch (err) {
    if (isStale()) {
      return;
    }
    host.walletStatus = null;
    host.walletSettings = null;
    host.walletApprovals = [];
    host.walletAuditEntries = [];
    host.walletActivityPage = 1;
    host.walletBalances = null;
    host.walletProviders = [];
    host.walletNamedWallets = [];
    host.walletAssignments = {};
    host.walletDefaultWalletId = null;
    host.walletError = String(err);
    notifyWalletRpcHealth(host);
  } finally {
    if (!isStale()) {
      host.walletLoading = false;
      host.walletSettingsLoading = false;
      host.walletApprovalsLoading = false;
      host.walletAuditLoading = false;
      host.walletBalancesLoading = false;
      host.walletProvidersLoading = false;
    }
  }
}
