export type FederationDirectoryEntry = {
  handle: string;
  status: "pending" | "unverified" | "verified" | "revoked" | "blocked";
  version: string;
  endpoint?: string;
  lastSeenAt?: string;
};

export type FederationHandleEntry = {
  handle: string;
  nodeEndpoint: string;
  status: "active" | "revoked";
};

export type FederationToken = {
  tokenId: string;
  nodeId: string;
  handle: string;
  issuedAt: string;
  expiresAt: string;
  scopes: string[];
  signature: string;
  trustState?: "pending" | "verified" | "revoked" | "blocked";
  hostedState?: "disabled" | "pending" | "ready" | "missing";
  agentSlug?: string;
  publicUrl?: string;
  zrokTokenPresent?: boolean;
  lastAttestOrRenewAt?: string;
  paidFlowEligible?: boolean;
};

export type FederationStatus = {
  managed: boolean;
  sourcePath: string;
  joined: boolean;
  lifecycle: "active" | "expired" | "missing" | "invalid";
  checkedAt: string;
  configured?: {
    autoConnect: boolean;
    baseUrl?: string;
    handle?: string;
    nodeEndpoint?: string;
  };
  token?: FederationToken;
};

export type FederationStatusResponse = {
  ok: true;
  status: FederationStatus;
};

export type RegisterHandleRequest = {
  requestedHandle: string;
  nodeEndpoint: string;
};

export type RegisterHandleResponse = {
  status: "accepted" | "rejected";
  handle?: string;
  reason?: string;
};

export type AttestationRequest = {
  handle: string;
};

export type FederationEnrollChallengeRequest = {
  handle: string;
  nodeEndpoint?: string;
};

export type FederationEnrollChallengeResult = {
  status?: "accepted" | "rejected";
  challengeId?: string;
  nonce?: string;
  reason?: string;
};

export type FederationEnrollRequest = {
  challengeId: string;
  nonce: string;
  handle: string;
};

export type AttestationResult = {
  status: "accepted" | "rejected";
  reason?: string;
  token?: FederationToken;
};

export type TokenRevokeRequest = {
  tokenId?: string;
  handle?: string;
};

export type TokenRevokeResult = {
  status: "revoked" | "rejected";
  reason?: string;
};

function resolveBaseUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const injected = (window as typeof window & { __FASED_FEDERATION_BASE_URL__?: string })
    .__FASED_FEDERATION_BASE_URL__;
  if (injected && injected.trim()) {
    return injected.trim();
  }
  return "";
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    const trimmed = text.trim();
    const upstreamHost = trimmed
      .match(
        /id="cf-host-status"[\s\S]*?<span[^>]*class="md:block w-full truncate"[^>]*>([^<]+)<\/span>/i,
      )?.[1]
      ?.trim();
    if (/<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
      const statusLabel = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
      throw new Error(
        upstreamHost
          ? `${statusLabel} from ${upstreamHost}`
          : `${statusLabel} from federation upstream`,
      );
    }
    throw new Error(trimmed || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export type FederationApi = {
  registerHandle: (input: RegisterHandleRequest) => Promise<RegisterHandleResponse>;
  getHandle: (handle: string) => Promise<FederationHandleEntry | null>;
  getStatus: () => Promise<FederationStatusResponse>;
  enrollChallenge: (
    input: FederationEnrollChallengeRequest,
  ) => Promise<FederationEnrollChallengeResult>;
  enroll: (input: FederationEnrollRequest) => Promise<AttestationResult>;
  attest: (input: AttestationRequest) => Promise<AttestationResult>;
  renew: (input: AttestationRequest) => Promise<AttestationResult>;
  revoke: (input: TokenRevokeRequest) => Promise<TokenRevokeResult>;
  listDirectory: (
    status?: FederationDirectoryEntry["status"],
  ) => Promise<FederationDirectoryEntry[]>;
};
export function createFederationApi(): FederationApi {
  const baseUrl = resolveBaseUrl();
  return {
    async registerHandle(payload) {
      return await fetchJson<RegisterHandleResponse>(`${baseUrl}/api/federation/registry/handles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async getHandle(handle) {
      return await fetchJson<FederationHandleEntry | null>(
        `${baseUrl}/api/federation/registry/handles/${encodeURIComponent(handle)}`,
      );
    },
    async getStatus() {
      return await fetchJson<FederationStatusResponse>(`${baseUrl}/api/federation/status`, {
        cache: "no-store",
      });
    },
    async enrollChallenge(payload) {
      return await fetchJson<FederationEnrollChallengeResult>(
        `${baseUrl}/api/federation/admission/challenge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    },
    async enroll(payload) {
      return await fetchJson<AttestationResult>(`${baseUrl}/api/federation/admission/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async attest(payload) {
      return await fetchJson<AttestationResult>(`${baseUrl}/api/federation/admission/attest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async renew(payload) {
      return await fetchJson<AttestationResult>(`${baseUrl}/api/federation/admission/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async revoke(payload) {
      return await fetchJson<TokenRevokeResult>(`${baseUrl}/api/federation/admission/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async listDirectory(status) {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
      const data = await fetchJson<{ entries: FederationDirectoryEntry[] }>(
        `${baseUrl}/api/federation/directory${suffix}`,
      );
      return data.entries ?? [];
    },
  };
}
