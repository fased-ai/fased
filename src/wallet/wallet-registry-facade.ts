import {
  deleteNamedWallet,
  nextRoleWalletIdentity,
  normalizeWalletUserRole,
  readWalletProviderRegistry,
  resolveWalletSelection,
  resolveWalletSelectionForAgent,
  resolveWalletUserRole,
  setAgentWalletAssignment,
  setDefaultWallet,
  setWalletProviderEnabled,
  setWalletProvidersEnabled,
  upsertNamedWallet,
  writeWalletProviderRegistry,
} from "./wallet-provider-registry.js";

export type WalletRegistryFacade = {
  delete: typeof deleteNamedWallet;
  nextRoleIdentity: typeof nextRoleWalletIdentity;
  normalizeRole: typeof normalizeWalletUserRole;
  read: typeof readWalletProviderRegistry;
  resolveRole: typeof resolveWalletUserRole;
  resolveSelection: typeof resolveWalletSelection;
  resolveSelectionForAgent: typeof resolveWalletSelectionForAgent;
  setAgentAssignment: typeof setAgentWalletAssignment;
  setDefault: typeof setDefaultWallet;
  setProviderEnabled: typeof setWalletProviderEnabled;
  setProvidersEnabled: typeof setWalletProvidersEnabled;
  upsert: typeof upsertNamedWallet;
  write: typeof writeWalletProviderRegistry;
};

type WalletRegistryFacadeDependencies = WalletRegistryFacade;

export function createWalletRegistryFacade(
  overrides: Partial<WalletRegistryFacadeDependencies> = {},
): WalletRegistryFacade {
  return {
    delete: deleteNamedWallet,
    nextRoleIdentity: nextRoleWalletIdentity,
    normalizeRole: normalizeWalletUserRole,
    read: readWalletProviderRegistry,
    resolveRole: resolveWalletUserRole,
    resolveSelection: resolveWalletSelection,
    resolveSelectionForAgent: resolveWalletSelectionForAgent,
    setAgentAssignment: setAgentWalletAssignment,
    setDefault: setDefaultWallet,
    setProviderEnabled: setWalletProviderEnabled,
    setProvidersEnabled: setWalletProvidersEnabled,
    upsert: upsertNamedWallet,
    write: writeWalletProviderRegistry,
    ...overrides,
  };
}

export const walletRegistryFacade = createWalletRegistryFacade();
