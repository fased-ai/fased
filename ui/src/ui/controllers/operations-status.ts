import { createFederationApi } from "../federation-api.js";
import type { FederationStatus, FederationToken } from "../federation-api.js";
import {
  getMiningProfile,
  getMiningHistory,
  getMiningReadiness,
  getMiningStatus,
  getMiningWalletAttachment,
} from "../mining-api.js";
import type {
  SatMinerProfile,
  SatMiningHistory,
  SatMiningReadiness,
  SatMiningRuntimeStatus,
} from "../mining-api.js";
import {
  getWalletBalances,
  getWalletNamedWallets,
  getWalletStatus,
  type WalletNamedWallet,
} from "../wallet-api.js";
import type { WalletStatus } from "../wallet-api.js";

export type OperationsStatusState = {
  connected: boolean;
  walletStatus: WalletStatus | null;
  walletNamedWallets: WalletNamedWallet[];
  walletAssignments: Record<string, string>;
  walletDefaultWalletId: string | null;
  miningAttachedWalletId: string | null;
  miningProfile: SatMinerProfile | null;
  miningReadiness: SatMiningReadiness | null;
  miningStatus: SatMiningRuntimeStatus | null;
  miningHistory: SatMiningHistory | null;
  federationToken: FederationToken | null;
  federationStatus: FederationStatus | null;
};

function filterDisplayWallets(wallets: WalletNamedWallet[]) {
  return wallets.filter(
    (wallet) => !wallet.id.startsWith("auto_") && !wallet.id.startsWith("status_"),
  );
}

async function loadWalletSummary(state: OperationsStatusState) {
  const [statusResult, namedWalletsResult] = await Promise.allSettled([
    getWalletStatus(),
    getWalletNamedWallets(),
  ]);

  if (statusResult.status === "fulfilled") {
    state.walletStatus = statusResult.value.status;
  }

  if (namedWalletsResult.status === "fulfilled") {
    const displayWallets = filterDisplayWallets(namedWalletsResult.value.wallets);
    const balanceResults = await Promise.allSettled(
      displayWallets.map(async (wallet) => {
        if (!wallet.addresses?.solana) {
          return wallet;
        }
        const result = await getWalletBalances("solana", { walletId: wallet.id });
        const solanaBalance = result.balances.solana;
        if (!solanaBalance?.ok || typeof solanaBalance.balance !== "string") {
          return wallet;
        }
        return {
          ...wallet,
          balances: {
            ...wallet.balances,
            solana: solanaBalance.balance,
          },
        } satisfies WalletNamedWallet;
      }),
    );
    state.walletNamedWallets = balanceResults.map((result, index) =>
      result.status === "fulfilled" ? result.value : displayWallets[index],
    );
    state.walletAssignments = namedWalletsResult.value.assignments;
    state.walletDefaultWalletId = namedWalletsResult.value.defaultWalletId ?? null;
  }
}

async function loadMiningSummary(state: OperationsStatusState) {
  const [profileResult, attachmentResult, statusResult, historyResult] = await Promise.allSettled([
    getMiningProfile(),
    getMiningWalletAttachment(),
    getMiningStatus(),
    getMiningHistory("7d", { activityWindow: "7d" }),
  ]);

  if (profileResult.status === "fulfilled") {
    state.miningProfile = profileResult.value.profile;
  }
  if (statusResult.status === "fulfilled") {
    state.miningStatus = statusResult.value.status;
  }
  if (historyResult.status === "fulfilled") {
    state.miningHistory = historyResult.value.history;
  }

  let attachedWalletId: string | null = null;
  if (attachmentResult.status === "fulfilled") {
    attachedWalletId = attachmentResult.value.attachment?.walletId ?? null;
  }
  if (attachedWalletId === null && statusResult.status === "fulfilled") {
    attachedWalletId = statusResult.value.status.walletId ?? null;
  }
  if (attachedWalletId === null && profileResult.status === "fulfilled") {
    attachedWalletId = profileResult.value.profile?.walletId ?? null;
  }
  state.miningAttachedWalletId = attachedWalletId;

  if (!attachedWalletId) {
    state.miningReadiness = null;
    return;
  }

  const readinessResult = await Promise.allSettled([getMiningReadiness(attachedWalletId)]);
  if (readinessResult[0]?.status === "fulfilled") {
    state.miningReadiness = readinessResult[0].value.readiness;
  }
}

async function loadFederationSummary(state: OperationsStatusState) {
  const status = await createFederationApi().getStatus();
  state.federationStatus = status.status;
  if (status.status.token) {
    state.federationToken = status.status.token;
  } else if (!status.status.joined) {
    state.federationToken = null;
  }
}

export async function loadOperationsStatus(state: OperationsStatusState): Promise<void> {
  if (!state.connected) {
    return;
  }

  await Promise.allSettled([
    loadWalletSummary(state),
    loadMiningSummary(state),
    loadFederationSummary(state),
  ]);
}
