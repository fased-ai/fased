export type WalletChain = "solana";
export type WalletRuntimeMode = "managed" | "external";
export type WalletRuntimeKind = "external-docker" | "external-custom";
export type WalletExternalKind = "docker" | "custom";
export type WalletAuthMode = "jwt-bootstrap" | "static-token-compat";
export type WalletToolAccessMode = "owner-only" | "allowlist" | "all";
export type WalletExecutionMode = "manual" | "autonomous";
export type WalletApprovalAuthMode = "none" | "webauthn";
export type WalletProviderId =
  | "embedded-keystore"
  | "local-socket-signer"
  | "alchemy"
  | "turnkey"
  | "wallet-standard"
  | "privy";

export type WalletConfig = {
  provider?: WalletProviderConfig;
  execution?: WalletExecutionConfig;
  approvalAuth?: WalletApprovalAuthConfig;
  keystore?: WalletKeystoreConfig;
  runtime?: WalletRuntimeConfig;
};

export type WalletProviderConfig = {
  id?: WalletProviderId;
};

export type WalletExecutionConfig = {
  mode?: WalletExecutionMode;
};

export type WalletApprovalAuthConfig = {
  mode?: WalletApprovalAuthMode;
  challengeTtlSeconds?: number;
  grantTtlSeconds?: number;
};

export type WalletKeystoreConfig = {
  enabled?: boolean;
  path?: string;
  chainSupport?: WalletChain[];
  autoLockSeconds?: number;
  requirePasskeyForUnlock?: boolean;
};

export type WalletRuntimeConfig = {
  enabled?: boolean;
  mode?: WalletRuntimeMode;
  runtime?: WalletRuntimeKind;
  external?: WalletExternalConfig;
  auth?: WalletAuthConfig;
  source?: WalletSourceConfig;
  chains?: WalletChain[];
  service?: WalletServiceConfig;
  install?: WalletInstallConfig;
  policy?: WalletPolicyConfig;
  toolAccess?: WalletToolAccessConfig;
};

export type WalletExternalConfig = {
  kind?: WalletExternalKind;
};

export type WalletAuthConfig = {
  mode?: WalletAuthMode;
  bootstrapUrl?: string;
};

export type WalletSourceConfig = {
  ref?: string;
};

export type WalletServiceConfig = {
  host?: string;
  port?: number;
};

export type WalletInstallConfig = {
  enabled?: boolean;
  version?: string;
};

export type WalletPolicyConfig = {
  capsEnabled?: boolean;
  directSigning?: boolean;
  skillsEnabled?: boolean;
  solana?: WalletChainPolicy;
};

export type WalletChainPolicy = {
  allowPrograms?: string[];
  tokenCaps?: Record<string, WalletTokenPolicyCap>;
  maxPerTx?: string;
  maxDaily?: string;
};

export type WalletTokenPolicyCap = {
  maxPerTx?: string;
  maxDaily?: string;
};

export type WalletToolAccessConfig = {
  mode?: WalletToolAccessMode;
  allowAgents?: string[];
  allowSkills?: string[];
  denySkills?: string[];
  allowSources?: string[];
};
