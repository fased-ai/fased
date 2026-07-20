import { html, nothing } from "lit";
import type {
  WalletSkillGrantDraft,
  WalletSkillGrantRow,
} from "../controllers/wallet-skill-grants.ts";
import { WALLET_SKILL_ACTIONS } from "../controllers/wallet-skill-grants.ts";
import type { FederationBondStatus } from "../federation-api.ts";
import { icons } from "../icons.ts";
import type { SatMinerProfile, SatMiningReadiness, SatMiningRuntimeStatus } from "../mining-api.ts";
import { taskLedgerAnchorId } from "../task-ledger-source-route.ts";
import type {
  WalletApprovalFilter,
  WalletAssetEntry,
  WalletSendApprovalRequest,
  WalletAuditEntry,
  WalletBalancesResponse,
  WalletSendCreateInput,
  WalletSettings,
  WalletSettingsPatch,
  WalletProviderInfo,
  WalletSolanaTokenSearchResult,
  WalletStatus,
} from "../wallet-api.ts";
import {
  buildRecurringTransferCron,
  parseRecurringTransferCron,
  type WalletRecurringIntervalUnit,
} from "../wallet-policy.ts";

export type WalletViewProps = {
  loading: boolean;
  error: string | null;
  mainPanel?: "wallets" | "access" | "skill-grants";
  onMainPanelChange?: (panel: "wallets" | "access" | "skill-grants") => void;
  status: WalletStatus | null;
  namedWallets: Array<{
    id: string;
    name: string;
    providerId:
      | "embedded-keystore"
      | "local-socket-signer"
      | "alchemy"
      | "turnkey"
      | "wallet-standard"
      | "privy";
    addresses?: { solana?: string };
    balances?: { solana?: string };
    metadata?: Record<string, unknown>;
    readiness?: {
      keystore: boolean;
      rpc: boolean;
      api?: boolean;
      ata?: boolean;
      ready?: boolean;
      error?: string;
      signer?: NonNullable<NonNullable<WalletStatus["wallets"]>[number]["readiness"]["signer"]>;
    };
  }>;
  balancesLoading: boolean;
  balancesError: string | null;
  balances: WalletBalancesResponse | null;
  defaultWalletId: string | null;
  assignments?: Record<string, string>;
  agents?: Array<{ id: string; name?: string }>;
  assignAgentId?: string;
  assignWalletId?: string;
  providers?: WalletProviderInfo[];
  createName?: string;
  createId?: string;
  createProvider?: WalletProviderInfo["id"];
  createRole?: "" | "agent" | "mining" | "vault";
  createRpcUrl?: string;
  settingsBusy: boolean;
  settingsError: string | null;
  settingsMessage: string | null;
  settings: WalletSettings | null;
  skillGrantsLoading: boolean;
  skillGrantsError: string | null;
  skillGrantsMessage: string | null;
  skillGrantsWorkspace: string | null;
  skillGrantRows: WalletSkillGrantRow[];
  skillGrantDraft: WalletSkillGrantDraft;
  skillGrantBusy: boolean;
  federationBond?: FederationBondStatus | null;
  onNavigate?: (tab: "federation") => void;
  rpcChain: "solana";
  policyCapsEnabled?: boolean;
  policyAutoEnabled?: boolean;
  policySkillsEnabled?: boolean;
  policySolMaxPerTx: string;
  policySolMaxDaily: string;
  policySolanaAllowPrograms?: string;
  policySolanaTokenCaps: Record<string, { maxPerTx?: string; maxDaily?: string; decimals: number }>;
  policyTokenCapMint: string;
  policyTokenCapDecimals: string;
  policyTokenCapMaxPerTx: string;
  policyTokenCapMaxDaily: string;
  policyTokenSearchQuery: string;
  policyTokenSearchLoading: boolean;
  policyTokenSearchError: string | null;
  policyTokenSearchResults: WalletSolanaTokenSearchResult[];
  recurringTransferEnabled: boolean;
  recurringTransferDestination: string;
  recurringTransferMint: string;
  recurringTransferAmountMode: "fixed" | "percentage";
  recurringTransferAmount: string;
  recurringTransferPercentage: string;
  recurringTransferMinAmount: string;
  recurringTransferKeepAmount: string;
  recurringTransferDecimals: string;
  recurringTransferCron: string;
  recurringTransferTz: string;
  recurringTransferName: string;
  actionMessage: string | null;
  actionBusy?: boolean;
  passkeyBusy: boolean;
  passkeyError: string | null;
  passkeyLabel: string;
  auditEntries: WalletAuditEntry[];
  activityPage: number;
  sendModalVisible: boolean;
  onSendModalOpen: (walletId: string, assetId?: string) => void;
  onSendModalClose: () => void;
  sendCreateBusy: boolean;
  sendCreateError: string | null;
  sendCreateForm: WalletSendCreateInput;
  walletDetailsWalletId: string;
  balanceWalletId?: string;
  expandedWalletId?: string;
  expandedPanel?: "balance" | "security" | "";
  policyPanel?: WalletPolicyPanel;
  approvalsLoading: boolean;
  approvalsBusyId: string | null;
  approvalsError: string | null;
  approvalsFilter: WalletApprovalFilter;
  approvals: WalletSendApprovalRequest[];
  onSendCreatePatch: (patch: Partial<WalletSendCreateInput>) => void;
  onWalletDetailsWalletChange: (walletId: string) => void;
  onWalletBalanceWalletChange?: (walletId: string) => void;
  onPolicyPanelChange?: (panel: WalletPolicyPanel) => void;
  onApprovalsFilterChange: (filter: WalletApprovalFilter) => void;
  onAttachWalletStandardVault?: () => void;
  onCreateNameChange?: (next: string) => void;
  onCreateIdChange?: (next: string) => void;
  onCreateProviderChange?: (next: WalletProviderInfo["id"]) => void;
  onCreateRoleChange?: (next: "" | "agent" | "mining" | "vault") => void;
  onCreateRpcUrlChange?: (next: string) => void;
  rpcUrl?: string;
  onRpcUrlChange?: (next: string) => void;
  onSaveWalletRpc?: () => void;
  onCreateWallet?: () => void;
  onArchiveWallet?: (walletId: string) => void;
  onApproveRequest: (requestId: string) => void;
  onRejectRequest: (requestId: string) => void;
  onSetDefaultWallet: (walletId: string | null) => void;
  onAssignAgentIdChange?: (agentId: string) => void;
  onAssignWalletIdChange?: (walletId: string) => void;
  onAssignAgentWallet?: () => void;
  onDeleteAgentAssignment?: (agentId: string) => void;
  onPasskeyLabelChange: (next: string) => void;
  onEnablePasskeyApproval: () => void;
  onEnrollPasskey: () => void;
  onDeletePasskey?: (credentialId: string) => void;
  onApplyRecommendedPolicy?: () => void;
  onMiningSatSweepChange?: (
    patch: Partial<NonNullable<SatMinerProfile["automation"]["satSweep"]>>,
  ) => void;
  onPatchSettings: (
    patch: WalletSettingsPatch,
    opts?: { requireExecutionApproval?: boolean },
  ) => void;
  onActivityPageChange: (page: number) => void;
  onRpcChainChange: (next: "solana") => void;
  onPolicyDraftChange: (patch: {
    capsEnabled?: boolean;
    directSigning?: boolean;
    skillsEnabled?: boolean;
    solMaxPerTx?: string;
    solMaxDaily?: string;
    solanaAllowPrograms?: string;
    solanaTokenCaps?: Record<string, { maxPerTx?: string; maxDaily?: string; decimals: number }>;
    tokenCapMint?: string;
    tokenCapDecimals?: string;
    tokenCapMaxPerTx?: string;
    tokenCapMaxDaily?: string;
    recurringTransferEnabled?: boolean;
    recurringTransferDestination?: string;
    recurringTransferMint?: string;
    recurringTransferAmountMode?: "fixed" | "percentage";
    recurringTransferAmount?: string;
    recurringTransferPercentage?: string;
    recurringTransferMinAmount?: string;
    recurringTransferKeepAmount?: string;
    recurringTransferDecimals?: string;
    recurringTransferCron?: string;
    recurringTransferTz?: string;
    recurringTransferName?: string;
  }) => void;
  onTokenSearchQueryChange: (next: string) => void;
  onTokenSearch: () => void;
  onTokenSearchSelect: (token: WalletSolanaTokenSearchResult) => void;
  onSavePolicy: () => void;
  onRefresh: () => void;
  onSkillGrantSelect: (row: WalletSkillGrantRow) => void;
  onSkillGrantDraftPatch: (patch: Partial<WalletSkillGrantDraft>) => void;
  onSkillGrantActionToggle: (action: string, enabled: boolean) => void;
  onSkillGrantSave: () => void;
  onSkillGrantClear: (skillId: string) => void;
  onCreateSendRequest: () => void;
  miningProfile: SatMinerProfile | null;
  miningReadiness: SatMiningReadiness | null;
  miningStatus: SatMiningRuntimeStatus | null;
};

export type OperatorWalletRoleSummary = {
  title: string;
  summary: string;
  detail: string;
  tone: "success" | "warn" | "neutral";
  walletId?: string;
};

export type OperatorWalletRoles = {
  admin: OperatorWalletRoleSummary;
  agent: OperatorWalletRoleSummary;
  mining: OperatorWalletRoleSummary;
  bond: OperatorWalletRoleSummary;
  sharedWalletWarning: string | null;
  miningWalletId: string | null;
  bondWalletId: string | null;
};

type DisplayedWalletRole = "mining" | "agent" | "vault";
export type WalletPolicyPanel = "caps" | "schedule" | "automation" | "skills" | "sweep";

const WALLET_ACTIVITY_PAGE_SIZE = 8;
const SOL_DECIMALS = 9n;
const SAT_DECIMALS = 11n;

export function describeAdminControlShortcut(
  props: Pick<WalletViewProps, "status" | "settingsBusy" | "passkeyBusy">,
): {
  summary: string;
  detail: string;
  enableVisible: boolean;
  enableLabel: string;
  enableDisabled: boolean;
  enrollVisible: boolean;
  enrollLabel: string;
  enrollDisabled: boolean;
} {
  const approvalMode = props.status?.approvalAuth?.mode ?? "none";
  const approvalReady = props.status?.approvalAuth?.ready ?? false;
  const passkeyCount = props.status?.approvalAuth?.passkeyCount ?? 0;
  if (approvalMode !== "webauthn") {
    return {
      summary: "Optional",
      detail:
        "Optional extra approval for Control UI account actions. It is not part of Agent or Mining wallet readiness.",
      enableVisible: true,
      enableLabel: props.settingsBusy ? "Enabling..." : "Add account passkey",
      enableDisabled: props.settingsBusy || props.passkeyBusy,
      enrollVisible: false,
      enrollLabel: "Enroll passkey",
      enrollDisabled: true,
    };
  }
  if (!approvalReady || passkeyCount <= 0) {
    return {
      summary: "Setup incomplete",
      detail:
        "Account passkey mode is enabled but no device is enrolled. Wallet creation, Agent automation, and Mining automation are unaffected.",
      enableVisible: false,
      enableLabel: "Passkey approval enabled",
      enableDisabled: true,
      enrollVisible: true,
      enrollLabel: props.passkeyBusy ? "Enrolling..." : "Enroll passkey",
      enrollDisabled: props.settingsBusy || props.passkeyBusy,
    };
  }
  return {
    summary: "Enabled",
    detail:
      "Optional Control UI account passkey is enabled. Agent and Mining autonomous signer policies remain independent.",
    enableVisible: false,
    enableLabel: "Passkey approval ready",
    enableDisabled: true,
    enrollVisible: false,
    enrollLabel: props.passkeyBusy ? "Adding passkey..." : "Add passkey",
    enrollDisabled: props.settingsBusy || props.passkeyBusy,
  };
}

export function describeVaultSignerApproval(
  status: Pick<WalletStatus, "nativeSignerApproval"> | null | undefined,
): {
  summary: string;
  detail: string;
  setupCommand: string | null;
} {
  const approval = status?.nativeSignerApproval;
  if (!approval) {
    return {
      summary: "Status unavailable",
      detail:
        "Signer-owned Vault approval readiness is unavailable. Vault remains manual and receive-only until signer health is restored and an exact manual policy is acknowledged.",
      setupCommand: null,
    };
  }
  if (!approval.configured) {
    return {
      summary: "Not configured",
      detail:
        "This signer has no WebAuthn origin configured. Vault creation and receiving still work, but native Vault review cannot be enabled yet.",
      setupCommand: null,
    };
  }
  if (!approval.ready || approval.credentialCount <= 0) {
    return {
      summary: "Not enrolled",
      detail:
        "No signer-owned approval device is enrolled. Run the native signer-owner ceremony from the host terminal; ordinary Gateway JavaScript cannot enroll it.",
      setupCommand:
        "Local: ~/.fased/bin/fased-signer-enroll · Hosting root console: /usr/local/sbin/fased-signer-enroll",
    };
  }
  return {
    summary: `Ready · ${approval.credentialCount} device${approval.credentialCount === 1 ? "" : "s"}`,
    detail:
      "The native signer has an approval device. This Vault still needs an acknowledged manual policy for the exact operation before Send becomes available.",
    setupCommand: null,
  };
}

export function describeWalletSendFlow(
  _status: Pick<WalletStatus, "policy" | "approvalAuth"> | null | undefined,
): {
  mode: "manual";
  submitLabel: string;
  detail: string;
} {
  return {
    mode: "manual",
    submitLabel: "Create Approval Request",
    detail:
      "Direct user Send is always reviewed/manual. Confirm creates a pending wallet approval request below. The optional account passkey is requested only when the user enabled it.",
  };
}

function renderWalletHelp(text: string) {
  return html`
    <span class="wallet-help" role="img" tabindex="0" aria-label=${text} data-tooltip=${text}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2-3 4" />
        <path d="M12 17h.01" />
      </svg>
    </span>
  `;
}

export function describeWalletAutomationPolicySummary(
  status: Pick<WalletStatus, "policy"> | null | undefined,
): {
  label: "Automation on" | "Automation off";
  detail: string;
  operatorDetail: string;
} {
  if (status?.policy?.directSigning) {
    return {
      label: "Automation on",
      detail:
        "This selected wallet can execute approved typed background actions when signer policy and caps allow it.",
      operatorDetail:
        "These caps belong to the selected wallet. They are not SAT mining cycle limits, and they do not override signer or role restrictions.",
    };
  }
  return {
    label: "Automation off",
    detail:
      "This selected wallet is manual-first. Reviewed Wallet UI sends can still be approved, but background actions cannot execute.",
    operatorDetail:
      "These caps belong to the selected wallet. They are not SAT mining cycle limits, and they do not override signer or role restrictions.",
  };
}

export function resolveActiveMiningWalletId(
  props: Pick<WalletViewProps, "miningProfile" | "miningReadiness" | "miningStatus">,
): string | null {
  return (
    String(
      props.miningProfile?.walletId ||
        props.miningStatus?.walletId ||
        props.miningReadiness?.selectedWalletId ||
        "",
    ).trim() || null
  );
}

export function hasWalletBalanceValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function preferredWalletChain(wallet: WalletViewProps["namedWallets"][number]): "solana" | null {
  if (wallet.id.startsWith("solana-") || wallet.name.toLowerCase().startsWith("solana ")) {
    return "solana";
  }
  if (wallet.addresses?.solana) {
    return "solana";
  }
  return null;
}

function allowedWalletSendChains(
  wallet: WalletViewProps["namedWallets"][number] | undefined,
): Array<"solana"> {
  if (!wallet) {
    return ["solana"];
  }
  const preferred = preferredWalletChain(wallet);
  if (preferred === "solana") {
    return ["solana"];
  }
  return ["solana"];
}

