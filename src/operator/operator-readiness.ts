import type { FederationHostedState, FederationTrustState } from "../federation/access-token.js";

export type OperatorReadinessTone = "success" | "warn" | "neutral";

export type OperatorReadinessChecklistItem = {
  title: string;
  summary: string;
  detail: string;
  tone: OperatorReadinessTone;
};

export type OperatorReadinessInput = {
  walletStatus?: {
    approvalAuth?: {
      mode?: "none" | "webauthn";
      ready?: boolean;
      passkeyCount?: number;
    };
  } | null;
  walletNamedWallets?: Array<{
    id: string;
    name: string;
    metadata?: Record<string, unknown>;
  }>;
  defaultWalletId?: string | null;
  miningAttachedWalletId?: string | null;
  federationBondWalletId?: string | null;
  joined?: boolean;
  trustState?: FederationTrustState | null;
  hostedState?: FederationHostedState | null;
  publicUrl?: string | null;
};

function findNamedWallet(
  wallets: OperatorReadinessInput["walletNamedWallets"],
  walletId: string | null | undefined,
) {
  const normalized = String(walletId ?? "").trim();
  if (!normalized) {
    return undefined;
  }
  return (wallets ?? []).find((wallet) => wallet.id === normalized);
}

function resolveWalletRole(
  wallet: NonNullable<OperatorReadinessInput["walletNamedWallets"]>[number] | undefined,
): "agent" | "vault" | "mining" | undefined {
  const raw =
    typeof wallet?.metadata?.purpose === "string"
      ? wallet.metadata.purpose
      : typeof wallet?.metadata?.role === "string"
        ? wallet.metadata.role
        : "";
  const normalized = raw.trim().toLowerCase();
  return normalized === "agent" || normalized === "vault" || normalized === "mining"
    ? normalized
    : undefined;
}

