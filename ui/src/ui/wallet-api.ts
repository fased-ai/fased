export type WalletProviderId =
  | "embedded-keystore"
  | "local-socket-signer"
  | "alchemy"
  | "turnkey"
  | "wallet-standard"
  | "privy";

export type WalletStatus = {
  capabilities?: {
    canEditPolicy: boolean;
    canSend: boolean;
    canSetupWallets: boolean;
    canEditProviders: boolean;
    canEditRpc: boolean;
  };
  policyDisplay?: {
    solana: {
      maxPerTx: { raw: string; human: string };
      maxDaily: { raw: string; human: string };
    };
  };
  wallets?: Array<{
    id: string;
    name: string;
    providerId: WalletProviderId;
    addresses?: { solana?: string };
    balances?: { solana?: string };
    readiness: {
      keystore: boolean;
      rpc: boolean;
      api?: boolean;
      ata?: boolean;
    };
  }>;
  providerSummary?: {
    id?: WalletProviderId;
    label?: string;
    category?: "embedded" | "local-signer" | "hosted-provider";
    signerMode?: "embedded-in-process" | "local-native-signer" | "hosted-provider";
  };
  configuredProviderId?: WalletProviderId;
  activeSignerMode?: "embedded-in-process" | "local-native-signer" | "hosted-provider";
  managedMode: boolean;
  enabled: boolean;
  mode: "managed" | "external";
  runtime: "external-docker" | "external-custom";
  settlement: {
    class: "real-chain";
    realChainReady: boolean;
    summary: string;
  };
  chains: Array<"solana">;
  service: {
    host: string;
    port: number;
    healthy: boolean;
    pid?: number;
    runtime?: string;
    startedAt?: string;
  };
  stack?: {
    configured: boolean;
    composePath: string;
    envPath: string;
    runningServices: number;
    healthy: boolean;
  };
  policy: {
    executionMode: "manual" | "autonomous";
    capsEnabled?: boolean;
    directSigning: boolean;
    skillsEnabled?: boolean;
    toolAccessMode: "owner-only" | "allowlist" | "all";
    allowAgents: string[];
    solana: {
      allowPrograms: string[];
      maxPerTx: string;
      maxDaily: string;
    };
  };
  approvalAuth: {
    mode: "none" | "webauthn";
    ready: boolean;
    passkeyCount: number;
    notes: string[];
    passkeys: Array<{
      id: string;
      label: string;
      createdAt: string;
      lastUsedAt?: string;
    }>;
    statePath: string;
  };
  nativeSignerApproval?: {
    configured: boolean;
    ready: boolean;
    credentialCount: number;
    credentialVersion: number;
  };
  addresses?: {
    solana?: string;
  };
  paths: {
    rootDir: string;
    keysPath: string;
    pidPath: string;
  };
  checkedAt: string;
  startupState: "healthy" | "degraded" | "unreachable";
  authState: "ok" | "required" | "mismatch" | "unknown";
  providerAuthMode?: "jwt-bootstrap" | "static-token-compat";
  providerAuthSource?: "bootstrap" | "secret" | "env" | "stack-env" | "none";
  providerAuthDetails?: {
    endpoint?: string;
    lastError?: string;
    lastSuccessAt?: string;
    expiresAt?: string;
  };
  error?: string;
  signerDaemon?: {
    ok: boolean;
    running: boolean;
    socketPath: string;
    pidPath: string;
    auditPath: string;
    checks: Array<{ check: string; ok: boolean; detail?: string }>;
  };
  chainWallets?: {
    solana: Array<{
      walletId: string;
      keystoreReady: boolean;
      decryptReady: boolean;
      rpcConfigured: boolean;
      keystoreDetail?: string;
      rpcDetail?: string;
    }>;
  };
};

export type WalletStatusResponse = {
  ok: true;
  status: WalletStatus;
};

export type WalletSignerDoctorResponse = {
  ok: true;
  report: NonNullable<WalletStatus["signerDaemon"]>;
  chainWallets: NonNullable<WalletStatus["chainWallets"]>;
};

export type WalletSendApprovalRequest = {
  id: string;
  taskLedgerId?: string;
  createdAt: string;
  expiresAt: string;
  status:
    | "pending"
    | "executing"
    | "approved"
    | "unknown"
    | "rejected"
    | "executed"
    | "failed"
    | "expired";
  requestedBy: string;
  approvedBy?: string;
  rejectedBy?: string;
  decisionAt?: string;
  reason?: string;
  payload: {
    chain: "solana";
    actionKind?: "send" | "solana_swap" | "signer_review";
    assetId?: string;
    assetSymbol?: string;
    assetName?: string;
    assetDecimals?: number;
    amountDisplay?: string;
    walletHandle?: string;
    providerId?: WalletProviderId;
    walletId?: string;
    walletName?: string;
    to?: string;
    amount?: string;
    contract?: string;
    program?: string;
    memo?: string;
    inputMint?: string;
    outputMint?: string;
    inputSymbol?: string;
    outputSymbol?: string;
    inputName?: string;
    outputName?: string;
    inputDecimals?: number;
    outputDecimals?: number;
    inputLogoUri?: string;
    outputLogoUri?: string;
    outAmount?: string;
    outAmountDisplay?: string;
    otherAmountThreshold?: string;
    slippageBps?: number;
    priceImpactPct?: string;
    routeLabel?: string;
    programIds?: string[];
    routeProgramIds?: string[];
    usesAddressLookupTables?: boolean;
    jupiterRequestId?: string;
    signerReviewId?: string;
    signerWalletId?: string;
    signerWalletPublicKey?: string;
    signerIntentType?: string;
    signerPolicyHash?: string;
    signerIntentDigest?: string;
    signerSemanticIntent?: unknown;
    signerArtifactKind?:
      | "solana-transaction"
      | "domain-separated-message"
      | "jupiter-trigger-state";
    signerArtifactDigest?: string;
    signerTransactionDigest?: string;
    signerStateDigest?: string;
    signerStateSlot?: number;
    signerAsset?: string;
    signerAmount?: string;
    signerDestination?: string;
    signerPolicyOperation?: string;
    signerRequiredPrograms?: string[];
    signerRequiredRole?: "agent" | "mining" | "vault";
    signerNonce?: string;
    signerIssuedAt?: string;
    signerReviewExpiresAt?: string;
  };
  simulation?: WalletPolicySimulation;
  approvalDiff?: WalletApprovalDiff;
  result?: {
    txHash?: string;
    error?: string;
  };
};

