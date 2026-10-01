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

export function describeOperatorReadinessChecklist(
  input: OperatorReadinessInput,
): OperatorReadinessChecklistItem[] {
  const passkeyCount = input.walletStatus?.approvalAuth?.passkeyCount ?? 0;
  const approvalMode = input.walletStatus?.approvalAuth?.mode ?? "none";
  const approvalReady = input.walletStatus?.approvalAuth?.ready ?? false;
  const defaultWalletId = String(input.defaultWalletId ?? "").trim() || null;
  const defaultWallet = findNamedWallet(input.walletNamedWallets, defaultWalletId);
  const agentWallet = defaultWallet ?? input.walletNamedWallets?.[0];
  const joined = input.joined === true;
  const trustState = input.trustState ?? "pending";
  const hostedState = input.hostedState ?? "disabled";
  const publicUrl = String(input.publicUrl ?? "").trim();

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
          title: "Wallet available",
          summary: agentWallet.name,
          detail: defaultWallet
            ? "This Default Agent wallet is the final fallback for paid A2A sends, payment evidence publication, skill/plugin wallet actions, and routine transfers after explicit, skill, and Agent assignment routing."
            : "This Agent wallet can be selected explicitly or assigned to an Agent or skill. Set it as the optional fallback only when global fallback behavior is wanted.",
          tone: "success" as const,
        }
      : defaultWalletId
        ? {
            title: "Wallet available",
            summary: defaultWalletId,
            detail:
              "An Agent wallet is configured but not present in this wallet list right now. Refresh or repair the registry before paid Fased Network or skill wallet work.",
            tone: "warn" as const,
          }
        : {
            title: "Wallet available",
            summary: "Not set",
            detail:
              "Pick one Agent wallet before paid Fased Network tasks, receipts, skill wallet actions, or routine sends use a clear wallet.",
            tone: "warn" as const,
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
