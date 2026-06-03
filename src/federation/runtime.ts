import type { FasedAgentConfig } from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";

export const DEFAULT_FEDERATION_BASE_URL = "https://ff1.fased.app";

function normalizeUrl(raw: string): string {
  const parsed = new URL(raw);
  const value = parsed.toString();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function sanitizeName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "fased-agent";
}

export function normalizeHandle(raw: string, domain: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@") && trimmed.includes("@", 1)) {
    return trimmed;
  }
  const base = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (base.includes("@")) {
    return `@${base}`;
  }
  return `@${base}@${domain}`;
}

export function resolveFederationBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.FASED_FEDERATION_BASE_URL?.trim() ||
    env.FASED_FEDERATION_URL?.trim() ||
    DEFAULT_FEDERATION_BASE_URL;
  try {
    return normalizeUrl(raw);
  } catch {
    return "";
  }
}

export function resolveAgentPublicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FASED_A2A_ORIGIN?.trim() || env.FASED_FEDIFY_ORIGIN?.trim() || "";
  if (explicit) {
    try {
      return normalizeUrl(explicit);
    } catch {
      // fall through to local default
    }
  }
  const port = Number(env.FASED_GATEWAY_PORT ?? "18789");
  const safePort = Number.isFinite(port) && port > 0 ? Math.floor(port) : 18789;
  return `http://127.0.0.1:${safePort}`;
}

export function resolveFederationHandle(params?: {
  env?: NodeJS.ProcessEnv;
  fallbackDomain?: string;
  nodeId?: string;
}): string {
  const env = params?.env ?? process.env;
  const fallbackDomain = params?.fallbackDomain ?? "localhost";
  const explicit = env.FASED_A2A_HANDLE?.trim() || env.FASED_FEDERATION_HANDLE?.trim() || "";
  if (explicit) {
    return normalizeHandle(explicit, fallbackDomain);
  }

  const federationBaseUrl = resolveFederationBaseUrl(env);
  const federationDomain = federationBaseUrl ? new URL(federationBaseUrl).hostname : fallbackDomain;
  const nodeId = params?.nodeId ?? loadOrCreateDeviceIdentity().deviceId;
  const prefix = sanitizeName(env.FASED_A2A_NAME?.trim() || "fased-agent");
  const shortNodeId = nodeId.slice(0, 12);
  return `@${prefix}-${shortNodeId}@${federationDomain}`;
}

export function resolveFederationBondWalletId(params?: {
  env?: NodeJS.ProcessEnv;
  cfg?: FasedAgentConfig;
}): string {
  const env = params?.env ?? process.env;
  const cfg = params?.cfg;
  const envExplicit =
    env.FASED_FEDERATION_BOND_WALLET_ID?.trim() || env.FASED_BOND_WALLET_ID?.trim() || "";
  if (envExplicit) {
    return envExplicit;
  }
  const configExplicit = cfg?.federation?.bond?.walletId?.trim() || "";
  if (configExplicit) {
    return configExplicit;
  }
  return "";
}