export type WalletPolicySimulationCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info";
  detail: string;
  code?: string;
};

export type WalletApprovalDiff = {
  fromWalletId?: string;
  fromWalletName?: string;
  fromRole: "mining" | "agent" | "vault";
  to?: string;
  chain: "solana";
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

export type WalletApprovalFilter = WalletSendApprovalRequest["status"] | "all";

export type WalletApprovalsResponse = {
  ok: true;
  requests: WalletSendApprovalRequest[];
};

export type WalletSolanaTokenSearchResult = {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  verified?: boolean;
  source: "native" | "jupiter" | "mint";
  exactMint: boolean;
};

export type WalletSolanaTokenSearchResponse = {
  ok: true;
  query: string;
  tokens: WalletSolanaTokenSearchResult[];
};

export type WalletSendCreateInput = {
  chain: "solana";
  amountFormat?: "base" | "human";
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
  assetId?: string;
  assetSymbol?: string;
  assetName?: string;
  assetDecimals?: number;
  amountDisplay?: string;
  to?: string;
  amount?: string;
  contract?: string;
  program?: string;
  memo?: string;
};

export type WalletSendCreateResponse = {
  ok: true;
  mode: "manual" | "autonomous";
  request?: WalletSendApprovalRequest;
  executed?: boolean;
  tx?: {
    ok: boolean;
    chain: "solana";
    txHash: string;
    signer?: string;
  };
  payload?: WalletSendCreateInput;
};

export type WalletSettings = {
  managedMode: boolean;
  provider: {
    id: WalletProviderId;
    operationsImplemented: boolean;
    supportedChains: Array<"solana">;
    requiresCredentials: boolean;
    capabilities: WalletProviderCapabilities;
  };
  runtime: {
    enabled: boolean;
    mode: "managed" | "external";
    runtime: "external-docker" | "external-custom";
    external: { kind: "docker" | "custom" };
    auth: {
      mode: "jwt-bootstrap" | "static-token-compat";
      bootstrapUrl?: string;
    };
    source: {
      ref: string;
    };
    chains: Array<"solana">;
    service: { host: string; port: number };
    install: { enabled: boolean; version: string };
  };
  execution: {
    mode: "manual" | "autonomous";
  };
  approvalAuth: {
    mode: "none" | "webauthn";
    challengeTtlSeconds: number;
    grantTtlSeconds: number;
  };
  policy: {
    capsEnabled?: boolean;
    directSigning: boolean;
    skillsEnabled?: boolean;
    solana: {
      allowPrograms: string[];
      maxPerTx: string;
      maxDaily: string;
      tokenCaps?: Record<string, { maxPerTx: string; maxDaily: string }>;
    };
    recurringTransfer?: {
      enabled: boolean;
      chain: "solana";
      to: string;
      program?: string;
      amountMode: "fixed" | "percentage";
      amount?: string;
      percentage?: number;
      minAmount?: string;
      keepAmount?: string;
      schedule?: Record<string, unknown>;
      name?: string;
      updatedAt: string;
    } | null;
  };
  signerPolicy?: {
    state: "locked" | "acknowledged" | "unavailable";
    walletId: string;
    role?: "agent" | "mining" | "vault";
    version?: number;
    hash?: string;
    operations?: string[];
    programs?: string[];
    assets?: Array<{
      asset: string;
      destinations: string[];
      maxPerTx: string;
      maxDaily: string;
    }>;
    guidance?: string;
  };
  toolAccess: {
    mode: "owner-only" | "allowlist" | "all";
    allowAgents: string[];
  };
  providerCredentials: {
    configured: boolean;
    providerId: WalletProviderId;
    updatedAt?: string;
    fields: string[];
    path: string;
    source?: "secret" | "env" | "stack-env" | "none";
  };
  rpc: {
    configured: boolean;
    providerId?: WalletProviderId;
    chain?: "solana" | "multi";
    provider?: string;
    updatedAt?: string;
    path: string;
  };
  checkedAt: string;
};

export type WalletProviderInfo = {
  id: WalletProviderId;
  enabled: boolean;
  label?: string;
  isDefault: boolean;
  operationsImplemented: boolean;
  capabilities: WalletProviderCapabilities;
  credentialsConfigured: boolean;
  credentialsSource?: "secret" | "env" | "stack-env" | "none";
  health: {
    ok: boolean;
    details?: string;
  };
  providerAuthDiagnosis?: {
    state: "ok" | "required" | "mismatch" | "unknown";
    resolvedSource: "secret" | "env" | "stack-env" | "none";
    authMode: "jwt-bootstrap" | "static-token-compat";
    bootstrapEndpoint?: string;
    bootstrapLastError?: string;
    bootstrapExpiresAt?: string;
    bootstrapLastSuccessAt?: string;
    persistedSecretConfigured: boolean;
    guidance: string[];
  };
};

export type WalletProviderCapabilities = {
  providerId: WalletProviderId;
  supportedChains: Array<"solana">;
  integrationMode: "native" | "bridge";
  signingLocation: "server" | "browser" | "unavailable";
  signing: {
    transaction: boolean;
    message: boolean;
    interactiveSend: boolean;
  };
  operations: {
    createWallet: boolean;
    receiveAddress: boolean;
    getBalance: boolean;
    prepare: boolean;
    send: boolean;
    deposit: boolean;
    withdraw: boolean;
    rotateKeys: boolean;
    resetKeys: boolean;
  };
  chains: {
    solana: {
      receiveAddress: boolean;
      getBalance: boolean;
      prepare: boolean;
      send: boolean;
    };
  };
  requiresCredentials: boolean;
  requiresRpcSecret: boolean;
};

export type WalletNamedWallet = {
  id: string;
  name: string;
  providerId: WalletProviderId;
  addresses?: { solana?: string };
  metadata?: Record<string, unknown>;
  balances?: { solana?: string };
  readiness?: {
    keystore: boolean;
    rpc: boolean;
    api?: boolean;
    ata?: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

export type WalletProvidersResponse = {
  ok: true;
  providers: WalletProviderInfo[];
  wallets: WalletNamedWallet[];
  assignments: Record<string, string>;
  defaultWalletId?: string;
  defaultProviderId?: WalletProviderId;
  checkedAt: string;
};

export type WalletNamedWalletsResponse = {
  ok: true;
  wallets: WalletNamedWallet[];
  assignments: Record<string, string>;
  defaultWalletId?: string;
  checkedAt: string;
};

export type WalletAssignmentsResponse = {
  ok: true;
  assignments: Record<string, string>;
  defaultWalletId?: string;
};

export type WalletBalanceEntry = {
  ok: boolean;
  chain: "solana";
  address?: string;
  balance?: string;
  unit?: string;
  error?: string;
};

export type WalletAssetEntry = {
  id: string;
  chain: "solana";
  kind: "native" | "spl-token";
  symbol: string;
  name: string;
  amountRaw: string;
  amountDisplay: string;
  decimals: number;
  unit: string;
  isNative: boolean;
  address?: string;
  program?: string;
  tokenProgramId?: string;
  metadataUri?: string;
  logoUri?: string;
  verificationStatus?: "verified" | "unverified" | "unknown";
  verificationSource?: "jupiter" | "metadata-uri" | "unknown";
  priceUsd?: number;
  valueUsd?: number;
  tags?: string[];
};

export type WalletBalancesResponse = {
  ok: true;
  chain: "solana" | "all";
  provider: string;
  walletId?: string;
  walletName?: string;
  balances: {
    solana?: WalletBalanceEntry;
  };
  addresses?: {
    solana?: string;
  };
  assets?: {
    solana?: WalletAssetEntry[];
  };
  assetErrors?: {
    solana?: string;
  };
  checkedAt: string;
};

export type WalletSettingsResponse = {
  ok: true;
  settings: WalletSettings;
};

export type WalletSettingsPatch = {
  walletId?: string;
  policyTemplate?:
    | "recommended"
    | "read-only"
    | "manual-only"
    | "small-agent-spend"
    | "mining-only"
    | "skill-limited"
    | "trading-experimental";
  providerId?: WalletProviderId;
  executionMode?: "manual" | "autonomous";
  approvalAuthMode?: "none" | "webauthn";
  approvalChallengeTtlSeconds?: number;
  approvalGrantTtlSeconds?: number;
  capsEnabled?: boolean;
  directSigning?: boolean;
  skillsEnabled?: boolean;
  solanaAllowPrograms?: string[];
  solanaMaxPerTx?: string;
  solanaMaxDaily?: string;
  solanaTokenCaps?: Record<string, { maxPerTx?: string; maxDaily?: string }>;
  recurringTransfer?: {
    enabled?: boolean;
    chain?: "solana";
    to?: string;
    program?: string;
    amountMode?: "fixed" | "percentage";
    amount?: string;
    percentage?: number;
    minAmount?: string;
    keepAmount?: string;
    schedule?: Record<string, unknown>;
    name?: string;
  } | null;
  toolAccessMode?: "owner-only" | "allowlist" | "all";
  toolAccessAllowAgents?: string[];
};

export type WalletSettingsValidateResponse = {
  ok: boolean;
  valid: boolean;
  checks: Array<{ id: string; ok: boolean; message: string }>;
  mode: "managed" | "external";
  runtime: "external-docker" | "external-custom";
  executionMode: "manual" | "autonomous";
  rpc: {
    configured: boolean;
    providerId?: WalletProviderId;
    chain?: "solana" | "multi";
    provider?: string;
    updatedAt?: string;
    path: string;
  };
};

export type WalletProviderCredentialsStatusResponse = {
  ok: true;
  provider: WalletProviderId;
  status: {
    configured: boolean;
    providerId: WalletProviderId;
    updatedAt?: string;
    fields: string[];
    path: string;
    source?: "secret" | "env" | "stack-env" | "none";
  };
};

export type WalletAuditEntry = {
  id: string;
  at: string;
  action: string;
  actor: string;
  details?: Record<string, unknown>;
};

export type WalletAuditResponse = {
  ok: true;
  entries: WalletAuditEntry[];
};

export type WalletInboundEvent = {
  id: string;
  providerId: WalletProviderId;
  walletId?: string;
  walletName?: string;
  chain: "solana";
  direction: "inbound" | "outbound" | "unknown";
  kind: "deposit" | "withdrawal" | "transfer";
  status: "detected" | "confirmed" | "reconciled" | "ignored";
  amount?: string;
  unit?: string;
  txHash?: string;
  address?: string;
  source: "poll" | "webhook";
  observedAt: string;
  occurredAt?: string;
  reconciledAt?: string;
  metadata?: Record<string, unknown>;
};

export type WalletInboundResponse = {
  ok: true;
  events: WalletInboundEvent[];
  checkedAt: string;
};

export type WalletInboundPollResponse = {
  ok: true;
  result: {
    ok: true;
    checkedAt: string;
    providerId: WalletProviderId;
    walletId?: string;
    walletName?: string;
    balances: Record<string, unknown>;
    detected: WalletInboundEvent[];
    reconciliation: {
      ok: true;
      reconciled: number;
      examined: number;
      lastReconciledAt?: string;
    };
  };
};

export type WalletApprovalAuthStatus = {
  mode: "none" | "webauthn";
  passkeyCount: number;
  ready: boolean;
  notes: string[];
  passkeys: Array<{
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt?: string;
  }>;
  statePath: string;
};

export type WalletApprovalAuthStatusResponse = {
  ok: true;
  status: WalletApprovalAuthStatus;
  challengeTtlSeconds: number;
  grantTtlSeconds?: number;
};

export type WalletApprovalChallengeResponse = {
  ok: true;
  challenge: {
    id: string;
    challenge: string;
    requestId?: string;
    operation: string;
    createdAt: string;
    expiresAt: string;
    status: "pending" | "consumed" | "expired";
  };
  challengeTtlSeconds: number;
};

export type WalletPasskeyRegistrationBeginResponse = {
  ok: true;
  challengeId: string;
  challengeTtlSeconds: number;
  options: {
    challenge: string;
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
    timeoutMs: number;
    attestation: "none";
    authenticatorSelection: {
      residentKey: "preferred";
      userVerification: "required";
    };
    excludeCredentialIds: string[];
  };
};

export type WalletPasskeyRegistrationFinishResponse = {
  ok: true;
  passkey: { id: string; label: string; createdAt: string; lastUsedAt?: string };
  snapshot: WalletApprovalAuthStatus;
};

export type WalletPasskeyDeleteResponse = {
  ok: true;
  passkey: { id: string; label: string; createdAt: string; lastUsedAt?: string };
  snapshot: WalletApprovalAuthStatus;
};

export type WalletPasskeyAssertionBeginResponse = {
  ok: true;
  challengeId: string;
  challengeTtlSeconds: number;
  options: {
    challenge: string;
    rpId: string;
    timeoutMs: number;
    userVerification: "required";
    allowCredentialIds: string[];
  };
};

export type WalletPasskeyAssertionFinishResponse = {
  ok: true;
  approvalToken: string;
  expiresAt: string;
  ttlSeconds: number;
  operation: string;
  requestId?: string;
};

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: unknown; message?: unknown };
        request?: unknown;
      };
      const message =
        typeof parsed.error?.message === "string" && parsed.error.message.trim()
          ? parsed.error.message.trim()
          : text || `Request failed (${res.status})`;
      const error = new Error(message) as Error & {
        code?: string;
        payload?: unknown;
        request?: unknown;
      };
      if (typeof parsed.error?.code === "string") {
        error.code = parsed.error.code;
      }
      error.payload = parsed;
      error.request = parsed.request;
      throw error;
    } catch (error) {
      if (error instanceof Error && "payload" in error) {
        throw error;
      }
    }
    throw new Error(text || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function getWalletStatus(walletId?: string): Promise<WalletStatusResponse> {
  const search = new URLSearchParams();
  if (walletId?.trim()) {
    search.set("walletId", walletId.trim());
  }
  return await fetchJson<WalletStatusResponse>(
    `/api/wallet/status${search.toString() ? `?${search.toString()}` : ""}`,
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    },
  );
}

