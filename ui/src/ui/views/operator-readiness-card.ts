import { html, nothing } from "lit";
import {
  describeOperatorReadinessChecklist,
  type OperatorReadinessChecklistItem,
} from "../../../../src/operator/operator-readiness.js";
import type { FederationStatus, FederationToken } from "../federation-api.js";
import type { SatMinerProfile, SatMiningReadiness, SatMiningRuntimeStatus } from "../mining-api.js";
import type { WalletStatus } from "../wallet-api.js";

export type OperatorReadinessContext = {
  status: FederationStatus | null;
  token: FederationToken | null;
  managedMode: boolean;
  walletStatus: WalletStatus | null;
  walletNamedWallets: Array<{
    id: string;
    name: string;
    providerId: "embedded-keystore" | "local-socket-signer" | "alchemy" | "turnkey" | "privy";
    addresses?: { solana?: string };
    balances?: { solana?: string };
    readiness?: {
      keystore: boolean;
      rpc: boolean;
      api?: boolean;
      ata?: boolean;
    };
  }>;
  defaultWalletId: string | null;
  miningAttachedWalletId: string | null;
  miningProfile: SatMinerProfile | null;
  miningReadiness: SatMiningReadiness | null;
  miningStatus: SatMiningRuntimeStatus | null;
};

export type OperatorReadinessItem = OperatorReadinessChecklistItem & {
  actionLabel?: string;
  actionKey?: "admin" | "payment" | "mining" | "federation-review";
};

export type OperatorReadinessCardProps = OperatorReadinessContext & {
  title: string;
  subtitle: string;
  intro: string;
  onOpenAdminControl?: () => void;
  onOpenTaskPayment?: () => void;
  onOpenMining?: () => void;
  onOpenFederationReview?: () => void;
};

export function describeOperatorReadiness(
  props: OperatorReadinessContext,
): OperatorReadinessItem[] {
  const managedToken = props.status?.token ?? null;
  const activeToken = props.managedMode ? managedToken : props.token;
  const activeTrustState = activeToken?.trustState ?? "pending";
  const activeHostedState = activeToken?.hostedState ?? "disabled";
  const activePublicUrl = String(activeToken?.publicUrl ?? "").trim();
  const joined = props.managedMode
    ? props.status?.joined === true && Boolean(managedToken)
    : Boolean(props.token);
  const miningWalletId =
    String(
      props.miningAttachedWalletId ||
        props.miningProfile?.walletId ||
        props.miningStatus?.walletId ||
        props.miningReadiness?.selectedWalletId ||
        "",
    ).trim() || null;
  return describeOperatorReadinessChecklist({
    walletStatus: props.walletStatus
      ? {
          approvalAuth: {
            mode: props.walletStatus.approvalAuth?.mode,
            ready: props.walletStatus.approvalAuth?.ready,
            passkeyCount: props.walletStatus.approvalAuth?.passkeyCount,
          },
        }
      : null,
    walletNamedWallets: props.walletNamedWallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.name,
    })),
    defaultWalletId: props.defaultWalletId,
    miningAttachedWalletId: miningWalletId,
    joined,
    trustState: activeTrustState,
    hostedState: activeHostedState,
    publicUrl: activePublicUrl,
  }).map((item) => ({
    ...item,
    actionLabel:
      item.title === "Wallet Control Passkey ready"
        ? "Open Wallet Access"
        : item.title === "Agent wallet set"
          ? "Set Agent"
          : item.title === "Mining wallet separate"
            ? "Open Mining"
            : item.title === "Fased Network joined / trusted"
              ? "Open Fased Network review"
              : undefined,
    actionKey:
      item.title === "Wallet Control Passkey ready"
        ? "admin"
        : item.title === "Agent wallet set"
          ? "payment"
          : item.title === "Mining wallet separate"
            ? "mining"
            : item.title === "Fased Network joined / trusted"
              ? "federation-review"
              : undefined,
  }));
}

function resolveReadinessAction(
  props: OperatorReadinessCardProps,
  item: OperatorReadinessItem,
): (() => void) | null {
  switch (item.actionKey) {
    case "admin":
      return props.onOpenAdminControl ?? null;
    case "payment":
      return props.onOpenTaskPayment ?? null;
    case "mining":
      return props.onOpenMining ?? null;
    case "federation-review":
      return props.onOpenFederationReview ?? null;
    default:
      return null;
  }
}

export function renderOperatorReadinessCard(props: OperatorReadinessCardProps) {
  const readinessItems = describeOperatorReadiness(props);
  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">${props.title}</div>
      <div class="card-sub">${props.subtitle}</div>
      <div class="callout" style="margin-top: 12px;">${props.intro}</div>
      <div
        style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 16px;"
      >
        ${readinessItems.map((item) => {
          const action = resolveReadinessAction(props, item);
          return html`
            <div
              class="card"
              style="margin: 0; border-color: ${
                item.tone === "success"
                  ? "rgba(62, 180, 137, 0.45)"
                  : item.tone === "warn"
                    ? "rgba(232, 186, 82, 0.45)"
                    : "rgba(255,255,255,0.12)"
              };"
            >
              <div class="row" style="justify-content: space-between; align-items: baseline;">
                <strong>${item.title}</strong>
                <span class="pill ${item.tone === "warn" ? "danger" : item.tone === "success" ? "success" : ""}">
                  ${item.summary}
                </span>
              </div>
              <div class="muted" style="margin-top: 10px;">${item.detail}</div>
              ${
                item.actionLabel && action
                  ? html`<div style="margin-top: 12px;">
                      <button class="btn small" @click=${action}>${item.actionLabel}</button>
                    </div>`
                  : nothing
              }
            </div>
          `;
        })}
      </div>
    </section>
  `;
}
