import type { FasedAgentConfig } from "../config/config.js";
import {
  type AuthProfileCredential,
  type AuthProfileStore,
  resolveAuthProfileDisplayLabel,
} from "./auth-profiles.js";
import { normalizeProviderId } from "./model-selection.js";

export type AuthProfileSource = "store";

export type AuthProfileHealthStatus =
  | "ok"
  | "expiring"
  | "refresh-required"
  | "expired"
  | "missing"
  | "static";

export type AuthProfileHealth = {
  profileId: string;
  provider: string;
  type: "oauth" | "token" | "api_key";
  status: AuthProfileHealthStatus;
  reasonCode?: "invalid_expires" | "missing_token";
  expiresAt?: number;
  remainingMs?: number;
  source: AuthProfileSource;
  label: string;
};

export type AuthProviderHealthStatus = AuthProfileHealthStatus;

export type AuthProviderHealth = {
  provider: string;
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
  profiles: AuthProfileHealth[];
};

export type AuthHealthSummary = {
  now: number;
  warnAfterMs: number;
  profiles: AuthProfileHealth[];
  providers: AuthProviderHealth[];
};

export const DEFAULT_OAUTH_WARN_MS = 24 * 60 * 60 * 1000;

export function resolveAuthProfileSource(_profileId: string): AuthProfileSource {
  return "store";
}

export function formatRemainingShort(
  remainingMs?: number,
  opts?: {
    underMinuteLabel?: string;
  },
): string {
  if (remainingMs === undefined || Number.isNaN(remainingMs)) {
    return "unknown";
  }
  if (remainingMs <= 0) {
    return "0m";
  }
  const roundedMinutes = Math.round(remainingMs / 60_000);
  if (roundedMinutes < 1) {
    return opts?.underMinuteLabel ?? "1m";
  }
  const minutes = roundedMinutes;
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function resolveOAuthStatus(
  expiresAt: number | undefined,
  now: number,
  warnAfterMs: number,
): { status: AuthProfileHealthStatus; remainingMs?: number } {
  if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return { status: "missing" };
  }
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) {
    return { status: "expired", remainingMs };
  }
  if (remainingMs <= warnAfterMs) {
    return { status: "expiring", remainingMs };
  }
  return { status: "ok", remainingMs };
}

function buildProfileHealth(params: {
  profileId: string;
  credential: AuthProfileCredential;
  store: AuthProfileStore;
  cfg?: FasedAgentConfig;
  now: number;
  warnAfterMs: number;
}): AuthProfileHealth {
  const { profileId, credential, store, cfg, now, warnAfterMs } = params;
  const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
  const source = resolveAuthProfileSource(profileId);
  const provider = normalizeProviderId(credential.provider);

  if (credential.type === "api_key") {
    return {
      profileId,
      provider,
      type: "api_key",
      status: "static",
      source,
      label,
    };
  }

  if (credential.type === "token") {
    if (!credential.token?.trim() && !credential.tokenRef) {
      return {
        profileId,
        provider,
        type: "token",
        status: "missing",
        reasonCode: "missing_token",
        source,
        label,
      };
    }
    const hasExplicitExpires = Object.prototype.hasOwnProperty.call(credential, "expires");
    const expiresAt =
      typeof credential.expires === "number" && Number.isFinite(credential.expires)
        ? credential.expires
        : undefined;
    if (!expiresAt || expiresAt <= 0) {
      if (hasExplicitExpires) {
        return {
          profileId,
          provider,
          type: "token",
          status: "missing",
          reasonCode: "invalid_expires",
          source,
          label,
        };
      }
      return {
        profileId,
        provider,
        type: "token",
        status: "static",
        source,
        label,
      };
    }
    const { status, remainingMs } = resolveOAuthStatus(expiresAt, now, warnAfterMs);
    return {
      profileId,
      provider,
      type: "token",
      status,
      expiresAt,
      remainingMs,
      source,
      label,
    };
  }

  const hasRefreshToken = typeof credential.refresh === "string" && credential.refresh.length > 0;
  const { status: rawStatus, remainingMs } = resolveOAuthStatus(
    credential.expires,
    now,
    warnAfterMs,
  );
  // A stored refresh token makes renewal possible, not proven. Report the
  // transition honestly until a real provider request refreshes the profile.
  const status =
    hasRefreshToken && (rawStatus === "expired" || rawStatus === "expiring")
      ? "refresh-required"
      : rawStatus;
  return {
    profileId,
    provider,
    type: "oauth",
    status,
    expiresAt: credential.expires,
    remainingMs,
    source,
    label,
  };
}

export function buildAuthHealthSummary(params: {
  store: AuthProfileStore;
  cfg?: FasedAgentConfig;
  warnAfterMs?: number;
  providers?: string[];
}): AuthHealthSummary {
  const now = Date.now();
  const warnAfterMs = params.warnAfterMs ?? DEFAULT_OAUTH_WARN_MS;
  const providerFilter = params.providers
    ? new Set(params.providers.map((p) => normalizeProviderId(p.trim())).filter(Boolean))
    : null;

  const profiles = Object.entries(params.store.profiles)
    .filter(([_, cred]) =>
      providerFilter ? providerFilter.has(normalizeProviderId(cred.provider)) : true,
    )
    .map(([profileId, credential]) =>
      buildProfileHealth({
        profileId,
        credential,
        store: params.store,
        cfg: params.cfg,
        now,
        warnAfterMs,
      }),
    )
    .toSorted((a, b) => {
      if (a.provider !== b.provider) {
        return a.provider.localeCompare(b.provider);
      }
      return a.profileId.localeCompare(b.profileId);
    });

  const providersMap = new Map<string, AuthProviderHealth>();
  for (const profile of profiles) {
    const existing = providersMap.get(profile.provider);
    if (!existing) {
      providersMap.set(profile.provider, {
        provider: profile.provider,
        status: "missing",
        profiles: [profile],
      });
    } else {
      existing.profiles.push(profile);
    }
  }

  if (providerFilter) {
    for (const provider of providerFilter) {
      if (!providersMap.has(provider)) {
        providersMap.set(provider, {
          provider,
          status: "missing",
          profiles: [],
        });
      }
    }
  }

  for (const provider of providersMap.values()) {
    if (provider.profiles.length === 0) {
      provider.status = "missing";
      continue;
    }

    const oauthProfiles = provider.profiles.filter((p) => p.type === "oauth");
    const tokenProfiles = provider.profiles.filter((p) => p.type === "token");
    const apiKeyProfiles = provider.profiles.filter((p) => p.type === "api_key");

    const expirable = [...oauthProfiles, ...tokenProfiles];
    if (expirable.length === 0) {
      provider.status = apiKeyProfiles.length > 0 ? "static" : "missing";
      continue;
    }

    const expiryCandidates = expirable
      .map((p) => p.expiresAt)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (expiryCandidates.length > 0) {
      provider.expiresAt = Math.min(...expiryCandidates);
      provider.remainingMs = provider.expiresAt - now;
    }

    const statuses = new Set(provider.profiles.map((p) => p.status));
    if (statuses.has("ok")) {
      provider.status = "ok";
    } else if (statuses.has("static")) {
      provider.status = "static";
    } else if (statuses.has("expiring")) {
      provider.status = "expiring";
    } else if (statuses.has("refresh-required")) {
      provider.status = "refresh-required";
    } else if (statuses.has("expired")) {
      provider.status = "expired";
    } else {
      provider.status = "missing";
    }
  }

  const providers = Array.from(providersMap.values()).toSorted((a, b) =>
    a.provider.localeCompare(b.provider),
  );

  return { now, warnAfterMs, profiles, providers };
}