export function describeOperatorReadinessChecklist(
  input: OperatorReadinessInput,
): OperatorReadinessChecklistItem[] {
  const passkeyCount = input.walletStatus?.approvalAuth?.passkeyCount ?? 0;
  const approvalMode = input.walletStatus?.approvalAuth?.mode ?? "none";
  const approvalReady = input.walletStatus?.approvalAuth?.ready ?? false;
  const defaultWalletId = String(input.defaultWalletId ?? "").trim() || null;
  const defaultWalletCandidate = findNamedWallet(input.walletNamedWallets, defaultWalletId);
  const defaultWallet =
    defaultWalletCandidate && resolveWalletRole(defaultWalletCandidate) !== "vault"
      ? defaultWalletCandidate
      : undefined;
  const firstAgentWallet = (input.walletNamedWallets ?? []).find(
    (wallet) => resolveWalletRole(wallet) === "agent",
  );
  const agentWallet = defaultWallet ?? firstAgentWallet;
  const miningWalletId = String(input.miningAttachedWalletId ?? "").trim() || null;
  const miningWallet = findNamedWallet(input.walletNamedWallets, miningWalletId);
  const bondWalletId = String(input.federationBondWalletId ?? "").trim() || null;
  const explicitBondWallet = findNamedWallet(input.walletNamedWallets, bondWalletId);
  const vaultWallet =
    explicitBondWallet ??
    (input.walletNamedWallets ?? []).find(
      (wallet) => resolveWalletRole(wallet) === "vault" && wallet.id !== miningWalletId,
    );
  const joined = input.joined === true;
  const trustState = input.trustState ?? "pending";
  const hostedState = input.hostedState ?? "disabled";
  const publicUrl = String(input.publicUrl ?? "").trim();
  const miningSeparate =
    Boolean(miningWalletId) &&
    Boolean(agentWallet) &&
    String(agentWallet?.id ?? "").trim() !== miningWalletId;
  const sharedWalletWarning =
    agentWallet && miningWallet && agentWallet.id === miningWallet.id
      ? "Agent and Mining wallets must stay separate. They currently share one wallet, so switch the Agent wallet or reattach Mining to another wallet first."
      : null;

  return [
    input.walletStatus
      ? approvalMode === "webauthn" && approvalReady
        ? {
            title: "Wallet Control Passkey ready",
            summary:
              passkeyCount > 0
                ? `Passkey approval ready (${passkeyCount})`
                : "Passkey approval ready",
            detail:
              "Use this passkey for send approvals, policy changes, wallet security setup, unlock, recovery, and device changes.",
            tone: "success" as const,
          }
        : approvalMode === "webauthn"
          ? {
              title: "Wallet Control Passkey ready",
              summary: "Passkey setup incomplete",
              detail:
                "Control operations are available, but finish passkey approval before trusting higher-risk wallet automation.",
              tone: "warn" as const,
            }
          : {
              title: "Wallet Control Passkey ready",
              summary: "Optional, not enrolled",
              detail:
                "Wallet approvals work from the signed-in Control UI. Enroll a passkey only if you want an additional approval step.",
              tone: "neutral" as const,
            }
      : {
          title: "Wallet Control Passkey ready",
          summary: "Wallet control state unavailable",
          detail: "Refresh the wallet surface before changing operator roles.",
          tone: "neutral" as const,
        },
    agentWallet
      ? {
          title: "Agent wallet set",
          summary:
            defaultWallet && firstAgentWallet && defaultWallet.id !== firstAgentWallet.id
              ? `${defaultWallet.name} · ${firstAgentWallet.name}`
              : agentWallet.name,
          detail: defaultWallet
            ? "This Default Agent wallet is the final fallback for paid A2A sends, payment evidence publication, skill/plugin wallet actions, and routine transfers after explicit, skill, and Agent assignment routing."
            : "This Agent wallet can be selected explicitly or assigned to an Agent or skill. Set it as the optional fallback only when global fallback behavior is wanted.",
          tone: "success" as const,
        }
      : defaultWalletId
        ? {
            title: "Agent wallet set",
            summary: defaultWalletId,
            detail:
              "An Agent wallet is configured but not present in this wallet list right now. Refresh or repair the registry before paid Fased Network or skill wallet work.",
            tone: "warn" as const,
          }
        : {
            title: "Agent wallet set",
            summary: "Not set",
            detail:
              "Pick one Agent wallet before paid Fased Network tasks, receipts, skill wallet actions, or routine sends use a clear wallet.",
            tone: "warn" as const,
          },
    !miningWalletId
      ? {
          title: "Mining wallet separate",
          summary: "Optional and not configured",
          detail:
            "Mining is optional. If you enable it later, create or import the singleton @wallet:mining wallet.",
          tone: "neutral" as const,
        }
      : sharedWalletWarning
        ? {
            title: "Mining wallet separate",
            summary: "Conflict",
            detail: sharedWalletWarning,
            tone: "warn" as const,
          }
        : miningWallet
          ? {
              title: "Mining wallet separate",
              summary: miningSeparate ? miningWallet.name : "Attached",
              detail: miningSeparate
                ? "Mining is attached to a dedicated wallet, separate from the Agent wallet."
                : "Mining wallet is present but could not be compared against the Agent wallet yet.",
              tone: miningSeparate ? ("success" as const) : ("neutral" as const),
            }
          : {
              title: "Mining wallet separate",
              summary: miningWalletId,
              detail:
                "SAT runtime points at a wallet id that is not visible in the current wallet list. Refresh mining and wallet state before changing roles.",
              tone: "warn" as const,
            },
    vaultWallet
      ? {
          title: "Vault wallet present",
          summary: vaultWallet.name,
          detail:
            "Use this as the manual-first destination for longer-term SAT/SOL storage and mining sweeps.",
          tone: "success" as const,
        }
      : {
          title: "Vault wallet present",
          summary: "Not set",
          detail:
            "Create or reserve a wallet that is not Agent or SAT Mining if you want a manual-first vault destination.",
          tone: "neutral" as const,
        },
    !joined
      ? {
          title: "Fased Network joined / trusted",
          summary: "Not joined",
          detail:
            "Register a handle and attest this node before expecting Fased Network trust or remote task routing.",
          tone: "warn" as const,
        }
      : trustState === "verified"
        ? {
            title: "Fased Network joined / trusted",
            summary: "Verified",
            detail: "This node is joined and currently trusted for normal Fased Network routing.",
            tone: "success" as const,
          }
        : {
            title: "Fased Network joined / trusted",
            summary: trustState,
            detail:
              trustState === "pending"
                ? "This node is joined, but Fased Network currently holds it in a manual or policy pending state."
                : "This node is joined, but its trust state limits or blocks Fased Network use.",
            tone: "warn" as const,
          },
    hostedState === "ready" && publicUrl
      ? {
          title: "Fased Network reachability state",
          summary: "Ready",
          detail: `Public URL is issued: ${publicUrl}`,
          tone: "success" as const,
        }
      : hostedState === "pending"
        ? {
            title: "Fased Network reachability state",
            summary: "Pending",
            detail:
              "Hosted token state is present, but the public URL or hosted issuance is still pending.",
            tone: "warn" as const,
          }
        : {
            title: "Fased Network reachability state",
            summary: hostedState === "missing" ? "Missing" : "Disabled",
            detail:
              hostedState === "missing"
                ? "Fased Network reachability expects credentials or issued state, but they are missing on this node."
                : "Fased Network reachability is optional and currently not enabled on this node.",
            tone: hostedState === "missing" ? ("warn" as const) : ("neutral" as const),
          },
  ];
}