export async function getWalletSignerDoctor(): Promise<WalletSignerDoctorResponse> {
  return await fetchJson<WalletSignerDoctorResponse>("/api/wallet/signer-doctor", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getWalletBalances(
  chain: "all" | "solana" = "all",
  options?: {
    providerId?: WalletProviderId;
    walletId?: string;
    includeAssets?: boolean;
  },
): Promise<WalletBalancesResponse> {
  const search = new URLSearchParams();
  search.set("chain", chain);
  if (options?.providerId) {
    search.set("providerId", options.providerId);
  }
  if (options?.walletId && options.walletId.trim()) {
    search.set("walletId", options.walletId.trim());
  }
  if (options?.includeAssets) {
    search.set("includeAssets", "1");
  }
  return await fetchJson<WalletBalancesResponse>(`/api/wallet/balances?${search.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function searchWalletSolanaTokens(params: {
  query: string;
  walletId?: string;
}): Promise<WalletSolanaTokenSearchResponse> {
  const search = new URLSearchParams();
  search.set("query", params.query.trim());
  if (params.walletId?.trim()) {
    search.set("walletId", params.walletId.trim());
  }
  return await fetchJson<WalletSolanaTokenSearchResponse>(
    `/api/wallet/solana-token-search?${search.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    },
  );
}

export async function getWalletApprovals(params?: {
  status?: string;
  limit?: number;
}): Promise<WalletApprovalsResponse> {
  const search = new URLSearchParams();
  if (params?.status) {
    search.set("status", params.status);
  }
  if (typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
    search.set("limit", String(Math.floor(params.limit)));
  }
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return await fetchJson<WalletApprovalsResponse>(`/api/wallet/approvals${suffix}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getWalletInboundEvents(params?: {
  providerId?: WalletProviderId;
  walletId?: string;
  chain?: "solana";
  status?: "all" | "detected" | "confirmed" | "reconciled" | "ignored";
  limit?: number;
}): Promise<WalletInboundResponse> {
  const search = new URLSearchParams();
  if (params?.providerId) {
    search.set("providerId", params.providerId);
  }
  if (params?.walletId && params.walletId.trim()) {
    search.set("walletId", params.walletId.trim());
  }
  if (params?.chain) {
    search.set("chain", params.chain);
  }
  if (params?.status) {
    search.set("status", params.status);
  }
  if (typeof params?.limit === "number" && Number.isFinite(params.limit) && params.limit > 0) {
    search.set("limit", String(Math.floor(params.limit)));
  }
  return await fetchJson<WalletInboundResponse>(`/api/wallet/inbound?${search.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function pollWalletInboundEvents(input?: {
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
  chain?: "solana" | "all";
}): Promise<WalletInboundPollResponse> {
  return await fetchJson<WalletInboundPollResponse>("/api/wallet/inbound/poll", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
}

export async function reconcileWalletInboundEvents(): Promise<{
  ok: true;
  result: { ok: true; reconciled: number; examined: number; lastReconciledAt?: string };
}> {
  return await fetchJson<{
    ok: true;
    result: { ok: true; reconciled: number; examined: number; lastReconciledAt?: string };
  }>("/api/wallet/inbound/reconcile", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
  });
}

export async function createWalletSendRequest(
  input: WalletSendCreateInput,
  approvalToken?: string,
): Promise<WalletSendCreateResponse> {
  return await fetchJson<WalletSendCreateResponse>("/api/wallet/approvals/create", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(approvalToken && approvalToken.trim()
        ? { "x-wallet-approval-token": approvalToken.trim() }
        : {}),
    },
    body: JSON.stringify(input),
  });
}

export async function simulateWalletPolicy(
  input: WalletSendCreateInput,
): Promise<{ ok: true; simulation: WalletPolicySimulation }> {
  return await fetchJson<{ ok: true; simulation: WalletPolicySimulation }>(
    "/api/wallet/policy/simulate",
    {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function getWalletSettings(walletId?: string): Promise<WalletSettingsResponse> {
  const search = new URLSearchParams();
  if (walletId?.trim()) {
    search.set("walletId", walletId.trim());
  }
  return await fetchJson<WalletSettingsResponse>(
    `/api/wallet/settings${search.toString() ? `?${search.toString()}` : ""}`,
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    },
  );
}

export async function patchWalletSettings(
  input: WalletSettingsPatch,
  approvalToken?: string,
): Promise<WalletSettingsResponse> {
  return await fetchJson<WalletSettingsResponse>("/api/wallet/settings", {
    method: "PATCH",
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(approvalToken && approvalToken.trim()
        ? { "x-wallet-approval-token": approvalToken.trim() }
        : {}),
    },
    body: JSON.stringify(input),
  });
}

export async function putWalletRpcSettings(
  input: {
    providerId?: WalletProviderId;
    chain: "solana" | "multi";
    provider?: string;
    apiKey?: string;
    rpcUrl?: string;
  },
  approvalToken?: string,
): Promise<{
  ok: true;
  rpc: {
    configured: boolean;
    providerId?: WalletProviderId;
    chain?: "solana" | "multi";
    provider?: string;
    updatedAt?: string;
    path: string;
  };
}> {
  return await fetchJson<{
    ok: true;
    rpc: {
      configured: boolean;
      chain?: "solana" | "multi";
      provider?: string;
      updatedAt?: string;
      path: string;
    };
  }>("/api/wallet/settings/rpc", {
    method: "PUT",
    cache: "no-store",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(approvalToken && approvalToken.trim()
        ? { "x-wallet-approval-token": approvalToken.trim() }
        : {}),
    },
    body: JSON.stringify(input),
  });
}

export async function deleteWalletRpcSettings(approvalToken?: string): Promise<{
  ok: true;
  removed: { removed: boolean; path: string };
}> {
  return await deleteWalletRpcSettingsFor(undefined, approvalToken);
}

export async function deleteWalletRpcSettingsFor(
  providerId?: WalletProviderId,
  approvalToken?: string,
): Promise<{
  ok: true;
  removed: { removed: boolean; path: string };
}> {
  const search = new URLSearchParams();
  if (providerId) {
    search.set("providerId", providerId);
  }
  return await fetchJson<{
    ok: true;
    removed: { removed: boolean; path: string };
  }>(`/api/wallet/settings/rpc${search.toString() ? `?${search.toString()}` : ""}`, {
    method: "DELETE",
    cache: "no-store",
    credentials: "include",
    headers:
      approvalToken && approvalToken.trim()
        ? { "x-wallet-approval-token": approvalToken.trim() }
        : undefined,
  });
}

export async function getWalletProviderCredentialsStatus(): Promise<WalletProviderCredentialsStatusResponse> {
  return await getWalletProviderCredentialsStatusFor();
}

export async function getWalletProviderCredentialsStatusFor(
  providerId?: WalletProviderId,
): Promise<WalletProviderCredentialsStatusResponse> {
  const search = new URLSearchParams();
  if (providerId) {
    search.set("providerId", providerId);
  }
  return await fetchJson<WalletProviderCredentialsStatusResponse>(
    `/api/wallet/settings/provider-credentials${search.toString() ? `?${search.toString()}` : ""}`,
    {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    },
  );
}

export type WalletProviderCredentialsUpdate = {
  providerId?: WalletProviderId;
  credentials?: Record<string, string>;
  apiKey?: string;
  serverSignerAccessKey?: string;
  serverSignerAccountId?: string;
  walletApiBaseUrl?: string;
  signerApiBaseUrl?: string;
  rpcUrl?: string;
  defaultSolanaAddress?: string;
};

export async function putWalletProviderCredentials(
  input: WalletProviderCredentialsUpdate,
  approvalToken?: string,
): Promise<WalletProviderCredentialsStatusResponse & { savedAt?: string }> {
  return await fetchJson<WalletProviderCredentialsStatusResponse & { savedAt?: string }>(
    "/api/wallet/settings/provider-credentials",
    {
      method: "PUT",
      cache: "no-store",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(approvalToken && approvalToken.trim()
          ? { "x-wallet-approval-token": approvalToken.trim() }
          : {}),
      },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteWalletProviderCredentials(approvalToken?: string): Promise<{
  ok: true;
  provider: WalletProviderId;
  removed: { removed: boolean; path: string };
}> {
  return await deleteWalletProviderCredentialsFor(undefined, approvalToken);
}

export async function deleteWalletProviderCredentialsFor(
  providerId?: WalletProviderId,
  approvalToken?: string,
): Promise<{
  ok: true;
  provider: WalletProviderId;
  removed: { removed: boolean; path: string };
}> {
  const search = new URLSearchParams();
  if (providerId) {
    search.set("providerId", providerId);
  }
  return await fetchJson<{
    ok: true;
    provider: WalletProviderId;
    removed: { removed: boolean; path: string };
  }>(
    `/api/wallet/settings/provider-credentials${search.toString() ? `?${search.toString()}` : ""}`,
    {
      method: "DELETE",
      cache: "no-store",
      credentials: "include",
      headers:
        approvalToken && approvalToken.trim()
          ? { "x-wallet-approval-token": approvalToken.trim() }
          : undefined,
    },
  );
}

export async function getWalletProviders(): Promise<WalletProvidersResponse> {
  return await fetchJson<WalletProvidersResponse>("/api/wallet/providers", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function patchWalletProvider(input: {
  providerId: WalletProviderId;
  enabled?: boolean;
  label?: string;
  setDefault?: boolean;
}): Promise<WalletProvidersResponse> {
  return await fetchJson<WalletProvidersResponse>("/api/wallet/providers", {
    method: "PATCH",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getWalletNamedWallets(): Promise<WalletNamedWalletsResponse> {
  return await fetchJson<WalletNamedWalletsResponse>("/api/wallet/wallets", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function createWalletNamedWallet(input: {
  name: string;
  walletId?: string;
  providerId?: WalletProviderId;
  role?: "agent" | "mining" | "vault";
  chain?: "solana";
  rpcUrl?: string;
  address?: string;
}): Promise<{ ok: true; wallet: WalletNamedWallet }> {
  return await fetchJson<{ ok: true; wallet: WalletNamedWallet }>("/api/wallet/wallets", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateWalletNamedWallet(input: {
  walletId: string;
  role?: "agent" | "mining" | "vault";
  rpcUrl?: string;
}): Promise<{ ok: true; wallet: WalletNamedWallet }> {
  return await fetchJson<{ ok: true; wallet: WalletNamedWallet }>("/api/wallet/wallets", {
    method: "PATCH",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteWalletNamedWallet(input: {
  walletId: string;
  archive?: boolean;
  confirmWalletId?: string;
}): Promise<{ ok: true; removed: boolean }> {
  return await fetchJson<{ ok: true; removed: boolean }>("/api/wallet/wallets", {
    method: "DELETE",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getWalletAssignments(): Promise<WalletAssignmentsResponse> {
  return await fetchJson<WalletAssignmentsResponse>("/api/wallet/assignments", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function upsertWalletAssignment(input: {
  agentId?: string;
  walletId?: string;
  defaultWalletId?: string | null;
}): Promise<WalletAssignmentsResponse> {
  return await fetchJson<WalletAssignmentsResponse>("/api/wallet/assignments", {
    method: "PUT",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteWalletAssignment(input: {
  agentId: string;
}): Promise<WalletAssignmentsResponse> {
  return await fetchJson<WalletAssignmentsResponse>("/api/wallet/assignments", {
    method: "DELETE",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function validateWalletSettings(options?: {
  providerId?: WalletProviderId;
}): Promise<WalletSettingsValidateResponse> {
  return await fetchJson<WalletSettingsValidateResponse>("/api/wallet/settings/validate", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options?.providerId ? { providerId: options.providerId } : {}),
  });
}

export async function getWalletAudit(limit = 100): Promise<WalletAuditResponse> {
  return await getWalletAuditFor(limit);
}

export async function getWalletAuditFor(
  limit = 100,
  options?: {
    providerId?: WalletProviderId;
    walletId?: string;
  },
): Promise<WalletAuditResponse> {
  const search = new URLSearchParams();
  search.set("limit", String(Math.max(1, Math.floor(limit))));
  if (options?.providerId) {
    search.set("providerId", options.providerId);
  }
  if (options?.walletId && options.walletId.trim()) {
    search.set("walletId", options.walletId.trim());
  }
  return await fetchJson<WalletAuditResponse>(`/api/wallet/audit?${search.toString()}`, {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function getWalletApprovalAuthStatus(): Promise<WalletApprovalAuthStatusResponse> {
  return await fetchJson<WalletApprovalAuthStatusResponse>("/api/wallet/approval-auth/status", {
    method: "GET",
    cache: "no-store",
    credentials: "include",
  });
}

export async function createWalletApprovalChallenge(input?: {
  requestId?: string;
  operation?: string;
}): Promise<WalletApprovalChallengeResponse> {
  return await fetchJson<WalletApprovalChallengeResponse>("/api/wallet/approval-auth/challenge", {
    method: "POST",
    cache: "no-store",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
}

export async function beginWalletPasskeyRegistration(input: {
  label?: string;
}): Promise<WalletPasskeyRegistrationBeginResponse> {
  return await fetchJson<WalletPasskeyRegistrationBeginResponse>(
    "/api/wallet/approval-auth/passkeys/register/options",
    {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function finishWalletPasskeyRegistration(
  input: {
    challengeId: string;
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    publicKeySpki: string;
    publicKeyAlgorithm: number;
    transports?: string[];
  },
  approvalToken?: string,
): Promise<WalletPasskeyRegistrationFinishResponse> {
  return await fetchJson<WalletPasskeyRegistrationFinishResponse>(
    "/api/wallet/approval-auth/passkeys/register/finish",
    {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        ...(approvalToken && approvalToken.trim()
          ? { "x-wallet-approval-token": approvalToken.trim() }
          : {}),
      },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteWalletPasskey(
  credentialId: string,
  approvalToken?: string,
): Promise<WalletPasskeyDeleteResponse> {
  return await fetchJson<WalletPasskeyDeleteResponse>(
    `/api/wallet/approval-auth/passkeys/${encodeURIComponent(credentialId)}`,
    {
      method: "DELETE",
      cache: "no-store",
      credentials: "include",
      headers:
        approvalToken && approvalToken.trim()
          ? { "x-wallet-approval-token": approvalToken.trim() }
          : undefined,
    },
  );
}

export async function beginWalletPasskeyAssertion(input: {
  operation: string;
  requestId?: string;
}): Promise<WalletPasskeyAssertionBeginResponse> {
  return await fetchJson<WalletPasskeyAssertionBeginResponse>(
    "/api/wallet/approval-auth/assert/options",
    {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function finishWalletPasskeyAssertion(input: {
  challengeId: string;
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}): Promise<WalletPasskeyAssertionFinishResponse> {
  return await fetchJson<WalletPasskeyAssertionFinishResponse>(
    "/api/wallet/approval-auth/assert/finish",
    {
      method: "POST",
      cache: "no-store",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function rotateWalletKeys(
  _approvalToken?: string,
  _providerId?: WalletProviderId,
): Promise<{ ok: true; result: unknown }> {
  throw new Error("Wallet key rotation is unavailable through the Gateway UI.");
}

export async function resetWalletKeys(
  _confirmText: string,
  _approvalToken?: string,
  _providerId?: WalletProviderId,
): Promise<{ ok: true; result: unknown }> {
  throw new Error("Wallet reset is unavailable through the Gateway UI.");
}

export type WalletStandardBrowserReview = {
  requestId: string;
  preparedId: string;
  signer: string;
  unsignedTxBase64: string;
  messageBase64: string;
  intentDigest: string;
  expiresAt: string;
  chain: "solana:mainnet" | "solana:devnet";
  simulation: { ok: true; unitsConsumed?: number };
};

export type WalletApproveSendResponse = {
  ok: true;
  mode?: "browser" | "signer-webauthn";
  request: WalletSendApprovalRequest;
  browserReview?: WalletStandardBrowserReview;
  signerAuthorization?: WalletSignerReviewAuthorizationBegin;
  tx?: {
    ok: boolean;
    chain: "solana";
    txHash: string;
    signer?: string;
    idempotent?: boolean;
  };
};

export type WalletSignerReviewAuthorizationBegin = {
  challengeId: string;
  expiresAt: string;
  binding: {
    requestId: string;
    walletId: string;
    role: "agent" | "mining" | "vault";
    walletPublicKey?: string;
    intentType: string;
    intentDigest: string;
    semanticIntent: unknown;
    artifactKind: "solana-transaction" | "domain-separated-message" | "jupiter-trigger-state";
    artifactDigest: string;
    transactionDigest?: string;
    stateDigest?: string;
    stateSlot?: number;
    asset: string;
    amount: string;
    destination: string;
    policyOperation: string;
    requiredPrograms: string[];
    policyHash: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
  };
  options: unknown;
};

function canonicalSignerSemanticIntent(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("signer semantic intent contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSignerSemanticIntent(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalSignerSemanticIntent(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("signer semantic intent is missing or unsupported");
}

function signerSemanticIntentsMatch(left: unknown, right: unknown): boolean {
  try {
    return canonicalSignerSemanticIntent(left) === canonicalSignerSemanticIntent(right);
  } catch {
    return false;
  }
}

export function signerAuthorizationMatchesWalletApproval(
  authorization: WalletSignerReviewAuthorizationBegin,
  request: WalletSendApprovalRequest,
): boolean {
  const binding = authorization.binding;
  const payload = request.payload;
  const sameOptional = (left: string | undefined, right: string | undefined) =>
    (left?.trim() || undefined) === (right?.trim() || undefined);
  const requiredPrograms = payload.signerRequiredPrograms;
  return (
    binding.requestId === payload.signerReviewId?.trim() &&
    binding.walletId === payload.signerWalletId?.trim() &&
    sameOptional(binding.walletPublicKey, payload.signerWalletPublicKey) &&
    binding.role === payload.signerRequiredRole &&
    binding.intentType === payload.signerIntentType?.trim() &&
    binding.policyHash === payload.signerPolicyHash?.trim() &&
    binding.intentDigest === payload.signerIntentDigest?.trim() &&
    signerSemanticIntentsMatch(binding.semanticIntent, payload.signerSemanticIntent) &&
    binding.artifactKind === payload.signerArtifactKind &&
    binding.artifactDigest === payload.signerArtifactDigest?.trim() &&
    sameOptional(binding.transactionDigest, payload.signerTransactionDigest) &&
    sameOptional(binding.stateDigest, payload.signerStateDigest) &&
    (binding.stateSlot ?? undefined) === payload.signerStateSlot &&
    binding.asset === payload.signerAsset?.trim() &&
    binding.amount === payload.signerAmount?.trim() &&
    binding.destination === payload.signerDestination?.trim() &&
    binding.policyOperation === payload.signerPolicyOperation?.trim() &&
    Boolean(requiredPrograms) &&
    requiredPrograms?.length === binding.requiredPrograms.length &&
    requiredPrograms.every((program, index) => program === binding.requiredPrograms[index]) &&
    binding.nonce === payload.signerNonce?.trim() &&
    binding.issuedAt === payload.signerIssuedAt?.trim() &&
    binding.expiresAt === payload.signerReviewExpiresAt?.trim()
  );
}

export async function approveWalletSend(
  requestId: string,
  approvalToken?: string,
): Promise<WalletApproveSendResponse> {
  return await fetchJson<WalletApproveSendResponse>(
    `/api/wallet/approvals/${encodeURIComponent(requestId)}/approve`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(approvalToken && approvalToken.trim()
          ? { "x-wallet-approval-token": approvalToken.trim() }
          : {}),
      },
      body: "{}",
    },
  );
}

export async function finishWalletSignerReviewApproval(input: {
  requestId: string;
  challengeId: string;
  credential: unknown;
}): Promise<WalletApproveSendResponse> {
  return await fetchJson<WalletApproveSendResponse>(
    `/api/wallet/approvals/${encodeURIComponent(input.requestId)}/approve`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signerAuthorization: {
          challengeId: input.challengeId,
          credential: input.credential,
        },
      }),
    },
  );
}

export async function executeWalletStandardSend(input: {
  requestId: string;
  preparedId: string;
  intentDigest: string;
  signedTxBase64: string;
}): Promise<WalletApproveSendResponse> {
  return await fetchJson<WalletApproveSendResponse>(
    `/api/wallet/approvals/${encodeURIComponent(input.requestId)}/execute`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        preparedId: input.preparedId,
        intentDigest: input.intentDigest,
        signedTxBase64: input.signedTxBase64,
      }),
    },
  );
}

export async function rejectWalletSend(
  requestId: string,
  reason?: string,
  approvalToken?: string,
): Promise<{ ok: true; request: unknown }> {
  return await fetchJson<{ ok: true; request: unknown }>(
    `/api/wallet/approvals/${encodeURIComponent(requestId)}/reject`,
    {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        ...(approvalToken && approvalToken.trim()
          ? { "x-wallet-approval-token": approvalToken.trim() }
          : {}),
      },
      body: JSON.stringify({ reason: reason ?? "" }),
    },
  );
}
