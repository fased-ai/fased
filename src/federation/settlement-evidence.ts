import { loadPersistedFederationToken } from "./access-token.js";
import { normalizeHandle, resolveFederationBaseUrl } from "./runtime.js";

export type FederationSettlementEvidencePublishParams = {
  taskId?: string;
  invoiceId: string;
  senderHandle?: string;
  txRef: string;
  chain: string;
  asset?: {
    kind: "native" | "spl-token";
    address?: string;
  };
  amount: string;
  payeeAddress: string;
  providerId?: string;
  walletId?: string;
  walletName?: string;
  env?: NodeJS.ProcessEnv;
};

export type FederationSettlementEvidencePublishResult =
  | { ok: true; entry?: Record<string, unknown> }
  | { ok: false; code: string; message: string; status?: number };

function describeFailureReason(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (value == null) {
    return "unknown federation publish failure";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "unknown federation publish failure";
    }
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol") {
    return value.description ?? "unknown federation publish failure";
  }
  return "unknown federation publish failure";
}

export async function publishFederationSettlementEvidence(
  params: FederationSettlementEvidencePublishParams,
): Promise<FederationSettlementEvidencePublishResult> {
  const env = params.env ?? process.env;
  const baseUrl = resolveFederationBaseUrl(env);
  if (!baseUrl) {
    return {
      ok: false,
      code: "federation_not_configured",
      message: "federation base URL not configured",
    };
  }
  const token = await loadPersistedFederationToken(env);
  if (!token?.tokenId) {
    return {
      ok: false,
      code: "federation_token_missing",
      message: "federation access token missing",
    };
  }
  const expiresAtMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return {
      ok: false,
      code: "federation_token_expired",
      message: "federation access token expired",
    };
  }

  const invoiceId = params.invoiceId.trim();
  const txRef = params.txRef.trim();
  const chain = params.chain.trim().toLowerCase();
  const assetKind = params.asset?.kind;
  const assetAddress = params.asset?.address?.trim();
  const amount = params.amount.trim();
  const payeeAddress = params.payeeAddress.trim();
  if (!invoiceId || !txRef || !chain || !amount || !payeeAddress) {
    return {
      ok: false,
      code: "settlement_evidence_invalid",
      message: "invoiceId, txRef, chain, amount, and payeeAddress are required",
    };
  }
  if (assetKind && assetKind !== "native" && assetKind !== "spl-token") {
    return {
      ok: false,
      code: "settlement_evidence_invalid",
      message: "asset.kind must be native or spl-token",
    };
  }
  if (assetKind === "spl-token" && !assetAddress) {
    return {
      ok: false,
      code: "settlement_evidence_invalid",
      message: "token settlement evidence requires asset.address",
    };
  }

  if (params.senderHandle?.trim()) {
    const domain = new URL(baseUrl).hostname;
    const normalizedSenderHandle = normalizeHandle(params.senderHandle, domain);
    if (normalizedSenderHandle && normalizedSenderHandle !== token.handle) {
      return {
        ok: false,
        code: "federation_handle_mismatch",
        message: "sender handle does not match persisted federation token",
      };
    }
  }

  const response = await fetch(new URL("/api/federation/settlements", baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.tokenId}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      taskId: params.taskId?.trim() || undefined,
      invoiceId,
      txRef,
      chain,
      asset: assetKind
        ? {
            kind: assetKind,
            address: assetKind === "native" ? undefined : assetAddress,
          }
        : undefined,
      amount,
      payee: {
        chain,
        address: payeeAddress,
      },
      providerId: params.providerId?.trim() || undefined,
      walletId: params.walletId?.trim() || undefined,
      walletName: params.walletName?.trim() || undefined,
      status: "executed",
    }),
  });

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const failureReason =
      parsed?.reason ?? parsed?.status ?? response.statusText ?? "publish failed";
    return {
      ok: false,
      code: "federation_publish_failed",
      message: describeFailureReason(failureReason),
      status: response.status,
    };
  }
  if (parsed?.status === "rejected") {
    return {
      ok: false,
      code: "federation_publish_rejected",
      message: describeFailureReason(parsed.reason ?? "settlement evidence rejected"),
      status: response.status,
    };
  }
  return {
    ok: true,
    entry:
      parsed && typeof parsed.entry === "object" && parsed.entry !== null
        ? (parsed.entry as Record<string, unknown>)
        : undefined,
  };
}