function findNamedWallet(
  wallets: WalletViewProps["namedWallets"],
  walletId: string | null | undefined,
) {
  const normalized = String(walletId ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  return wallets.find((wallet) => wallet.id === normalized);
}

function formatSkillGrantSummary(grant: Record<string, unknown> | null): string {
  if (!grant) {
    return "No grant";
  }
  const actions = Array.isArray(grant.actions)
    ? grant.actions.map((entry) => String(entry)).filter(Boolean)
    : [];
  const chains = Array.isArray(grant.chains)
    ? grant.chains.map((entry) => String(entry)).filter(Boolean)
    : [];
  const walletIds = Array.isArray(grant.walletIds)
    ? grant.walletIds.map((entry) => String(entry)).filter(Boolean)
    : [];
  const flags = [
    grant.autonomous === true ? "autonomous" : null,
    grant.cron === true ? "cron" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return [
    actions.length > 0 ? actions.join(", ") : "actions unspecified",
    walletIds.length === 1
      ? `skill override ${walletIds[0]}`
      : walletIds.length > 1
        ? `wallet allowlist ${walletIds.join(", ")}`
        : "wallet unspecified",
    chains.length > 0 ? chains.join(", ") : "chain unspecified",
    flags,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatRequestedWalletActions(requested: WalletSkillGrantRow["requestedWalletActions"]) {
  if (!requested) {
    return "No marketplace wallet request recorded";
  }
  const actions = requested.actions?.length ? requested.actions.join(", ") : "actions unspecified";
  const chains = requested.chains?.length ? requested.chains.join(", ") : "chain unspecified";
  const flags = [
    requested.autonomous ? "autonomous requested" : null,
    requested.cron ? "cron requested" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return [actions, chains, flags].filter(Boolean).join(" · ");
}

function resolveWalletMetadataRole(
  wallet: WalletViewProps["namedWallets"][number] | undefined,
): "agent" | "vault" | "mining" | undefined {
  const roleRaw =
    typeof wallet?.metadata?.purpose === "string"
      ? wallet.metadata.purpose
      : typeof wallet?.metadata?.role === "string"
        ? wallet.metadata.role
        : "";
  const role = roleRaw.toLowerCase();
  if (role === "agent") {
    return "agent";
  }
  if (role === "vault") {
    return "vault";
  }
  if (role === "mining") {
    return "mining";
  }
  return undefined;
}

function isAgentWallet(
  wallet: WalletViewProps["namedWallets"][number] | undefined,
  defaultWalletId: string | null | undefined,
): boolean {
  if (!wallet) {
    return false;
  }
  const metadataRole = resolveWalletMetadataRole(wallet);
  if (metadataRole && metadataRole !== "agent") {
    return false;
  }
  return wallet.id === String(defaultWalletId ?? "").trim() || metadataRole === "agent";
}

export function resolveOperatorWalletRoles(
  props: Pick<
    WalletViewProps,
    | "status"
    | "namedWallets"
    | "defaultWalletId"
    | "federationBond"
    | "miningProfile"
    | "miningReadiness"
    | "miningStatus"
  >,
): OperatorWalletRoles {
  const approvalMode = props.status?.approvalAuth?.mode ?? "none";
  const approvalReady = props.status?.approvalAuth?.ready ?? false;
  const defaultWalletId = String(props.defaultWalletId ?? "").trim() || null;
  const defaultWallet = findNamedWallet(props.namedWallets, defaultWalletId);
  const agentWallets = props.namedWallets.filter((wallet) =>
    isAgentWallet(wallet, defaultWalletId),
  );
  const defaultAgentWallet =
    defaultWallet && isAgentWallet(defaultWallet, defaultWalletId) ? defaultWallet : undefined;
  const miningWalletId =
    String(
      props.miningProfile?.walletId ||
        props.miningStatus?.walletId ||
        props.miningReadiness?.selectedWalletId ||
        "",
    ).trim() || null;
  const miningWallet = findNamedWallet(props.namedWallets, miningWalletId);
  const bondWalletId = String(props.federationBond?.walletId ?? "").trim() || null;
  const bondWallet = findNamedWallet(props.namedWallets, bondWalletId);

  const admin: OperatorWalletRoleSummary = props.status
    ? approvalMode === "webauthn" && approvalReady
      ? {
          title: "Control UI account passkey",
          summary: "Optional · enabled",
          detail: "Adds account-level approval without changing Agent or Mining readiness.",
          tone: "success",
        }
      : approvalMode === "webauthn"
        ? {
            title: "Control UI account passkey",
            summary: "Optional · setup incomplete",
            detail: "Finish or disable account passkey mode. Wallet role readiness is separate.",
            tone: "warn",
          }
        : {
            title: "Control UI account passkey",
            summary: "Optional · off",
            detail:
              "The signed-in Control UI session is active. Add an account passkey only if you want the extra approval step.",
            tone: "neutral",
          }
    : {
        title: "Control UI account passkey",
        summary: "Optional status unavailable",
        detail: "Refresh Account Security before changing account-level approval.",
        tone: "neutral",
      };

  const agent: OperatorWalletRoleSummary = defaultAgentWallet
    ? {
        title: "Agent wallets",
        summary:
          agentWallets.length > 1
            ? `${defaultAgentWallet.name} + ${agentWallets.length - 1}`
            : defaultAgentWallet.name,
        detail:
          agentWallets.length > 1
            ? "Multiple Agent wallets can be selected explicitly. Otherwise routing checks a skill override, then the Agent assignment, then this optional Default Agent wallet fallback."
            : "If no explicit, skill, or Agent assignment exists, approved wallet actions use this optional fallback.",
        tone: "success",
        walletId: defaultAgentWallet.id,
      }
    : agentWallets.length > 0
      ? {
          title: "Agent wallets",
          summary: `${agentWallets.length} set · no fallback`,
          detail:
            "Agent wallets can be selected by explicit @wallet:<id> handles. Set one default Agent wallet if approved actions should have a fallback.",
          tone: "warn",
          walletId: agentWallets[0]?.id,
        }
      : defaultWalletId
        ? {
            title: "Agent wallets",
            summary: defaultWalletId,
            detail:
              "An Agent wallet is configured but not present in this wallet list right now. Refresh or repair the registry before paid Fased Network or skill wallet work.",
            tone: "warn",
            walletId: defaultWalletId,
          }
        : {
            title: "Agent wallets",
            summary: "Not set",
            detail:
              "Mark at least one Agent wallet before paid Fased Network tasks, payment evidence, or skill wallet actions use a clear operator wallet.",
            tone: "warn",
          };

  const mining: OperatorWalletRoleSummary = miningWallet
    ? {
        title: "SAT Mining",
        summary: miningWallet.name,
        detail:
          "SAT mining uses the singleton @wallet:mining wallet for capital, cycle history, and restart recovery. Keep it separate from Agent wallets.",
        tone: "success",
        walletId: miningWallet.id,
      }
    : miningWalletId
      ? {
          title: "SAT Mining",
          summary: miningWalletId,
          detail:
            "SAT runtime points at @wallet:mining, but that wallet is not visible in the current wallet list. Refresh mining and wallet state before SAT mining.",
          tone: "warn",
          walletId: miningWalletId,
        }
      : {
          title: "SAT Mining",
          summary: "Not configured",
          detail:
            "Create or import @wallet:mining in onboarding or CLI if you want SAT participation. Mining is optional and should not be assumed by Fased Network join.",
          tone: "neutral",
        };

  const bond: OperatorWalletRoleSummary = bondWallet
    ? {
        title: "Fased Network Bond",
        summary: bondWallet.name,
        detail:
          props.federationBond?.status === "active"
            ? `This wallet currently holds the active SAT bond for Fased Network. Tier ${props.federationBond?.tier ?? "none"} · quota ${props.federationBond?.quotaBand ?? "standard"}.`
            : "This wallet is configured for Fased Network bond. Use the Fased Network page to open, increase, unlock, or re-prove the SAT bond.",
        tone:
          props.federationBond?.status === "active"
            ? "success"
            : props.federationBond?.status === "unlocking"
              ? "warn"
              : "neutral",
        walletId: bondWallet.id,
      }
    : bondWalletId
      ? {
          title: "Fased Network Bond",
          summary: bondWalletId,
          detail:
            "A Fased Network bond Vault is configured but not visible in the current wallet list. Refresh wallet state or repair the local wallet registry before changing bond posture.",
          tone: "warn",
          walletId: bondWalletId,
        }
      : {
          title: "Fased Network Bond",
          summary: "Not set",
          detail:
            "Select a Vault wallet on Fased Network before longer-lived bond capital if you want bonded network access.",
          tone: "neutral",
        };

  const sharedWalletWarning =
    miningWallet && agentWallets.some((wallet) => wallet.id === miningWallet.id)
      ? "Agent and Mining wallets must stay separate. This singleton mining wallet is also marked Agent; use a dedicated Agent wallet and clear the Agent default before wallet work."
      : null;
  return {
    admin,
    agent,
    mining,
    bond,
    sharedWalletWarning,
    miningWalletId,
    bondWalletId,
  };
}

export function describeWalletRoleBadges(
  walletId: string,
  props: Pick<
    WalletViewProps,
    | "defaultWalletId"
    | "federationBond"
    | "miningProfile"
    | "miningReadiness"
    | "miningStatus"
    | "namedWallets"
  >,
): Array<{ label: string; tone: "success" | "warn" | "neutral" }> {
  void walletId;
  void props;
  return [];
}

function renderWalletBondIcon(
  walletId: string,
  federationBond: FederationBondStatus | null | undefined,
  onNavigate?: (tab: "federation") => void,
) {
  if (walletId !== String(federationBond?.walletId ?? "").trim()) {
    return nothing;
  }
  const status = federationBond?.status ?? "none";
  const dataRole =
    status === "active" ? "bond-active" : status === "unlocking" ? "bond-unlocking" : "bond";
  const title =
    status === "active"
      ? "Fased Network bond active"
      : status === "unlocking"
        ? "Fased Network bond unlocking"
        : "Fased Network bond wallet";
  return html`
    <button
      type="button"
      class="wallet-status-icon wallet-status-icon--button"
      data-role=${dataRole}
      title=${`${title}. Open Fased Network.`}
      aria-label=${`${title}. Open Fased Network.`}
      @click=${() => onNavigate?.("federation")}
    >
      ${icons.shield}
    </button>
  `;
}

function renderWalletRuntimeStatusIcons(params: {
  role: DisplayedWalletRole;
  automationEnabled?: boolean;
}) {
  const { role } = params;
  if (role === "mining") {
    return nothing;
  }
  if (role === "vault") {
    return html`
      <span
        class="wallet-status-icon"
        data-state="vault-manual"
        title="Vault wallet is manual signing only. No background wallet automation."
        aria-label="Vault manual signing"
      >
        ${icons.hand}
      </span>
    `;
  }
  if (params.automationEnabled === undefined) {
    return nothing;
  }
  const automationEnabled = params.automationEnabled;
  const detail = automationEnabled
    ? "Agent auto policy is on. Background sends can run within approval policy, caps, allowlists, and skill grants."
    : "Agent auto policy is off. Sends require manual approval.";
  return html`
    <span
      class="wallet-status-icon"
      data-state=${automationEnabled ? "agent-auto-on" : "agent-auto-off"}
      title=${detail}
      aria-label=${automationEnabled ? "Agent auto on" : "Agent auto off"}
    >
      ${automationEnabled ? icons.zap : icons.hand}
    </span>
  `;
}

function renderWalletPasskeyChip(summary: string, detail: string) {
  const enabled = summary.toLowerCase() === "enabled";
  return html`
    <span class="wallet-lock-chip" data-state=${enabled ? "unlocked" : "locked"} title=${detail}>
      <span class="wallet-lock-chip__dot"></span>
      ${summary}
    </span>
  `;
}

function renderWalletSweepChip(profile: SatMinerProfile | null | undefined) {
  const enabled = Boolean(profile?.automation?.satSweep?.enabled);
  if (!enabled) {
    return nothing;
  }
  return html`
    <span
      class="wallet-status-icon"
      data-role="sweep-on"
      title="Sweep enabled"
    >
      ${icons.arrowDown}
    </span>
  `;
}

function renderWalletActivePolicyIcons(params: {
  walletId: string;
  role: DisplayedWalletRole;
  props: Pick<
    WalletViewProps,
    | "walletDetailsWalletId"
    | "policyCapsEnabled"
    | "policySkillsEnabled"
    | "recurringTransferEnabled"
  >;
}) {
  if (params.walletId !== params.props.walletDetailsWalletId) {
    return nothing;
  }
  const entries =
    params.role === "agent"
      ? [
          params.props.policyCapsEnabled
            ? { dataRole: "policy-on", title: "Caps active", icon: icons.shield }
            : null,
          params.props.recurringTransferEnabled
            ? { dataRole: "policy-on", title: "Recurring send active", icon: icons.send }
            : null,
          params.props.policySkillsEnabled
            ? {
                dataRole: "policy-on",
                title:
                  "Skill wallet access gate is active. Individual skills still need explicit Wallet > Skill Grants.",
                icon: icons.spark,
              }
            : null,
        ]
      : params.role === "vault"
        ? [
            params.props.policyCapsEnabled
              ? { dataRole: "policy-on", title: "Vault caps active", icon: icons.shield }
              : null,
          ]
        : [];
  return entries
    .filter((entry): entry is NonNullable<(typeof entries)[number]> => entry !== null)
    .map(
      (entry) => html`
        <span class="wallet-status-icon" data-role=${entry.dataRole} title=${entry.title}>
          ${entry.icon}
        </span>
      `,
    );
}

export function describeAgentDefaultAction(
  walletId: string,
  props: Pick<
    WalletViewProps,
    | "defaultWalletId"
    | "settingsBusy"
    | "miningProfile"
    | "miningReadiness"
    | "miningStatus"
    | "namedWallets"
  >,
): { label: string; disabled: boolean; title: string } {
  const isDefaultWallet = walletId === String(props.defaultWalletId ?? "").trim();
  const conflictsWithMining = !isDefaultWallet && walletId === resolveActiveMiningWalletId(props);
  const wallet = findNamedWallet(props.namedWallets, walletId);
  const metadataRole = resolveWalletMetadataRole(wallet);
  const purposeLocked = Boolean(metadataRole && metadataRole !== "agent");
  return {
    label: isDefaultWallet ? "Clear fallback" : "Set fallback",
    disabled: props.settingsBusy || conflictsWithMining || purposeLocked,
    title: conflictsWithMining
      ? "Agent and Mining wallets must stay separate. Create a dedicated Agent wallet instead."
      : purposeLocked
        ? "Wallet purpose is permanent. Create a new Agent wallet instead of changing this wallet."
        : isDefaultWallet
          ? "Clear this optional Default Agent wallet fallback. Existing Agent roles and assignments stay unchanged."
          : "Use this as the optional Default Agent wallet fallback after explicit, skill, and Agent assignments.",
  };
}

function resolveDisplayedWalletRole(
  walletId: string,
  props: Pick<
    WalletViewProps,
    "defaultWalletId" | "miningProfile" | "miningReadiness" | "miningStatus" | "namedWallets"
  >,
): DisplayedWalletRole {
  if (walletId === resolveActiveMiningWalletId(props)) {
    return "mining";
  }
  const wallet = findNamedWallet(props.namedWallets, walletId);
  const metadataRole = resolveWalletMetadataRole(wallet);
  if (metadataRole === "mining") {
    return "mining";
  }
  if (isAgentWallet(wallet, props.defaultWalletId)) {
    return "agent";
  }
  return "vault";
}

function walletRoleRank(role: DisplayedWalletRole): number {
  switch (role) {
    case "mining":
      return 0;
    case "vault":
      return 1;
    case "agent":
      return 2;
  }
}

export function orderWalletsForDisplay(
  wallets: WalletViewProps["namedWallets"],
  props: Pick<
    WalletViewProps,
    "defaultWalletId" | "miningProfile" | "miningReadiness" | "miningStatus" | "namedWallets"
  >,
): WalletViewProps["namedWallets"] {
  const defaultWalletId = String(props.defaultWalletId ?? "").trim();
  return wallets.toSorted((a, b) => {
    const aRole = resolveDisplayedWalletRole(a.id, props);
    const bRole = resolveDisplayedWalletRole(b.id, props);
    const roleDelta = walletRoleRank(aRole) - walletRoleRank(bRole);
    if (roleDelta !== 0) {
      return roleDelta;
    }
    if (aRole === "agent" && bRole === "agent") {
      if (a.id === defaultWalletId && b.id !== defaultWalletId) {
        return -1;
      }
      if (b.id === defaultWalletId && a.id !== defaultWalletId) {
        return 1;
      }
    }
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

function formatSatInputValue(raw: string | number | bigint | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "0";
  }
  try {
    const units = BigInt(value);
    const scale = 100_000_000_000n;
    const whole = units / scale;
    const fraction = (units % scale).toString().padStart(11, "0").replace(/0+$/, "").slice(0, 6);
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  } catch {
    return "0";
  }
}

function parseSatInputToRaw(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^\d+(\.\d{0,11})?$/.test(normalized)) {
    return "0";
  }
  const [wholePart, fractionPart = ""] = normalized.split(".");
  return (
    BigInt(wholePart || "0") * 100_000_000_000n +
    BigInt((fractionPart + "00000000000").slice(0, 11) || "0")
  ).toString();
}

function toHumanAmount(raw: string, chain: "solana", options: { hideUnit?: boolean } = {}): string {
  try {
    const value = BigInt(raw);
    const base = 10n ** 9n;
    const unit = "SOL";
    const whole = value / base;
    const frac = (value % base).toString().padStart(9, "0").replace(/0+$/, "");
    const numeric = frac ? `${whole.toString()}.${frac}` : whole.toString();
    return options.hideUnit ? numeric : `${numeric} ${unit}`;
  } catch {
    return "—";
  }
}

function toDisplayText(value: unknown, fallback = "n/a"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function chainLabel(value: unknown): string {
  const raw = toDisplayText(value, "n/a").toLowerCase();
  if (raw === "solana") {
    return "SOL";
  }
  return toDisplayText(value, "n/a");
}

function normalizeWalletChain(value: unknown): "solana" | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  const raw = String(value).trim().toLowerCase();
  if (raw === "solana" || raw === "sol") {
    return "solana";
  }
  return null;
}

function formatWalletAmount(value: unknown, chain: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return "n/a";
  }
  const raw = String(value).trim();
  if (!raw) {
    return "n/a";
  }
  const normalizedChain = normalizeWalletChain(chain);
  if (!normalizedChain) {
    return raw;
  }
  try {
    return toHumanAmount(raw, normalizedChain);
  } catch {
    return raw;
  }
}

function formatTokenAmountFromBaseUnits(
  raw: string | null | undefined,
  decimals: number | null | undefined,
): string | null {
  const value = String(raw ?? "").trim();
  if (!value) {
    return null;
  }
  if (typeof decimals !== "number" || !Number.isFinite(decimals) || decimals < 0) {
    return null;
  }
  try {
    const base = 10n ** BigInt(decimals);
    const amount = BigInt(value);
    const whole = amount / base;
    const fractionRaw = (amount % base).toString().padStart(decimals, "0");
    const fractionTrimmed = fractionRaw.replace(/0+$/, "");
    if (!fractionTrimmed) {
      return whole.toString();
    }
    const visibleFraction = fractionTrimmed.slice(0, 6).replace(/0+$/, "");
    return visibleFraction ? `${whole.toString()}.${visibleFraction}` : whole.toString();
  } catch {
    return null;
  }
}

function readWalletAuditString(details: Record<string, unknown>, key: string): string {
  return typeof details[key] === "string" ? String(details[key]).trim() : "";
}

function readWalletAuditNumber(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatWalletActivityDecimalAmount(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(normalized)) {
    return normalized;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return normalized;
  }
  if (parsed > 0 && parsed < 0.000001) {
    return "<0.000001";
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.abs(parsed) >= 1 ? 2 : 6,
  }).format(parsed);
}

function resolveWalletActivityAmountText(params: {
  details: Record<string, unknown>;
  balances: WalletBalancesResponse | null;
}): string {
  const chain = normalizeWalletChain(params.details.chain);
  const program = readWalletAuditString(params.details, "program");
  if (chain === "solana" && program) {
    const matchedAsset = Array.isArray(params.balances?.assets?.solana)
      ? params.balances.assets.solana.find((asset) => !asset.isNative && asset.program === program)
      : undefined;
    const rawSymbol =
      readWalletAuditString(params.details, "assetSymbol") || matchedAsset?.symbol || "SPL";
    const rawName = readWalletAuditString(params.details, "assetName") || matchedAsset?.name || "";
    const symbol = usesFallbackMintIdentity({
      isNative: false,
      program,
      symbol: rawSymbol,
      name: rawName,
    })
      ? "SPL"
      : rawSymbol;
    const displayAmount = readWalletAuditString(params.details, "amountDisplay");
    if (displayAmount) {
      return `${formatWalletActivityDecimalAmount(displayAmount)} ${symbol}`;
    }
    const decimals =
      readWalletAuditNumber(params.details, "assetDecimals") ?? matchedAsset?.decimals;
    const tokenAmount = formatTokenAmountFromBaseUnits(
      toDisplayText(params.details.amount, ""),
      decimals,
    );
    if (tokenAmount) {
      return `${formatWalletActivityDecimalAmount(tokenAmount)} ${symbol}`;
    }
    const rawAmount = toDisplayText(params.details.amount, "");
    return rawAmount ? `${rawAmount} raw ${symbol}` : "n/a";
  }
  return formatWalletAmount(params.details.amount, chain);
}

function describeWalletApprovalAsset(request: WalletSendApprovalRequest): {
  name: string | null;
  symbol: string | null;
  program: string | null;
} {
  const name = String(request.payload.assetName ?? "").trim() || null;
  const symbol = String(request.payload.assetSymbol ?? "").trim() || null;
  const program = String(request.payload.program ?? "").trim() || null;
  return { name, symbol, program };
}

function resolveWalletApprovalDisplay(params: {
  request: WalletSendApprovalRequest;
  balances: WalletBalancesResponse | null;
}): {
  amountValueText: string;
  assetPrimaryText: string | null;
  assetSecondaryText: string | null;
  name: string | null;
  symbol: string | null;
  program: string | null;
  usesFallbackIdentity: boolean;
} {
  if (params.request.payload.actionKind === "solana_swap") {
    const inputSymbol = String(params.request.payload.inputSymbol ?? "").trim() || "SOL";
    const outputSymbol =
      String(params.request.payload.outputSymbol ?? "").trim() ||
      (params.request.payload.outputMint
        ? shortMintMetadataLabel(params.request.payload.outputMint)
        : "token");
    const inputDecimals =
      typeof params.request.payload.inputDecimals === "number" &&
      Number.isFinite(params.request.payload.inputDecimals)
        ? params.request.payload.inputDecimals
        : Number(SOL_DECIMALS);
    const amountDisplay =
      String(params.request.payload.amountDisplay ?? "").trim() ||
      formatTokenAmountFromBaseUnits(params.request.payload.amount, inputDecimals) ||
      "";
    return {
      amountValueText: amountDisplay
        ? `${formatRoundedAssetAmountForUi(amountDisplay)} ${inputSymbol}`
        : formatWalletAmount(params.request.payload.amount, params.request.payload.chain),
      assetPrimaryText: `${inputSymbol} -> ${outputSymbol}`,
      assetSecondaryText: params.request.payload.routeLabel
        ? `Jupiter · ${params.request.payload.routeLabel}`
        : "Jupiter swap",
      name: String(params.request.payload.outputName ?? "").trim() || null,
      symbol: outputSymbol,
      program: params.request.payload.outputMint ?? null,
      usesFallbackIdentity: false,
    };
  }
  const approvalAsset = describeWalletApprovalAsset(params.request);
  const requestProgram = approvalAsset.program;
  const matchedAsset =
    requestProgram && Array.isArray(params.balances?.assets?.solana)
      ? params.balances.assets.solana.find((asset) => asset.program === requestProgram)
      : undefined;
  const symbol = approvalAsset.symbol ?? matchedAsset?.symbol ?? null;
  const name = approvalAsset.name ?? matchedAsset?.name ?? null;
  const usesFallbackIdentity = usesFallbackMintIdentity({
    isNative: false,
    program: requestProgram ?? "",
    symbol: symbol ?? "",
    name: name ?? "",
  });
  const amountDisplay =
    String(params.request.payload.amountDisplay ?? "").trim() ||
    formatTokenAmountFromBaseUnits(params.request.payload.amount, matchedAsset?.decimals) ||
    "";
  if (amountDisplay) {
    return {
      amountValueText: formatRoundedAssetAmountForUi(amountDisplay),
      assetPrimaryText: usesFallbackIdentity ? symbol : (name ?? symbol ?? requestProgram),
      assetSecondaryText:
        !usesFallbackIdentity && symbol && name && symbol !== name ? symbol : null,
      name,
      symbol,
      program: requestProgram,
      usesFallbackIdentity,
    };
  }
  return {
    amountValueText: formatWalletAmount(
      params.request.payload.amount,
      params.request.payload.chain,
    ),
    assetPrimaryText: usesFallbackIdentity ? symbol : (name ?? symbol ?? requestProgram),
    assetSecondaryText: !usesFallbackIdentity && symbol && name && symbol !== name ? symbol : null,
    name,
    symbol,
    program: requestProgram,
    usesFallbackIdentity,
  };
}

function resolveWalletApprovalEndpoints(params: {
  request: WalletSendApprovalRequest;
  namedWallets: WalletViewProps["namedWallets"];
}): {
  fromLabel: string | null;
  fromAddress: string | null;
  toAddress: string | null;
} {
  const walletId = String(params.request.payload.walletId ?? "").trim();
  const walletName = String(params.request.payload.walletName ?? "").trim();
  const chain = params.request.payload.chain;
  const sourceWallet =
    findNamedWallet(params.namedWallets, walletId) ??
    (walletName
      ? params.namedWallets.find(
          (wallet) => wallet.name.trim().toLowerCase() === walletName.toLowerCase(),
        )
      : undefined);
  const fromAddress = sourceWallet ? resolveWalletSourceAddress(sourceWallet, chain) || null : null;
  const fromLabel = sourceWallet?.name?.trim() || walletName || walletId || null;
  const toAddress = String(params.request.payload.to ?? "").trim() || null;
  return { fromLabel, fromAddress, toAddress };
}

function renderWalletApprovalDiffSummary(params: {
  request: WalletSendApprovalRequest;
  display: ReturnType<typeof resolveWalletApprovalDisplay>;
  endpoints: ReturnType<typeof resolveWalletApprovalEndpoints>;
}) {
  const diff = params.request.approvalDiff ?? params.request.simulation?.diff;
  if (!diff) {
    return nothing;
  }
  const from =
    diff.fromWalletName ||
    params.endpoints.fromLabel ||
    (diff.fromWalletId ? `@wallet:${diff.fromWalletId}` : "wallet");
  const amount = diff.amountDisplay || params.display.amountValueText || diff.amount || "amount";
  const token = diff.token || params.display.assetPrimaryText || diff.mint || diff.chain;
  const target = diff.to || params.endpoints.toAddress || "destination";
  const trigger = [
    diff.source,
    diff.skillId ? `skill ${diff.skillId}` : "",
    diff.taskId ? `task ${diff.taskId}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return html`
    <div class="wallet-approval-diff">
      <span>Spend <strong>${amount}</strong> ${token ? html`<span>${token}</span>` : nothing}</span>
      <span>from <strong>${from}</strong> <span class="muted">(${diff.fromRole})</span></span>
      <span>to <span class="mono">${shortenMiddle(target, 8, 6)}</span></span>
      ${trigger ? html`<span class="muted">triggered by ${trigger}</span>` : nothing}
    </div>
  `;
}

function walletSignerIntentRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function walletSignerIntentValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  if (Array.isArray(value)) {
    const values = value.map((entry) => walletSignerIntentValue(entry)).filter(Boolean);
    return values.length > 0 ? values.join(", ") : null;
  }
  return null;
}

function renderWalletSignerSemanticIntent(request: WalletSendApprovalRequest) {
  const intent = walletSignerIntentRecord(request.payload.signerSemanticIntent);
  const intentType = walletSignerIntentValue(intent?.type);
  if (!intent || !intentType) {
    return nothing;
  }
  const fields: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    const text = walletSignerIntentValue(value);
    if (text) {
      fields.push({ label, value: text });
    }
  };
  let missingTriggerTerms: string[] = [];
  if (intentType.startsWith("solana.jupiter.")) {
    const jupiter = walletSignerIntentRecord(intent.jupiter);
    const trigger = walletSignerIntentRecord(jupiter?.trigger);
    add("Owner", jupiter?.owner);
    add("Input mint", jupiter?.inputMint);
    add("Output mint", jupiter?.outputMint);
    add("Input amount", jupiter?.inputAmount);
    add("Maximum input", jupiter?.maxInputAmount);
    add("Minimum output", jupiter?.minimumOutputAmount);
    add("Fee ceiling (lamports)", jupiter?.maxFeeLamports);
    add("Source token account", jupiter?.sourceTokenAccount);
    add("Destination token account", jupiter?.destinationTokenAccount);
    add("Programs", jupiter?.programs);
    add("Trigger operation", trigger?.operation);
    add("Trigger program", trigger?.program);
    add("Trigger order ID", trigger?.order);
    add("Trigger mint", trigger?.triggerMint);
    add("Condition", trigger?.condition);
    add("Target price (USD)", trigger?.targetPriceUsd);
    add("Slippage (bps)", trigger?.slippageBps);
    add("Order expiry", trigger?.expiresAt);
    add("Expected order state", trigger?.expectedOrderState);
    if (intentType.includes(".trigger.")) {
      const operation = walletSignerIntentValue(trigger?.operation);
      const requiredTerms =
        operation === "create"
          ? [
              ["input mint", jupiter?.inputMint],
              ["output mint", jupiter?.outputMint],
              ["exact input amount", jupiter?.inputAmount],
              ["trigger mint", trigger?.triggerMint],
              ["condition", trigger?.condition],
              ["target price", trigger?.targetPriceUsd],
              ["slippage", trigger?.slippageBps],
              ["order expiry", trigger?.expiresAt],
              ["expected new state", trigger?.expectedOrderState],
            ]
          : operation === "cancel"
            ? [
                ["order ID", trigger?.order],
                ["refund mint", jupiter?.outputMint],
                ["minimum refund", jupiter?.minimumOutputAmount],
                ["refund destination", jupiter?.destinationTokenAccount],
                ["expected open state", trigger?.expectedOrderState],
              ]
            : [["operation", trigger?.operation]];
      missingTriggerTerms = requiredTerms
        .filter((entry) => walletSignerIntentValue(entry[1]) === null)
        .map((entry) => String(entry[0]));
      const forbiddenSignerOwnedFields = [
        ["vault", trigger?.vault],
        ["external request ID", trigger?.requestId],
        ["source token account", jupiter?.sourceTokenAccount],
        ...(operation === "create"
          ? [["destination token account", jupiter?.destinationTokenAccount]]
          : []),
      ]
        .filter((entry) => walletSignerIntentValue(entry[1]) !== null)
        .map((entry) => String(entry[0]));
      missingTriggerTerms.push(
        ...forbiddenSignerOwnedFields.map((field) => `remove caller-provided ${field}`),
      );
    }
  } else if (intentType === "solana.nativeTransfer") {
    add("Destination", intent.destination);
    add("Lamports", intent.lamports);
  } else if (intentType === "solana.splTransferChecked") {
    add("Token program", intent.tokenProgram);
    add("Mint", intent.mint);
    add("Destination", intent.destination);
    add("Amount", intent.amount);
  } else if (intentType === "solana.vaultBondAction") {
    const context = walletSignerIntentRecord(intent.context);
    add("Cluster", intent.cluster);
    add("Vault action", intent.action);
    add("Program", intent.programId);
    add("Target authority", context?.targetAuthority);
    add("Dispute authority", context?.disputeAuthority);
    add("Interval start cycle", context?.intervalStartCycleId);
    add("Registry page", context?.registryPageIndex);
    add("Miner authorities", context?.minerAuthorities);
    add("Front cycle IDs", context?.frontCycleIds);
    add("Back cycle IDs", context?.backCycleIds);
  } else if (intentType === "federation.bondChallenge") {
    const federation = walletSignerIntentRecord(intent.federation);
    add("Challenge ID", federation?.challengeId);
    add("Bond ID", federation?.bondId);
    add("Bond tier", federation?.tier);
    add("Bond amount", federation?.amountRaw);
    add("Federation handle", federation?.handle);
    add("Node ID", federation?.nodeId);
    add("Token ID", federation?.tokenId);
    add("Federation origin", federation?.federationOrigin);
    add("Challenge expiry", federation?.expiresAt);
  }
  return html`
    <div class="wallet-approval-diff" style="margin-top: 6px;">
      <span><strong>Signer intent</strong> <span class="mono">${intentType}</span></span>
      ${fields.map(
        (field) => html`
          <span>
            ${field.label}:
            <span class="mono" style="overflow-wrap: anywhere;">${field.value}</span>
          </span>
        `,
      )}
      ${
        missingTriggerTerms.length > 0
          ? html`
            <span class="muted">
              Invalid or incomplete signer binding: ${missingTriggerTerms.join(", ")}. Do not
              approve this Trigger review.
            </span>
          `
          : nothing
      }
    </div>
  `;
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatCompactTokenAmount(raw: string | null | undefined, unit: "SOL" | "SAT"): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "0";
  }
  try {
    const decimals = unit === "SOL" ? SOL_DECIMALS : SAT_DECIMALS;
    const amount = Number(value) / 10 ** Number(decimals);
    if (!Number.isFinite(amount)) {
      return "0";
    }
    const abs = Math.abs(amount);
    if (unit === "SAT") {
      if (abs >= 1000) {
        return trimTrailingZeros(amount.toFixed(1));
      }
      if (abs >= 1) {
        return trimTrailingZeros(amount.toFixed(2));
      }
      return trimTrailingZeros(amount.toFixed(3));
    }
    if (abs >= 1) {
      return trimTrailingZeros(amount.toFixed(2));
    }
    if (abs >= 0.01) {
      return trimTrailingZeros(amount.toFixed(2));
    }
    return abs > 0 ? "<0.01" : "0";
  } catch {
    return value;
  }
}

function stripUnitSuffix(value: string | null | undefined, unit: "SOL" | "SAT"): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "—";
  }
  const suffix = new RegExp(`\\s*${unit}$`, "i");
  return text.replace(suffix, "").trim() || "0";
}

function resolveMiningWalletId(
  props: Pick<WalletViewProps, "miningProfile" | "miningReadiness" | "miningStatus">,
): string {
  return String(
    props.miningProfile?.walletId ??
      props.miningStatus?.walletId ??
      props.miningReadiness?.selectedWalletId ??
      "",
  ).trim();
}

function resolveWalletSolBalanceDisplay(
  wallet: WalletViewProps["namedWallets"][number],
  props: Pick<WalletViewProps, "balancesLoading" | "miningReadiness" | "miningStatus">,
  isMiningWallet: boolean,
): string {
  if (typeof wallet.balances?.solana === "string" && wallet.balances.solana.trim()) {
    return formatRoundedAssetAmountForUi(
      stripUnitSuffix(toHumanAmount(wallet.balances.solana, "solana"), "SOL"),
    );
  }
  if (isMiningWallet) {
    const miningDisplay = String(props.miningReadiness?.balances.solBalanceDisplay ?? "").trim();
    if (miningDisplay) {
      return formatRoundedAssetAmountForUi(stripUnitSuffix(miningDisplay, "SOL"));
    }
    const statusLamports = String(props.miningStatus?.currentSolBalanceLamports ?? "").trim();
    if (statusLamports) {
      return formatRoundedAssetAmountForUi(formatCompactTokenAmount(statusLamports, "SOL"));
    }
  }
  if (wallet.addresses?.solana) {
    return props.balancesLoading ? "Loading" : "0";
  }
  return props.balancesLoading ? "Loading" : "—";
}

function resolveWalletSourceAddress(
  wallet: WalletViewProps["namedWallets"][number] | undefined,
  _chain: "solana",
): string {
  if (!wallet) {
    return "";
  }
  return wallet.addresses?.solana || "";
}

type WalletResolvedAssetOption = {
  id: string;
  chain: "solana";
  symbol: string;
  name: string;
  amountDisplay: string;
  amountRaw?: string;
  decimals?: number;
  isNative: boolean;
  program?: string;
  tokenProgramId?: string;
  address?: string;
  logoUri?: string;
  verificationStatus?: "verified" | "unverified" | "unknown";
  priceUsd?: number;
  valueUsd?: number;
  tags?: string[];
};

function resolveWalletDetailAssetEntries(
  wallet: WalletViewProps["namedWallets"][number] | undefined,
  balances: WalletBalancesResponse | null,
): WalletAssetEntry[] {
  if (!wallet || balances?.walletId !== wallet.id) {
    return [];
  }
  return Array.isArray(balances.assets?.solana) ? balances.assets.solana : [];
}

function buildWalletAssetOptions(
  wallet: WalletViewProps["namedWallets"][number] | undefined,
  props: Pick<
    WalletViewProps,
    "balances" | "balancesLoading" | "miningProfile" | "miningReadiness" | "miningStatus"
  >,
): WalletResolvedAssetOption[] {
  if (!wallet) {
    return [];
  }
  const options: WalletResolvedAssetOption[] = [];
  const isMiningWallet = resolveMiningWalletId(props) === wallet.id;
  const solanaAssets = resolveWalletDetailAssetEntries(wallet, props.balances);
  if (solanaAssets.length > 0) {
    for (const asset of solanaAssets) {
      options.push({
        id: asset.id,
        chain: "solana",
        symbol: asset.symbol,
        name: asset.name,
        amountDisplay: asset.amountDisplay,
        amountRaw: asset.amountRaw,
        decimals: asset.decimals,
        isNative: asset.isNative,
        program: asset.program,
        tokenProgramId: asset.tokenProgramId,
        address: asset.address,
        logoUri: asset.logoUri,
        verificationStatus: asset.verificationStatus,
        priceUsd: asset.priceUsd,
        valueUsd: asset.valueUsd,
        tags: asset.tags,
      });
    }
  } else {
    options.push({
      id: "solana:native",
      chain: "solana",
      symbol: "SOL",
      name: "Solana",
      amountDisplay: resolveWalletSolBalanceDisplay(wallet, props, isMiningWallet),
      amountRaw: wallet.balances?.solana,
      isNative: true,
      address: wallet.addresses?.solana,
    });
  }
  return options;
}

function formatRoundedAssetAmountForUi(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "—" || normalized.toLowerCase() === "loading") {
    return value;
  }
  const parsed = Number.parseFloat(normalized.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) {
    return value;
  }
  if (parsed > 0 && parsed < 0.01) {
    return "<0.01";
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(parsed);
}

function resolveTokenCapDraftValue(params: {
  drafts: WalletViewProps["policySolanaTokenCaps"];
  settings: WalletSettings | null;
  mint: string | undefined;
  field: "maxPerTx" | "maxDaily";
  decimals: number;
}): string {
  const mint = params.mint?.trim();
  if (!mint) {
    return "";
  }
  const draft = params.drafts[mint]?.[params.field];
  if (draft !== undefined) {
    if ((params.drafts[mint]?.decimals ?? -1) < 0) {
      return formatTokenAmountFromBaseUnits(draft, params.decimals) ?? draft;
    }
    return draft;
  }
  const raw = params.settings?.policy.solana.tokenCaps?.[mint]?.[params.field];
  return formatTokenAmountFromBaseUnits(raw, params.decimals) ?? "";
}

function updateTokenCapDraft(
  props: WalletViewProps,
  mint: string | undefined,
  decimals: number,
  field: "maxPerTx" | "maxDaily",
  value: string,
) {
  const normalizedMint = mint?.trim();
  if (!normalizedMint) {
    return;
  }
  const existing = props.policySolanaTokenCaps[normalizedMint];
  const current =
    existing && existing.decimals < 0
      ? {
          decimals,
          maxPerTx: formatTokenAmountFromBaseUnits(existing.maxPerTx, decimals) ?? "",
          maxDaily: formatTokenAmountFromBaseUnits(existing.maxDaily, decimals) ?? "",
        }
      : (existing ?? { decimals });
  props.onPolicyDraftChange({
    solanaTokenCaps: {
      ...props.policySolanaTokenCaps,
      [normalizedMint]: {
        ...current,
        decimals,
        [field]: value,
      },
    },
  });
}

function addManualTokenCapDraft(props: WalletViewProps) {
  const mint = props.policyTokenCapMint.trim();
  if (!mint) {
    return;
  }
  const parsedDecimals = Number.parseInt(props.policyTokenCapDecimals.trim(), 10);
  const decimals = Number.isFinite(parsedDecimals) ? Math.max(0, Math.min(18, parsedDecimals)) : 0;
  props.onPolicyDraftChange({
    solanaTokenCaps: {
      ...props.policySolanaTokenCaps,
      [mint]: {
        decimals,
        maxPerTx: props.policyTokenCapMaxPerTx.trim(),
        maxDaily: props.policyTokenCapMaxDaily.trim(),
      },
    },
    tokenCapMint: "",
    tokenCapDecimals: "",
    tokenCapMaxPerTx: "",
    tokenCapMaxDaily: "",
  });
}

function collectWalletCapAssetRows(params: {
  props: WalletViewProps;
  selectedWalletTokens: WalletResolvedAssetOption[];
}): Array<{
  key: string;
  label: string;
  detail: string;
  mint?: string;
  decimals: number;
  logo?: unknown;
}> {
  const rows: Array<{
    key: string;
    label: string;
    detail: string;
    mint?: string;
    decimals: number;
    logo?: unknown;
  }> = [];
  const seen = new Set<string>();
  for (const asset of params.selectedWalletTokens) {
    const mint = asset.program?.trim();
    if (asset.isNative || !mint || seen.has(mint)) {
      continue;
    }
    const shortMint = shortenMiddle(mint, 2, 2);
    const rawSymbol = String(asset.symbol || "").trim();
    const label =
      !rawSymbol ||
      rawSymbol === "Token" ||
      rawSymbol.includes("...") ||
      rawSymbol.includes("…") ||
      rawSymbol.length > 8
        ? shortMint
        : rawSymbol;
    seen.add(mint);
    rows.push({
      key: mint,
      label,
      detail: shortMint,
      mint,
      decimals: asset.decimals ?? 0,
      logo: renderWalletAssetLogo(asset, 20),
    });
  }
  const capMints = new Set([
    ...Object.keys(params.props.settings?.policy.solana.tokenCaps ?? {}),
    ...Object.keys(params.props.policySolanaTokenCaps ?? {}),
  ]);
  for (const mintRaw of capMints) {
    const mint = mintRaw.trim();
    if (!mint || seen.has(mint)) {
      continue;
    }
    seen.add(mint);
    rows.push({
      key: mint,
      label: shortenMiddle(mint, 2, 2),
      detail: shortenMiddle(mint, 2, 2),
      mint,
      decimals: params.props.policySolanaTokenCaps[mint]?.decimals ?? -1,
    });
  }
  return rows;
}

function renderWalletCapsPanel(params: {
  props: WalletViewProps;
  settings: WalletSettings;
  policyDisplay: WalletStatus["policyDisplay"] | undefined;
  cardRole: "agent" | "vault" | "mining";
  selectedWalletId: string;
  cardWalletCanSpendSolana: boolean;
  selectedWalletTokens: WalletResolvedAssetOption[];
  canEditPolicy: boolean;
}) {
  const {
    props,
    settings,
    policyDisplay,
    cardRole,
    selectedWalletId,
    cardWalletCanSpendSolana,
    selectedWalletTokens,
    canEditPolicy,
  } = params;
  const capsEnabled = props.policyCapsEnabled === true;
  const tokenRows = collectWalletCapAssetRows({ props, selectedWalletTokens });
  return html`
    <div class="field">
      <div class="wallet-spend-limit-row" style="align-items: end;">
        <label class="field">
          <span>Status</span>
          <select
            .value=${capsEnabled ? "enabled" : "disabled"}
            ?disabled=${props.settingsBusy || !canEditPolicy}
            @change=${(event: Event) =>
              props.onPolicyDraftChange({
                capsEnabled: (event.currentTarget as HTMLSelectElement).value === "enabled",
              })}
          >
            <option value="disabled">Off</option>
            <option value="enabled">On</option>
          </select>
        </label>
        <button class="btn" ?disabled=${props.settingsBusy || !canEditPolicy} @click=${props.onSavePolicy}>
          ${props.settingsBusy ? "Saving..." : "Save"}
        </button>
      </div>
      <label class="field" style="margin-top: 10px;">
        <span>Preset</span>
        <select
          ?disabled=${props.settingsBusy || !canEditPolicy}
          @change=${(event: Event) => {
            const preset = (event.currentTarget as HTMLSelectElement).value as
              | WalletSettingsPatch["policyTemplate"]
              | "";
            if (!preset) {
              return;
            }
            props.onPatchSettings({ walletId: selectedWalletId, policyTemplate: preset });
            (event.currentTarget as HTMLSelectElement).value = "";
          }}
        >
          <option value="">Choose policy preset...</option>
          <option value="read-only">Read-only</option>
          <option value="manual-only">Manual only</option>
          <option value="small-agent-spend">Small Agent spend</option>
          <option value="mining-only">Mining only</option>
          <option value="skill-limited">Skill limited</option>
          <option value="trading-experimental">Advanced wallet actions</option>
          <option value="recommended">Role recommended</option>
        </select>
      </label>
      <div class="wallet-token-list" style="margin-top: 10px;">
        ${
          cardWalletCanSpendSolana
            ? html`
                <div class="wallet-token-cap-row">
                  <label class="field wallet-cap-field">
                    <span class="wallet-field-label wallet-field-label--mint">
                      <span>SOL</span>
                      ${renderWalletHelp(
                        "Maximum SOL this wallet may spend in one day under this policy.",
                      )}
                    </span>
                    <input
                      aria-label="Daily SOL cap"
                      placeholder="5.0"
                      .value=${
                        props.policySolMaxDaily ||
                        policyDisplay?.solana.maxDaily.human.split(" ")[0] ||
                        toHumanAmount(settings.policy.solana.maxDaily, "solana", {
                          hideUnit: true,
                        })
                      }
                      ?disabled=${props.settingsBusy || !canEditPolicy}
                      @input=${(event: Event) =>
                        props.onPolicyDraftChange({
                          solMaxDaily: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field wallet-cap-field">
                    <span class="wallet-field-label">
                      <span>Tx</span>
                      ${renderWalletHelp(
                        "Maximum SOL this wallet may spend in one approved transaction.",
                      )}
                    </span>
                    <input
                      aria-label="Per transaction SOL cap"
                      placeholder="1.0"
                      .value=${
                        props.policySolMaxPerTx ||
                        policyDisplay?.solana.maxPerTx.human.split(" ")[0] ||
                        toHumanAmount(settings.policy.solana.maxPerTx, "solana", {
                          hideUnit: true,
                        })
                      }
                      ?disabled=${props.settingsBusy || !canEditPolicy}
                      @input=${(event: Event) =>
                        props.onPolicyDraftChange({
                          solMaxPerTx: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                </div>
              `
            : nothing
        }
        ${tokenRows.map(
          (row) => html`
            <div class="wallet-token-cap-row">
              <label class="field wallet-cap-field">
                <span class="wallet-field-label wallet-field-label--mint mono" title=${row.mint ?? row.label}>
                  <span>${row.label}</span>
                  ${renderWalletHelp(
                    "Maximum token amount this wallet may spend in one day under this policy.",
                  )}
                </span>
                <input
                  aria-label=${`Daily cap for ${row.label}`}
                  placeholder="0"
                  .value=${resolveTokenCapDraftValue({
                    drafts: props.policySolanaTokenCaps,
                    settings,
                    mint: row.mint,
                    field: "maxDaily",
                    decimals: row.decimals,
                  })}
                  ?disabled=${props.settingsBusy || !canEditPolicy}
                  @input=${(event: Event) =>
                    updateTokenCapDraft(
                      props,
                      row.mint,
                      row.decimals,
                      "maxDaily",
                      (event.target as HTMLInputElement).value,
                    )}
                />
              </label>
              <label class="field wallet-cap-field">
                <span class="wallet-field-label">
                  <span>Tx</span>
                  ${renderWalletHelp(
                    "Maximum token amount this wallet may spend in one approved transaction.",
                  )}
                </span>
                <input
                  aria-label=${`Per transaction cap for ${row.label}`}
                  placeholder="0"
                  .value=${resolveTokenCapDraftValue({
                    drafts: props.policySolanaTokenCaps,
                    settings,
                    mint: row.mint,
                    field: "maxPerTx",
                    decimals: row.decimals,
                  })}
                  ?disabled=${props.settingsBusy || !canEditPolicy}
                  @input=${(event: Event) =>
                    updateTokenCapDraft(
                      props,
                      row.mint,
                      row.decimals,
                      "maxPerTx",
                      (event.target as HTMLInputElement).value,
                    )}
                />
              </label>
            </div>
          `,
        )}
      </div>
      ${
        cardRole !== "mining"
          ? html`
              <details class="wallet-advanced-box" style="margin-top: 12px;">
                <summary>Add asset</summary>
                <div class="wallet-spend-limit-row" style="margin-top: 10px;">
                  <label class="field" style="min-width: 220px;">
                    <span>Asset</span>
                    <input
                      placeholder="Symbol, name, or mint"
                      .value=${props.policyTokenSearchQuery ?? ""}
                      ?disabled=${props.settingsBusy || !canEditPolicy}
                      @input=${(event: Event) =>
                        props.onTokenSearchQueryChange((event.target as HTMLInputElement).value)}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          props.onTokenSearch();
                        }
                      }}
                    />
                  </label>
                  <button
                    class="btn"
                    ?disabled=${
                      props.settingsBusy ||
                      !canEditPolicy ||
                      props.policyTokenSearchLoading ||
                      !(props.policyTokenSearchQuery ?? "").trim()
                    }
                    @click=${props.onTokenSearch}
                  >
                    ${props.policyTokenSearchLoading ? "Searching..." : "Search"}
                  </button>
                </div>
                ${
                  props.policyTokenSearchError
                    ? html`<div class="wallet-security-note error" style="margin-top: 8px;">${props.policyTokenSearchError}</div>`
                    : nothing
                }
                ${
                  (props.policyTokenSearchResults ?? []).length > 0
                    ? html`
                        <div class="wallet-token-list" style="margin-top: 8px;">
                          ${(props.policyTokenSearchResults ?? []).map(
                            (token) => html`
                              <div class="wallet-token-cap-row">
                                <div class="wallet-token-cap-row__asset">
                                  <div class="wallet-token-cap-row__symbol" title=${token.symbol}>
                                    ${token.symbol}${
                                      token.verified
                                        ? html`
                                            <span class="muted"> verified</span>
                                          `
                                        : nothing
                                    }
                                  </div>
                                </div>
                                <div class="muted mono wallet-token-cap-row__detail" title=${token.mint}>
                                  ${shortenMiddle(token.mint, 2, 2)}
                                </div>
                                <button class="btn" ?disabled=${props.settingsBusy || !canEditPolicy} @click=${() => props.onTokenSearchSelect(token)}>
                                  Use
                                </button>
                              </div>
                            `,
                          )}
                        </div>
                      `
                    : nothing
                }
                <div class="wallet-spend-limit-row" style="margin-top: 8px;">
                  <label class="field" style="min-width: 220px;">
                    <span>Mint</span>
                    <input
                      placeholder="Mint address"
                      .value=${props.policyTokenCapMint ?? ""}
                      ?disabled=${props.settingsBusy || !canEditPolicy}
                      @input=${(event: Event) =>
                        props.onPolicyDraftChange({
                          tokenCapMint: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field">
                    <span>Decimals</span>
                    <input
                      placeholder="6"
                      inputmode="numeric"
                      .value=${props.policyTokenCapDecimals}
                      ?disabled=${props.settingsBusy || !canEditPolicy}
                      @input=${(event: Event) =>
                        props.onPolicyDraftChange({
                          tokenCapDecimals: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field">
                    <span class="wallet-field-label wallet-field-label--icon-only">
                      ${renderWalletHelp(
                        "Maximum token amount this wallet may spend in one day under this policy.",
                      )}
                    </span>
                    <input
                      aria-label="Daily token cap"
                      placeholder="0"
                      .value=${props.policyTokenCapMaxDaily ?? ""}
                      ?disabled=${props.settingsBusy || !canEditPolicy}
                      @input=${(event: Event) =>
                        props.onPolicyDraftChange({
                          tokenCapMaxDaily: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <label class="field">
                    <span class="wallet-field-label wallet-field-label--icon-only">
                      ${renderWalletHelp(
                        "Maximum token amount this wallet may spend in one approved transaction.",
                      )}
                    </span>
                    <input
                      aria-label="Per transaction token cap"
                      placeholder="0"
                      .value=${props.policyTokenCapMaxPerTx ?? ""}
                      ?disabled=${props.settingsBusy || !canEditPolicy}
                      @input=${(event: Event) =>
                        props.onPolicyDraftChange({
                          tokenCapMaxPerTx: (event.target as HTMLInputElement).value,
                        })}
                    />
                  </label>
                  <button
                    class="btn"
                    ?disabled=${props.settingsBusy || !canEditPolicy || !(props.policyTokenCapMint ?? "").trim()}
                    @click=${() => addManualTokenCapDraft(props)}
                  >
                    Add
                  </button>
                </div>
              </details>
            `
          : nothing
      }
      ${
        cardRole === "agent"
          ? html`
              <details style="margin-top: 12px;">
                <summary class="muted" style="cursor: pointer;">Routes</summary>
                <label class="field" style="margin-top: 8px;">
                  <span>Program IDs</span>
                  <textarea
                    rows="3"
                    placeholder="Optional route program IDs, one per line"
                    .value=${props.policySolanaAllowPrograms ?? ""}
                    ?disabled=${props.settingsBusy || !canEditPolicy}
                    @input=${(event: Event) =>
                      props.onPolicyDraftChange({
                        solanaAllowPrograms: (event.target as HTMLTextAreaElement).value,
                      })}
                  ></textarea>
                </label>
              </details>
            `
          : nothing
      }
    </div>
  `;
}

function renderWalletAssetLogo(
  asset: Pick<WalletResolvedAssetOption, "logoUri" | "symbol">,
  sizePx = 28,
) {
  const fallback = asset.symbol.trim().slice(0, 1).toUpperCase() || "?";
  const style =
    `width:${sizePx}px;height:${sizePx}px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;` +
    "background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.92);font-weight:600;font-size:0.8em;overflow:hidden;flex-shrink:0;";
  if (!asset.logoUri) {
    return html`<span style=${style}>${fallback}</span>`;
  }
  return html`<span style=${style}
    ><img
      src=${asset.logoUri}
      alt=${`${asset.symbol} logo`}
      style=${`width:${sizePx}px;height:${sizePx}px;object-fit:cover;display:block;`}
      @error=${(event: Event) => {
        const img = event.currentTarget as HTMLImageElement | null;
        const parent = img?.parentElement;
        if (img && parent) {
          img.style.display = "none";
          parent.textContent = fallback;
        }
      }}
    /></span
  >`;
}

function resolveSelectedWalletAsset(
  wallet: WalletViewProps["namedWallets"][number] | undefined,
  props: Pick<
    WalletViewProps,
    | "balances"
    | "balancesLoading"
    | "miningProfile"
    | "miningReadiness"
    | "miningStatus"
    | "sendCreateForm"
  >,
): { selected?: WalletResolvedAssetOption; options: WalletResolvedAssetOption[] } {
  const options = buildWalletAssetOptions(wallet, props);
  if (options.length === 0) {
    return { options };
  }
  const requestedAssetId = String(props.sendCreateForm.assetId ?? "").trim();
  const requestedChain = props.sendCreateForm.chain;
  const selected =
    options.find((asset) => asset.id === requestedAssetId) ??
    options.find((asset) => asset.chain === requestedChain && asset.isNative) ??
    options.find((asset) => asset.chain === requestedChain) ??
    options[0];
  return { selected, options };
}

function describeWalletAuditAction(action: string): string {
  switch (action) {
    case "send_requested":
      return "Request created";
    case "send_approved":
      return "Approved";
    case "send_rejected":
      return "Rejected";
    case "send_executed":
      return "Executed";
    case "send_failed":
      return "Failed";
    default:
      return action.replace(/_/g, " ");
  }
}

function describeWalletAuditEntry(entry: WalletAuditEntry): string {
  const details = entry.details ?? {};
  const actionKind = readWalletAuditString(details, "actionKind");
  if (actionKind === "solana_limit_order") {
    if (entry.action === "send_executed") {
      return "Limit order created";
    }
    if (entry.action === "send_failed") {
      return "Limit order failed";
    }
    return "Limit order request";
  }
  if (actionKind === "solana_limit_cancel") {
    if (entry.action === "send_executed") {
      return "Limit order cancelled";
    }
    if (entry.action === "send_failed") {
      return "Cancel failed";
    }
    return "Cancel request";
  }
  return describeWalletAuditAction(entry.action);
}

function renderWalletApprovalStatusIcon(status: string) {
  switch (status) {
    case "pending":
      return icons.loader;
    case "approved":
      return icons.check;
    case "executed":
      return icons.send;
    case "failed":
    case "rejected":
    case "expired":
      return icons.x;
    default:
      return icons.fileText;
  }
}

function renderWalletAuditActionIcon(action: string) {
  switch (action) {
    case "send_requested":
      return icons.penLine;
    case "send_approved":
      return icons.check;
    case "send_rejected":
      return icons.x;
    case "send_executed":
      return icons.send;
    case "send_failed":
      return icons.bug;
    default:
      return icons.fileText;
  }
}

function shortenMiddle(value: string, start = 8, end = 6): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "—";
  }
  if (trimmed.length <= start + end + 1) {
    return trimmed;
  }
  return `${trimmed.slice(0, start)}...${trimmed.slice(-end)}`;
}

function shortMintMetadataLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "TOKEN";
  }
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function usesFallbackMintIdentity(
  asset:
    | Pick<WalletAssetEntry, "isNative" | "program" | "symbol" | "name">
    | Pick<WalletResolvedAssetOption, "isNative" | "program" | "symbol" | "name">
    | null
    | undefined,
): boolean {
  if (!asset || asset.isNative || !asset.program) {
    return false;
  }
  const shortMint = shortMintMetadataLabel(asset.program);
  return (
    String(asset.symbol ?? "")
      .trim()
      .toUpperCase() === shortMint.toUpperCase() &&
    String(asset.name ?? "").trim() === `Token ${shortMint}`
  );
}

async function copyToClipboard(value: string): Promise<void> {
  const text = value.trim();
  if (!text || typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Ignore copy failures silently for now.
  }
}

function walletSecretId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-") || "wallet";
}

function toggleWalletSecretText(id: string, hidden: string, visible: string) {
  if (typeof document === "undefined") {
    return;
  }
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  const revealed = element.dataset.revealed === "true";
  element.textContent = revealed ? hidden : visible;
  element.dataset.revealed = revealed ? "false" : "true";
}

function renderCopyButton(value: string, label: string) {
  const text = value.trim();
  if (!text) {
    return nothing;
  }
  return html`<button
    type="button"
    class="wallet-copy-btn"
    title=${`Copy ${label}`}
    aria-label=${`Copy ${label}`}
    @click=${() => void copyToClipboard(text)}
  >
    <span class="wallet-copy-btn__icon">${icons.copy}</span>
  </button>`;
}

function renderCopyTextButton(params: {
  value: string | null | undefined;
  display: string;
  label: string;
  title?: string;
  className?: string;
}) {
  const text = String(params.value ?? "").trim();
  if (!text) {
    return nothing;
  }
  const display = params.display.trim() || shortenMiddle(text);
  return html`<button
    type="button"
    class=${`wallet-copy-text ${params.className ?? ""}`.trim()}
    data-copied="false"
    title=${params.title ?? `Copy ${params.label}`}
    aria-label=${`Copy ${params.label}`}
    @click=${(event: Event) => {
      void copyToClipboard(text).then(() => {
        const button = event.currentTarget as HTMLButtonElement | null;
        if (!button) {
          return;
        }
        const popover = button.querySelector<HTMLElement>(".wallet-copy-popover");
        button.dataset.copied = "true";
        if (popover) {
          popover.textContent = "Copied";
        }
        window.setTimeout(() => {
          if (popover) {
            popover.textContent = "Copy";
          }
          button.dataset.copied = "false";
        }, 1200);
      });
    }}
  >
    <span class="wallet-copy-text__label">${display}</span>
    <span class="wallet-copy-popover" aria-hidden="true">Copy</span>
  </button>`;
}

function renderInfoButton(label: string, detail: string) {
  const tooltip = `${label}: ${detail}`;
  return html`<button
    type="button"
    class="wallet-icon-btn"
    title=${tooltip}
    aria-label=${tooltip}
  >
    <span class="wallet-copy-btn__icon">${icons.info}</span>
  </button>`;
}

function renderExternalLinkButton(href: string | null | undefined, label: string) {
  const target = String(href ?? "").trim();
  if (!target) {
    return nothing;
  }
  return html`<a
    class="wallet-icon-btn"
    href=${target}
    target="_blank"
    rel="noreferrer noopener"
    title=${label}
    aria-label=${label}
  >
    <span class="wallet-copy-btn__icon">${icons.externalLink}</span>
  </a>`;
}

function walletExplorerUrl(
  chain: "solana" | null,
  kind: "address" | "tx",
  value: string | null | undefined,
): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || !chain) {
    return null;
  }
  return kind === "tx"
    ? `https://solscan.io/tx/${encodeURIComponent(trimmed)}`
    : `https://solscan.io/account/${encodeURIComponent(trimmed)}`;
}

function renderWalletBalancePill(
  label: "SOL" | "SAT",
  value: string,
  tone: "success" | "warn" | "neutral" = "neutral",
  options: {
    title?: string;
    onClick?: () => void;
  } = {},
) {
  const title = options.title ?? label;
  const content = html`<div class="wallet-balance-pill__value">${value}</div>`;
  if (options.onClick) {
    return html`<button
      type="button"
      class="wallet-balance-pill wallet-balance-pill--button"
      data-tone=${tone}
      title=${title}
      aria-label=${`${title} balance. Click to show token balances.`}
      @click=${options.onClick}
    >
      ${content}
    </button>`;
  }
  return html`<div class="wallet-balance-pill" data-tone=${tone} title=${title}>${content}</div>`;
}

function renderWalletMetaRow(params: {
  label: string;
  value: string;
  rawValue?: string | null | undefined;
  copyLabel?: string;
  href?: string | null | undefined;
}) {
  return html`<div class="wallet-meta-row">
    <span class="wallet-meta-row__label">${params.label}</span>
    <span class="wallet-meta-row__value mono">${params.value}</span>
    <span class="wallet-meta-row__actions">
      ${
        params.rawValue && params.copyLabel
          ? renderCopyButton(params.rawValue, params.copyLabel)
          : nothing
      }
      ${renderExternalLinkButton(params.href, `Open ${params.label}`)}
    </span>
  </div>`;
}

function renderWalletSkillGrantsPanel(props: WalletViewProps) {
  const draft = props.skillGrantDraft;
  const selectedRow =
    props.skillGrantRows.find((row) => row.skillId === draft.skillId) ?? props.skillGrantRows[0];
  const walletIds = (draft.walletIds ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const saveDisabled =
    props.skillGrantBusy ||
    !draft.skillId.trim() ||
    draft.actions.length === 0 ||
    walletIds.length === 0;
  return html`
    <div id="wallet-skill-grants" class="card wallet-panel">
      <div class="wallet-panel__head">
        <div>
          <div class="card-title">Skill Grants</div>
          <div class="card-sub">
            Per-skill caps for Agent wallets. One wallet id is the explicit skill override;
            multiple ids are an allowlist and normal Agent routing continues.
          </div>
        </div>
        <button class="btn" ?disabled=${props.skillGrantsLoading} @click=${props.onRefresh}>
          ${props.skillGrantsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      ${
        props.skillGrantsWorkspace
          ? html`<div class="muted mono" style="margin-top: 8px;">${props.skillGrantsWorkspace}</div>`
          : nothing
      }
      ${
        props.skillGrantsError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.skillGrantsError}</div>`
          : nothing
      }
      ${
        props.skillGrantsMessage
          ? html`<div class="callout success" style="margin-top: 12px;">${props.skillGrantsMessage}</div>`
          : nothing
      }
      ${
        props.skillGrantRows.length === 0
          ? html`
              <div class="wallet-security-note" style="margin-top: 12px">
                No reviewed wallet-capable skills or existing wallet grants found yet.
              </div>
            `
          : html`
              <div class="wallet-skill-grant-layout">
                <div class="wallet-skill-grant-list">
                  ${props.skillGrantRows.map((row) => {
                    const selected = row.skillId === selectedRow?.skillId;
                    const needsGrant = row.requestedWalletActions && !row.grantedWalletActions;
                    return html`
                      <button
                        class="wallet-skill-grant-row ${selected ? "is-selected" : ""}"
                        type="button"
                        @click=${() => props.onSkillGrantSelect(row)}
                      >
                        <span
                          class="status-dot ${row.grantedWalletActions ? "ok" : needsGrant ? "warn" : ""}"
                        ></span>
                        <span>
                          <strong>${row.skillId}</strong>
                          <span class="muted">
                            ${row.source === "clawhub" ? "ClawHub" : "config"}
                            ${row.version ? ` · ${row.version}` : ""}
                          </span>
                        </span>
                        <span class="muted">${formatSkillGrantSummary(row.grantedWalletActions)}</span>
                      </button>
                    `;
                  })}
                </div>
                <div class="wallet-skill-grant-form">
                  <div class="wallet-skill-grant-facts">
                    <div>
                      <span>Requested</span>
                      <strong>
                        ${formatRequestedWalletActions(selectedRow?.requestedWalletActions ?? null)}
                      </strong>
                    </div>
                    <div>
                      <span>Current grant</span>
                      <strong>${formatSkillGrantSummary(selectedRow?.grantedWalletActions ?? null)}</strong>
                    </div>
                  </div>
                  <label class="field">
                    <span>Skill</span>
                    <input
                      .value=${draft.skillId}
                      @input=${(event: Event) =>
                        props.onSkillGrantDraftPatch({
                          skillId: (event.target as HTMLInputElement).value,
                        })}
                      placeholder="daily-dca"
                    />
                  </label>
                  <div class="wallet-skill-grant-actions">
                    ${WALLET_SKILL_ACTIONS.map(
                      (action) => html`
                        <label>
                          <input
                            type="checkbox"
                            .checked=${draft.actions.includes(action)}
                            @change=${(event: Event) =>
                              props.onSkillGrantActionToggle(
                                action,
                                (event.target as HTMLInputElement).checked,
                              )}
                          />
                          <span>${action}</span>
                        </label>
                      `,
                    )}
                  </div>
                  <div class="wallet-card-security__grid">
                    <label class="field">
                      <span>Chain</span>
                      <select .value="solana" disabled>
                        <option value="solana">Solana</option>
                      </select>
                    </label>
                    <label class="field">
                      <span>Agent wallet ids</span>
                      <input
                        .value=${draft.walletIds}
                        @input=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            walletIds: (event.target as HTMLInputElement).value,
                          })}
                        placeholder="comma-separated"
                      />
                    </label>
                    <label class="field">
                      <span>Max amount</span>
                      <input
                        .value=${draft.maxAmount}
                        @input=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            maxAmount: (event.target as HTMLInputElement).value,
                          })}
                        placeholder="base units"
                      />
                    </label>
                    <label class="field">
                      <span>Slippage bps</span>
                      <input
                        .value=${draft.maxSlippageBps}
                        @input=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            maxSlippageBps: (event.target as HTMLInputElement).value,
                          })}
                        placeholder="50"
                      />
                    </label>
                    <label class="field">
                      <span>Registry</span>
                      <input
                        .value=${draft.registry}
                        @input=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            registry: (event.target as HTMLInputElement).value,
                          })}
                      />
                    </label>
                    <label class="field">
                      <span>Input mints</span>
                      <input
                        .value=${draft.inputMints}
                        @input=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            inputMints: (event.target as HTMLInputElement).value,
                          })}
                        placeholder="comma-separated"
                      />
                    </label>
                    <label class="field">
                      <span>Output mints</span>
                      <input
                        .value=${draft.outputMints}
                        @input=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            outputMints: (event.target as HTMLInputElement).value,
                          })}
                        placeholder="comma-separated"
                      />
                    </label>
                  </div>
                  <div class="wallet-skill-grant-flags">
                    <label>
                      <input
                        type="checkbox"
                        .checked=${draft.autonomous}
                        @change=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            autonomous: (event.target as HTMLInputElement).checked,
                          })}
                      />
                      <span>Autonomous</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        .checked=${draft.cron}
                        @change=${(event: Event) =>
                          props.onSkillGrantDraftPatch({
                            cron: (event.target as HTMLInputElement).checked,
                          })}
                      />
                      <span>Cron</span>
                    </label>
                  </div>
                  <div class="wallet-card-security__actions">
                    <button class="btn primary" ?disabled=${saveDisabled} @click=${props.onSkillGrantSave}>
                      ${props.skillGrantBusy ? "Saving..." : "Save grant"}
                    </button>
                    <button
                      class="btn danger"
                      ?disabled=${props.skillGrantBusy || !draft.skillId.trim()}
                      @click=${() => props.onSkillGrantClear(draft.skillId)}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            `
      }
    </div>
  `;
}

function renderWalletAccessPanel(props: WalletViewProps) {
  const status = props.status;
  const adminControlShortcut = describeAdminControlShortcut(props);
  const agentWallets = props.namedWallets.filter((wallet) =>
    isAgentWallet(wallet, props.defaultWalletId),
  );
  const agentIds = [
    ...new Set([
      ...(props.agents ?? []).map((agent) => agent.id.trim()).filter(Boolean),
      ...Object.keys(props.assignments ?? {}),
    ]),
  ].toSorted();

  return html`
    <div class="wallet-top-grid">
      <div id="wallet-admin-control" class="card wallet-top-card">
        <div class="wallet-top-card__head">
          <div>
            <div class="wallet-top-card__title-row">
              <div class="card-title">Control UI account passkey</div>
              ${renderInfoButton(
                "Optional Control UI account passkey",
                `${adminControlShortcut.detail} Use a device passkey such as Touch ID, Windows Hello, a phone passkey, or a supported security key.`,
              )}
              ${renderWalletPasskeyChip(adminControlShortcut.summary, adminControlShortcut.detail)}
            </div>
          </div>
        </div>
        <div class="row" style="gap: 10px; flex-wrap: wrap;">
          ${
            adminControlShortcut.enableVisible
              ? html`
                  <button
                    class="btn"
                    ?disabled=${adminControlShortcut.enableDisabled}
                    @click=${props.onEnablePasskeyApproval}
                  >
                    ${adminControlShortcut.enableLabel}
                  </button>
                `
              : nothing
          }
          ${
            adminControlShortcut.enrollVisible
              ? html`
                  <input
                    style="min-width: 220px;"
                    .value=${props.passkeyLabel}
                    @input=${(event: Event) =>
                      props.onPasskeyLabelChange((event.target as HTMLInputElement).value)}
                    placeholder="Passkey label (optional)"
                  />
                  <button
                    class="btn primary"
                    ?disabled=${adminControlShortcut.enrollDisabled}
                    @click=${props.onEnrollPasskey}
                  >
                    ${adminControlShortcut.enrollLabel}
                  </button>
                `
              : nothing
          }
        </div>
        <div class="wallet-security-note" style="margin-top: 10px;">
          This is optional account security for the browser Control UI. It is not requested during
          installation or wallet creation and does not gate Agent or Mining automation. A Vault
          approval device is a separate signer-owned feature configured only for Vault review.
        </div>
        ${
          !adminControlShortcut.enableVisible && !adminControlShortcut.enrollVisible
            ? html`
                <details class="wallet-advanced-box">
                  <summary>Manage passkey</summary>
                  ${
                    (status?.approvalAuth?.passkeys?.length ?? 0) > 0
                      ? html`
                          <div class="wallet-security-device-list">
                            ${status!.approvalAuth.passkeys.map(
                              (passkey) => html`
                                <div class="wallet-security-device-row">
                                  <div>
                                    <div>Label: ${passkey.label || "Wallet passkey"}</div>
                                    <div class="wallet-security-note">
                                      Credential ID <span class="mono">${shortenMiddle(passkey.id)}</span>
                                      · added ${new Date(passkey.createdAt).toLocaleString()}
                                    </div>
                                  </div>
                                  <button
                                    class="btn small"
                                    ?disabled=${props.passkeyBusy || !props.onDeletePasskey}
                                    @click=${() => props.onDeletePasskey?.(passkey.id)}
                                  >
                                    Remove passkey
                                  </button>
                                </div>
                              `,
                            )}
                          </div>
                        `
                      : nothing
                  }
                </details>
              `
            : nothing
        }
        ${
          props.passkeyError
            ? html`<div class="callout danger">${props.passkeyError}</div>`
            : nothing
        }
      </div>
      <div id="wallet-agent-routing" class="card wallet-top-card">
        <div class="wallet-top-card__head">
          <div>
            <div class="card-title">Agent wallet routing</div>
            <div class="card-sub">
              Explicit action → one-wallet skill override → Agent assignment → optional Default
              Agent wallet fallback. If none exists, the action stops with Select an Agent wallet.
            </div>
          </div>
        </div>
        <div class="wallet-security-device-list" style="margin-top: 12px">
          ${
            agentIds.length > 0
              ? agentIds.map((agentId) => {
                  const assignedWalletId = props.assignments?.[agentId];
                  const effectiveWalletId = assignedWalletId || props.defaultWalletId || null;
                  const agentName =
                    props.agents?.find((agent) => agent.id === agentId)?.name?.trim() || agentId;
                  return html`
                    <div class="wallet-security-device-row">
                      <div>
                        <strong>${agentName}</strong>
                        <div class="wallet-security-note mono">${agentId}</div>
                        <div class="wallet-security-note">
                          Assigned: ${assignedWalletId || "none"} · Effective fallback:
                          ${effectiveWalletId || "Select an Agent wallet"}
                        </div>
                      </div>
                      <button
                        class="btn small"
                        ?disabled=${props.settingsBusy || !assignedWalletId}
                        @click=${() => props.onDeleteAgentAssignment?.(agentId)}
                      >
                        Clear assignment
                      </button>
                    </div>
                  `;
                })
              : html`
                  <div class="wallet-security-note">No Agents are available yet.</div>
                `
          }
        </div>
        <div class="wallet-card-security__grid" style="margin-top: 12px">
          <label class="field">
            <span>Agent</span>
            <select
              .value=${props.assignAgentId ?? ""}
              @change=${(event: Event) =>
                props.onAssignAgentIdChange?.((event.target as HTMLSelectElement).value)}
            >
              <option value="">Select Agent</option>
              ${agentIds.map((agentId) => html`<option value=${agentId}>${agentId}</option>`)}
            </select>
          </label>
          <label class="field">
            <span>Assigned Agent wallet</span>
            <select
              .value=${props.assignWalletId ?? ""}
              @change=${(event: Event) =>
                props.onAssignWalletIdChange?.((event.target as HTMLSelectElement).value)}
            >
              <option value="">No assignment</option>
              ${agentWallets.map(
                (wallet) => html`<option value=${wallet.id}>${wallet.name} (${wallet.id})</option>`,
              )}
            </select>
          </label>
          <button
            class="btn primary"
            ?disabled=${props.settingsBusy || !props.assignAgentId?.trim()}
            @click=${props.onAssignAgentWallet}
          >
            Save assignment
          </button>
        </div>
      </div>
    </div>
  `;
}

function walletActivityTone(action: string): "success" | "warn" | "danger" | "neutral" {
  switch (action) {
    case "send_executed":
    case "send_approved":
      return "success";
    case "send_failed":
    case "send_rejected":
      return "danger";
    case "send_requested":
      return "warn";
    default:
      return "neutral";
  }
}

export function renderWallet(props: WalletViewProps) {
  const status = props.status;
  const settings = props.settings;
  const operatorRoles = resolveOperatorWalletRoles(props);
  const hasWalletMessages = Boolean(
    props.error ||
    props.settingsError ||
    props.actionMessage ||
    props.settingsMessage ||
    operatorRoles.sharedWalletWarning,
  );
  const recentWalletActivity = props.auditEntries
    .filter((entry) =>
      ["send_requested", "send_approved", "send_rejected", "send_executed", "send_failed"].includes(
        entry.action,
      ),
    )
    .slice(0, 48);
  const activityTotal = recentWalletActivity.length;
  const totalActivityPages = Math.max(1, Math.ceil(activityTotal / WALLET_ACTIVITY_PAGE_SIZE));
  const activityPage = Math.min(Math.max(props.activityPage, 1), totalActivityPages);
  const activityStart = (activityPage - 1) * WALLET_ACTIVITY_PAGE_SIZE;
  const activityEntries = recentWalletActivity.slice(
    activityStart,
    activityStart + WALLET_ACTIVITY_PAGE_SIZE,
  );
  const canEditPolicy = status?.capabilities?.canEditPolicy ?? true;
  const canSend = status?.capabilities?.canSend ?? true;
  const policyDisplay = status?.policyDisplay;
  const selectedWallet = findNamedWallet(props.namedWallets, props.walletDetailsWalletId);
  const displayedWallets = orderWalletsForDisplay(props.namedWallets, props);
  const miningSatSweep = {
    enabled: false,
    mode: "all" as const,
    percentage: 100,
    minRaw: "1",
    keepRaw: "0",
    ...props.miningProfile?.automation?.satSweep,
  };
  const miningSweepDestinationWalletOptions = props.namedWallets.filter(
    (wallet) => wallet.id !== selectedWallet?.id && Boolean(wallet.addresses?.solana),
  );
  const miningSweepDestinationMode =
    miningSatSweep.destinationAddress || !miningSatSweep.destinationWalletId
      ? "external"
      : "wallet";
  const expandedWalletId = String(props.expandedWalletId ?? "").trim();
  const expandedPanel = props.expandedPanel ?? "";
  const routeHash =
    typeof window !== "undefined" ? String(window.location?.hash ?? "").replace(/^#/, "") : "";
  const hashPanel =
    routeHash === "wallet-skill-grants"
      ? "skill-grants"
      : ["wallet-access", "wallet-admin-control"].includes(routeHash)
        ? "access"
        : null;
  const activeMainPanel = hashPanel ?? props.mainPanel ?? "wallets";
  const createProviders = (props.providers ?? []).filter(
    (provider) =>
      (provider.id === "local-socket-signer" || provider.id === "turnkey") &&
      provider.operationsImplemented &&
      provider.capabilities.operations.createWallet,
  );
  const createProviderId = props.createProvider ?? createProviders[0]?.id ?? "local-socket-signer";
  const createProvider = createProviders.find((provider) => provider.id === createProviderId);
  const createProviderReady = Boolean(
    createProvider?.enabled &&
    createProvider.health.ok &&
    (!createProvider.capabilities.requiresCredentials || createProvider.credentialsConfigured),
  );
  const existingMiningWallet = props.namedWallets.find(
    (wallet) => resolveDisplayedWalletRole(wallet.id, props) === "mining" || wallet.id === "mining",
  );
  const miningCreationBlocked = props.createRole === "mining" && Boolean(existingMiningWallet);
  const createInputReady = Boolean(
    props.createRole &&
    props.createName?.trim() &&
    (createProviderId !== "local-socket-signer" ||
      (props.createId?.trim() && props.createRpcUrl?.trim())) &&
    !miningCreationBlocked,
  );
  const setMainPanel = (panel: "wallets" | "access" | "skill-grants") => {
    props.onMainPanelChange?.(panel);
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    url.hash =
      panel === "skill-grants" ? "wallet-skill-grants" : panel === "access" ? "wallet-access" : "";
    window.history.replaceState({}, "", url.toString());
  };

  return html`
    ${renderSendModal(props)}
    <style>
      .wallet-dashboard {
        display: grid;
        gap: 12px;
      }
      .wallet-top-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
        margin-bottom: 0;
      }
      .wallet-top-card,
      .wallet-panel,
      .wallet-activity-card {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--card);
        padding: 18px;
        box-shadow:
          var(--shadow-sm),
          inset 0 1px 0 var(--card-highlight);
      }
      .wallet-main-stack {
        display: grid;
        gap: 12px;
      }
      .wallet-main-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .wallet-main-tabs__spacer {
        flex: 1 1 auto;
      }
      .wallet-main-tabs .btn[aria-selected="true"] {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--accent-contrast, var(--bg));
      }
      .wallet-skill-grant-layout {
        display: grid;
        grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.2fr);
        gap: 12px;
        margin-top: 14px;
        align-items: start;
      }
      .wallet-skill-grant-list,
      .wallet-skill-grant-form {
        display: grid;
        gap: 10px;
      }
      .wallet-skill-grant-row {
        width: 100%;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 8px 10px;
        align-items: start;
        text-align: left;
        border: 1px solid var(--border);
        background: var(--secondary);
        color: var(--text);
        border-radius: var(--radius-sm);
        padding: 10px;
        cursor: pointer;
      }
      .wallet-skill-grant-row.is-selected {
        border-color: var(--accent);
        box-shadow: inset 0 0 0 1px var(--accent);
      }
      .wallet-skill-grant-row > .muted {
        grid-column: 2;
        font-size: 12px;
      }
      .wallet-skill-grant-facts {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .wallet-skill-grant-facts > div {
        display: grid;
        gap: 4px;
        border: 1px solid var(--border);
        background: var(--secondary);
        border-radius: var(--radius-sm);
        padding: 10px;
      }
      .wallet-skill-grant-facts span {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .wallet-skill-grant-actions,
      .wallet-skill-grant-flags {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .wallet-skill-grant-actions label,
      .wallet-skill-grant-flags label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid var(--border);
        background: var(--secondary);
        border-radius: 999px;
        padding: 7px 10px;
        font-size: 12px;
      }
      @media (max-width: 920px) {
        .wallet-skill-grant-layout,
        .wallet-skill-grant-facts {
          grid-template-columns: 1fr;
        }
      }
      .wallet-top-card__head,
      .wallet-panel__head,
      .wallet-activity-card__head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
      }
      .wallet-panel__head-actions {
        align-items: center;
        display: flex;
        gap: 8px;
        min-height: 40px;
      }
      .wallet-title-with-help {
        align-items: center;
        display: inline-flex;
        gap: 8px;
      }
      .wallet-help {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-sm);
        color: var(--muted);
        cursor: help;
        display: inline-flex;
        flex: 0 0 auto;
        height: 22px;
        justify-content: center;
        position: relative;
        width: 22px;
      }
      .wallet-help svg {
        fill: none;
        height: 16px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
        width: 16px;
      }
      .wallet-help::after {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        color: var(--text-strong);
        content: attr(data-tooltip);
        font-size: 12px;
        font-weight: 520;
        left: auto;
        line-height: 1.45;
        opacity: 0;
        padding: 10px 12px;
        pointer-events: none;
        position: absolute;
        right: 0;
        top: calc(100% + 8px);
        transform: translateY(-2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease;
        white-space: normal;
        width: min(340px, calc(100vw - 48px));
        z-index: 50;
      }
      .wallet-help:hover,
      .wallet-help:focus-visible {
        background: var(--bg-hover);
        color: var(--text-strong);
      }
      .wallet-help:hover::after,
      .wallet-help:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
      }
      .wallet-top-card__title-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .wallet-top-card__sub {
        margin-top: 8px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .wallet-status-strip,
      .wallet-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .wallet-status-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--secondary);
        color: var(--text);
        font-size: 12px;
        line-height: 1;
        font-weight: 560;
      }
      .wallet-security-note {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .wallet-security-device-list {
        display: grid;
        gap: 10px;
      }
      .wallet-security-device-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px 12px;
      }
      .wallet-inline-badges {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .wallet-status-chip[data-tone="success"] {
        color: var(--ok);
        border-color: rgba(34, 197, 94, 0.24);
        background: var(--ok-subtle);
      }
      .wallet-status-chip[data-tone="warn"] {
        color: var(--warn);
        border-color: rgba(245, 158, 11, 0.24);
        background: var(--warn-subtle);
      }
      .wallet-status-chip[data-tone="danger"] {
        color: var(--danger);
        border-color: rgba(239, 68, 68, 0.24);
        background: var(--danger-subtle);
      }
      .wallet-inline-grid {
        display: grid;
        grid-template-columns: 96px repeat(2, minmax(0, 1fr)) auto;
        gap: 12px;
        align-items: end;
        margin-top: 16px;
      }
      .wallet-role-template-grid,
      .wallet-guide-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
        gap: 12px;
        margin-top: 16px;
      }
      .wallet-role-template-card,
      .wallet-guide-item,
      .wallet-role-focus {
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 14px;
        display: grid;
        gap: 8px;
      }
      .wallet-role-template-card[data-active="true"] {
        border-color: var(--accent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent);
      }
      .wallet-role-template-title {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
      }
      .wallet-role-template-list,
      .wallet-guide-list {
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
        display: grid;
        gap: 6px;
      }
      .wallet-guide-item__title {
        color: var(--text-strong);
        font-weight: 620;
      }
      .wallet-policy-advanced {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }
      .wallet-policy-advanced-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .wallet-policy-advanced input,
      .wallet-policy-advanced textarea,
      .wallet-card-security input,
      .wallet-card-security textarea {
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }
      .wallet-compat-list {
        display: grid;
        gap: 10px;
      }
      .wallet-setup-list {
        display: grid;
        gap: 10px;
      }
      .wallet-setup-row {
        display: grid;
        grid-template-columns: minmax(0, 190px) minmax(0, 120px) minmax(0, 1fr);
        gap: 12px;
        align-items: start;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
      }
      .wallet-setup-row__label {
        color: var(--text-strong);
        font-size: 12px;
        font-weight: 620;
      }
      .wallet-setup-row__state {
        color: var(--text);
        font-size: 12px;
      }
      .wallet-setup-row__detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .wallet-compat-row {
        display: grid;
        grid-template-columns: minmax(0, 180px) minmax(0, 140px) minmax(0, 1fr);
        gap: 12px;
        align-items: start;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
      }
      .wallet-compat-row__label {
        color: var(--text-strong);
        font-size: 12px;
        font-weight: 620;
      }
      .wallet-compat-row__state {
        color: var(--text);
        font-size: 12px;
      }
      .wallet-compat-row__detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .wallet-policy-advanced-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .wallet-advanced-box {
        margin-top: 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 12px 14px;
      }
      .wallet-advanced-box > summary {
        cursor: pointer;
        color: var(--text-strong);
        font-weight: 620;
      }
      .wallet-advanced-box[open] > summary {
        margin-bottom: 12px;
      }
      .wallet-message-stack {
        display: grid;
        gap: 10px;
        margin-bottom: 0;
      }
      .wallet-grid {
        align-items: stretch;
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        margin-top: 12px;
      }
      .wallet-card {
        border-radius: 18px;
        border: 1px solid var(--border);
        background: var(--card);
        padding: 16px;
        align-content: start;
        display: grid;
        gap: 14px;
        height: 100%;
        min-height: 220px;
        box-shadow:
          var(--shadow-sm),
          inset 0 1px 0 var(--card-highlight);
      }
      .wallet-card__header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }
      .wallet-card__identity {
        min-width: 0;
        display: grid;
        gap: 8px;
      }
      .wallet-card__title-row,
      .wallet-card__address-row,
      .wallet-card__balance-main {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .wallet-card__title-row {
        flex-wrap: wrap;
      }
      .wallet-status-icon,
      .wallet-lock-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }
      .wallet-status-icon {
        width: 18px;
        height: 18px;
        font-size: 12px;
        font-weight: 760;
      }
      .wallet-status-icon svg {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 2;
      }
      .wallet-status-icon--button {
        appearance: none;
        border: 0;
        background: transparent;
        padding: 0;
        cursor: pointer;
      }
      .wallet-status-icon--button:hover {
        color: var(--text);
      }
      .wallet-status-icon[data-role="bond"] {
        color: var(--accent);
      }
      .wallet-status-icon[data-role="bond-active"],
      .wallet-status-icon[data-role="sweep-on"],
      .wallet-status-icon[data-role="policy-on"] {
        color: var(--ok);
      }
      .wallet-status-icon[data-role="bond-unlocking"] {
        color: var(--warn);
      }
      .wallet-lock-chip {
        gap: 6px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 650;
      }
      .wallet-lock-chip__dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: currentColor;
        box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent);
      }
      .wallet-lock-chip[data-state="unlocked"] {
        color: var(--ok);
      }
      .wallet-lock-chip[data-state="locked"] {
        color: var(--warn);
      }
      .wallet-status-icon[data-state="agent-auto-on"],
      .wallet-status-icon[data-state="vault-split-locked"] {
        color: var(--ok);
      }
      .wallet-status-icon[data-state="agent-auto-off"],
      .wallet-status-icon[data-state="vault-manual"] {
        color: var(--muted);
      }
      .wallet-status-icon[data-state="vault-split-unlocked"] {
        color: var(--warn);
      }
      .wallet-card__wallet-icon {
        width: 18px;
        height: 18px;
        border: 0;
        background: transparent;
        color: var(--muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }
      .wallet-card__wallet-icon svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
      }
      .wallet-card__title {
        font-family: var(--font-display);
        color: var(--text-strong);
        font-size: 18px;
        font-weight: 650;
        line-height: 1.15;
      }
      .wallet-card__address-row {
        color: var(--muted);
        font-size: 13px;
        justify-content: flex-start;
        flex-wrap: nowrap;
        overflow: hidden;
        width: 100%;
      }
      .wallet-card__address {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--muted);
        flex: 0 1 auto;
        max-width: min(170px, 34vw);
      }
      .wallet-card__address-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
      }
      .wallet-card__handle {
        color: var(--muted);
        flex: 0 1 132px;
        max-width: none;
      }
      .wallet-card__balance-row {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }
      .wallet-card__balance-main {
        align-items: stretch;
      }
      .wallet-card__balance-main .wallet-balance-pill {
        flex: 1 1 auto;
        min-width: 0;
      }
      .wallet-card__send-btn {
        min-width: 92px;
        align-self: stretch;
      }
      .wallet-balance-pill {
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 10px 14px;
        text-align: left;
      }
      .wallet-balance-pill--button {
        appearance: none;
        color: inherit;
        cursor: pointer;
        transition:
          background 120ms ease,
          color 120ms ease;
      }
      .wallet-balance-pill--button:hover {
        background: rgba(255, 255, 255, 0.045);
      }
      .wallet-balance-pill[data-tone="success"] {
        border-color: rgba(34, 197, 94, 0.24);
        background: var(--ok-subtle);
      }
      .wallet-balance-pill[data-tone="warn"] {
        border-color: rgba(245, 158, 11, 0.24);
        background: var(--warn-subtle);
      }
      .wallet-balance-pill__value {
        margin-top: 0;
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        font-size: 19px;
        font-weight: 680;
        line-height: 1.1;
        color: var(--text-strong);
      }
      .wallet-meta-list {
        display: grid;
        gap: 8px;
      }
      .wallet-meta-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--secondary);
      }
      .wallet-meta-row__label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
      }
      .wallet-meta-row__value {
        min-width: 0;
        font-size: 13px;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wallet-meta-row__actions {
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }
      .wallet-icon-btn,
      .wallet-copy-btn {
        width: 20px;
        height: 20px;
        border: 0;
        background: transparent;
        color: var(--muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        cursor: pointer;
        text-decoration: none;
        transition:
          color 120ms ease,
          opacity 120ms ease;
      }
      .wallet-icon-btn:hover,
      .wallet-copy-btn:hover {
        color: var(--text-strong);
      }
      .wallet-copy-btn__icon {
        width: 15px;
        height: 15px;
        display: inline-flex;
      }
      .wallet-copy-btn__icon svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
      }
      .wallet-copy-text {
        appearance: none;
        border: 0;
        background: transparent;
        color: var(--muted);
        padding: 0;
        min-width: 0;
        max-width: none;
        flex: 0 1 auto;
        cursor: pointer;
        font: inherit;
        text-align: left;
        position: relative;
      }
      .wallet-copy-popover {
        position: absolute;
        left: 50%;
        bottom: calc(100% + 7px);
        transform: translateX(-50%) translateY(2px);
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--bg-elevated);
        color: var(--text-strong);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
        font-size: 11px;
        line-height: 1;
        opacity: 0;
        pointer-events: none;
        white-space: nowrap;
        transition:
          opacity 120ms ease,
          transform 120ms ease;
        z-index: 5;
      }
      .wallet-copy-text:hover .wallet-copy-popover,
      .wallet-copy-text:focus-visible .wallet-copy-popover {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .wallet-copy-text[data-copied="true"] .wallet-copy-popover {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
        border-color: rgba(34, 197, 94, 0.32);
        color: var(--ok);
      }
      .wallet-copy-text__label {
        display: block;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wallet-copy-text:hover {
        color: var(--text-strong);
      }
      .wallet-copy-text[data-copied="true"] {
        color: var(--accent);
        text-decoration: none;
      }
      .wallet-token-details {
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 10px 12px;
      }
      .wallet-balance-link {
        appearance: none;
        border: 0;
        background: transparent;
        color: var(--muted);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        justify-self: start;
        padding: 0;
        margin-top: 8px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 620;
      }
      .wallet-balance-link__icon {
        display: inline-flex;
        width: 14px;
        height: 14px;
      }
      .wallet-balance-link__icon svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
      }
      .wallet-balance-link:hover {
        color: var(--text-strong);
      }
      .wallet-balance-link[data-active="true"] {
        color: var(--muted);
      }
      .wallet-token-details__title {
        color: var(--text);
        font-size: 13px;
        font-weight: 620;
      }
      .wallet-token-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }
      .wallet-card-security {
        border-top: 1px solid var(--border);
        padding-top: 12px;
        display: grid;
        gap: 12px;
      }
      .wallet-policy-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .wallet-policy-tab {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--surface-muted);
        color: var(--muted);
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 650;
        line-height: 1;
        padding: 8px 10px;
      }
      .wallet-policy-tab:hover {
        color: var(--text-strong);
        border-color: var(--border-strong);
      }
      .wallet-policy-tab[data-active="true"] {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--text-strong);
      }
      .wallet-policy-heading {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .wallet-policy-help {
        width: 16px;
        height: 16px;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--muted);
        cursor: help;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        font-size: 11px;
        font-weight: 750;
        line-height: 1;
      }
      .wallet-card-security__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-end;
      }
      .wallet-card-security__grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
        gap: 10px;
      }
      .wallet-spend-limit-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
        gap: 10px;
        align-items: end;
      }
      .wallet-spend-limit-row > .field {
        min-width: 0 !important;
      }
      .wallet-spend-limit-row > .btn {
        min-width: 96px;
      }
      .wallet-token-cap-row {
        display: grid !important;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        align-items: end;
        width: 100%;
        min-width: 0;
      }
      .wallet-token-cap-row__asset {
        display: grid;
        gap: 2px;
        grid-column: 1 / -1;
        min-width: 0;
      }
      .wallet-token-cap-row__symbol {
        color: var(--text-strong);
        font-size: 14px;
        font-weight: 650;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wallet-token-cap-row__detail {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wallet-token-cap-row .row {
        min-width: 0;
      }
      .wallet-token-cap-row .field {
        min-width: 0;
      }
      .wallet-token-cap-row input {
        width: 100%;
        min-width: 0;
      }
      .wallet-cap-field {
        gap: 4px;
      }
      .wallet-field-label {
        align-items: center;
        display: inline-flex;
        gap: 5px;
        justify-content: space-between;
        min-width: 0;
      }
      .wallet-field-label--mint {
        color: var(--muted);
        font-size: 11px;
        font-weight: 650;
        line-height: 1.1;
      }
      .wallet-field-label--mint > span:first-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .wallet-asset-fallback {
        width: 20px;
        height: 20px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(45, 212, 191, 0.14);
        color: rgba(153, 246, 228, 0.95);
        font-size: 0.72rem;
        font-weight: 750;
        flex: 0 0 auto;
      }
      .wallet-recovery-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .wallet-card-security__note {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .wallet-create-panel {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface-muted);
        padding: 10px 12px;
      }
      .wallet-create-panel > summary {
        cursor: pointer;
        color: var(--text-strong);
        font-weight: 700;
      }
      .wallet-create-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: 12px;
      }
      .wallet-create-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        grid-column: 1 / -1;
      }
      @media (max-width: 720px) {
        .wallet-create-grid {
          grid-template-columns: 1fr;
        }
        .wallet-spend-limit-row {
          grid-template-columns: 1fr;
        }
        .wallet-token-cap-row {
          grid-template-columns: 1fr !important;
          align-items: stretch;
        }
      }
      .wallet-activity-toolbar {
        margin-top: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .wallet-activity-list {
        margin-top: 12px;
        display: grid;
        gap: 10px;
        max-height: 520px;
        overflow: auto;
        padding-right: 4px;
      }
      .wallet-activity-item {
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--card);
        padding: 14px;
        display: grid;
        gap: 10px;
      }
      .wallet-activity-item[data-tone="success"] {
        border-color: rgba(34, 197, 94, 0.24);
      }
      .wallet-activity-item[data-tone="warn"] {
        border-color: rgba(245, 158, 11, 0.24);
      }
      .wallet-activity-item[data-tone="danger"] {
        border-color: rgba(248, 113, 113, 0.24);
      }
      .wallet-activity-item__head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .wallet-approvals-grid .table-head,
      .wallet-approvals-grid .table-row {
        display: grid;
        grid-template-columns:
          minmax(0, 1.65fr)
          minmax(0, 0.7fr)
          minmax(0, 0.38fr)
          minmax(0, 1.25fr)
          minmax(0, 0.85fr)
          minmax(0, 0.85fr)
          minmax(0, 0.95fr)
          auto;
        gap: 10px;
        align-items: center;
        justify-items: start;
        text-align: left;
      }
      .wallet-approvals-grid .table-head > div,
      .wallet-approvals-grid .table-row > div {
        min-width: 0;
        justify-self: start;
        text-align: left;
      }
      .wallet-approvals-grid .table-row > div:last-child {
        justify-self: end;
      }
      .wallet-approval-diff {
        margin-top: 6px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        color: var(--text-muted);
        font-size: 0.76em;
        line-height: 1.35;
      }
      .wallet-activity-item__title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text-strong);
        font-weight: 620;
      }
      .wallet-activity-item__title span:first-child {
        width: 16px;
        height: 16px;
        display: inline-flex;
      }
      .wallet-activity-item__title span:first-child svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
      }
      .wallet-activity-item__time {
        color: var(--muted);
        font-size: 12px;
      }
      .wallet-activity-item__facts {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .wallet-activity-item__rows {
        display: grid;
        gap: 8px;
      }
      @media (max-width: 960px) {
        .wallet-top-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 820px) {
        .wallet-inline-grid {
          grid-template-columns: 1fr;
        }
        .wallet-policy-advanced-grid {
          grid-template-columns: 1fr;
        }
        .wallet-compat-row {
          grid-template-columns: 1fr;
        }
        .wallet-card__header {
          flex-direction: column;
          align-items: stretch;
        }
        .wallet-card__address-row {
          display: flex;
          flex-wrap: nowrap;
          align-items: center;
        }
        .wallet-card__address {
          flex-basis: 80px;
        }
        .wallet-card__handle {
          flex-basis: 108px;
        }
        .wallet-meta-row {
          grid-template-columns: minmax(54px, auto) minmax(0, 1fr) auto;
        }
      }
    </style>
    <section id="wallet-dashboard" class="wallet-dashboard">
    ${
      hasWalletMessages
        ? html`
            <div class="wallet-message-stack">
              ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
              ${props.settingsError ? html`<div class="callout danger">${props.settingsError}</div>` : nothing}
              ${
                props.actionMessage
                  ? html`<div class="callout success">${props.actionMessage}</div>`
                  : nothing
              }
              ${
                props.settingsMessage
                  ? html`<div class="callout success">${props.settingsMessage}</div>`
                  : nothing
              }
              ${
                operatorRoles.sharedWalletWarning
                  ? html`<div class="callout warn">${operatorRoles.sharedWalletWarning}</div>`
                  : nothing
              }
            </div>
          `
        : nothing
    }
    <div class="wallet-main-stack">
        <div class="wallet-main-tabs" role="tablist" aria-label="Wallet sections">
          <button
            class="btn"
            role="tab"
            aria-selected=${activeMainPanel === "wallets" ? "true" : "false"}
            @click=${() => setMainPanel("wallets")}
          >
            Wallets
          </button>
          <button
            class="btn"
            role="tab"
            aria-selected=${activeMainPanel === "access" ? "true" : "false"}
            @click=${() => setMainPanel("access")}
          >
            Account Security
          </button>
          <button
            class="btn"
            role="tab"
            aria-selected=${activeMainPanel === "skill-grants" ? "true" : "false"}
            @click=${() => setMainPanel("skill-grants")}
          >
            Skill Grants
          </button>
          ${
            activeMainPanel === "wallets"
              ? html`
                  <span class="wallet-main-tabs__spacer"></span>
                  <button
                    class="btn small"
                    ?disabled=${props.settingsBusy}
                    @click=${props.onAttachWalletStandardVault}
                    title="Attach a Solana Wallet Standard account. Wallet discovery cannot prove hardware backing; verify a reserve account on its device."
                  >
                    Attach Wallet Standard Vault
                  </button>
                  <button
                    class="btn small"
                    ?disabled=${props.loading || props.balancesLoading}
                    @click=${props.onRefresh}
                  >
                    ${props.balancesLoading ? "Refreshing..." : "Refresh"}
                  </button>
                `
              : nothing
          }
        </div>
        ${
          activeMainPanel === "skill-grants"
            ? renderWalletSkillGrantsPanel(props)
            : activeMainPanel === "access"
              ? renderWalletAccessPanel(props)
              : html`<div id="wallet-wallets" class="wallet-wallets-section">
          <details class="wallet-create-panel">
            <summary>Create a signer-owned wallet</summary>
            <div class="wallet-create-grid">
              <label class="field">
                <span>Name</span>
                <input
                  .value=${props.createName ?? ""}
                  placeholder="Agent wallet"
                  autocomplete="off"
                  @input=${(event: Event) =>
                    props.onCreateNameChange?.((event.target as HTMLInputElement).value)}
                />
              </label>
              <label class="field">
                <span>Permanent wallet ID</span>
                <input
                  .value=${props.createId ?? ""}
                  placeholder=${
                    createProviderId === "local-socket-signer"
                      ? "agent-operations (required)"
                      : "optional local label"
                  }
                  autocomplete="off"
                  @input=${(event: Event) =>
                    props.onCreateIdChange?.((event.target as HTMLInputElement).value)}
                />
              </label>
              <label class="field">
                <span>Custody provider</span>
                <select
                  .value=${createProviderId}
                  @change=${(event: Event) =>
                    props.onCreateProviderChange?.(
                      (event.target as HTMLSelectElement).value as WalletProviderInfo["id"],
                    )}
                >
                  ${createProviders.map(
                    (provider) => html`
                      <option value=${provider.id}>
                        ${
                          provider.label ||
                          (provider.id === "local-socket-signer" ? "Native Go signer" : "Turnkey")
                        }
                      </option>
                    `,
                  )}
                </select>
              </label>
              <label class="field">
                <span>Wallet role</span>
                <select
                  .value=${props.createRole ?? ""}
                  @change=${(event: Event) =>
                    props.onCreateRoleChange?.(
                      (event.target as HTMLSelectElement).value as
                        | ""
                        | "agent"
                        | "mining"
                        | "vault",
                    )}
                >
                  <option value="" disabled>Select a role</option>
                  <option value="agent">Agent — capped automation</option>
                  <option value="mining">Mining — singleton SAT operations</option>
                  <option value="vault">Vault — reviewed operations only</option>
                </select>
              </label>
              ${
                createProviderId === "local-socket-signer"
                  ? html`
                      <label class="field">
                        <span>Primary Solana RPC</span>
                        <input
                          .value=${props.createRpcUrl ?? ""}
                          placeholder="https://your-solana-rpc.example"
                          autocomplete="off"
                          spellcheck="false"
                          @input=${(event: Event) =>
                            props.onCreateRpcUrlChange?.((event.target as HTMLInputElement).value)}
                        />
                      </label>
                    `
                  : nothing
              }
              <div class="wallet-create-actions">
                <button
                  class="btn primary"
                  ?disabled=${props.settingsBusy || !createProviderReady || !createInputReady}
                  @click=${props.onCreateWallet}
                >
                  ${props.settingsBusy ? "Creating..." : "Create wallet"}
                </button>
                <span class="muted">
                  ${
                    miningCreationBlocked
                      ? `Mining already uses ${existingMiningWallet?.name ?? existingMiningWallet?.id}. Open, Replace, or Archive that singleton wallet.`
                      : !props.createRole
                        ? "Choose a wallet role; Agent is never selected silently."
                        : !createProvider
                          ? "No production wallet-creation provider is available."
                          : !createProvider.enabled
                            ? "Enable this provider in Wallet Access first."
                            : !createProvider.health.ok
                              ? createProvider.health.details || "Provider health check failed."
                              : createProvider.capabilities.requiresCredentials &&
                                  !createProvider.credentialsConfigured
                                ? "Configure restricted provider credentials before creating a wallet."
                                : createProviderId === "local-socket-signer"
                                  ? "The Go signer generates the key; Node receives only the public address."
                                  : "Turnkey creates the account under the configured restrictive policy."
                  }
                </span>
              </div>
            </div>
          </details>
          ${
            props.balancesError
              ? html`<div class="callout danger">${props.balancesError}</div>`
              : nothing
          }
          <div class="wallet-grid">
            ${displayedWallets.map((wallet) => {
              const isMiningWallet = resolveMiningWalletId(props) === wallet.id;
              const solBalanceDisplay = resolveWalletSolBalanceDisplay(
                wallet,
                props,
                isMiningWallet,
              );
              const activeBalanceWalletId = String(props.balanceWalletId ?? "").trim();
              const balanceSelected = wallet.id === expandedWalletId && expandedPanel === "balance";
              const securitySelected =
                wallet.id === expandedWalletId && expandedPanel === "security";
              const selectedWalletAssets =
                (balanceSelected || securitySelected) &&
                wallet.id === (activeBalanceWalletId || props.balances?.walletId)
                  ? buildWalletAssetOptions(wallet, props).filter(
                      (asset) => asset.chain === "solana",
                    )
                  : [];
              const selectedWalletTokens = selectedWalletAssets.filter((asset) => !asset.isNative);
              const addressChain = "solana" as const;
              const walletAddress = wallet.addresses?.solana || "";
              const walletAddressDisplayId = `wallet-address-${walletSecretId(wallet.id)}`;
              const nativeLabel = "SOL" as const;
              const nativeValue = solBalanceDisplay;
              const cardRole = resolveDisplayedWalletRole(wallet.id, props);
              const vaultSignerApproval = describeVaultSignerApproval(status);
              const cardAutomationEnabled =
                cardRole === "agent" && wallet.id === props.walletDetailsWalletId && settings
                  ? settings.policy.directSigning
                  : undefined;
              const cardSignerPolicy =
                wallet.id === props.walletDetailsWalletId ? settings?.signerPolicy : undefined;
              const cardSignerReadiness = wallet.readiness?.signer;
              const cardNetworkReady =
                wallet.providerId !== "local-socket-signer" ||
                cardSignerReadiness?.networkReady === true;
              const cardNetworkVersion =
                cardSignerReadiness?.networkVersion ??
                (typeof wallet.metadata?.networkVersion === "number"
                  ? wallet.metadata.networkVersion
                  : undefined);
              const cardWalletReady =
                wallet.providerId !== "local-socket-signer" || wallet.readiness?.ready === true;
              const cardWalletChains = allowedWalletSendChains(wallet);
              const cardWalletCanSpendSolana = cardWalletChains.includes("solana");
              const policyTabs: Array<{ id: WalletPolicyPanel; label: string; title: string }> =
                cardRole === "mining"
                  ? [
                      {
                        id: "sweep",
                        label: "Sweep",
                        title: "Mining-only sweep after SAT claims.",
                      },
                    ]
                  : cardRole === "agent"
                    ? [
                        {
                          id: "caps",
                          label: "Caps",
                          title:
                            "Limits used by chat, scheduled sends, swaps, and approved automation.",
                        },
                        {
                          id: "schedule",
                          label: "Send",
                          title:
                            "One Agent-wallet recurring send policy shared by chat and Wallet UI.",
                        },
                        {
                          id: "automation",
                          label: "Auto",
                          title:
                            "Stop or resume background wallet execution for this Agent wallet.",
                        },
                        {
                          id: "skills",
                          label: "Skills",
                          title:
                            "Allow reviewed skills to use this Agent wallet after separate skill grants.",
                        },
                      ]
                    : [
                        {
                          id: "caps",
                          label: "Caps",
                          title: "Vault guardrails for reviewed Wallet UI sends only.",
                        },
                      ];
              const activePolicyPanel =
                props.policyPanel && policyTabs.some((tab) => tab.id === props.policyPanel)
                  ? props.policyPanel
                  : (policyTabs[0]?.id ?? "caps");
              const recurringSchedule = parseRecurringTransferCron(
                props.recurringTransferCron ?? "",
              );
              const recurringTransferMint = String(props.recurringTransferMint ?? "").trim();
              const recurringAmountUnit = recurringTransferMint ? "token" : "SOL";
              const updateRecurringSchedule = (patch: {
                every?: string;
                unit?: WalletRecurringIntervalUnit;
                time?: string;
              }) =>
                props.onPolicyDraftChange({
                  recurringTransferCron: buildRecurringTransferCron({
                    every: patch.every ?? recurringSchedule.every,
                    unit: patch.unit ?? recurringSchedule.unit,
                    time: patch.time ?? recurringSchedule.time,
                  }),
                });
              return html`
                <div class="wallet-card" title=${wallet.id}>
                  <div class="wallet-card__header">
                    <div class="wallet-card__identity">
	                      <div class="wallet-card__title-row">
	                        <div class="wallet-card__title">${wallet.name}</div>
	                        ${renderWalletBondIcon(wallet.id, props.federationBond, props.onNavigate)}
	                        ${cardRole === "mining" ? renderWalletSweepChip(props.miningProfile) : nothing}
		                        ${renderWalletActivePolicyIcons({
                              walletId: wallet.id,
                              role: cardRole,
                              props,
                            })}
                        ${renderWalletRuntimeStatusIcons({
                          role: cardRole,
                          automationEnabled: cardAutomationEnabled,
                        })}
                      </div>
                      <div class="wallet-card__address-row">
                        ${
                          walletAddress
                            ? html`
                                <span
                                  class="wallet-card__wallet-icon"
                                  title="Wallet address configured"
                                  aria-label="Wallet address configured"
                                >
                                  ${icons.wallet}
                                </span>
                                <span
                                  id=${walletAddressDisplayId}
                                  class="mono wallet-card__address"
                                  data-revealed="false"
                                >
                                  ******
                                </span>
                                <span class="wallet-card__address-actions">
                                  <button
                                    type="button"
                                    class="wallet-icon-btn"
                                    title="Show wallet address"
                                    aria-label="Show wallet address"
                                    @click=${() =>
                                      toggleWalletSecretText(
                                        walletAddressDisplayId,
                                        "******",
                                        walletAddress,
                                      )}
                                  >
                                    <span class="wallet-copy-btn__icon">${icons.eye}</span>
                                  </button>
                                  ${renderCopyButton(walletAddress, "wallet address")}
                                  ${renderExternalLinkButton(
                                    walletExplorerUrl(addressChain, "address", walletAddress),
                                    "Open wallet address",
                                  )}
                                </span>
                              `
                            : html`
                                <span class="muted">No wallet address</span>
                              `
                        }
                        ${renderCopyTextButton({
                          value: `@wallet:${wallet.id}`,
                          display: `@wallet:${wallet.id}`,
                          label: "wallet handle",
                          title:
                            cardRole === "mining"
                              ? "Copy wallet handle. Mining wallets are reserved for SAT mining and SAT sweep."
                              : "Copy wallet handle for approved chat, skill, plugin, or scheduled wallet actions.",
                          className: "mono wallet-card__handle",
                        })}
                        ${
                          walletAddress
                            ? html`
                                <details>
                                  <summary>Receive QR</summary>
                                  <div class="qr-wrap">
                                    <img
                                      src=${`/api/wallet/receive-qr?walletId=${encodeURIComponent(wallet.id)}`}
                                      alt=${`Solana receive QR for ${wallet.name}`}
                                      loading="lazy"
                                    />
                                  </div>
                                </details>
                              `
                            : nothing
                        }
                      </div>
                    </div>
                    <div class="row" style="gap: 8px;">
                      <button
                        class="btn small ${securitySelected ? "primary" : ""}"
                        @click=${() => props.onWalletDetailsWalletChange(wallet.id)}
                      >
                        Policy
                      </button>
                      ${
                        wallet.providerId === "local-socket-signer"
                          ? html`
                              <button
                                class="btn small danger"
                                ?disabled=${props.settingsBusy || !props.onArchiveWallet}
                                title="The server requires Mining runtime obligations to be settled and locks the signer key deny-all. Confirm external balances and recovery before archiving."
                                @click=${() => props.onArchiveWallet?.(wallet.id)}
                              >
                                ${cardRole === "mining" ? "Archive Mining" : "Archive"}
                              </button>
                            `
                          : nothing
                      }
                    </div>
                  </div>
                  <div class="wallet-card__balance-row">
                    <div class="wallet-card__balance-main">
                      ${renderWalletBalancePill(nativeLabel, nativeValue, "neutral", {
                        title: "Solana",
                        onClick: wallet.addresses?.solana
                          ? () =>
                              (
                                props.onWalletBalanceWalletChange ??
                                props.onWalletDetailsWalletChange
                              )(wallet.id)
                          : undefined,
                      })}
                      <button
                        class="btn small primary wallet-card__send-btn"
                        ?disabled=${!canSend || !cardWalletReady}
                        title=${
                          cardWalletReady
                            ? "Send from this wallet"
                            : "Setup incomplete: live signer key, role baseline, or network readiness is not confirmed"
                        }
                        @click=${() => props.onSendModalOpen(wallet.id)}
                      >
                        Send
                      </button>
                    </div>
                    ${
                      wallet.addresses?.solana
                        ? html`
                            <button
                              type="button"
                              class="wallet-balance-link"
                              data-active=${balanceSelected ? "true" : "false"}
                              @click=${() =>
                                (
                                  props.onWalletBalanceWalletChange ??
                                  props.onWalletDetailsWalletChange
                                )(wallet.id)}
                            >
                              <span class="wallet-balance-link__icon">${icons.barChart}</span>
                              <span>Balance</span>
                            </button>
                          `
                        : nothing
                    }
                    ${
                      selectedWalletTokens.length > 0
                        ? html`
                            <div class="wallet-token-details">
                              <div class="wallet-token-list">
                                ${selectedWalletTokens.map(
                                  (asset) => html`
                                    <div class="row" style="gap: 8px; align-items: center;">
                                      <button
                                        class="btn small"
                                        style="display: inline-flex; gap: 8px; align-items: center;"
                                        ?disabled=${!canSend || !cardWalletReady}
                                        @click=${() => props.onSendModalOpen(wallet.id, asset.id)}
                                      >
                                        ${renderWalletAssetLogo(asset, 20)}
                                        <span>${asset.symbol}</span>
                                        <span class="muted"
                                          >${formatRoundedAssetAmountForUi(asset.amountDisplay)}</span
                                        >
                                      </button>
                                      ${
                                        asset.program
                                          ? renderExternalLinkButton(
                                              walletExplorerUrl("solana", "address", asset.program),
                                              `Open ${asset.symbol} mint`,
                                            )
                                          : nothing
                                      }
                                    </div>
                                  `,
                                )}
                              </div>
                            </div>
                          `
                        : balanceSelected && props.balancesLoading
                          ? html`
                              <div class="muted" style="font-size: 0.85em">Loading balance...</div>
                            `
                          : balanceSelected && wallet.addresses?.solana
                            ? html`
                                <div class="muted" style="font-size: 0.85em">Balance loaded. No SPL token balances detected.</div>
                              `
                            : nothing
                    }
                  </div>
                  ${
                    securitySelected
                      ? html`
                          <div id="wallet-security-card" class="wallet-card-security">
                            <div class="wallet-policy-tabs" role="tablist" aria-label="Wallet policy sections">
                              ${policyTabs.map(
                                (tab) => html`
                                  <button
                                    type="button"
                                    class="wallet-policy-tab"
                                    data-active=${activePolicyPanel === tab.id ? "true" : "false"}
                                    title=${tab.title}
                                    role="tab"
                                    aria-selected=${activePolicyPanel === tab.id ? "true" : "false"}
                                    @click=${() => props.onPolicyPanelChange?.(tab.id)}
                                  >
                                    ${tab.label}
                                  </button>
                                `,
                              )}
                            </div>
                            ${
                              wallet.providerId === "local-socket-signer"
                                ? html`
                                    <div
                                      class="callout ${cardNetworkReady ? "success" : "warn"}"
                                      style="margin-top: 10px"
                                      data-testid="wallet-signer-network-status"
                                    >
                                      <strong
                                        >Signer RPC: ${
                                          cardNetworkReady
                                            ? `ready${cardNetworkVersion ? ` · version ${cardNetworkVersion}` : ""}`
                                            : "not ready"
                                        }</strong
                                      >
                                      <div>
                                        Enter one primary RPC. The Go signer verifies its genesis;
                                        ordinary setup never asks for a Solana network or a second
                                        RPC.
                                      </div>
                                      <div class="wallet-card-security__grid" style="margin-top: 8px">
                                        <label class="field">
                                          <span>Replace primary Solana RPC</span>
                                          <input
                                            .value=${props.rpcUrl ?? ""}
                                            placeholder="https://your-solana-rpc.example"
                                            autocomplete="off"
                                            spellcheck="false"
                                            @input=${(event: Event) =>
                                              props.onRpcUrlChange?.(
                                                (event.target as HTMLInputElement).value,
                                              )}
                                          />
                                        </label>
                                        <button
                                          class="btn small"
                                          ?disabled=${
                                            props.settingsBusy ||
                                            !props.rpcUrl?.trim() ||
                                            !props.onSaveWalletRpc
                                          }
                                          @click=${props.onSaveWalletRpc}
                                        >
                                          Verify and save RPC
                                        </button>
                                      </div>
                                    </div>
                                  `
                                : nothing
                            }
                            ${
                              cardSignerPolicy
                                ? html`
                                    <div
                                      class="callout ${cardSignerPolicy.state === "acknowledged" ? "success" : "warn"}"
                                      style="margin-top: 10px"
                                      data-testid="wallet-signer-policy-status"
                                    >
                                      <strong>Native signer policy: ${cardSignerPolicy.state}</strong>
                                      ${
                                        cardSignerPolicy.state === "locked"
                                          ? html`
                                              <div>
                                                This pre-role-baseline wallet remains deny-all. Review its immutable role, then select Activate
                                                role baseline with the native wallet CLI. No root policy helper is required.
                                              </div>
                                            `
                                          : nothing
                                      }
                                      ${
                                        cardSignerPolicy.version && cardSignerPolicy.hash
                                          ? html`
                                              <div>
                                                Version ${cardSignerPolicy.version} ·
                                                <span class="mono" style="overflow-wrap: anywhere"
                                                  >${cardSignerPolicy.hash}</span
                                                >
                                              </div>
                                            `
                                          : nothing
                                      }
                                      ${cardSignerPolicy.guidance ? html`<div>${cardSignerPolicy.guidance}</div>` : nothing}
                                    </div>
                                  `
                                : nothing
                            }
                            ${
                              cardSignerReadiness
                                ? html`
                                    <div
                                      class="callout ${cardSignerReadiness.ready ? "success" : "warn"}"
                                      style="margin-top: 10px"
                                      data-testid="wallet-live-readiness"
                                    >
                                      <strong
                                        >Role readiness:
                                        ${
                                          cardSignerReadiness.ready ? "ready" : "setup incomplete"
                                        }</strong
                                      >
                                      <div>
                                        ${cardSignerReadiness.role} baseline v${cardSignerReadiness.baselineVersion}
                                        · ${cardSignerReadiness.operationLane}
                                      </div>
                                      <div>
                                        Policy v${cardSignerReadiness.policyVersion} · Network
                                        v${cardSignerReadiness.networkVersion}
                                      </div>
                                    </div>
                                  `
                                : nothing
                            }
                            ${
                              cardRole === "vault" && wallet.providerId === "local-socket-signer"
                                ? html`
                                    <div class="callout" style="margin-top: 10px">
                                      <strong>Vault approval device · ${vaultSignerApproval.summary}</strong>
                                      <div>${vaultSignerApproval.detail}</div>
                                      ${
                                        vaultSignerApproval.setupCommand
                                          ? html`<div class="mono" style="overflow-wrap: anywhere">
                                              ${vaultSignerApproval.setupCommand}
                                            </div>`
                                          : nothing
                                      }
                                      <div>
                                        This optional signer-owned device never changes Agent or Mining automation.
                                      </div>
                                    </div>
                                  `
                                : nothing
                            }
                            ${
                              cardRole === "mining"
                                ? activePolicyPanel === "sweep"
                                  ? html`
	                                    <div class="field">
	                                      <div class="wallet-card-security__grid">
	                                        <label class="field">
	                                          <span>Status</span>
	                                          <select
                                            ?disabled=${props.settingsBusy || !props.onMiningSatSweepChange}
                                            @change=${(event: Event) =>
                                              props.onMiningSatSweepChange?.({
                                                enabled:
                                                  (event.currentTarget as HTMLSelectElement)
                                                    .value === "enabled",
                                              })}
                                          >
                                            <option
                                              value="disabled"
                                              ?selected=${!miningSatSweep.enabled}
                                            >
                                              Off
                                            </option>
                                            <option
                                              value="enabled"
                                              ?selected=${miningSatSweep.enabled}
                                            >
                                              On
                                            </option>
                                          </select>
                                        </label>
                                        <label class="field">
                                          <span>Destination</span>
                                          <select
                                            ?disabled=${
                                              props.settingsBusy ||
                                              !miningSatSweep.enabled ||
                                              !props.onMiningSatSweepChange
                                            }
                                            @change=${(event: Event) => {
                                              const value = (
                                                event.currentTarget as HTMLSelectElement
                                              ).value;
                                              props.onMiningSatSweepChange?.(
                                                value === "__external__"
                                                  ? {
                                                      destinationWalletId: undefined,
                                                      destinationAddress:
                                                        miningSatSweep.destinationAddress ?? "",
                                                    }
                                                  : {
                                                      destinationWalletId: value || undefined,
                                                      destinationAddress: undefined,
                                                    },
                                              );
                                            }}
                                          >
                                            <option
                                              value="__external__"
                                              ?selected=${miningSweepDestinationMode === "external"}
                                            >
                                              External
                                            </option>
                                            ${miningSweepDestinationWalletOptions.map(
                                              (targetWallet) => html`
                                                <option
                                                  value=${targetWallet.id}
                                                  ?selected=${
                                                    miningSatSweep.destinationWalletId ===
                                                    targetWallet.id
                                                  }
                                                >
                                                  ${targetWallet.name}
                                                </option>
                                              `,
                                            )}
                                          </select>
                                        </label>
                                        ${
                                          miningSweepDestinationMode === "external"
                                            ? html`
                                                <label class="field">
                                                  <span>Address</span>
                                                  <input
                                                    type="text"
                                                    .value=${miningSatSweep.destinationAddress ?? ""}
                                                    ?disabled=${
                                                      props.settingsBusy ||
                                                      !miningSatSweep.enabled ||
                                                      !props.onMiningSatSweepChange
                                                    }
                                                    @change=${(event: Event) =>
                                                      props.onMiningSatSweepChange?.({
                                                        destinationAddress:
                                                          (
                                                            event.currentTarget as HTMLInputElement
                                                          ).value.trim() || undefined,
                                                        destinationWalletId: undefined,
                                                      })}
                                                    placeholder="Solana address"
                                                  />
                                                </label>
                                              `
                                            : nothing
                                        }
                                        ${
                                          miningSatSweep.mode === "percentage"
                                            ? html`
                                                <label class="field">
                                                  <span>Percent</span>
                                                  <input
                                                    type="number"
                                                    min="1"
                                                    max="100"
                                                    step="1"
                                                    .value=${String(
                                                      miningSatSweep.percentage ?? 100,
                                                    )}
                                                    ?disabled=${
                                                      props.settingsBusy ||
                                                      !miningSatSweep.enabled ||
                                                      !props.onMiningSatSweepChange
                                                    }
                                                    @change=${(event: Event) =>
                                                      props.onMiningSatSweepChange?.({
                                                        percentage: Math.max(
                                                          1,
                                                          Math.min(
                                                            100,
                                                            Number(
                                                              (
                                                                event.currentTarget as HTMLInputElement
                                                              ).value,
                                                            ) || 100,
                                                          ),
                                                        ),
                                                      })}
                                                  />
                                                </label>
                                              `
                                            : nothing
                                        }
                                        <label class="field">
                                          <span>Amount</span>
                                          <select
                                            ?disabled=${
                                              props.settingsBusy ||
                                              !miningSatSweep.enabled ||
                                              !props.onMiningSatSweepChange
                                            }
                                            @change=${(event: Event) =>
                                              props.onMiningSatSweepChange?.({
                                                mode:
                                                  (event.currentTarget as HTMLSelectElement)
                                                    .value === "percentage"
                                                    ? "percentage"
                                                    : "all",
                                              })}
                                          >
                                            <option
                                              value="all"
                                              ?selected=${miningSatSweep.mode !== "percentage"}
                                            >
                                              All
                                            </option>
                                            <option
                                              value="percentage"
                                              ?selected=${miningSatSweep.mode === "percentage"}
                                            >
                                              %
                                            </option>
                                          </select>
                                        </label>
                                        <label class="field">
                                          <span>Minimum SAT</span>
                                          <input
                                            type="text"
                                            inputmode="decimal"
                                            .value=${formatSatInputValue(
                                              miningSatSweep.minRaw ?? "1",
                                            )}
                                            ?disabled=${
                                              props.settingsBusy ||
                                              !miningSatSweep.enabled ||
                                              !props.onMiningSatSweepChange
                                            }
                                            @change=${(event: Event) =>
                                              props.onMiningSatSweepChange?.({
                                                minRaw: parseSatInputToRaw(
                                                  (event.currentTarget as HTMLInputElement).value,
                                                ),
                                              })}
                                            placeholder="1"
                                          />
                                        </label>
                                        <label class="field">
                                          <span>Keep SAT</span>
                                          <input
                                            type="text"
                                            inputmode="decimal"
                                            .value=${formatSatInputValue(
                                              miningSatSweep.keepRaw ?? "0",
                                            )}
                                            ?disabled=${
                                              props.settingsBusy ||
                                              !miningSatSweep.enabled ||
                                              !props.onMiningSatSweepChange
                                            }
                                            @change=${(event: Event) =>
                                              props.onMiningSatSweepChange?.({
                                                keepRaw: parseSatInputToRaw(
                                                  (event.currentTarget as HTMLInputElement).value,
                                                ),
                                              })}
                                            placeholder="0"
                                          />
                                        </label>
                                      </div>
                                    </div>
                                  `
                                  : nothing
                                : html`
                                    ${
                                      settings && activePolicyPanel === "caps"
                                        ? renderWalletCapsPanel({
                                            props,
                                            settings,
                                            policyDisplay,
                                            cardRole,
                                            selectedWalletId: wallet.id,
                                            cardWalletCanSpendSolana,
                                            selectedWalletTokens,
                                            canEditPolicy,
                                          })
                                        : nothing
                                    }
                                    ${
                                      cardRole === "agent" && activePolicyPanel === "schedule"
                                        ? html`
                                            <div class="field">
                                              <div class="wallet-card-security__grid">
                                                <label class="field">
                                                  <span>Status</span>
                                                  <select
                                                    .value=${
                                                      props.recurringTransferEnabled
                                                        ? "enabled"
                                                        : "disabled"
                                                    }
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @change=${(event: Event) =>
                                                      props.onPolicyDraftChange({
                                                        recurringTransferEnabled:
                                                          (event.currentTarget as HTMLSelectElement)
                                                            .value === "enabled",
                                                      })}
                                                  >
                                                    <option value="disabled">Off</option>
                                                    <option value="enabled">On</option>
                                                  </select>
                                                </label>
                                                <label class="field">
                                                  <span>Destination</span>
                                                  <input
                                                    placeholder="@wallet:vault or Solana address"
                                                    .value=${props.recurringTransferDestination}
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @input=${(event: Event) =>
                                                      props.onPolicyDraftChange({
                                                        recurringTransferDestination: (
                                                          event.currentTarget as HTMLInputElement
                                                        ).value,
                                                      })}
                                                  />
                                                </label>
                                                <label class="field">
                                                  <span>Token mint</span>
                                                  <input
                                                    placeholder="Blank for SOL"
                                                    .value=${props.recurringTransferMint}
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @input=${(event: Event) =>
                                                      props.onPolicyDraftChange({
                                                        recurringTransferMint: (
                                                          event.currentTarget as HTMLInputElement
                                                        ).value,
                                                      })}
                                                  />
                                                </label>
                                                ${
                                                  recurringTransferMint
                                                    ? html`
                                                        <label class="field">
                                                          <span>Decimals</span>
                                                          <input
                                                            inputmode="numeric"
                                                            placeholder="6"
                                                            .value=${props.recurringTransferDecimals}
                                                            ?disabled=${props.settingsBusy || !canEditPolicy}
                                                            @input=${(event: Event) =>
                                                              props.onPolicyDraftChange({
                                                                recurringTransferDecimals: (
                                                                  event.currentTarget as HTMLInputElement
                                                                ).value,
                                                              })}
                                                          />
                                                        </label>
                                                      `
                                                    : nothing
                                                }
                                                <label class="field">
                                                  <span>Amount mode</span>
                                                  <select
                                                    .value=${props.recurringTransferAmountMode}
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @change=${(event: Event) =>
                                                      props.onPolicyDraftChange({
                                                        recurringTransferAmountMode:
                                                          (event.currentTarget as HTMLSelectElement)
                                                            .value === "percentage"
                                                            ? "percentage"
                                                            : "fixed",
                                                      })}
                                                  >
                                                    <option value="fixed">Fixed</option>
                                                    <option value="percentage">%</option>
                                                  </select>
                                                </label>
                                                ${
                                                  props.recurringTransferAmountMode === "percentage"
                                                    ? html`
                                                        <label class="field">
                                                          <span>Percent</span>
                                                          <input
                                                            inputmode="numeric"
                                                            placeholder="40"
                                                            .value=${props.recurringTransferPercentage}
                                                            ?disabled=${props.settingsBusy || !canEditPolicy}
                                                            @input=${(event: Event) =>
                                                              props.onPolicyDraftChange({
                                                                recurringTransferPercentage: (
                                                                  event.currentTarget as HTMLInputElement
                                                                ).value,
                                                              })}
                                                          />
                                                        </label>
                                                        <label class="field">
                                                          <span>Minimum</span>
                                                          <input
                                                            placeholder=${`0.01 ${recurringAmountUnit}`}
                                                            .value=${props.recurringTransferMinAmount}
                                                            ?disabled=${props.settingsBusy || !canEditPolicy}
                                                            @input=${(event: Event) =>
                                                              props.onPolicyDraftChange({
                                                                recurringTransferMinAmount: (
                                                                  event.currentTarget as HTMLInputElement
                                                                ).value,
                                                              })}
                                                          />
                                                        </label>
                                                        <label class="field">
                                                          <span>Keep</span>
                                                          <input
                                                            placeholder=${`0 ${recurringAmountUnit}`}
                                                            .value=${props.recurringTransferKeepAmount}
                                                            ?disabled=${props.settingsBusy || !canEditPolicy}
                                                            @input=${(event: Event) =>
                                                              props.onPolicyDraftChange({
                                                                recurringTransferKeepAmount: (
                                                                  event.currentTarget as HTMLInputElement
                                                                ).value,
                                                              })}
                                                          />
                                                        </label>
                                                      `
                                                    : html`
                                                        <label class="field">
                                                          <span>Amount</span>
                                                          <input
                                                            placeholder=${`0.1 ${recurringAmountUnit}`}
                                                            .value=${props.recurringTransferAmount}
                                                            ?disabled=${props.settingsBusy || !canEditPolicy}
                                                            @input=${(event: Event) =>
                                                              props.onPolicyDraftChange({
                                                                recurringTransferAmount: (
                                                                  event.currentTarget as HTMLInputElement
                                                                ).value,
                                                              })}
                                                          />
                                                        </label>
                                                      `
                                                }
                                                <label class="field">
                                                  <span>Every</span>
                                                  <input
                                                    type="number"
                                                    min="1"
                                                    step="1"
                                                    placeholder="1"
                                                    .value=${recurringSchedule.every}
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @input=${(event: Event) =>
                                                      updateRecurringSchedule({
                                                        every: (
                                                          event.currentTarget as HTMLInputElement
                                                        ).value,
                                                      })}
                                                  />
                                                </label>
                                                <label class="field">
                                                  <span>Unit</span>
                                                  <select
                                                    .value=${recurringSchedule.unit}
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @change=${(event: Event) =>
                                                      updateRecurringSchedule({
                                                        unit: (
                                                          event.currentTarget as HTMLSelectElement
                                                        ).value as WalletRecurringIntervalUnit,
                                                      })}
                                                  >
                                                    <option value="minutes">minutes</option>
                                                    <option value="hours">hours</option>
                                                    <option value="days">days</option>
                                                    <option value="months">months</option>
                                                  </select>
                                                </label>
                                                ${
                                                  recurringSchedule.unit === "days" ||
                                                  recurringSchedule.unit === "months"
                                                    ? html`
                                                        <label class="field">
                                                          <span>At</span>
                                                          <input
                                                            type="time"
                                                            .value=${recurringSchedule.time}
                                                            ?disabled=${props.settingsBusy || !canEditPolicy}
                                                            @input=${(event: Event) =>
                                                              updateRecurringSchedule({
                                                                time: (
                                                                  event.currentTarget as HTMLInputElement
                                                                ).value,
                                                              })}
                                                          />
                                                        </label>
                                                      `
                                                    : nothing
                                                }
                                                <label class="field">
                                                  <span>Timezone</span>
                                                  <input
                                                    placeholder="America/Chicago"
                                                    .value=${props.recurringTransferTz}
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @input=${(event: Event) =>
                                                      props.onPolicyDraftChange({
                                                        recurringTransferTz: (
                                                          event.currentTarget as HTMLInputElement
                                                        ).value,
                                                      })}
                                                  />
                                                </label>
                                                <label class="field">
                                                  <span>Name</span>
                                                  <input
                                                    placeholder="Daily transfer"
                                                    .value=${props.recurringTransferName}
                                                    ?disabled=${props.settingsBusy || !canEditPolicy}
                                                    @input=${(event: Event) =>
                                                      props.onPolicyDraftChange({
                                                        recurringTransferName: (
                                                          event.currentTarget as HTMLInputElement
                                                        ).value,
                                                      })}
                                                  />
                                                </label>
                                                <button
                                                  class="btn"
                                                  ?disabled=${props.settingsBusy || !canEditPolicy}
                                                  @click=${props.onSavePolicy}
                                                >
                                                  ${props.settingsBusy ? "Saving..." : "Save"}
                                                </button>
                                              </div>
                                              ${
                                                recurringSchedule.custom
                                                  ? html`
                                                      <div class="wallet-security-note" style="margin-top: 8px">
                                                        Existing custom schedule is preserved until you edit Every, Unit, or At.
                                                      </div>
                                                    `
                                                  : nothing
                                              }
                                            </div>
                                          `
                                        : nothing
                                    }
                                    ${
                                      cardRole === "agent" && activePolicyPanel === "automation"
                                        ? html`
                                              ${(() => {
                                                const autoEnabled =
                                                  props.policyAutoEnabled ??
                                                  settings?.policy.directSigning ??
                                                  true;
                                                return html`
	                                            <div class="field">
	                                              <div class="wallet-spend-limit-row">
	                                                <label class="field">
	                                                  <span>Status</span>
	                                                  <select
	                                                    .value=${autoEnabled ? "enabled" : "disabled"}
	                                                    ?disabled=${props.settingsBusy || !settings || !canEditPolicy}
	                                                    @change=${(event: Event) =>
                                                        props.onPolicyDraftChange({
                                                          directSigning:
                                                            (
                                                              event.currentTarget as HTMLSelectElement
                                                            ).value === "enabled",
                                                        })}
	                                                  >
	                                                    <option value="disabled">Off</option>
	                                                    <option value="enabled">On</option>
	                                                  </select>
	                                                </label>
	                                                <button
	                                                  class="btn"
	                                                  ?disabled=${props.settingsBusy || !settings || !canEditPolicy}
	                                                  @click=${props.onSavePolicy}
	                                                >
	                                                  ${props.settingsBusy ? "Saving..." : "Save"}
	                                                </button>
	                                              </div>
	                                            </div>
                                                  `;
                                              })()}
	                                          `
                                        : nothing
                                    }
                                    ${
                                      cardRole === "agent" && activePolicyPanel === "skills"
                                        ? html`
                                            ${(() => {
                                              const skillsEnabled =
                                                props.policySkillsEnabled ??
                                                settings?.policy.skillsEnabled ??
                                                false;
                                              return html`
                                                <div class="field">
                                                  <div class="wallet-spend-limit-row">
                                                    <label class="field">
                                                      <span>Status</span>
                                                      <select
                                                        .value=${
                                                          skillsEnabled ? "enabled" : "disabled"
                                                        }
                                                        ?disabled=${
                                                          props.settingsBusy ||
                                                          !settings ||
                                                          !canEditPolicy
                                                        }
                                                        @change=${(event: Event) =>
                                                          props.onPolicyDraftChange({
                                                            skillsEnabled:
                                                              (
                                                                event.currentTarget as HTMLSelectElement
                                                              ).value === "enabled",
                                                          })}
                                                      >
                                                        <option value="disabled">Off</option>
                                                        <option value="enabled">On</option>
                                                      </select>
                                                    </label>
                                                    <button
                                                      class="btn"
                                                      ?disabled=${
                                                        props.settingsBusy ||
                                                        !settings ||
                                                        !canEditPolicy
                                                      }
                                                      @click=${props.onSavePolicy}
                                                    >
                                                      ${props.settingsBusy ? "Saving..." : "Save"}
                                                    </button>
                                                  </div>
                                                </div>
                                              `;
                                            })()}
                                          `
                                        : nothing
                                    }
                                  `
                            }
                          </div>
                        `
                      : nothing
                  }
                </div>
              `;
            })}
            ${
              props.namedWallets.length === 0
                ? html`
                    <div class="callout">No wallets configured. Create/import wallets from onboarding or CLI.</div>
                  `
                : nothing
            }
          </div>
        </div>

        <div id="wallet-approvals" class="card wallet-panel">
          <div class="wallet-panel__head">
            <div>
              <div class="card-title wallet-title-with-help">
                <span>Wallet Approvals</span>
                ${renderWalletHelp(
                  "Reviewed sends, Vault actions, and federation signatures appear here. The signer executes only the exact prepared operation; Vault review may require its separately configured approval device.",
                )}
              </div>
			  <div class="card-sub">Pending and recent reviewed wallet operations.</div>
            </div>
            <div class="row" style="gap: 8px; flex-wrap: wrap;">
              ${(
                ["pending", "approved", "executed", "failed", "all"] as WalletApprovalFilter[]
              ).map(
                (filter) => html`
                  <button
                    class="btn small ${props.approvalsFilter === filter ? "primary" : ""}"
                    ?disabled=${props.approvalsLoading}
                    @click=${() => props.onApprovalsFilterChange(filter)}
                  >
                    ${filter}
                  </button>
                `,
              )}
            </div>
          </div>
          ${
            props.approvalsError
              ? html`<div class="callout danger" style="margin-top: 12px;">${props.approvalsError}</div>`
              : nothing
          }
          ${
            props.approvals.length > 0
              ? html`
                  <div class="table wallet-approvals-grid" style="margin-top: 16px;">
                    <div
                      class="table-head"
                      style="align-items: start;"
                    >
                      <div>Request</div>
                      <div>Status</div>
                      <div>Amount</div>
                      <div>Asset</div>
                      <div>From</div>
                      <div>To</div>
                      <div>Created</div>
                      <div>Action</div>
                    </div>
                    ${props.approvals.map((request) => {
                      const approvalDisplay = resolveWalletApprovalDisplay({
                        request,
                        balances: props.balances,
                      });
                      const approvalEndpoints = resolveWalletApprovalEndpoints({
                        request,
                        namedWallets: props.namedWallets,
                      });
                      const routeProgramIds = Array.isArray(request.payload.routeProgramIds)
                        ? request.payload.routeProgramIds
                            .map((programId) => String(programId).trim())
                            .filter(Boolean)
                        : [];
                      return html`
                      <div
                        id=${taskLedgerAnchorId("wallet-approval", request.id)}
                        class="table-row"
                        style="align-items: center;"
                      >
                        <div>
                          <div class="mono" style="font-size: 0.85em;">${request.id}</div>
                          <div class="muted" style="font-size: 0.8em; margin-top: 4px;">
                            expires ${new Date(request.expiresAt).toLocaleString()}
                          </div>
                          ${renderWalletApprovalDiffSummary({
                            request,
                            display: approvalDisplay,
                            endpoints: approvalEndpoints,
                          })}
                          ${renderWalletSignerSemanticIntent(request)}
                        </div>
                        <div>
                          <div class="row" style="gap: 8px; align-items: center;">
                            <span
                              style="width: 16px; height: 16px; display: inline-flex; color: ${request.status === "failed" || request.status === "rejected" || request.status === "expired" ? "rgba(248,113,113,0.95)" : request.status === "executed" || request.status === "approved" ? "rgba(104,211,145,0.95)" : "rgba(96,165,250,0.95)"};"
                            >
                              ${renderWalletApprovalStatusIcon(request.status)}
                            </span>
                            <span style="font-size: 0.9em; font-weight: 600; text-transform: lowercase;">
                              ${request.status}
                            </span>
                          </div>
                        </div>
                        <div>
                          <div>
                            <strong>${approvalDisplay.amountValueText}</strong>
                          </div>
                        </div>
                        <div style="min-width: 0;">
                          ${
                            approvalDisplay.assetPrimaryText || approvalDisplay.program
                              ? html`
                                  <div
                                    class="row"
                                    style="gap: 6px; align-items: center; flex-wrap: nowrap; min-width: 0; overflow: hidden;"
                                  >
                                    ${
                                      approvalDisplay.assetPrimaryText
                                        ? html`
                                            <span
                                              style="font-size: 0.85em; white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis;"
                                            >
                                              ${approvalDisplay.assetPrimaryText}
                                            </span>
                                          `
                                        : nothing
                                    }
                                    ${
                                      approvalDisplay.assetSecondaryText
                                        ? html`
                                            <span
                                              class="muted"
                                              style="font-size: 0.78em; white-space: nowrap; flex-shrink: 0;"
                                            >
                                              ${approvalDisplay.assetSecondaryText}
                                            </span>
                                          `
                                        : nothing
                                    }
                                    ${
                                      approvalDisplay.program
                                        ? html`
                                            ${renderExternalLinkButton(
                                              walletExplorerUrl(
                                                "solana",
                                                "address",
                                                approvalDisplay.program,
                                              ),
                                              `Open ${(approvalDisplay.symbol ?? "token").trim() || "token"} mint`,
                                            )}
                                          `
                                        : nothing
                                    }
                                  </div>
                                `
                              : nothing
                          }
                          ${
                            routeProgramIds.length > 0
                              ? html`
                                  <div class="muted" style="font-size: 0.76em; margin-top: 4px;">
                                    route ${routeProgramIds
                                      .map((programId) => shortenMiddle(programId, 4, 4))
                                      .join(", ")}
                                  </div>
                                `
                              : nothing
                          }
                        </div>
                        <div style="min-width: 0;">
                          ${
                            approvalEndpoints.fromAddress
                              ? html`
                                  <div class="mono" style="font-size: 0.82em;">
                                    ${shortenMiddle(approvalEndpoints.fromAddress)}
                                  </div>
                                `
                              : html`
                                  <div class="muted">—</div>
                                `
                          }
                        </div>
                        <div style="min-width: 0;">
                          ${
                            approvalEndpoints.toAddress
                              ? html`
                                  <div class="mono" style="font-size: 0.82em;">
                                    ${shortenMiddle(approvalEndpoints.toAddress)}
                                  </div>
                                `
                              : html`
                                  <div class="muted">—</div>
                                `
                          }
                        </div>
                        <div style="white-space: nowrap;">
                          <span style="font-size: 0.85em;">${new Date(request.createdAt).toLocaleString()}</span>
                        </div>
                        <div>
                          ${
                            request.status === "pending"
                              ? html`
                                  <span class="row" style="gap: 6px; align-items: center; flex-wrap: nowrap;">
                                    <button
                                      class="btn small primary"
                                      style="padding-left: 12px; padding-right: 12px;"
                                      ?disabled=${props.approvalsBusyId === request.id}
                                      @click=${() => props.onApproveRequest(request.id)}
                                    >
                                      ${props.approvalsBusyId === request.id ? "Working..." : "Approve"}
                                    </button>
                                    <button
                                      class="btn small"
                                      style="padding-left: 12px; padding-right: 12px;"
                                      ?disabled=${props.approvalsBusyId === request.id}
                                      @click=${() => props.onRejectRequest(request.id)}
                                    >
                                      Reject
                                    </button>
                                  </span>
                                `
                              : request.result?.txHash
                                ? html`
                                    <span class="mono muted" style="font-size: 0.8em;">
                                      ${shortenMiddle(request.result.txHash)}
                                    </span>
                                  `
                                : html`
                                    <span class="muted">—</span>
                                  `
                          }
                        </div>
                      </div>
                    `;
                    })}
                  </div>
                `
              : html`
                  <div class="muted" style="margin-top: 12px;">
                    ${
                      props.approvalsLoading
                        ? "Loading wallet approvals..."
                        : props.approvalsFilter === "pending"
                          ? "No pending wallet approvals."
                          : "No wallet approvals for this filter."
                    }
                  </div>
                `
          }
        </div>
            `
        }
    </div>
    ${
      activeMainPanel === "wallets"
        ? html`<div class="card wallet-activity-card" style="grid-column: 1 / -1;">
      <div class="wallet-activity-card__head">
        <div>
          <div class="card-title">Wallet Activity</div>
          <div class="card-sub">Recent send requests and outcomes.</div>
        </div>
        ${
          activityTotal > 0
            ? html`<div class="wallet-status-chip">
                Showing ${activityStart + 1}-${Math.min(
                  activityStart + WALLET_ACTIVITY_PAGE_SIZE,
                  activityTotal,
                )} of ${activityTotal}
              </div>`
            : nothing
        }
      </div>
      ${
        activityTotal > 0
          ? html`
              <div class="wallet-activity-toolbar">
                <div class="wallet-chip-row">
                  <span class="wallet-status-chip">Page ${activityPage} / ${totalActivityPages}</span>
                </div>
                <div class="row" style="gap: 8px; flex-wrap: wrap;">
                  <button
                    class="btn small"
                    ?disabled=${activityPage <= 1}
                    @click=${() => props.onActivityPageChange(activityPage - 1)}
                  >
                    Prev
                  </button>
                  <button
                    class="btn small"
                    ?disabled=${activityPage >= totalActivityPages}
                    @click=${() => props.onActivityPageChange(activityPage + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
              <div class="wallet-activity-list">
                ${activityEntries.map((entry) => {
                  const details = entry.details ?? {};
                  const chain = normalizeWalletChain(details.chain);
                  const tokenMint =
                    chain === "solana" ? readWalletAuditString(details, "program") : "";
                  const amountTxt = resolveWalletActivityAmountText({
                    details,
                    balances: props.balances,
                  });
                  const toTxt = toDisplayText(details.to, "n/a");
                  const hashTxt = toDisplayText(details.txHash || details.txId, "");
                  const reasonTxt = toDisplayText(details.reason, "");
                  const orderIdTxt = toDisplayText(details.orderId, "");
                  const vaultTxt = toDisplayText(details.vaultPubkey, "");
                  const executionProviderTxt = toDisplayText(details.executionProvider, "");
                  const activityTone = walletActivityTone(entry.action);
                  return html`
                    <div class="wallet-activity-item" data-tone=${activityTone}>
                      <div class="wallet-activity-item__head">
                        <div class="wallet-activity-item__title">
                          <span style="color: ${
                            activityTone === "danger"
                              ? "var(--danger)"
                              : activityTone === "success"
                                ? "var(--ok)"
                                : activityTone === "warn"
                                  ? "var(--warn)"
                                  : "var(--muted)"
                          };">${renderWalletAuditActionIcon(entry.action)}</span>
                          <span>${describeWalletAuditEntry(entry)}</span>
                        </div>
                        <div class="wallet-activity-item__time">
                          ${new Date(entry.at).toLocaleString()}
                        </div>
                      </div>
                      <div class="wallet-activity-item__facts">
                        ${
                          tokenMint
                            ? nothing
                            : html`<span class="wallet-status-chip"
                                >${chain ? chainLabel(chain) : "n/a"}</span
                              >`
                        }
                        <span class="wallet-status-chip">${amountTxt}</span>
                        ${
                          executionProviderTxt
                            ? html`<span class="wallet-status-chip">${executionProviderTxt}</span>`
                            : nothing
                        }
                      </div>
                      <div class="wallet-activity-item__rows">
                        ${
                          toTxt !== "n/a"
                            ? renderWalletMetaRow({
                                label: "To",
                                value: shortenMiddle(toTxt, 10, 8),
                                rawValue: toTxt,
                                copyLabel: "destination address",
                                href: walletExplorerUrl(chain, "address", toTxt),
                              })
                            : nothing
                        }
                        ${
                          tokenMint
                            ? renderWalletMetaRow({
                                label: "Mint",
                                value: shortenMiddle(tokenMint, 10, 8),
                                rawValue: tokenMint,
                                copyLabel: "token mint",
                                href: walletExplorerUrl("solana", "address", tokenMint),
                              })
                            : nothing
                        }
                        ${
                          orderIdTxt
                            ? renderWalletMetaRow({
                                label: "Order",
                                value: shortenMiddle(orderIdTxt, 10, 8),
                                rawValue: orderIdTxt,
                                copyLabel: "order id",
                              })
                            : nothing
                        }
                        ${
                          vaultTxt
                            ? renderWalletMetaRow({
                                label: "Vault",
                                value: shortenMiddle(vaultTxt, 10, 8),
                                rawValue: vaultTxt,
                                copyLabel: "vault address",
                                href: walletExplorerUrl("solana", "address", vaultTxt),
                              })
                            : nothing
                        }
                        ${
                          hashTxt
                            ? renderWalletMetaRow({
                                label: "Tx",
                                value: shortenMiddle(hashTxt, 10, 8),
                                rawValue: hashTxt,
                                copyLabel: "transaction hash",
                                href: walletExplorerUrl(chain, "tx", hashTxt),
                              })
                            : reasonTxt
                              ? html`<div class="wallet-meta-row">
                                  <span class="wallet-meta-row__label">Note</span>
                                  <span class="wallet-meta-row__value">${reasonTxt}</span>
                                  <span class="wallet-meta-row__actions"></span>
                                </div>`
                              : nothing
                        }
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 10px">No recent wallet activity.</div>
            `
      }
    </div>
        `
        : nothing
    }
    </section>
  `;
}

function renderSendModal(props: WalletViewProps) {
  if (!props.sendModalVisible) {
    return nothing;
  }

  const canSend = props.status?.capabilities?.canSend ?? true;
  const selectedWallet = props.namedWallets.find(
    (wallet) => wallet.id === props.sendCreateForm.walletId,
  );
  const { selected: selectedAsset, options: assetOptions } = resolveSelectedWalletAsset(
    selectedWallet,
    props,
  );
  const allowedChains = [...new Set(assetOptions.map((asset) => asset.chain))] as Array<"solana">;
  const fallbackChain = selectedAsset?.chain ?? allowedChains[0] ?? props.sendCreateForm.chain;
  const effectiveChain = allowedChains.includes(props.sendCreateForm.chain)
    ? props.sendCreateForm.chain
    : fallbackChain;
  const sourceAddress = resolveWalletSourceAddress(selectedWallet, effectiveChain);
  const activeAsset =
    selectedAsset && selectedAsset.chain === effectiveChain ? selectedAsset : undefined;
  const amountUnitLabel = activeAsset?.symbol || "SOL";
  const sourceWalletLabel = selectedWallet
    ? `${selectedWallet.name} (@wallet:${selectedWallet.id})`
    : "Default wallet";

  return html`
    <div class="modal-overlay" @click=${props.onSendModalClose}>
      <div class="modal-card card" @click=${(e: Event) => e.stopPropagation()}>
        <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <div>
            <div class="card-title" style="margin: 0;">Send Asset</div>
            <div class="muted" style="margin-top: 6px;">
              From ${sourceWalletLabel}
              ${
                sourceAddress
                  ? html`<span class="mono" style="margin-left: 8px;">
                      ${shortenMiddle(sourceAddress, 4, 4)}
                    </span>`
                  : nothing
              }
            </div>
          </div>
          <button class="btn small" @click=${props.onSendModalClose}>Close</button>
        </div>

          <div class="wallet-send-form-grid">
            <div class="wallet-send-column">
              <label class="field wallet-send-field">
                <span>Asset</span>
                <select
                  .value=${activeAsset?.id ?? ""}
                  ?disabled=${props.sendCreateBusy || !canSend || assetOptions.length <= 1}
                  @change=${(event: Event) => {
                    const assetId = (event.target as HTMLSelectElement).value;
                    const asset = assetOptions.find((entry) => entry.id === assetId);
                    props.onSendCreatePatch({
                      assetId,
                      chain: asset?.chain ?? effectiveChain,
                      contract: undefined,
                      program:
                        asset?.chain === "solana" && !asset?.isNative ? asset.program : undefined,
                    });
                  }}
                >
                  ${assetOptions.map(
                    (asset) => html`
                      <option value=${asset.id} ?selected=${asset.id === activeAsset?.id}>
                        ${asset.symbol}${
                          asset.name && asset.name !== asset.symbol ? ` · ${asset.name}` : ""
                        } · ${formatRoundedAssetAmountForUi(asset.amountDisplay)}
                      </option>
                    `,
                  )}
                </select>
              </label>
              <label class="field wallet-send-field">
                <span>Amount (${amountUnitLabel})</span>
                <input
                  placeholder="0.0"
                  .value=${props.sendCreateForm.amount ?? ""}
                  ?disabled=${props.sendCreateBusy || !canSend}
                  @input=${(event: Event) =>
                    props.onSendCreatePatch({
                      amount: (event.target as HTMLInputElement).value,
                    })}
                />
              </label>
            </div>
            <div class="wallet-send-column">
              <label class="field wallet-send-field">
                <span>Destination</span>
                <input
                  placeholder="@wallet:vault or Solana address"
                  .value=${props.sendCreateForm.to ?? ""}
                  ?disabled=${props.sendCreateBusy || !canSend}
                  @input=${(event: Event) =>
                    props.onSendCreatePatch({
                      to: (event.target as HTMLInputElement).value,
                    })}
                />
              </label>
              <div class="field wallet-send-field">
                <span>Advanced</span>
                <details class="wallet-send-advanced-field">
                  <summary class="muted">Memo / Program</summary>
                  <div class="wallet-send-advanced-grid">
                    ${
                      !activeAsset?.program
                        ? html`
                              <label class="field">
                                <span>SPL Mint (optional)</span>
                                <input
                                  placeholder="Mint address"
                                  .value=${props.sendCreateForm.program ?? ""}
                                  ?disabled=${props.sendCreateBusy || !canSend}
                                  @input=${(event: Event) =>
                                    props.onSendCreatePatch({
                                      program:
                                        (event.target as HTMLInputElement).value || undefined,
                                    })}
                                />
                              </label>
                            `
                        : nothing
                    }
                    <label class="field">
                      <span>Memo (optional)</span>
                      <input
                        placeholder="Transaction reference"
                        .value=${props.sendCreateForm.memo ?? ""}
                        ?disabled=${props.sendCreateBusy || !canSend}
                        @input=${(event: Event) =>
                          props.onSendCreatePatch({
                            memo: (event.target as HTMLInputElement).value || undefined,
                          })}
                      />
                    </label>
                  </div>
                </details>
              </div>
            </div>
        </div>

        <div class="row" style="margin-top: 24px; justify-content: flex-end; gap: 12px;">
          <button class="btn" ?disabled=${props.sendCreateBusy} @click=${props.onSendModalClose}>Cancel</button>
          <button class="btn primary" style="min-width: 120px;" ?disabled=${props.sendCreateBusy || !canSend} @click=${props.onCreateSendRequest}>
            ${props.sendCreateBusy ? "Submitting..." : "Create Approval Request"}
          </button>
        </div>
        ${
          props.sendCreateError
            ? html`<div class="callout danger" style="margin-top: 16px;">${props.sendCreateError}</div>`
            : nothing
        }
      </div>
    </div>

    <style>
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(8px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        animation: fadeIn 0.2s ease-out;
      }
      .modal-card {
        width: 100%;
        max-width: 560px;
        background: #0f1929;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 32px 64px rgba(0, 0, 0, 0.6);
        transform: translateY(0);
        animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .wallet-send-form-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 14px;
      }
      .wallet-send-column {
        display: contents;
      }
      .wallet-send-field {
        min-width: 0;
      }
      .wallet-send-field select,
      .wallet-send-field input {
        width: 100%;
        min-height: 42px;
        box-sizing: border-box;
      }
      .wallet-send-advanced-field {
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        padding: 9px 12px;
        min-height: 42px;
        box-sizing: border-box;
      }
      .wallet-send-advanced-field summary {
        cursor: pointer;
        min-height: 22px;
        line-height: 22px;
      }
      .wallet-send-advanced-grid {
        display: grid;
        gap: 12px;
        margin-top: 12px;
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    </style>
  `;
}
