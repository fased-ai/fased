import {
  checkNamedWalletDeletionSafety,
  deleteNamedWallet,
  nextRoleWalletIdentity,
  normalizeWalletUserRole,
  readWalletProviderRegistry,
  replaceRetiredMiningWallet,
  resolveWalletSelection,
  resolveWalletSelectionForAgent,
  resolveWalletUserRole,
  setAgentWalletAssignment,
  setDefaultWallet,
  setNamedWalletRole,
  setWalletProviderEnabled,
  setWalletProvidersEnabled,
  upsertNamedWallet,
  writeWalletProviderRegistry,
} from "./wallet-provider-registry.js";

export type WalletRegistryFacade = {
  checkDeletionSafety: typeof checkNamedWalletDeletionSafety;
  delete: typeof deleteNamedWallet;
  nextRoleIdentity: typeof nextRoleWalletIdentity;
  normalizeRole: typeof normalizeWalletUserRole;
  read: typeof readWalletProviderRegistry;
  replaceRetiredMiningWallet: typeof replaceRetiredMiningWallet;
  resolveRole: typeof resolveWalletUserRole;
  resolveSelection: typeof resolveWalletSelection;
  resolveSelectionForAgent: typeof resolveWalletSelectionForAgent;
  setAgentAssignment: typeof setAgentWalletAssignment;
  setDefault: typeof setDefaultWallet;
  setProviderEnabled: typeof setWalletProviderEnabled;
  setProvidersEnabled: typeof setWalletProvidersEnabled;
  setRole: typeof setNamedWalletRole;
  upsert: typeof upsertNamedWallet;
  write: typeof writeWalletProviderRegistry;
};

type WalletRegistryFacadeDependencies = WalletRegistryFacade;

export function createWalletRegistryFacade(
  overrides: Partial<WalletRegistryFacadeDependencies> = {},
): WalletRegistryFacade {
  return {
    checkDeletionSafety: checkNamedWalletDeletionSafety,
    delete: deleteNamedWallet,
    nextRoleIdentity: nextRoleWalletIdentity,
    normalizeRole: normalizeWalletUserRole,
    read: readWalletProviderRegistry,
    replaceRetiredMiningWallet,
    resolveRole: resolveWalletUserRole,
    resolveSelection: resolveWalletSelection,
    resolveSelectionForAgent: resolveWalletSelectionForAgent,
    setAgentAssignment: setAgentWalletAssignment,
    setDefault: setDefaultWallet,
    setProviderEnabled: setWalletProviderEnabled,
    setProvidersEnabled: setWalletProvidersEnabled,
    setRole: setNamedWalletRole,
    upsert: upsertNamedWallet,
    write: writeWalletProviderRegistry,
    ...overrides,
  };
}

export const walletRegistryFacade = createWalletRegistryFacade();
