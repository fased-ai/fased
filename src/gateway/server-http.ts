import fs from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import {
  invalidateSatReadCaches,
  inspectSatBondPosition,
  inspectSatBondStakingDistributor,
  inspectSatBondStakingPosition,
  inspectSatChainSlot,
} from "../../extensions/sat-mining/src/rpc-read.js";
import {
  submitSatCancelBondUnlock,
  submitSatClaimBondStakingRewards,
  submitSatFinalizeBondUnlock,
  submitSatIncreaseBondPosition,
  submitSatOpenBondPosition,
  submitSatRequestBondUnlock,
  submitSatSyncBondStakingPosition,
  submitSatSyncBondStakingRewards,
  runWithSatSubmissionWorkflow,
} from "../../extensions/sat-mining/src/solana-submit.js";
import { digestSatSubmissionIntent } from "../../extensions/sat-mining/src/submission-ledger.js";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import {
  A2UI_PATH,
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
} from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { walletSetupCommand } from "../commands/wallet.js";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  resolveGatewayPort,
  setRuntimeConfigSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { tryResolveSatRuntimeIds } from "../config/sat-runtime-ids.js";
import type {
  WalletApprovalAuthMode,
  WalletChain,
  WalletExecutionMode,
  WalletProviderId,
  WalletRuntimeMode,
  WalletToolAccessMode,
} from "../config/types.wallet.js";
import {
  createAndSubmitFederationBondProof,
  loadPersistedFederationBondProof,
  submitFederationBondProof,
} from "../federation/auto-connect.js";
import {
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationBondWalletId,
  resolveFederationHandle,
} from "../federation/runtime.js";
import { retryAsync } from "../infra/retry.js";
import { getDiagnosticStabilitySnapshot } from "../logging/diagnostic-stability.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveManagedFederationPublicUrl } from "../managed/federation.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  LegacyEmbeddedKeystoreMigrationRequiredError,
  LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE,
} from "../wallet/legacy-embedded-keystore.js";
import { lockSignerOwnedWalletForArchive } from "../wallet/local-socket-signer-archive.js";
import {
  buildLocalSignerPolicyTightening,
  LocalSignerPolicyAdminRequiredError,
  localSignerPolicyState,
} from "../wallet/local-socket-signer-policy.js";
import type { LocalSocketSignerPolicyV2 } from "../wallet/local-socket-signer-protocol.js";
import { resolveNativeSignerWalletId } from "../wallet/native-signer-wallet-id.js";
import { LocalSocketSignerAdapter } from "../wallet/providers/local-socket-signer-adapter.js";
import { configureSignerOwnedWalletNetwork } from "../wallet/signer-network-admin.js";
import { isValidSolanaAddress } from "../wallet/solana-address.js";
import {
  fetchSolanaMintInfoViaRpc,
  fetchSolanaWalletAssetsViaRpc,
  invalidateSolanaAssetRpcCaches,
  summarizeSolanaAssetRpcMetrics,
} from "../wallet/solana-assets.js";
import {
  fetchSolanaNativeBalanceViaRpc,
  fetchSolanaTokenBalanceViaRpc,
} from "../wallet/solana-assets.js";
import { resolveFederationBondWallet } from "../wallet/solana-bond-signing.js";
import { fetchSolanaGenesisHashFromRpc } from "../wallet/solana-network-discovery.js";
import { fetchPinnedSolanaRpcRead } from "../wallet/solana-rpc-read-fetch.js";
import { searchSolanaTokens } from "../wallet/solana-token-resolver.js";
import {
  beginWalletApprovalAssertion,
  beginWalletPasskeyRegistration,
  consumeWalletApprovalGrant,
  finishWalletApprovalAssertion,
  finishWalletPasskeyRegistration,
  createWalletApprovalChallenge,
  listWalletPasskeys,
  removeWalletPasskey,
  readWalletApprovalAuthSnapshot,
  resolveWalletApprovalGrantTtlSeconds,
  resolveWalletApprovalChallengeTtlSeconds,
  resolveWalletApprovalAuthMode,
} from "../wallet/wallet-approval-auth.js";
import { appendWalletAuditEntry, readWalletAuditEntries } from "../wallet/wallet-audit-log.js";
import {
  listWalletInboundEvents,
  pollWalletInboundEvents,
  recordWalletInboundWebhookEvent,
  reconcileWalletInboundEvents,
} from "../wallet/wallet-inbound-events.js";
import {
  incrementWalletObservabilityCounter,
  readWalletObservabilitySnapshot,
} from "../wallet/wallet-observability.js";
import { simulateWalletPolicy } from "../wallet/wallet-policy-simulation.js";
import {
  commitWalletPolicyConfigUpdate,
  prepareWalletPolicyConfigUpdate,
  resolveWalletPolicyConfig,
  resolveWalletRecurringTransferPolicy,
  type PreparedWalletPolicyConfigUpdate,
  type WalletPolicyPresetId,
} from "../wallet/wallet-policy.js";
import type { WalletProviderSignerReviewBindingV2 } from "../wallet/wallet-provider-adapter.js";
import {
  buildWalletProviderCapabilityMatrix,
  providerSupportsChainOperation,
  type WalletProviderCapabilityMatrix,
} from "../wallet/wallet-provider-capabilities.js";
import {
  WALLET_PROVIDER_IDS,
  checkNamedWalletDeletionSafety,
  deleteNamedWallet,
  nextRoleWalletIdentity,
  readWalletProviderRegistry,
  resolveWalletSelection,
  resolveWalletUserRole,
  setAgentWalletAssignment,
  setDefaultWallet,
  setNamedWalletRole,
  setWalletProviderEnabled,
  upsertNamedWallet,
  normalizeWalletUserRole,
} from "../wallet/wallet-provider-registry.js";
import {
  createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet,
  resolveWalletProviderId,
} from "../wallet/wallet-provider-resolver.js";
import { walletDiagnosticErrorMessage } from "../wallet/wallet-redaction.js";
import {
  resolveLocalSignerSocketPath,
  resolveWalletRuntimeConfig,
} from "../wallet/wallet-runtime-config.js";
import {
  deleteWalletProviderSecret,
  readWalletProviderSecretStatus,
  readWalletRpcSecretStatus,
  saveWalletProviderSecret,
} from "../wallet/wallet-secrets-store.js";
import {
  approveWalletSendRequest,
  createOrExecuteWalletSend,
  getWalletSendApprovalRequest,
  listWalletSendApprovalRequests,
  markWalletSendRequestBroadcastUnknown,
  markWalletSendRequestExecutedExternally,
  rejectWalletSendRequest,
  sanitizeWalletSendApprovalPayload,
  sanitizeWalletSendApprovalRequest,
  signerReviewBindingMatchesWalletApprovalPayload,
  signerReviewMatchesWalletApprovalPayload,
} from "../wallet/wallet-send-approvals.js";
import {
  executeWalletStandardReview,
  prepareWalletStandardReview,
  readWalletStandardReviewTxHash,
} from "../wallet/wallet-standard-review.js";
import { readWalletStatusSnapshot } from "../wallet/wallet-status.js";
import { renderQrPngBase64 } from "../web/qr-image.js";
import { createA2aHandler } from "./a2a-http.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeGatewayConnect,
  isDirectLoopbackRequest,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { callGatewayScoped } from "./call.js";
import { normalizeCanvasScopedUrl } from "./canvas-capability.js";
import { CONTROL_UI_BOOT_CHECK_PATH, resolveControlUiBootCheck } from "./control-ui-boot-check.js";
import {
  normalizePublicHost,
  resolveControlUiPublicHost,
  type LoginGrantExchangeResult,
} from "./control-ui-login.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  isControlUiStaticAssetPath,
  type ControlUiRootState,
} from "./control-ui.js";
import { handleFederationHttpRequest } from "./federation-http.js";
import { runPaidFederatedContentSummarize } from "./federation-marketplace.js";
import { createFedifyHandler } from "./fedify-http.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  type HookMessageChannel,
  type HooksConfigResolved,
  isHookAgentAllowed,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { sendGatewayAuthFailure, setDefaultSecurityHeaders } from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";
import {
  isPrivateOrLoopbackAddress,
  isTrustedProxyAddress,
  resolveGatewayClientIp,
} from "./net.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { buildGatewayProbePayload, buildGatewayReadinessPayload } from "./probe-payload.js";
import { canonicalizePathVariant, isPathProtectedByPrefixes } from "./security-path.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;
type HookAuthFailure = { count: number; windowStartedAtMs: number };

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;
const HOOK_AUTH_FAILURE_TRACK_MAX = 2048;
const FEDERATION_HTTP_ROUTE_PREFIXES = ["/api/federation"] as const;
// These two peer-facing routes perform mandatory directory-bound Ed25519 v2
// authentication in federation-http. Every other federation route stays
// behind the local Gateway auth boundary.
const SIGNED_FEDERATION_INBOUND_ROUTES = new Set([
  "/api/federation/marketplace/orders",
  "/api/federation/marketplace/deliveries",
]);
const CONTROL_UI_SETTINGS_STORAGE_KEY = "fased.control.settings.v1";
const CONTROL_UI_TOKEN_LOCAL_STORAGE_KEY = "fased.control.token.local.v1";
const CONTROL_UI_TOKEN_SESSION_STORAGE_KEY = "fased.control.token.session.v1";
const GATEWAY_PROBE_STATUS_BY_PATH = new Map<string, "live" | "ready">([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
]);

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    triggerId?: string;
    agentId?: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    notifyPolicy?: import("../tasks/task-registry.types.js").TaskNotifyPolicy;
    allowUnsafeExternalContent?: boolean;
  }) => string;
  dispatchWorkflowHook: (value: {
    workflowDefinitionId: string;
    name: string;
    triggerId?: string;
    agentId?: string;
    sessionKey: string;
    notifyPolicy?: import("../tasks/task-registry.types.js").TaskNotifyPolicy;
  }) => string;
};

function parseCookies(raw: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!raw) {
    return cookies;
  }
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || !value) {
      continue;
    }
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function normalizeHostName(host: string): string {
  const raw = host.trim().toLowerCase();
  return raw.startsWith("[")
    ? (() => {
        const end = raw.indexOf("]");
        return end > 0 ? raw.slice(1, end) : raw;
      })()
    : raw.replace(/:\d+$/, "");
}

function isLiteralLoopbackHostName(host: string): boolean {
  const normalized = normalizeHostName(host);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLocalHostName(host: string): boolean {
  const normalized = normalizeHostName(host);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  );
}

function isLoopbackBrowserOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLiteralLoopbackHostName(parsed.host);
  } catch {
    return false;
  }
}

function isSameBrowserOriginHost(origin: string, host: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return parsed.host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

function appendVaryHeader(res: ServerResponse, value: string): void {
  const current = res.getHeader("Vary");
  const values =
    typeof current === "string"
      ? current
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : Array.isArray(current)
        ? current.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }
  res.setHeader("Vary", values.join(", "));
}

function applyLoopbackCorsIfAllowed(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
): boolean {
  const origin = String(getHeader(req, "origin") ?? "").trim();
  if (!origin) {
    return false;
  }
  if (
    !isLocalHostName(host) ||
    (!isLoopbackBrowserOrigin(origin) && !isSameBrowserOriginHost(origin, host))
  ) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization,content-type,x-wallet-approval-token,x-fased-auth-grant",
  );
  res.setHeader("Access-Control-Max-Age", "600");
  appendVaryHeader(res, "Origin");
  return true;
}

function parseHostForControlUiRedirect(host: string): { hostname: string; port: string } | null {
  const normalized = normalizePublicHost(host);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]");
    if (end <= 0) {
      return null;
    }
    const hostname = normalized.slice(1, end);
    const suffix = normalized.slice(end + 1);
    return {
      hostname,
      port: suffix.startsWith(":") ? suffix.slice(1) : "",
    };
  }
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon > 0 && normalized.indexOf(":") === lastColon) {
    return {
      hostname: normalized.slice(0, lastColon),
      port: normalized.slice(lastColon + 1),
    };
  }
  return { hostname: normalized, port: "" };
}

function resolveControlUiLoopbackRedirect(params: {
  host: string;
  path: string;
  search: string;
  secure: boolean;
}): string | null {
  const parsed = parseHostForControlUiRedirect(params.host);
  if (!parsed) {
    return null;
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "::1") {
    return null;
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  const scheme = params.secure ? "https" : "http";
  return `${scheme}://localhost${port}${params.path}${params.search}`;
}

function isSecureRequest(req: IncomingMessage, host: string): boolean {
  const proto = String(getHeader(req, "x-forwarded-proto") ?? "").toLowerCase();
  if (proto.includes("https")) {
    return true;
  }
  const socketEncrypted = "encrypted" in req.socket && Boolean(req.socket.encrypted);
  if (socketEncrypted) {
    return true;
  }
  return !isLocalHostName(host);
}

function formatBindHostForOrigin(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function setControlUiSessionCookie(res: ServerResponse, token: string, secure: boolean): void {
  const attrs = [
    `${CONTROL_UI_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
  res.setHeader("Set-Cookie", attrs);
}

function clearControlUiSessionCookie(res: ServerResponse, secure: boolean): void {
  const attrs = [
    `${CONTROL_UI_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
  res.setHeader("Set-Cookie", attrs);
}

export const CONTROL_UI_SESSION_COOKIE = "fased_ui_session";

export function resolveControlUiSessionCookie(req: IncomingMessage): string {
  const cookies = parseCookies(getHeader(req, "cookie"));
  return cookies.get(CONTROL_UI_SESSION_COOKIE)?.trim() ?? "";
}

function controlUiLoginPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fased Control — Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #080e1a; font-family: system-ui, -apple-system, sans-serif; color: #e2e8f0; padding: 24px; }
    .card { width: 100%; max-width: 420px; background: #0f1929; border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 40px 36px; box-shadow: 0 24px 64px rgba(0,0,0,0.5); }
    .logo { width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #2563eb, #7c3aed); display: flex; align-items: center; justify-content: center; font-size: 26px; margin-bottom: 24px; }
    h1 { margin: 0 0 6px; font-size: 22px; font-weight: 700; color: #f0f4ff; }
    .subtitle { margin: 0 0 28px; font-size: 14px; color: #6b7a99; line-height: 1.6; }
    label { display: block; font-size: 12px; font-weight: 600; color: #9aa5bf; margin-bottom: 8px; letter-spacing: 0.05em; text-transform: uppercase; }
    input { width: 100%; padding: 12px 14px; background: #060d1a; border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; color: #c9d4f0; font-size: 14px; font-family: ui-monospace, monospace; outline: none; transition: border-color 0.2s; margin-bottom: 16px; }
    input:focus { border-color: #2563eb; }
    button { width: 100%; padding: 13px; background: linear-gradient(135deg, #2563eb, #1d4ed8); border: none; border-radius: 10px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.15s, transform 0.1s; }
    button:hover { opacity: 0.9; transform: translateY(-1px); }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .msg { margin-top: 14px; padding: 10px 14px; border-radius: 8px; font-size: 13px; display: none; }
    .msg.err { display: block; background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.25); color: #f87171; }
    .msg.ok { display: block; background: rgba(34,197,94,0.10); border: 1px solid rgba(34,197,94,0.2); color: #86efac; }
    .hint { margin-top: 20px; font-size: 12px; color: #3a4660; text-align: center; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⚡</div>
    <h1>Sign in to Fased Agent</h1>
    <p class="subtitle">Enter your owner gateway token to access the private dashboard. Your session will be authorized with a secure cookie.</p>
    <label for="token">Gateway Token</label>
    <input id="token" type="password" placeholder="Paste your gateway token" />
    <button id="btn">Sign in</button>
    <div id="msg" class="msg"></div>
    <p class="hint">Token is only used to establish a secure session — it is not stored in your browser.</p>
  </div>
  <script>
    const msg = document.getElementById("msg");
    const input = document.getElementById("token");
    const btn = document.getElementById("btn");
    const buildRedirectUrl = () => {
      const searchParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
      for (const key of ["token", "password", "login"]) {
        searchParams.delete(key);
        hashParams.delete(key);
      }
      const search = searchParams.toString();
      const hash = hashParams.toString();
      return window.location.pathname + (search ? "?" + search : "") + (hash ? "#" + hash : "");
    };
    const readTokenFromUrl = () => {
      const searchParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
      return (hashParams.get("token") || searchParams.get("token") || "").trim();
    };
    const readLoginGrantFromUrl = () => {
      const searchParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash);
      return (hashParams.get("login") || searchParams.get("login") || "").trim();
    };
    const currentGatewayUrl = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + window.location.host;
    };
    const storeGatewayUrl = () => {
      try {
        const raw = localStorage.getItem(${JSON.stringify(CONTROL_UI_SETTINGS_STORAGE_KEY)});
        const parsed = raw ? JSON.parse(raw) : {};
        localStorage.setItem(
          ${JSON.stringify(CONTROL_UI_SETTINGS_STORAGE_KEY)},
          JSON.stringify({
            ...parsed,
            gatewayUrl: currentGatewayUrl(),
            authStorage: "local",
            token: "",
          }),
        );
      } catch {}
    };
    const storeSessionToken = (sessionToken) => {
      if (!sessionToken) { return; }
      storeGatewayUrl();
      try {
        localStorage.setItem(
          ${JSON.stringify(CONTROL_UI_TOKEN_LOCAL_STORAGE_KEY)},
          sessionToken,
        );
      } catch {}
    };
    const write = (text, ok) => {
      msg.className = "msg " + (ok ? "ok" : "err");
      msg.textContent = text;
    };
    const submit = async () => {
      const token = input.value.trim();
      if (!token) { write("Gateway token is required."); return; }
      btn.disabled = true;
      btn.textContent = "Signing in…";
      msg.className = "msg";
      try {
        const res = await fetch("/api/control-ui/login/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.ok !== true) {
          write("Login failed: " + (data?.error?.message || data?.error?.code || ("HTTP " + res.status)));
          btn.disabled = false;
          btn.textContent = "Sign in";
          return;
        }
        storeSessionToken(data?.sessionToken || "");
        write("Signed in! Redirecting…", true);
        window.location.replace(buildRedirectUrl());
      } catch (err) {
        write("Network error: " + err.message);
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
    };
    const exchangeLoginGrant = async (grant) => {
      btn.disabled = true;
      btn.textContent = "Signing in…";
      msg.className = "msg";
      try {
        const res = await fetch("/api/control-ui/login/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({ grant }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.ok !== true) {
          write("Login failed: " + (data?.error?.message || data?.error?.code || ("HTTP " + res.status)));
          btn.disabled = false;
          btn.textContent = "Sign in";
          return;
        }
        storeSessionToken(data?.sessionToken || "");
        write("Signed in! Redirecting…", true);
        window.location.replace(buildRedirectUrl());
      } catch (err) {
        write("Network error: " + err.message);
        btn.disabled = false;
        btn.textContent = "Sign in";
      }
    };
    const restoreSavedSession = async () => {
      let saved = "";
      try {
        const rawSettings = localStorage.getItem(${JSON.stringify(CONTROL_UI_SETTINGS_STORAGE_KEY)});
        const settings = rawSettings ? JSON.parse(rawSettings) : {};
        const authStorage = settings?.authStorage === "session" ? "session" : "local";
        saved =
          authStorage === "session"
            ? sessionStorage.getItem(${JSON.stringify(CONTROL_UI_TOKEN_SESSION_STORAGE_KEY)}) || ""
            : localStorage.getItem(${JSON.stringify(CONTROL_UI_TOKEN_LOCAL_STORAGE_KEY)}) || "";
        if (!saved.trim()) {
          saved =
            sessionStorage.getItem(${JSON.stringify(CONTROL_UI_TOKEN_SESSION_STORAGE_KEY)}) ||
            localStorage.getItem(${JSON.stringify(CONTROL_UI_TOKEN_LOCAL_STORAGE_KEY)}) ||
            "";
        }
      } catch {}
      if (!saved.trim()) {
        return;
      }
      btn.disabled = true;
      btn.textContent = "Restoring session…";
      try {
        const res = await fetch("/api/control-ui/login/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          cache: "no-store",
          body: JSON.stringify({ token: saved.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok === true) {
          storeGatewayUrl();
          window.location.replace(buildRedirectUrl());
          return;
        }
      } catch {}
      btn.disabled = false;
      btn.textContent = "Sign in";
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    const tokenFromUrl = readTokenFromUrl();
    if (tokenFromUrl) {
      input.value = tokenFromUrl;
      try { window.history.replaceState({}, "", buildRedirectUrl()); } catch {}
      submit();
    } else if (readLoginGrantFromUrl()) {
      const grantFromUrl = readLoginGrantFromUrl();
      try { window.history.replaceState({}, "", buildRedirectUrl()); } catch {}
      exchangeLoginGrant(grantFromUrl);
    } else {
      restoreSavedSession();
    }
  </script>
</body>
</html>`;
}

function isControlUiCandidatePath(pathname: string, basePath: string): boolean {
  if (basePath) {
    return pathname === basePath || pathname.startsWith(`${basePath}/`);
  }
  if (pathname.startsWith("/api/")) {
    return false;
  }
  if (pathname.startsWith(CANVAS_HOST_PATH) || pathname.startsWith(A2UI_PATH)) {
    return false;
  }
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function resolveSolanaWalletHandleDestination(params: {
  to?: string;
  sourceWalletId?: string;
  env: NodeJS.ProcessEnv;
}): Promise<
  | { ok: true; to?: string; destinationWalletId?: string }
  | { ok: false; code: "invalid_wallet_handle" | "wallet_network_mismatch"; message: string }
> {
  const raw = params.to?.trim();
  if (!raw || !raw.toLowerCase().startsWith("@wallet:")) {
    return { ok: true, to: raw || undefined };
  }
  const handle = raw.slice("@wallet:".length).trim().toLowerCase();
  if (!handle) {
    return { ok: false, code: "invalid_wallet_handle", message: "wallet handle is empty" };
  }
  const registry = readWalletProviderRegistry(params.env);
  const byId = registry.wallets.find((wallet) => wallet.id.toLowerCase() === handle);
  const byName = registry.wallets.filter((wallet) => wallet.name.toLowerCase() === handle);
  const byRole = registry.wallets.filter((wallet) => resolveWalletUserRole(wallet) === handle);
  const wallet =
    byId ??
    (byName.length === 1 ? byName[0] : undefined) ??
    (byRole.length === 1 ? byRole[0] : undefined);
  if (!wallet) {
    if (byName.length > 1 || byRole.length > 1) {
      return {
        ok: false,
        code: "invalid_wallet_handle",
        message: `wallet handle ${raw} is ambiguous; use a specific @wallet:id`,
      };
    }
    return {
      ok: false,
      code: "invalid_wallet_handle",
      message: `wallet handle not found: ${raw}`,
    };
  }
  const solana = wallet.addresses?.solana?.trim();
  if (!solana) {
    return {
      ok: false,
      code: "invalid_wallet_handle",
      message: `wallet handle ${raw} has no Solana address`,
    };
  }
  const sourceWalletId = params.sourceWalletId?.trim();
  if (sourceWalletId && sourceWalletId !== wallet.id) {
    const sourceRpc = resolveWalletRpcUrlFromEnv(params.env, "solana", sourceWalletId);
    const destinationRpc = resolveWalletRpcUrlFromEnv(params.env, "solana", wallet.id);
    if (sourceRpc && destinationRpc && sourceRpc !== destinationRpc) {
      let sourceGenesis: string;
      let destinationGenesis: string;
      try {
        [sourceGenesis, destinationGenesis] = await Promise.all([
          fetchSolanaGenesisHashFromRpc(sourceRpc),
          fetchSolanaGenesisHashFromRpc(destinationRpc),
        ]);
      } catch {
        return {
          ok: false,
          code: "wallet_network_mismatch",
          message: `Unable to verify that @wallet:${sourceWalletId} and @wallet:${wallet.id} use the same Solana network. Check both RPC connections and try again.`,
        };
      }
      if (sourceGenesis !== destinationGenesis) {
        return {
          ok: false,
          code: "wallet_network_mismatch",
          message: `@wallet:${sourceWalletId} and @wallet:${wallet.id} use different Solana networks. Choose wallets on the same network before sending.`,
        };
      }
    }
  }
  return { ok: true, to: solana, destinationWalletId: wallet.id };
}

type FederationStatusToken = {
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
  bondId?: string;
  bondWallet?: {
    chain: string;
    address: string;
  };
  bondStatus?: "missing" | "active" | "unlocking" | "unlocked";
  bondTier?: "none" | "basic-bond" | "operator-bond";
  bondAmountRaw?: string;
  bondUnlockAvailableAt?: string;
  bondQuotaBand?: "standard" | "boosted" | "operator";
  bondDerivedScopes?: string[];
};

type FederationStatusBond = {
  exists: boolean;
  source: "token" | "proof" | "config" | "unresolved";
  walletId?: string;
  walletAddress?: string;
  bondId?: string;
  status?: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
  tier?: "none" | "basic-bond" | "operator-bond";
  amountRaw?: string;
  unlockAvailableAt?: string;
  unlockCurrentSlot?: number;
  unlockReady?: boolean;
  quotaBand?: "standard" | "boosted" | "operator";
  derivedScopes?: string[];
  staking?: {
    distributor?: {
      exists: boolean;
      address?: string;
      status?: "inactive" | "active";
      rewardVault?: string;
      minStakeRaw?: string;
      totalActiveStakeRaw?: string;
      rewardIndexFp?: string;
      observedRewardVaultRaw?: string;
      unallocatedRewardRaw?: string;
      rewardVaultBalanceRaw?: string;
      lastSyncedSlot?: number;
      mintMatchesRuntime?: boolean;
      vaultMatchesExpected?: boolean;
    };
    position?: {
      exists: boolean;
      address?: string;
      status?: "inactive" | "active";
      activeStakeRaw?: string;
      claimableRewardRaw?: string;
      rewardDebtFp?: string;
      estimatedClaimableRewardRaw?: string;
      lastSyncedSlot?: number;
    };
  };
  vaultBalances?: {
    solLamports?: string;
    satRaw?: string;
    satDecimals?: number;
    checkedAt?: string;
    error?: string;
  };
  warnings?: string[];
};

type FederationSellerLanePayload = {
  status: "draft" | "bonded-public" | "degraded" | "suspended";
  eligible: boolean;
  visibility: "hidden" | "degraded" | "public";
  reasons: string[];
  paymentRailsReady?: boolean;
  endpointHealthy?: boolean;
};

type FederationRoutingCapacityPayload = {
  status: "standard" | "routing-basic" | "degraded" | "suspended";
  eligible: boolean;
  intake: "standard" | "priority" | "reduced" | "blocked";
  reasons: string[];
  endpointHealthy: boolean;
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    hasRoutingScope: boolean;
    activeBond: boolean;
  };
};

type FederationHostedEdgePayload = {
  status: "standard" | "managed-edge" | "degraded" | "suspended";
  eligible: boolean;
  exposure: "local-only" | "managed-public" | "degraded" | "blocked";
  reasons: string[];
  managedPublicUrl?: string;
  fallbackUrl?: string;
  routeHealthy?: boolean;
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    hostedState: "disabled" | "pending" | "ready" | "missing";
    hasManagedUrl: boolean;
    hasManagedAttachment: boolean;
    activeBond: boolean;
  };
};

type FederationDirectoryIndexerPayload = {
  status: "standard" | "index-basic" | "degraded" | "suspended";
  eligible: boolean;
  surface: "canonical-only" | "mirrored-public" | "stale" | "blocked";
  reasons: string[];
  lastSeenAt?: string;
  reviewedAt?: string;
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    hasDirectoryScope: boolean;
    activeBond: boolean;
    freshness: "fresh" | "stale" | "missing";
    lastSeenAgeSeconds?: number;
  };
};

type FederationArtifactAvailabilityPayload = {
  status: "standard" | "availability-basic" | "degraded" | "suspended";
  eligible: boolean;
  retrieval: "local-only" | "shareable-public" | "degraded" | "blocked";
  reasons: string[];
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    activeBond: boolean;
    endpointHealthy: boolean;
    shareableSurface: boolean;
    integrityMode: "declared" | "unknown";
    replicationClass: "none" | "single-surface" | "multi-surface";
  };
};

type FederationHostedProbePayload = {
  state: "healthy" | "broken";
  checkedAt: string;
  publicUrl: string;
  agentCardUrl: string;
  statusCode?: number;
  reason?: string;
};

type FederationStatusPayload = {
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
  token?: FederationStatusToken;
  bond?: FederationStatusBond;
  sellerLane?: FederationSellerLanePayload;
  routingCapacity?: FederationRoutingCapacityPayload;
  hostedEdge?: FederationHostedEdgePayload;
  directoryIndexer?: FederationDirectoryIndexerPayload;
  artifactAvailability?: FederationArtifactAvailabilityPayload;
  hostedProbe?: FederationHostedProbePayload;
};

type WalletSettingsResponsePayload = {
  managedMode: boolean;
  provider: {
    id: WalletProviderId;
    operationsImplemented: boolean;
    supportedChains: Array<"solana">;
    requiresCredentials: boolean;
    capabilities: WalletProviderCapabilityMatrix;
  };
  runtime: {
    enabled: boolean;
    mode: WalletRuntimeMode;
    runtime: "external-docker" | "external-custom";
    chains: Array<"solana">;
    service: { host: string; port: number };
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
    capsEnabled: boolean;
    directSigning: boolean;
    skillsEnabled: boolean;
    solana: {
      allowPrograms: string[];
      maxPerTx: string;
      maxDaily: string;
      tokenCaps: Record<string, { maxPerTx: string; maxDaily: string }>;
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
  rpc: ReturnType<typeof readWalletRpcSecretStatus>;
  checkedAt: string;
};

type WalletProviderSummary = {
  id: WalletProviderId;
  enabled: boolean;
  label?: string;
  isDefault: boolean;
  operationsImplemented: boolean;
  capabilities: WalletProviderCapabilityMatrix;
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

type WalletRegistryWalletSummary = {
  id: string;
  name: string;
  providerId: WalletProviderId;
  addresses?: {
    solana?: string;
  };
  balances?: {
    solana?: string;
  };
  readiness?: {
    keystore: boolean;
    rpc: boolean;
    api?: boolean;
    ata?: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

type WalletSettingsPatchInput = {
  walletId?: string;
  policyTemplate?: WalletPolicyPresetId;
  providerId?: WalletProviderId;
  executionMode?: WalletExecutionMode;
  approvalAuthMode?: WalletApprovalAuthMode;
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
  toolAccessMode?: WalletToolAccessMode;
  toolAccessAllowAgents?: string[];
};

const WALLET_POLICY_PRESET_IDS = new Set<WalletPolicyPresetId>([
  "recommended",
  "read-only",
  "manual-only",
  "small-agent-spend",
  "mining-only",
  "skill-limited",
  "trading-experimental",
]);

function isWalletPolicyPatch(patch: WalletSettingsPatchInput): boolean {
  return (
    patch.policyTemplate !== undefined ||
    patch.approvalAuthMode !== undefined ||
    patch.approvalChallengeTtlSeconds !== undefined ||
    patch.approvalGrantTtlSeconds !== undefined ||
    patch.capsEnabled !== undefined ||
    patch.directSigning !== undefined ||
    patch.skillsEnabled !== undefined ||
    patch.solanaAllowPrograms !== undefined ||
    patch.solanaMaxPerTx !== undefined ||
    patch.solanaMaxDaily !== undefined ||
    patch.solanaTokenCaps !== undefined ||
    patch.recurringTransfer !== undefined ||
    patch.toolAccessMode !== undefined ||
    patch.toolAccessAllowAgents !== undefined
  );
}

function isWalletScopedPolicyPatch(patch: WalletSettingsPatchInput): boolean {
  return (
    patch.policyTemplate !== undefined ||
    patch.capsEnabled !== undefined ||
    patch.directSigning !== undefined ||
    patch.skillsEnabled !== undefined ||
    patch.solanaAllowPrograms !== undefined ||
    patch.solanaMaxPerTx !== undefined ||
    patch.solanaMaxDaily !== undefined ||
    patch.solanaTokenCaps !== undefined ||
    patch.recurringTransfer !== undefined
  );
}

function isManagedGatewayMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FASED_GATEWAY_MODE ?? "").trim().toLowerCase() === "managed";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toOptionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseWalletSolanaTokenCaps(
  value: unknown,
): Record<string, { maxPerTx?: string; maxDaily?: string }> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const out: Record<string, { maxPerTx?: string; maxDaily?: string }> = {};
  for (const [mintRaw, capRaw] of Object.entries(value)) {
    const mint = mintRaw.trim();
    if (!mint || !isPlainObject(capRaw)) {
      continue;
    }
    const maxPerTx = toOptionalString(capRaw.maxPerTx);
    const maxDaily = toOptionalString(capRaw.maxDaily);
    out[mint] = {
      ...(maxPerTx === undefined ? {} : { maxPerTx }),
      ...(maxDaily === undefined ? {} : { maxDaily }),
    };
  }
  return out;
}

function parseWalletRecurringTransferPatch(
  value: unknown,
): WalletSettingsPatchInput["recurringTransfer"] | undefined {
  if (value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const schedule = isPlainObject(value.schedule)
    ? (JSON.parse(JSON.stringify(value.schedule)) as Record<string, unknown>)
    : undefined;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    chain: value.chain === "solana" ? "solana" : undefined,
    to: toOptionalString(value.to),
    program: toOptionalString(value.program),
    amountMode:
      value.amountMode === "fixed" || value.amountMode === "percentage"
        ? value.amountMode
        : undefined,
    amount: toOptionalString(value.amount),
    percentage: typeof value.percentage === "number" ? value.percentage : undefined,
    minAmount: toOptionalString(value.minAmount),
    keepAmount: toOptionalString(value.keepAmount),
    schedule,
    name: toOptionalString(value.name),
  };
}

function parseWalletSettingsPatchInput(input: unknown): WalletSettingsPatchInput {
  const payload = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const policyTemplate =
    typeof payload.policyTemplate === "string" &&
    WALLET_POLICY_PRESET_IDS.has(payload.policyTemplate as WalletPolicyPresetId)
      ? (payload.policyTemplate as WalletPolicyPresetId)
      : undefined;
  return {
    walletId: toOptionalString(payload.walletId),
    policyTemplate,
    providerId:
      payload.providerId === "local-socket-signer" ||
      payload.providerId === "alchemy" ||
      payload.providerId === "turnkey" ||
      payload.providerId === "wallet-standard"
        ? payload.providerId
        : undefined,
    executionMode:
      payload.executionMode === "manual" || payload.executionMode === "autonomous"
        ? payload.executionMode
        : undefined,
    approvalAuthMode:
      payload.approvalAuthMode === "none" || payload.approvalAuthMode === "webauthn"
        ? payload.approvalAuthMode
        : undefined,
    approvalChallengeTtlSeconds: toOptionalInt(payload.approvalChallengeTtlSeconds),
    approvalGrantTtlSeconds: toOptionalInt(payload.approvalGrantTtlSeconds),
    capsEnabled: typeof payload.capsEnabled === "boolean" ? payload.capsEnabled : undefined,
    directSigning: typeof payload.directSigning === "boolean" ? payload.directSigning : undefined,
    skillsEnabled: typeof payload.skillsEnabled === "boolean" ? payload.skillsEnabled : undefined,
    solanaAllowPrograms: Array.isArray(payload.solanaAllowPrograms)
      ? payload.solanaAllowPrograms.map((entry) => String(entry).trim()).filter(Boolean)
      : undefined,
    solanaMaxPerTx: toOptionalString(payload.solanaMaxPerTx),
    solanaMaxDaily: toOptionalString(payload.solanaMaxDaily),
    solanaTokenCaps: parseWalletSolanaTokenCaps(payload.solanaTokenCaps),
    recurringTransfer: parseWalletRecurringTransferPatch(payload.recurringTransfer),
    toolAccessMode:
      payload.toolAccessMode === "owner-only" ||
      payload.toolAccessMode === "allowlist" ||
      payload.toolAccessMode === "all"
        ? payload.toolAccessMode
        : undefined,
    toolAccessAllowAgents: Array.isArray(payload.toolAccessAllowAgents)
      ? payload.toolAccessAllowAgents.map((entry) => String(entry).trim()).filter(Boolean)
      : undefined,
  };
}

function migrateWalletApprovalAuthFromEnvIfNeeded(
  cfg: ReturnType<typeof loadConfig>,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (cfg.wallet?.approvalAuth) {
    return;
  }
  const mode = resolveWalletApprovalAuthMode(env);
  const challengeTtlSeconds = resolveWalletApprovalChallengeTtlSeconds(env);
  const grantTtlSeconds = resolveWalletApprovalGrantTtlSeconds(env);
  cfg.wallet = {
    ...cfg.wallet,
    approvalAuth: {
      mode,
      challengeTtlSeconds,
      grantTtlSeconds,
    },
  };
}

function resolveProviderCredentialStatus(params: {
  providerId: WalletProviderId;
  wallet: ReturnType<typeof resolveWalletRuntimeConfig>;
  env?: NodeJS.ProcessEnv;
}): ReturnType<typeof readWalletProviderSecretStatus> & {
  source?: "secret" | "env" | "stack-env" | "none";
} {
  const env = params.env ?? process.env;
  return readWalletProviderSecretStatus(params.providerId, env);
}

function hasTurnkeyPolicyCredentialsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const status = readWalletProviderSecretStatus("turnkey", env);
  const configuredFields = new Set(status.fields);
  const hasApiPublicKey =
    configuredFields.has("apiPublicKey") ||
    Boolean(String(env.FASED_WALLET_TURNKEY_API_PUBLIC_KEY ?? "").trim());
  const hasApiPrivateKey =
    configuredFields.has("apiPrivateKey") ||
    Boolean(String(env.FASED_WALLET_TURNKEY_API_PRIVATE_KEY ?? "").trim());
  const hasOrganizationId =
    configuredFields.has("organizationId") ||
    Boolean(String(env.FASED_WALLET_TURNKEY_ORGANIZATION_ID ?? "").trim());
  const hasPolicyId =
    configuredFields.has("policyId") ||
    Boolean(String(env.FASED_WALLET_TURNKEY_POLICY_ID ?? "").trim());
  const hasRpcUrl =
    configuredFields.has("rpcUrl") ||
    Boolean(String(env.FASED_WALLET_TURNKEY_RPC_URL ?? "").trim()) ||
    Boolean(String(env.FASED_WALLET_SOLANA_RPC_URL ?? "").trim());
  return hasApiPublicKey && hasApiPrivateKey && hasOrganizationId && hasPolicyId && hasRpcUrl;
}

async function readWalletSettingsSignerPolicy(params: {
  cfg: ReturnType<typeof loadConfig>;
  walletId?: string;
  env: NodeJS.ProcessEnv;
  acknowledged?: LocalSocketSignerPolicyV2;
}): Promise<WalletSettingsResponsePayload["signerPolicy"] | undefined> {
  const walletId = params.walletId?.trim();
  if (!walletId) {
    return undefined;
  }
  const effectiveEnv = { ...params.env, ...params.cfg.env?.vars } as NodeJS.ProcessEnv;
  const wallet = readWalletProviderRegistry(effectiveEnv).wallets.find(
    (entry) => entry.id === walletId,
  );
  if (wallet?.providerId !== "local-socket-signer") {
    return undefined;
  }
  try {
    const signerWalletId = resolveNativeSignerWalletId(wallet);
    const policy =
      params.acknowledged?.walletId === signerWalletId
        ? params.acknowledged
        : await new LocalSocketSignerAdapter(
            resolveLocalSignerSocketPath(effectiveEnv),
          ).getSignerPolicy(signerWalletId);
    const state = localSignerPolicyState(policy);
    return {
      state,
      walletId: policy.walletId,
      role: policy.role,
      version: policy.version,
      hash: policy.hash,
      operations: [...policy.operations],
      programs: [...policy.programs],
      assets: policy.assets.map((asset) => ({ ...asset, destinations: [...asset.destinations] })),
      ...(state === "locked"
        ? {
            guidance: `This existing wallet is deny-all. Review its immutable role, then run: fased wallet policy activate-role-baseline --wallet-id ${walletId} --role ${policy.role} --confirm`,
          }
        : {}),
    };
  } catch {
    return {
      state: "unavailable",
      walletId,
      guidance:
        "Signer policy could not be verified. No policy change will be shown as saved until the signer returns its exact durable version and hash.",
    };
  }
}

async function buildWalletSettingsPayload(
  cfg: ReturnType<typeof loadConfig>,
  walletId?: string,
  env: NodeJS.ProcessEnv = process.env,
  acknowledgedSignerPolicy?: LocalSocketSignerPolicyV2,
): Promise<WalletSettingsResponsePayload> {
  const runtimeWallet = resolveWalletRuntimeConfig(cfg, env);
  const wallet = resolveWalletPolicyConfig(cfg, env, walletId);
  const providerId = resolveWalletProviderId(cfg, env);
  const providerAdapter = createWalletProviderAdapter({
    cfg,
    wallet: runtimeWallet,
    env,
  });
  const providerCapabilities = buildWalletProviderCapabilityMatrix(providerAdapter);
  const providerCredentials = resolveProviderCredentialStatus({
    providerId,
    wallet,
    env,
  });
  const signerPolicy = await readWalletSettingsSignerPolicy({
    cfg,
    walletId,
    env,
    acknowledged: acknowledgedSignerPolicy,
  });
  return {
    managedMode: isManagedGatewayMode(env),
    provider: {
      id: providerId,
      operationsImplemented:
        (providerAdapter.capabilities.supportsPrepare &&
          providerAdapter.capabilities.supportsSend) ||
        providerCapabilities.signing.interactiveSend,
      supportedChains: providerAdapter.capabilities.supportedChains,
      requiresCredentials: providerCapabilities.requiresCredentials,
      capabilities: providerCapabilities,
    },
    runtime: {
      enabled: wallet.enabled,
      mode: wallet.mode,
      runtime: wallet.runtime,
      chains: wallet.chains,
      service: {
        host: wallet.service.host,
        port: wallet.service.port,
      },
    },
    execution: {
      mode: wallet.execution.mode,
    },
    approvalAuth: {
      mode: resolveWalletApprovalAuthMode(env, cfg),
      challengeTtlSeconds: resolveWalletApprovalChallengeTtlSeconds(env, cfg),
      grantTtlSeconds: resolveWalletApprovalGrantTtlSeconds(env, cfg),
    },
    policy: {
      capsEnabled: wallet.policy.capsEnabled,
      directSigning: wallet.policy.directSigning,
      skillsEnabled: wallet.policy.skillsEnabled,
      solana: {
        allowPrograms: wallet.policy.solana.allowPrograms,
        maxPerTx: wallet.policy.solana.caps.maxPerTx.toString(),
        maxDaily: wallet.policy.solana.caps.maxDaily.toString(),
        tokenCaps: Object.fromEntries(
          Object.entries(wallet.policy.solana.tokenCaps).map(([mint, cap]) => [
            mint,
            {
              maxPerTx: cap.maxPerTx.toString(),
              maxDaily: cap.maxDaily.toString(),
            },
          ]),
        ),
      },
      recurringTransfer: resolveWalletRecurringTransferPolicy({ cfg, env, walletId }),
    },
    ...(signerPolicy ? { signerPolicy } : {}),
    toolAccess: {
      mode: wallet.toolAccess.mode,
      allowAgents: wallet.toolAccess.allowAgents,
    },
    providerCredentials,
    rpc: readWalletRpcSecretStatus(env, { providerId }),
    checkedAt: new Date().toISOString(),
  };
}

function parseWalletProviderId(value: unknown): WalletProviderId | null {
  switch (typeof value === "string" ? value.trim() : "") {
    case "embedded-keystore":
    case "local-socket-signer":
    case "alchemy":
    case "turnkey":
    case "wallet-standard":
    case "privy":
      return value as WalletProviderId;
    default:
      return null;
  }
}

function parseWalletAmountFormat(value: unknown): "base" | "human" {
  return value === "human" ? "human" : "base";
}

async function normalizeWalletAmountFromFormat(params: {
  amountRaw: string | undefined;
  chain: WalletChain;
  amountFormat: "base" | "human";
  program?: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<
  | {
      ok: true;
      amount?: string;
    }
  | {
      ok: false;
      message: string;
    }
> {
  const amount = params.amountRaw?.trim();
  if (!amount) {
    return { ok: true, amount: undefined };
  }
  if (params.amountFormat === "base") {
    return { ok: true, amount };
  }
  if (!/^[0-9]+(\.[0-9]+)?$/.test(amount)) {
    return { ok: false, message: "human amount must be a positive decimal number" };
  }
  let decimals = 9;
  if (params.program?.trim()) {
    const rpcUrl = resolveWalletRpcUrlFromEnv(params.env ?? process.env, "solana", params.walletId);
    if (!rpcUrl) {
      return {
        ok: false,
        message: "Solana RPC is required to normalize SPL token amounts",
      };
    }
    const mintInfo = await fetchSolanaMintInfoViaRpc({
      rpcUrl,
      mint: params.program.trim(),
    }).catch(() => null);
    if (!mintInfo) {
      return {
        ok: false,
        message: "failed to resolve SPL token decimals from Solana RPC",
      };
    }
    decimals = mintInfo.decimals;
  }
  const [wholePart, fracPartRaw = ""] = amount.split(".");
  if (fracPartRaw.length > decimals) {
    return {
      ok: false,
      message: `Solana human amount supports at most ${String(decimals)} decimals`,
    };
  }
  const whole = BigInt(wholePart || "0");
  const fracPadded = fracPartRaw.padEnd(decimals, "0");
  const fraction = fracPadded ? BigInt(fracPadded) : 0n;
  const base = 10n ** BigInt(decimals);
  return { ok: true, amount: (whole * base + fraction).toString() };
}

function formatLamportsToSol(raw: string): string {
  try {
    const lamports = BigInt(raw);
    const base = 10n ** 9n;
    const whole = lamports / base;
    const frac = (lamports % base).toString().padStart(9, "0").replace(/0+$/, "");
    return frac ? `${whole.toString()}.${frac} SOL` : `${whole.toString()} SOL`;
  } catch {
    return "invalid";
  }
}

function resolveProviderFromWalletSelection(params: {
  walletId?: string;
  env?: NodeJS.ProcessEnv;
}): WalletProviderId | undefined {
  const env = params.env ?? process.env;
  const walletId = params.walletId?.trim();
  if (!walletId) {
    return undefined;
  }
  const registry = readWalletProviderRegistry(env);
  const wallet = registry.wallets.find((entry) => entry.id === walletId);
  return wallet?.providerId;
}

function normalizeWalletIdForEnvSuffix(walletId?: string): string | undefined {
  const raw = String(walletId ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function walletIdsMatchForStatus(left?: string, right?: string): boolean {
  const normalizedLeft = String(left ?? "")
    .trim()
    .toLowerCase();
  const normalizedRight = String(right ?? "")
    .trim()
    .toLowerCase();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizeWalletIdForEnvSuffix(normalizedLeft) === normalizeWalletIdForEnvSuffix(normalizedRight)
  );
}

function findWalletChainEntry<T extends { walletId: string }>(
  entries: T[] | undefined,
  walletId: string,
): T | undefined {
  return (entries ?? []).find((entry) => walletIdsMatchForStatus(entry.walletId, walletId));
}

function inferWalletSummaryChain(wallet: {
  id?: string;
  name?: string;
  addresses?: { solana?: string };
}): "solana" | null {
  const id = String(wallet.id ?? "")
    .trim()
    .toLowerCase();
  const name = String(wallet.name ?? "")
    .trim()
    .toLowerCase();
  if (id.startsWith("solana-") || name.startsWith("solana ")) {
    return "solana";
  }
  if (wallet.addresses?.solana) {
    return "solana";
  }
  return null;
}

function resolveWalletRpcUrlFromEnv(
  env: NodeJS.ProcessEnv,
  _chain: "solana",
  walletId?: string,
): string {
  const suffix = normalizeWalletIdForEnvSuffix(walletId)?.toUpperCase();
  const perWalletKey = suffix ? `FASED_WALLET_SOLANA_RPC_URL__${suffix}` : "";
  const perChainKey = "FASED_WALLET_SOLANA_RPC_URL";
  const scopedOrChain =
    (perWalletKey ? String(env[perWalletKey] ?? "").trim() : "") ||
    String(env[perChainKey] ?? "").trim();
  return scopedOrChain || String(env.FASED_WALLET_RPC_URL ?? "").trim();
}

function maskWalletRpcUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  return "****";
}

function inferLocalSignerCreateChain(params: {
  payloadChain: unknown;
  walletId: string;
  walletName: string;
  runtimeChains?: WalletChain[];
}): WalletChain | null {
  if (params.payloadChain === "solana") {
    return "solana";
  }
  const runtimeChains = (params.runtimeChains ?? []).filter(
    (chain): chain is WalletChain => chain === "solana",
  );
  if (runtimeChains.length === 1) {
    return runtimeChains[0] ?? null;
  }
  return inferWalletSummaryChain({
    id: params.walletId,
    name: params.walletName,
  });
}

const silentWalletSetupRuntime = {
  log: () => undefined,
  error: () => undefined,
  exit: (code: number) => {
    throw new Error(`wallet setup exited with code ${code}`);
  },
};

type WalletGatewayRpcMethodMetrics = {
  requestsSinceStart: number;
  successesSinceStart: number;
  failuresSinceStart: number;
};

const walletGatewayRpcStartedAt = new Date().toISOString();
const walletGatewayRpcMetrics = new Map<string, WalletGatewayRpcMethodMetrics>();

function recordWalletGatewayRpcMethod(method: string, outcome: "success" | "failure"): void {
  const key = method.trim() || "unknown";
  const current = walletGatewayRpcMetrics.get(key) ?? {
    requestsSinceStart: 0,
    successesSinceStart: 0,
    failuresSinceStart: 0,
  };
  current.requestsSinceStart += 1;
  if (outcome === "success") {
    current.successesSinceStart += 1;
  } else {
    current.failuresSinceStart += 1;
  }
  walletGatewayRpcMetrics.set(key, current);
}

async function recordWalletGatewayRpc<T>(method: string, task: Promise<T>): Promise<T> {
  try {
    const value = await task;
    recordWalletGatewayRpcMethod(method, "success");
    return value;
  } catch (err) {
    recordWalletGatewayRpcMethod(method, "failure");
    throw err;
  }
}

function summarizeWalletGatewayRpcMetrics(): {
  startedAt: string;
  methods: Array<
    {
      method: string;
    } & WalletGatewayRpcMethodMetrics
  >;
} {
  return {
    startedAt: walletGatewayRpcStartedAt,
    methods: [...walletGatewayRpcMetrics.entries()]
      .map(([method, metrics]) => ({ method, ...metrics }))
      .toSorted((left, right) => left.method.localeCompare(right.method)),
  };
}

async function fetchSolanaLamportsViaRpc(params: {
  rpcUrl: string;
  address?: string;
  timeoutMs: number;
}): Promise<string | null> {
  const rpcUrl = String(params.rpcUrl ?? "").trim();
  const address = String(params.address ?? "").trim();
  if (!rpcUrl || !address) {
    return null;
  }
  let release: (() => Promise<void>) | undefined;
  try {
    const guarded = await fetchPinnedSolanaRpcRead({
      rpcUrl,
      timeoutMs: params.timeoutMs,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wallet-balance-fallback",
        method: "getBalance",
        params: [address],
      }),
    });
    release = guarded.release;
    const response = guarded.response;
    if (!response.ok) {
      recordWalletGatewayRpcMethod("direct.getBalance", "failure");
      return null;
    }
    const payload = (await response.json().catch(() => null)) as {
      result?: { value?: unknown };
    } | null;
    const value = payload?.result?.value;
    const ok = typeof value === "number" && Number.isFinite(value);
    recordWalletGatewayRpcMethod("direct.getBalance", ok ? "success" : "failure");
    return ok ? String(value) : null;
  } catch {
    recordWalletGatewayRpcMethod("direct.getBalance", "failure");
    return null;
  } finally {
    await release?.();
  }
}

function resolveWalletProbeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.FASED_WALLET_PROVIDER_PROBE_TIMEOUT_MS ?? ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 3500;
  }
  return Math.max(250, Math.min(20_000, Math.floor(raw)));
}

async function callSatMiningGateway<T>(
  method: string,
  params?: unknown,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const currentConfig = loadConfig();
  const token =
    currentConfig.gateway?.auth?.mode === "token" &&
    typeof currentConfig.gateway.auth.token === "string"
      ? currentConfig.gateway.auth.token.trim() || undefined
      : undefined;
  const url = `ws://localhost:${resolveGatewayPort(currentConfig, process.env)}`;
  return await callGatewayScoped<T>({
    url,
    token,
    config: currentConfig,
    method,
    params,
    scopes: ["operator.admin"],
    deviceAuth: "disabled",
    timeoutMs: typeof opts?.timeoutMs === "number" ? opts.timeoutMs : 15_000,
  });
}

async function readSatMiningStatusPayload(): Promise<Record<string, unknown>> {
  const result = await callSatMiningGateway<{ payload?: unknown }>("sat.getMiningStatus");
  return result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
    ? (result.payload as Record<string, unknown>)
    : {};
}

function readSatMiningWalletIdFromConfig(cfg: ReturnType<typeof loadConfig>): string | undefined {
  const config = cfg.plugins?.entries?.["sat-mining"]?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const walletId = (config as { walletId?: unknown }).walletId;
  return typeof walletId === "string" ? walletId.trim() || undefined : undefined;
}

function resolveMiningAgentWalletConflict(walletId: string | undefined): string | null {
  const normalizedWalletId = walletId?.trim();
  if (!normalizedWalletId) {
    return null;
  }
  const activeMiningWalletId = readSatMiningWalletIdFromConfig(loadConfig());
  if (activeMiningWalletId && activeMiningWalletId !== normalizedWalletId) {
    return `SAT Mining already uses ${activeMiningWalletId}. Archive that singleton wallet before attaching a replacement.`;
  }
  const registry = readWalletProviderRegistry(process.env);
  const wallet = registry.wallets.find((entry) => entry.id === normalizedWalletId);
  const otherMiningWallet = registry.wallets.find(
    (entry) => entry.id !== normalizedWalletId && resolveWalletUserRole(entry) === "mining",
  );
  if (otherMiningWallet) {
    return `SAT Mining already has the singleton wallet ${otherMiningWallet.id}. Archive it before attaching a replacement.`;
  }
  if (!wallet) {
    return "SAT Mining requires an existing dedicated Mining wallet.";
  }
  const purpose = resolveWalletUserRole(wallet);
  if (normalizedWalletId === registry.defaultWalletId || purpose === "agent") {
    return "SAT Mining must use a dedicated Mining wallet. Create a new Mining wallet instead of reusing an Agent wallet.";
  }
  if (purpose && purpose !== "mining") {
    return `SAT Mining must use a Mining wallet. ${wallet?.name ?? normalizedWalletId} is a ${purpose} wallet; create a new Mining wallet instead.`;
  }
  return null;
}

async function withWalletProbeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`wallet probe timeout (${timeoutMs}ms): ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function buildWalletProviderPayload(params: {
  cfg: ReturnType<typeof loadConfig>;
  env?: NodeJS.ProcessEnv;
  includeDerivedWallets?: boolean;
}) {
  const env = params.env ?? process.env;
  const probeTimeoutMs = resolveWalletProbeTimeoutMs(env);
  const walletCfg = resolveWalletRuntimeConfig(params.cfg, env);
  const defaultProviderId = resolveWalletProviderId(params.cfg, env);
  const registry = readWalletProviderRegistry(env);
  const providers: WalletProviderSummary[] = await Promise.all(
    WALLET_PROVIDER_IDS.map(async (providerId) => {
      let operationsImplemented = false;
      let capabilities: WalletProviderCapabilityMatrix = {
        providerId,
        supportedChains: [],
        integrationMode: "native",
        signingLocation: "unavailable",
        signing: {
          transaction: false,
          message: false,
          interactiveSend: false,
        },
        operations: {
          createWallet: false,
          receiveAddress: false,
          getBalance: false,
          prepare: false,
          send: false,
          deposit: false,
          withdraw: false,
          rotateKeys: false,
          resetKeys: false,
        },
        chains: {
          solana: { receiveAddress: false, getBalance: false, prepare: false, send: false },
        },
        requiresCredentials:
          providerId !== "local-socket-signer" && providerId !== "wallet-standard",
        requiresRpcSecret: false,
      };
      let health: WalletProviderSummary["health"] = {
        ok: false,
        details: "provider unavailable",
      };
      try {
        const adapter = createWalletProviderAdapter({
          cfg: params.cfg,
          wallet: walletCfg,
          env,
          providerIdOverride: providerId,
        });
        capabilities = buildWalletProviderCapabilityMatrix(adapter);
        operationsImplemented =
          providerId === "local-socket-signer" ||
          (adapter.capabilities.supportsPrepare && adapter.capabilities.supportsSend) ||
          capabilities.signing.interactiveSend;
        const healthResult = await withWalletProbeTimeout(
          adapter.health(),
          probeTimeoutMs,
          `provider.health:${providerId}`,
        );
        health = { ok: healthResult.ok, details: healthResult.details };
      } catch (err) {
        health = { ok: false, details: String(err) };
      }
      const credentials = resolveProviderCredentialStatus({
        providerId,
        wallet: walletCfg,
        env,
      });
      return {
        id: providerId,
        enabled: registry.providers[providerId]?.enabled ?? false,
        label: registry.providers[providerId]?.label,
        isDefault: providerId === defaultProviderId,
        operationsImplemented,
        capabilities,
        credentialsConfigured: credentials.configured,
        credentialsSource: credentials.source,
        health,
        providerAuthDiagnosis: undefined,
      };
    }),
  );
  const wallets: WalletRegistryWalletSummary[] = await Promise.all(
    registry.wallets.map(async (wallet) => {
      let balances: WalletRegistryWalletSummary["balances"] = undefined;
      const readiness: WalletRegistryWalletSummary["readiness"] = {
        keystore: false,
        rpc: false,
      };

      try {
        const adapter = createWalletProviderAdapter({
          cfg: params.cfg,
          wallet: { ...walletCfg, enabled: true }, // Ensure we can probe even if globably disabled
          env,
          providerIdOverride: wallet.providerId,
          walletId: wallet.id,
        });

        // 1. Keystore / API Health
        const providerHealth = await withWalletProbeTimeout(
          adapter.health(),
          probeTimeoutMs,
          `wallet.health:${wallet.id}`,
        );
        readiness.keystore = providerHealth.ok;
        readiness.api = providerHealth.configured;

        // 2. RPC Health & Balances
        const chains = adapter.capabilities.supportedChains;
        const balanceMap: Record<string, string> = {};
        let rpcOk = true;

        const chainResults = await Promise.all(
          chains.map(async (chain) => {
            try {
              const balance = await withWalletProbeTimeout(
                recordWalletGatewayRpc(
                  `provider.getBalance.${chain}`,
                  adapter.getBalance(chain, { walletId: wallet.id }),
                ),
                probeTimeoutMs,
                `wallet.balance:${wallet.id}:${chain}`,
              );
              return { chain, balance };
            } catch {
              return { chain, balance: null };
            }
          }),
        );
        for (const result of chainResults) {
          if (!result.balance || !result.balance.ok) {
            rpcOk = false;
            continue;
          }
          balanceMap[result.chain] = result.balance.balance;
        }
        readiness.rpc = rpcOk;
        if (Object.keys(balanceMap).length > 0) {
          balances = balanceMap;
        }

        // 3. Solana ATA Check (if applicable)
        if (chains.includes("solana") && wallet.addresses?.solana) {
          readiness.ata = await checkSolanaAtaReadiness(wallet.addresses.solana, env);
        }
      } catch {
        // Best effort
      }

      return {
        id: wallet.id,
        name: wallet.name,
        providerId: wallet.providerId,
        addresses: wallet.addresses,
        balances,
        readiness,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      };
    }),
  );

  if (params.includeDerivedWallets) {
    // Optional debug discovery path for operators; normal UI only shows named user wallets.
    const representedProviders = new Set(wallets.map((wallet) => wallet.providerId));
    const discoveredWallets: Array<WalletRegistryWalletSummary | null> = await Promise.all(
      WALLET_PROVIDER_IDS.map(async (providerId) => {
        const providerCfg = registry.providers[providerId];
        const isDefaultProvider = providerId === defaultProviderId;
        if (!providerCfg?.enabled && !isDefaultProvider) {
          return null;
        }
        if (representedProviders.has(providerId)) {
          return null;
        }

        try {
          const adapter = createWalletProviderAdapter({
            cfg: params.cfg,
            wallet: { ...walletCfg, enabled: true },
            env,
            providerIdOverride: providerId,
          });
          const readiness: WalletRegistryWalletSummary["readiness"] = {
            keystore: false,
            rpc: false,
          };
          try {
            const health = await withWalletProbeTimeout(
              adapter.health(),
              probeTimeoutMs,
              `provider.discovery.health:${providerId}`,
            );
            readiness.keystore = health.ok;
            readiness.api = health.configured;
          } catch {
            // Best effort.
          }

          let addresses: WalletRegistryWalletSummary["addresses"];
          try {
            addresses = await withWalletProbeTimeout(
              adapter.getAddresses(),
              probeTimeoutMs,
              `provider.discovery.addresses:${providerId}`,
            );
          } catch {
            addresses = undefined;
          }

          const chains = adapter.capabilities.supportedChains;
          const balanceMap: Record<string, string> = {};
          let rpcOk = true;
          const chainResults = await Promise.all(
            chains.map(async (chain) => {
              try {
                const balance = await withWalletProbeTimeout(
                  recordWalletGatewayRpc(
                    `provider.discovery.getBalance.${chain}`,
                    adapter.getBalance(chain),
                  ),
                  probeTimeoutMs,
                  `provider.discovery.balance:${providerId}:${chain}`,
                );
                return { chain, balance };
              } catch {
                return { chain, balance: null };
              }
            }),
          );
          for (const result of chainResults) {
            if (!result.balance || !result.balance.ok) {
              rpcOk = false;
              continue;
            }
            balanceMap[result.chain] = result.balance.balance;
          }
          readiness.rpc = rpcOk;

          if (!addresses?.solana && !isDefaultProvider) {
            return null;
          }
          return {
            id: `auto_${providerId}`,
            name: registry.providers[providerId]?.label || providerId,
            providerId,
            addresses,
            balances: Object.keys(balanceMap).length > 0 ? balanceMap : undefined,
            readiness,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } satisfies WalletRegistryWalletSummary;
        } catch {
          if (!isDefaultProvider) {
            return null;
          }
          return {
            id: `auto_${providerId}`,
            name: registry.providers[providerId]?.label || providerId,
            providerId,
            readiness: { keystore: false, rpc: false },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          } satisfies WalletRegistryWalletSummary;
        }
      }),
    );
    wallets.push(
      ...discoveredWallets.filter(
        (wallet): wallet is WalletRegistryWalletSummary => wallet !== null,
      ),
    );
  }

  return {
    providers,
    wallets,
    assignments: registry.assignments,
    defaultWalletId: registry.defaultWalletId,
    defaultProviderId,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Basic Solana ATA readiness check.
 * Checks if a USDC Associated Token Account exists for the given address.
 */
async function checkSolanaAtaReadiness(address: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const rpcUrl =
    String(env.FASED_WALLET_SOLANA_RPC_URL ?? "").trim() ||
    String(env.FASED_WALLET_RPC_URL ?? "").trim();
  if (!rpcUrl) {
    return false;
  }

  try {
    // USDC mint on Solana Mainnet
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // pragma: allowlist secret

    // Construct the request to getTokenAccountsByOwner
    const guarded = await fetchPinnedSolanaRpcRead({
      rpcUrl,
      timeoutMs: 10_000,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [address, { mint: USDC_MINT }, { encoding: "jsonParsed" }],
      }),
    });
    try {
      if (!guarded.response.ok) {
        recordWalletGatewayRpcMethod("direct.getTokenAccountsByOwner", "failure");
        return false;
      }
      const payload = await guarded.response.json();
      const accounts = payload?.result?.value;
      const ok = Array.isArray(accounts);
      recordWalletGatewayRpcMethod("direct.getTokenAccountsByOwner", ok ? "success" : "failure");
      return ok && accounts.length > 0;
    } finally {
      await guarded.release();
    }
  } catch {
    recordWalletGatewayRpcMethod("direct.getTokenAccountsByOwner", "failure");
    return false;
  }
}

async function updateWalletConfig(params: {
  env: NodeJS.ProcessEnv;
  mutate: (cfg: ReturnType<typeof loadConfig>) => void;
}): Promise<{ ok: true; cfg: ReturnType<typeof loadConfig> } | { ok: false; message: string }> {
  const writeSnapshot = await readConfigFileSnapshotForWrite();
  const baseConfig = structuredClone(writeSnapshot.snapshot.resolved ?? {});
  migrateWalletApprovalAuthFromEnvIfNeeded(baseConfig, params.env);
  try {
    params.mutate(baseConfig);
  } catch (err) {
    return { ok: false, message: String(err) };
  }
  const validated = validateConfigObjectWithPlugins(baseConfig);
  if (!validated.ok) {
    const detail = validated.issues
      .slice(0, 3)
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: detail || "invalid wallet config patch" };
  }
  await writeConfigFile(validated.config, writeSnapshot.writeOptions);
  const activated = await activateLatestWalletRuntimeConfig();
  return { ok: true, cfg: activated };
}

async function activateLatestWalletRuntimeConfig(): Promise<ReturnType<typeof loadConfig>> {
  const latest = await readConfigFileSnapshotForWrite();
  if (!latest.snapshot.valid) {
    throw new Error("wallet config write produced an invalid runtime snapshot");
  }
  setRuntimeConfigSnapshot(latest.snapshot.config, latest.snapshot.resolved);
  return latest.snapshot.config;
}

type FederationBondWalletInput = {
  walletId?: string | null;
};

type FederationBondMutationInput = {
  walletId?: string;
  amountSat?: string;
  tier?: "basic-bond" | "operator-bond";
  autoSubmitProof?: boolean;
  idempotencyKey?: string;
};

function parseFederationBondWalletInput(input: unknown): FederationBondWalletInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const body = input as Record<string, unknown>;
  if (body.walletId === null) {
    return { walletId: null };
  }
  return {
    walletId: typeof body.walletId === "string" ? body.walletId.trim() || undefined : undefined,
  };
}

function parseFederationBondMutationInput(input: unknown): FederationBondMutationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const body = input as Record<string, unknown>;
  return {
    walletId: typeof body.walletId === "string" ? body.walletId.trim() || undefined : undefined,
    amountSat: typeof body.amountSat === "string" ? body.amountSat.trim() || undefined : undefined,
    tier: body.tier === "basic-bond" || body.tier === "operator-bond" ? body.tier : undefined,
    autoSubmitProof: typeof body.autoSubmitProof === "boolean" ? body.autoSubmitProof : undefined,
    idempotencyKey:
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() || undefined : undefined,
  };
}

function normalizeFederationBondIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[^\x20-\x7e]/u.test(normalized)) {
    throw new Error("idempotency key must contain 1-160 printable characters");
  }
  return normalized;
}

function validateFederationBondVaultWallet(
  cfg: ReturnType<typeof loadConfig>,
  walletId: string,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const registry = readWalletProviderRegistry(process.env);
  const wallet = registry.wallets.find((entry) => entry.id === walletId);
  if (!wallet) {
    return {
      ok: false,
      status: 404,
      code: "wallet_not_found",
      message: "walletId not found",
    };
  }
  if (!wallet.addresses?.solana?.trim()) {
    return {
      ok: false,
      status: 400,
      code: "bond_wallet_requires_solana",
      message: "Federation bond requires a Vault wallet with a Solana address.",
    };
  }
  const purpose = resolveWalletUserRole(wallet);
  const activeMiningWalletId = readSatMiningWalletIdFromConfig(cfg);
  if (walletId === activeMiningWalletId || purpose === "mining") {
    return {
      ok: false,
      status: 400,
      code: "bond_wallet_mining_rejected",
      message: "Federation bond cannot use the Mining wallet. Create or select a Vault wallet.",
    };
  }
  if (walletId === registry.defaultWalletId || purpose === "agent") {
    return {
      ok: false,
      status: 400,
      code: "bond_wallet_agent_rejected",
      message: "Federation bond cannot use an Agent wallet. Create or select a Vault wallet.",
    };
  }
  if (purpose !== "vault") {
    return {
      ok: false,
      status: 400,
      code: "bond_wallet_vault_required",
      message: "Federation bond requires a Vault wallet.",
    };
  }
  return { ok: true };
}

function applyFederationBondWalletConfig(
  cfg: ReturnType<typeof loadConfig>,
  walletId?: string | null,
): void {
  if (walletId) {
    cfg.federation = cfg.federation ?? {};
    cfg.federation.bond = cfg.federation.bond ?? {};
    cfg.federation.bond.walletId = walletId;
    return;
  }
  if (cfg.federation?.bond) {
    delete cfg.federation.bond.walletId;
    if (Object.keys(cfg.federation.bond).length === 0) {
      delete cfg.federation.bond;
    }
  }
  if (cfg.federation && Object.keys(cfg.federation).length === 0) {
    delete cfg.federation;
  }
}

function buildSatWalletOverrideConfig(
  cfg: ReturnType<typeof loadConfig>,
  walletId: string,
): ReturnType<typeof loadConfig> {
  const next = structuredClone(cfg);
  next.plugins = next.plugins ?? {};
  next.plugins.entries = next.plugins.entries ?? {};
  const currentEntry = next.plugins.entries["sat-mining"];
  const currentConfig =
    currentEntry?.config &&
    typeof currentEntry.config === "object" &&
    !Array.isArray(currentEntry.config)
      ? currentEntry.config
      : {};
  next.plugins.entries["sat-mining"] = {
    enabled: true,
    ...currentEntry,
    config: {
      ...currentConfig,
      walletId,
    },
  };
  return next;
}

function resolveFederationBondDefaultWalletId(
  cfg: ReturnType<typeof loadConfig>,
): string | undefined {
  return resolveFederationBondWalletId({ cfg, env: process.env }) || undefined;
}

function resolveDefaultBondAmountSat(tier: FederationBondMutationInput["tier"]): string {
  return tier === "operator-bond" ? "500" : "25";
}

function resolveEffectiveBondStakingMinRaw(rawInput: string | undefined): string {
  const operatorMinRaw = "50000000000000";
  try {
    const configured = BigInt(rawInput?.trim() || "0");
    const operatorMin = BigInt(operatorMinRaw);
    return (configured >= operatorMin ? configured : operatorMin).toString();
  } catch {
    return operatorMinRaw;
  }
}

function isPositiveSatRawAmount(rawInput: string | undefined): boolean {
  try {
    return BigInt(rawInput?.trim() || "0") > 0n;
  } catch {
    return false;
  }
}

function isSolanaRpcRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /-32429|rate limited|too many requests|http\s*429|\b429\b/i.test(message);
}

async function retrySolanaRateLimit<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await retryAsync(fn, {
      label,
      attempts: 4,
      minDelayMs: 900,
      maxDelayMs: 5_000,
      jitter: 0.25,
      shouldRetry: (error) => isSolanaRpcRateLimitError(error),
    });
  } catch (error) {
    if (isSolanaRpcRateLimitError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${label} hit the Solana RPC rate limit after retries. Wait a few seconds and retry. ${message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function invalidateFederationBondReadCaches(): void {
  invalidateSatReadCaches();
  invalidateSolanaAssetRpcCaches();
}

const BOND_STAKING_REWARD_INDEX_SCALE = 1_000_000_000_000_000_000n;

function parseSatRawBigInt(rawInput: string | undefined): bigint | null {
  try {
    const raw = BigInt(rawInput?.trim() || "0");
    return raw >= 0n ? raw : null;
  } catch {
    return null;
  }
}

function estimateBondStakingClaimRaw(
  position:
    | { activeStakeRaw?: string; claimableRewardRaw?: string; rewardDebtFp?: string }
    | null
    | undefined,
  distributor:
    | {
        observedRewardVaultRaw?: string;
        rewardVaultBalanceRaw?: string;
        totalActiveStakeRaw?: string;
        rewardIndexFp?: string;
      }
    | null
    | undefined,
): string | undefined {
  let claimable = parseSatRawBigInt(position?.claimableRewardRaw) ?? 0n;
  const activeStake = parseSatRawBigInt(position?.activeStakeRaw) ?? 0n;
  const totalStake = parseSatRawBigInt(distributor?.totalActiveStakeRaw) ?? 0n;
  const rewardIndex = parseSatRawBigInt(distributor?.rewardIndexFp) ?? 0n;
  const rewardDebt = parseSatRawBigInt(position?.rewardDebtFp) ?? 0n;
  if (activeStake > 0n && rewardIndex > 0n) {
    const currentDebt = activeStake * rewardIndex;
    if (currentDebt > rewardDebt) {
      claimable += (currentDebt - rewardDebt) / BOND_STAKING_REWARD_INDEX_SCALE;
    }
  }
  const observedVault = parseSatRawBigInt(distributor?.observedRewardVaultRaw) ?? 0n;
  const liveVault = parseSatRawBigInt(distributor?.rewardVaultBalanceRaw) ?? observedVault;
  if (activeStake > 0n && totalStake > 0n && liveVault > observedVault) {
    const rewardDelta = liveVault - observedVault;
    const indexDelta = (rewardDelta * BOND_STAKING_REWARD_INDEX_SCALE) / totalStake;
    claimable += (activeStake * indexDelta) / BOND_STAKING_REWARD_INDEX_SCALE;
  }
  if (liveVault > 0n && claimable > liveVault) {
    claimable = liveVault;
  }
  return claimable > 0n ? claimable.toString() : undefined;
}

function appendActionWarning(current: string | undefined, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) {
    return current ?? "";
  }
  return current?.trim() ? `${current.trim()} ${trimmed}` : trimmed;
}

function parseSatAmountToRawNumber(amountSatInput: string): {
  amountRaw: string;
  safeInteger: number;
} {
  const normalized = amountSatInput.trim();
  if (!normalized || !/^\d+(\.\d{0,11})?$/.test(normalized)) {
    throw new Error("amountSat must be a positive decimal with up to 11 SAT decimals");
  }
  const [wholePart, fractionPart = ""] = normalized.split(".");
  const raw =
    BigInt(wholePart || "0") * 100_000_000_000n +
    BigInt((fractionPart + "00000000000").slice(0, 11) || "0");
  if (raw <= 0n) {
    throw new Error("amountSat must be greater than zero");
  }
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("amountSat is too large for the current gateway bond action path");
  }
  return {
    amountRaw: raw.toString(),
    safeInteger: Number(raw),
  };
}

async function runFederationBondProof(params: {
  cfg: ReturnType<typeof loadConfig>;
  walletId: string;
  liveBond?: Awaited<ReturnType<typeof inspectSatBondPosition>> | null;
}) {
  const bondView =
    params.liveBond ??
    (await resolveFederationBondWallet({
      env: process.env,
      cfg: params.cfg,
      walletId: params.walletId,
    }).then(
      async (wallet) =>
        await inspectSatBondPosition(params.cfg as never, { authority: wallet.walletAddress }),
    ));
  if (!bondView || bondView.statusLabel !== "active") {
    throw new Error("active SAT bond not found for proof submission");
  }
  const pendingProof = await loadPersistedFederationBondProof(process.env);
  if (
    pendingProof &&
    pendingProof.walletId === params.walletId &&
    pendingProof.bondId === bondView.address &&
    pendingProof.bondAmountRaw === bondView.amountRaw &&
    pendingProof.bondTier === bondView.tierLabel &&
    Date.parse(pendingProof.expiresAt) > Date.now()
  ) {
    if (pendingProof.verifiedAt) {
      return { proof: pendingProof };
    }
    return await submitFederationBondProof({
      env: process.env,
      cfg: params.cfg,
      proof: pendingProof,
    });
  }
  return await createAndSubmitFederationBondProof({
    env: process.env,
    cfg: params.cfg,
    walletId: params.walletId,
    bondId: bondView.address,
    amountRaw: bondView.amountRaw,
    tier: bondView.tierLabel,
  });
}

async function tryRunFederationBondProof(params: {
  cfg: ReturnType<typeof loadConfig>;
  walletId: string;
  liveBond?: Awaited<ReturnType<typeof inspectSatBondPosition>> | null;
}): Promise<{ submitted: boolean; warning?: string }> {
  try {
    await runFederationBondProof(params);
    return { submitted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      submitted: false,
      warning: `Bond transaction succeeded, but federation proof refresh is pending: ${message}`,
    };
  }
}

async function probeHostedFederationUrl(
  publicUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FederationHostedProbePayload> {
  const checkedAt = new Date().toISOString();
  let agentCardUrl = publicUrl;
  try {
    agentCardUrl = new URL("/.well-known/agent.json", publicUrl).toString();
  } catch {
    return {
      state: "broken",
      checkedAt,
      publicUrl,
      agentCardUrl,
      reason: "invalid public URL",
    };
  }
  try {
    const response = await fetchImpl(agentCardUrl, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(2_500),
    });
    const text = await response.text();
    if (!response.ok) {
      const normalized = text.toLowerCase();
      const shareMissing = normalized.includes("share") && normalized.includes("not found");
      return {
        state: "broken",
        checkedAt,
        publicUrl,
        agentCardUrl,
        statusCode: response.status,
        reason: shareMissing
          ? "public share not found"
          : `agent card returned HTTP ${response.status}`,
      };
    }
    let parsed: unknown = null;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      parsed = null;
    }
    if (!isPlainObject(parsed)) {
      return {
        state: "broken",
        checkedAt,
        publicUrl,
        agentCardUrl,
        statusCode: response.status,
        reason: "agent card returned invalid JSON",
      };
    }
    return {
      state: "healthy",
      checkedAt,
      publicUrl,
      agentCardUrl,
      statusCode: response.status,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "TimeoutError"
          ? "public URL probe timed out"
          : error.message || "public URL probe failed"
        : String(error);
    return {
      state: "broken",
      checkedAt,
      publicUrl,
      agentCardUrl,
      reason: message,
    };
  }
}

function deriveFederationSellerLane(params: {
  token?: FederationStatusToken;
  bond?: FederationStatusBond;
  hostedProbe?: FederationHostedProbePayload;
}): FederationSellerLanePayload | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bond = params.bond;
  const derivedScopes = bond?.derivedScopes ?? token.bondDerivedScopes ?? [];
  const bondStatus = bond?.status ?? token.bondStatus ?? "missing";
  const bondTier = bond?.tier ?? token.bondTier ?? "none";
  const endpointHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : Boolean(token.publicUrl?.trim());
  const hasPublishScope = derivedScopes.includes("offers.publish");
  const activeBond = bondStatus === "active" && hasPublishScope;
  const hasBondHistory =
    Boolean(token.bondId || bond?.bondId) ||
    bondTier === "basic-bond" ||
    bondTier === "operator-bond" ||
    bondStatus === "unlocking" ||
    bondStatus === "unlocked";
  const reasons: string[] = [];

  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      visibility: "hidden",
      reasons: [`trust state is ${trustState}`],
      endpointHealthy,
    };
  }
  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!activeBond) {
    reasons.push("active bond with offers.publish is required");
  }
  if (!endpointHealthy) {
    reasons.push("public endpoint health is missing");
  }
  if (trustState === "verified" && activeBond && endpointHealthy) {
    return {
      status: "bonded-public",
      eligible: true,
      visibility: "public",
      reasons: [],
      endpointHealthy,
    };
  }
  if (trustState === "verified" && (hasBondHistory || Boolean(token.publicUrl?.trim()))) {
    return {
      status: "degraded",
      eligible: false,
      visibility: "degraded",
      reasons,
      endpointHealthy,
    };
  }
  return {
    status: "draft",
    eligible: false,
    visibility: "hidden",
    reasons,
    endpointHealthy,
  };
}

function deriveFederationRoutingCapacity(params: {
  token?: FederationStatusToken;
  bond?: FederationStatusBond;
  hostedProbe?: FederationHostedProbePayload;
}): FederationRoutingCapacityPayload | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bond = params.bond;
  const derivedScopes = bond?.derivedScopes ?? token.bondDerivedScopes ?? [];
  const bondStatus = bond?.status ?? token.bondStatus ?? "missing";
  const quotaBand = bond?.quotaBand ?? token.bondQuotaBand ?? "standard";
  const endpointHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : Boolean(token.publicUrl?.trim());
  const hasRoutingScope = derivedScopes.includes("routing.capacity.basic");
  const activeBond = bondStatus === "active" && hasRoutingScope;
  const hasRoutingHistory =
    hasRoutingScope ||
    token.bondTier === "operator-bond" ||
    quotaBand === "operator" ||
    bondStatus === "unlocking" ||
    bondStatus === "unlocked";
  const reasons: string[] = [];

  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      intake: "blocked",
      reasons: [`trust state is ${trustState}`],
      endpointHealthy,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasRoutingScope,
        activeBond,
      },
    };
  }
  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!hasRoutingScope) {
    reasons.push("active operator bond with routing.capacity.basic is required");
  }
  if (quotaBand !== "operator") {
    reasons.push("operator quota band is required");
  }
  if (!endpointHealthy) {
    reasons.push("public endpoint health is missing");
  }
  if (trustState === "verified" && activeBond && quotaBand === "operator" && endpointHealthy) {
    return {
      status: "routing-basic",
      eligible: true,
      intake: "priority",
      reasons: [],
      endpointHealthy,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasRoutingScope,
        activeBond,
      },
    };
  }
  if (trustState === "verified" && (hasRoutingHistory || Boolean(token.publicUrl?.trim()))) {
    return {
      status: "degraded",
      eligible: false,
      intake: endpointHealthy ? "reduced" : "blocked",
      reasons,
      endpointHealthy,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasRoutingScope,
        activeBond,
      },
    };
  }
  return {
    status: "standard",
    eligible: false,
    intake: "standard",
    reasons,
    endpointHealthy,
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      hasRoutingScope,
      activeBond,
    },
  };
}

function deriveFederationHostedEdge(params: {
  token?: FederationStatusToken;
  bond?: FederationStatusBond;
  hostedProbe?: FederationHostedProbePayload;
}): FederationHostedEdgePayload | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bond = params.bond;
  const bondStatus = bond?.status ?? token.bondStatus ?? "missing";
  const quotaBand = bond?.quotaBand ?? token.bondQuotaBand ?? "standard";
  const hostedState = token.hostedState ?? "disabled";
  const managedPublicUrl = token.publicUrl?.trim() || "";
  const hasManagedUrl = managedPublicUrl.length > 0;
  const hasManagedAttachment = token.zrokTokenPresent === true || Boolean(token.agentSlug?.trim());
  const activeBond =
    bondStatus === "active" && (token.bondTier === "operator-bond" || quotaBand === "operator");
  const routeHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : hasManagedUrl
      ? undefined
      : false;
  const reasons: string[] = [];

  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      exposure: "blocked",
      reasons: [`trust state is ${trustState}`],
      ...(managedPublicUrl ? { managedPublicUrl } : {}),
      ...(routeHealthy !== undefined ? { routeHealthy } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hostedState,
        hasManagedUrl,
        hasManagedAttachment,
        activeBond,
      },
    };
  }

  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!activeBond) {
    reasons.push("active operator bond is required");
  }
  if (hostedState !== "ready") {
    reasons.push("hosted state is not ready");
  }
  if (!hasManagedUrl) {
    reasons.push("managed public URL is missing");
  }
  if (!hasManagedAttachment) {
    reasons.push("managed edge attachment is not present");
  }
  if (routeHealthy === false) {
    reasons.push("managed public route health is broken");
  }

  if (
    trustState === "verified" &&
    activeBond &&
    hostedState === "ready" &&
    hasManagedUrl &&
    hasManagedAttachment &&
    routeHealthy !== false
  ) {
    return {
      status: "managed-edge",
      eligible: true,
      exposure: "managed-public",
      reasons: [],
      managedPublicUrl,
      ...(routeHealthy !== undefined ? { routeHealthy } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hostedState,
        hasManagedUrl,
        hasManagedAttachment,
        activeBond,
      },
    };
  }

  if (
    trustState === "verified" &&
    (hasManagedUrl || hasManagedAttachment || hostedState === "pending" || hostedState === "ready")
  ) {
    return {
      status: "degraded",
      eligible: false,
      exposure: routeHealthy === false ? "blocked" : "degraded",
      reasons,
      ...(managedPublicUrl ? { managedPublicUrl } : {}),
      ...(routeHealthy !== undefined ? { routeHealthy } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hostedState,
        hasManagedUrl,
        hasManagedAttachment,
        activeBond,
      },
    };
  }

  return {
    status: "standard",
    eligible: false,
    exposure: "local-only",
    reasons,
    ...(managedPublicUrl ? { managedPublicUrl } : {}),
    ...(routeHealthy !== undefined ? { routeHealthy } : {}),
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      hostedState,
      hasManagedUrl,
      hasManagedAttachment,
      activeBond,
    },
  };
}

const DIRECTORY_INDEX_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function deriveFederationDirectoryIndexer(params: {
  token?: FederationStatusToken;
  bond?: FederationStatusBond;
}): FederationDirectoryIndexerPayload | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bond = params.bond;
  const derivedScopes = bond?.derivedScopes ?? token.bondDerivedScopes ?? [];
  const bondStatus = bond?.status ?? token.bondStatus ?? "missing";
  const quotaBand = bond?.quotaBand ?? token.bondQuotaBand ?? "standard";
  const hasDirectoryScope = derivedScopes.includes("directory.priority.basic");
  const activeBond = bondStatus === "active" && hasDirectoryScope;
  const freshnessRef = token.lastAttestOrRenewAt?.trim() || token.issuedAt?.trim() || "";
  const freshnessMs = freshnessRef ? Date.parse(freshnessRef) : Number.NaN;
  const lastSeenAgeMs = Number.isFinite(freshnessMs) ? Math.max(0, Date.now() - freshnessMs) : null;
  const freshness =
    lastSeenAgeMs === null
      ? "missing"
      : lastSeenAgeMs <= DIRECTORY_INDEX_FRESHNESS_MS
        ? "fresh"
        : "stale";
  const hasIndexerHistory =
    hasDirectoryScope ||
    token.bondTier === "operator-bond" ||
    quotaBand === "operator" ||
    bondStatus === "unlocking" ||
    bondStatus === "unlocked" ||
    Boolean(freshnessRef);
  const reasons: string[] = [];

  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      surface: "blocked",
      reasons: [`trust state is ${trustState}`],
      ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasDirectoryScope,
        activeBond,
        freshness,
        ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
      },
    };
  }

  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!hasDirectoryScope) {
    reasons.push("active operator bond with directory.priority.basic is required");
  }
  if (quotaBand !== "operator") {
    reasons.push("operator quota band is required");
  }
  if (freshness !== "fresh") {
    reasons.push(
      freshness === "stale"
        ? "directory record freshness is stale"
        : "directory freshness is unknown",
    );
  }

  if (
    trustState === "verified" &&
    activeBond &&
    quotaBand === "operator" &&
    freshness === "fresh"
  ) {
    return {
      status: "index-basic",
      eligible: true,
      surface: "mirrored-public",
      reasons: [],
      ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasDirectoryScope,
        activeBond,
        freshness,
        ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
      },
    };
  }

  if (trustState === "verified" && hasIndexerHistory) {
    return {
      status: "degraded",
      eligible: false,
      surface: freshness === "stale" ? "stale" : "canonical-only",
      reasons,
      ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasDirectoryScope,
        activeBond,
        freshness,
        ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
      },
    };
  }

  return {
    status: "standard",
    eligible: false,
    surface: "canonical-only",
    reasons,
    ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      hasDirectoryScope,
      activeBond,
      freshness,
      ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
    },
  };
}

function deriveFederationArtifactAvailability(params: {
  token?: FederationStatusToken;
  bond?: FederationStatusBond;
  hostedProbe?: FederationHostedProbePayload;
  sellerLane?: FederationSellerLanePayload;
  hostedEdge?: FederationHostedEdgePayload;
  directoryIndexer?: FederationDirectoryIndexerPayload;
}): FederationArtifactAvailabilityPayload | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bond = params.bond;
  const bondStatus = bond?.status ?? token.bondStatus ?? "missing";
  const quotaBand = bond?.quotaBand ?? token.bondQuotaBand ?? "standard";
  const activeBond =
    bondStatus === "active" && (token.bondTier === "operator-bond" || quotaBand === "operator");
  const endpointHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : Boolean(token.publicUrl?.trim());
  const sellerSurface = params.sellerLane?.eligible === true;
  const hostedSurface = params.hostedEdge?.eligible === true;
  const directorySurface = params.directoryIndexer?.eligible === true;
  const shareableSurface = sellerSurface || hostedSurface || directorySurface;
  const replicationSurfaceCount =
    Number(sellerSurface) + Number(hostedSurface) + Number(directorySurface);
  const replicationClass =
    replicationSurfaceCount >= 2 ? "multi-surface" : shareableSurface ? "single-surface" : "none";
  const integrityMode = shareableSurface ? "declared" : "unknown";
  const hasAvailabilityHistory =
    shareableSurface ||
    token.bondTier === "operator-bond" ||
    quotaBand === "operator" ||
    bondStatus === "unlocking" ||
    bondStatus === "unlocked" ||
    Boolean(token.publicUrl?.trim());
  const reasons: string[] = [];

  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      retrieval: "blocked",
      reasons: [`trust state is ${trustState}`],
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        activeBond,
        endpointHealthy,
        shareableSurface,
        integrityMode,
        replicationClass,
      },
    };
  }
  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!activeBond) {
    reasons.push("active operator bond is required");
  }
  if (!shareableSurface) {
    reasons.push("no approved shareable artifact surface is active");
  }
  if (integrityMode !== "declared") {
    reasons.push("artifact integrity mode is not declared");
  }

  if (trustState === "verified" && activeBond && shareableSurface && integrityMode === "declared") {
    return {
      status: "availability-basic",
      eligible: true,
      retrieval: "shareable-public",
      reasons: [],
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        activeBond,
        endpointHealthy,
        shareableSurface,
        integrityMode,
        replicationClass,
      },
    };
  }

  if (trustState === "verified" && hasAvailabilityHistory) {
    return {
      status: "degraded",
      eligible: false,
      retrieval: shareableSurface || endpointHealthy ? "degraded" : "local-only",
      reasons,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        activeBond,
        endpointHealthy,
        shareableSurface,
        integrityMode,
        replicationClass,
      },
    };
  }

  return {
    status: "standard",
    eligible: false,
    retrieval: "local-only",
    reasons,
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      activeBond,
      endpointHealthy,
      shareableSurface,
      integrityMode,
      replicationClass,
    },
  };
}

function resolveConfiguredFederationStatus(
  env: NodeJS.ProcessEnv = process.env,
): NonNullable<FederationStatusPayload["configured"]> {
  const autoConnectRaw = String(env.FASED_FEDERATION_AUTO_CONNECT ?? "")
    .trim()
    .toLowerCase();
  const autoConnect = !["0", "false", "off", "no"].includes(autoConnectRaw);
  const baseUrl = resolveFederationBaseUrl(env);
  const fallbackDomain = baseUrl ? new URL(baseUrl).hostname : "localhost";
  const handle = resolveFederationHandle({ env, fallbackDomain }).trim();
  const nodeEndpoint = resolveAgentPublicOrigin(env).trim();
  return {
    autoConnect,
    ...(baseUrl ? { baseUrl } : {}),
    ...(handle ? { handle } : {}),
    ...(nodeEndpoint ? { nodeEndpoint } : {}),
  };
}

async function readLocalFederationStatus(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<FederationStatusPayload> {
  const checkedAt = new Date().toISOString();
  const sourcePath = path.join(resolveStateDir(env), "federation", "access-token.json");
  const managed = (env.FASED_GATEWAY_MODE ?? "").trim().toLowerCase() === "managed";
  const configured = resolveConfiguredFederationStatus(env);
  if (!fs.existsSync(sourcePath)) {
    return {
      managed,
      sourcePath,
      joined: false,
      lifecycle: "missing",
      checkedAt,
      configured,
    };
  }

  let rawText = "";
  try {
    rawText = fs.readFileSync(sourcePath, "utf-8");
  } catch {
    return {
      managed,
      sourcePath,
      joined: false,
      lifecycle: "invalid",
      checkedAt,
      configured,
    };
  }

  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(rawText) as unknown;
    if (!value || typeof value !== "object") {
      throw new Error("invalid token payload");
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return {
      managed,
      sourcePath,
      joined: false,
      lifecycle: "invalid",
      checkedAt,
      configured,
    };
  }

  const tokenId = typeof parsed.tokenId === "string" ? parsed.tokenId.trim() : "";
  const nodeId = typeof parsed.nodeId === "string" ? parsed.nodeId.trim() : "";
  const handle = typeof parsed.handle === "string" ? parsed.handle.trim() : "";
  const issuedAt = typeof parsed.issuedAt === "string" ? parsed.issuedAt.trim() : "";
  const expiresAt = typeof parsed.expiresAt === "string" ? parsed.expiresAt.trim() : "";
  const signature = typeof parsed.signature === "string" ? parsed.signature.trim() : "";
  if (!tokenId || !nodeId || !handle || !issuedAt || !expiresAt || !signature) {
    return {
      managed,
      sourcePath,
      joined: false,
      lifecycle: "invalid",
      checkedAt,
      configured,
    };
  }

  const scopes = Array.isArray(parsed.scopes)
    ? parsed.scopes.filter((value): value is string => typeof value === "string")
    : [];
  const expiresAtMs = Date.parse(expiresAt);
  const lifecycle: FederationStatusPayload["lifecycle"] = Number.isFinite(expiresAtMs)
    ? expiresAtMs > Date.now()
      ? "active"
      : "expired"
    : "invalid";

  let fileUpdatedAt: string | undefined;
  try {
    fileUpdatedAt = fs.statSync(sourcePath).mtime.toISOString();
  } catch {
    fileUpdatedAt = undefined;
  }

  const token: FederationStatusToken = {
    tokenId,
    nodeId,
    handle,
    issuedAt,
    expiresAt,
    scopes,
    signature,
    trustState:
      parsed.trustState === "pending" ||
      parsed.trustState === "verified" ||
      parsed.trustState === "revoked" ||
      parsed.trustState === "blocked"
        ? parsed.trustState
        : undefined,
    hostedState:
      parsed.hostedState === "disabled" ||
      parsed.hostedState === "pending" ||
      parsed.hostedState === "ready" ||
      parsed.hostedState === "missing"
        ? parsed.hostedState
        : undefined,
    agentSlug: typeof parsed.agentSlug === "string" ? parsed.agentSlug.trim() : undefined,
    publicUrl: resolveManagedFederationPublicUrl({
      publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl.trim() : undefined,
      agentSlug: typeof parsed.agentSlug === "string" ? parsed.agentSlug.trim() : undefined,
    }),
    zrokTokenPresent: typeof parsed.zrokToken === "string" && parsed.zrokToken.trim().length > 0,
    lastAttestOrRenewAt:
      typeof parsed.lastAttestOrRenewAt === "string"
        ? parsed.lastAttestOrRenewAt.trim()
        : fileUpdatedAt,
    paidFlowEligible: parsed.paidFlowEligible === true,
    bondId: typeof parsed.bondId === "string" ? parsed.bondId.trim() || undefined : undefined,
    bondWallet:
      parsed.bondWallet &&
      typeof parsed.bondWallet === "object" &&
      typeof (parsed.bondWallet as { chain?: unknown }).chain === "string" &&
      typeof (parsed.bondWallet as { address?: unknown }).address === "string"
        ? {
            chain: (parsed.bondWallet as { chain: string }).chain,
            address: (parsed.bondWallet as { address: string }).address,
          }
        : undefined,
    bondStatus:
      parsed.bondStatus === "missing" ||
      parsed.bondStatus === "active" ||
      parsed.bondStatus === "unlocking" ||
      parsed.bondStatus === "unlocked"
        ? parsed.bondStatus
        : undefined,
    bondTier:
      parsed.bondTier === "none" ||
      parsed.bondTier === "basic-bond" ||
      parsed.bondTier === "operator-bond"
        ? parsed.bondTier
        : undefined,
    bondAmountRaw:
      typeof parsed.bondAmountRaw === "string"
        ? parsed.bondAmountRaw.trim() || undefined
        : undefined,
    bondUnlockAvailableAt:
      typeof parsed.bondUnlockAvailableAt === "string"
        ? parsed.bondUnlockAvailableAt.trim() || undefined
        : undefined,
    bondQuotaBand:
      parsed.bondQuotaBand === "standard" ||
      parsed.bondQuotaBand === "boosted" ||
      parsed.bondQuotaBand === "operator"
        ? parsed.bondQuotaBand
        : undefined,
    bondDerivedScopes: Array.isArray(parsed.bondDerivedScopes)
      ? parsed.bondDerivedScopes.filter((value): value is string => typeof value === "string")
      : undefined,
  };

  const status: FederationStatusPayload = {
    managed,
    sourcePath,
    joined: true,
    lifecycle,
    checkedAt,
    configured,
    token,
  };
  try {
    const cfg = loadConfig();
    const proof = await loadPersistedFederationBondProof(env);
    const configuredWalletId = resolveFederationBondDefaultWalletId(cfg);
    const proofWalletId = proof?.walletId?.trim() || undefined;
    const walletId = configuredWalletId ?? proofWalletId;
    let configuredWalletAddress = "";
    if (walletId) {
      try {
        configuredWalletAddress = (
          await resolveFederationBondWallet({
            env,
            cfg,
            walletId,
          })
        ).walletAddress.trim();
      } catch {
        configuredWalletAddress = "";
      }
    }
    const proofWalletAddress = proof?.walletAddress?.trim() || "";
    const tokenWalletAddress = token.bondWallet?.address?.trim() || "";
    const walletAddress = configuredWalletAddress || proofWalletAddress || tokenWalletAddress;
    const usesTokenBond = Boolean(tokenWalletAddress && walletAddress === tokenWalletAddress);
    const usesProofBond = Boolean(proofWalletAddress && walletAddress === proofWalletAddress);
    const liveBond = walletAddress
      ? await inspectSatBondPosition(cfg as never, { authority: walletAddress }).catch(() => null)
      : null;
    const liveBondStakingDistributor = await inspectSatBondStakingDistributor(cfg as never).catch(
      () => null,
    );
    const liveBondStakingPosition = walletAddress
      ? await inspectSatBondStakingPosition(cfg as never, { authority: walletAddress }).catch(
          () => null,
        )
      : null;
    const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
    const bondVaultBalances: NonNullable<FederationStatusPayload["bond"]>["vaultBalances"] = {};
    if (walletAddress) {
      const solanaRpc = resolveScopedRpcUrlForWallet({
        env: effectiveEnv,
        chains: ["solana"],
        walletId,
      });
      if (solanaRpc) {
        const satRuntimeIds = tryResolveSatRuntimeIds(effectiveEnv);
        const [solLamports, satBalance] = await Promise.all([
          fetchSolanaNativeBalanceViaRpc({
            rpcUrl: solanaRpc,
            ownerAddress: walletAddress,
          }).catch((error: unknown) => {
            bondVaultBalances.error = error instanceof Error ? error.message : String(error);
            return null;
          }),
          satRuntimeIds?.mintAddress
            ? fetchSolanaTokenBalanceViaRpc({
                rpcUrl: solanaRpc,
                ownerAddress: walletAddress,
                mint: satRuntimeIds.mintAddress,
              }).catch((error: unknown) => {
                bondVaultBalances.error = error instanceof Error ? error.message : String(error);
                return null;
              })
            : Promise.resolve(null),
        ]);
        if (solLamports !== null) {
          bondVaultBalances.solLamports = solLamports;
        }
        if (satBalance) {
          bondVaultBalances.satRaw = satBalance.amountRaw;
          bondVaultBalances.satDecimals = satBalance.decimals;
        } else if (!bondVaultBalances.satRaw) {
          bondVaultBalances.satRaw = "0";
          bondVaultBalances.satDecimals = 11;
        }
        bondVaultBalances.checkedAt = checkedAt;
      } else {
        bondVaultBalances.error = "No Solana RPC configured for bond Vault wallet.";
      }
    }
    const currentSlot =
      liveBond && liveBond.unlockAvailableAtSlot > 0
        ? await inspectSatChainSlot(cfg as never).catch(() => 0)
        : 0;
    const tokenBondId = usesTokenBond ? token.bondId : undefined;
    const tokenBondStatus = usesTokenBond ? token.bondStatus : undefined;
    const tokenBondTier = usesTokenBond ? token.bondTier : undefined;
    const tokenBondAmountRaw = usesTokenBond ? token.bondAmountRaw : undefined;
    const tokenBondUnlockAvailableAt = usesTokenBond ? token.bondUnlockAvailableAt : undefined;
    const tokenBondQuotaBand = usesTokenBond ? token.bondQuotaBand : undefined;
    const tokenBondDerivedScopes = usesTokenBond ? token.bondDerivedScopes : undefined;
    const proofBondId = usesProofBond ? proof?.bondId : undefined;
    const proofBondDerivedScopes = usesProofBond ? proof?.bondDerivedScopes : undefined;
    const warnings: string[] = [];
    if (!walletAddress) {
      warnings.push("Bond Vault is not configured for live SAT bond inspection.");
    }
    if (liveBond && liveBond.statusLabel === "unlocking") {
      warnings.push(
        currentSlot > 0 && liveBond.unlockAvailableAtSlot > currentSlot
          ? `Bond unlock is in progress. Withdrawal is available at slot ${liveBond.unlockAvailableAtSlot}.`
          : "Bond unlock is in progress. Network access state can change after unlock finalizes.",
      );
    }
    if ((liveBond?.tierLabel ?? tokenBondTier ?? "none") === "none") {
      warnings.push("Current SAT bond is below published network tiers.");
    }
    status.bond = {
      exists: Boolean(liveBond),
      source: configuredWalletAddress
        ? "config"
        : proofWalletAddress
          ? "proof"
          : tokenWalletAddress
            ? "token"
            : "unresolved",
      walletId,
      walletAddress: walletAddress || undefined,
      bondId: liveBond?.address ?? proofBondId ?? tokenBondId,
      status: liveBond?.statusLabel ?? tokenBondStatus ?? "missing",
      tier: liveBond?.tierLabel ?? tokenBondTier ?? "none",
      amountRaw: liveBond?.amountRaw ?? tokenBondAmountRaw,
      unlockAvailableAt:
        liveBond && liveBond.unlockAvailableAtSlot > 0
          ? `slot:${String(liveBond.unlockAvailableAtSlot)}`
          : tokenBondUnlockAvailableAt,
      unlockCurrentSlot: currentSlot > 0 ? currentSlot : undefined,
      unlockReady:
        liveBond && liveBond.unlockAvailableAtSlot > 0
          ? currentSlot >= liveBond.unlockAvailableAtSlot
          : undefined,
      quotaBand: tokenBondQuotaBand,
      derivedScopes: tokenBondDerivedScopes ?? proofBondDerivedScopes ?? [],
      staking: {
        distributor: {
          exists: Boolean(liveBondStakingDistributor),
          address: liveBondStakingDistributor?.address,
          status: liveBondStakingDistributor?.statusLabel,
          rewardVault: liveBondStakingDistributor?.rewardVault,
          minStakeRaw: resolveEffectiveBondStakingMinRaw(liveBondStakingDistributor?.minStakeRaw),
          totalActiveStakeRaw: liveBondStakingDistributor?.totalActiveStakeRaw,
          rewardIndexFp: liveBondStakingDistributor?.rewardIndexFp,
          observedRewardVaultRaw: liveBondStakingDistributor?.observedRewardVaultRaw,
          unallocatedRewardRaw: liveBondStakingDistributor?.unallocatedRewardRaw,
          rewardVaultBalanceRaw: liveBondStakingDistributor?.rewardVaultBalanceRaw,
          lastSyncedSlot: liveBondStakingDistributor?.lastSyncedSlot,
          mintMatchesRuntime: liveBondStakingDistributor?.mintMatchesRuntime,
          vaultMatchesExpected: liveBondStakingDistributor?.vaultMatchesExpected,
        },
        position: {
          exists: Boolean(liveBondStakingPosition),
          address: liveBondStakingPosition?.address,
          status: liveBondStakingPosition?.statusLabel,
          activeStakeRaw: liveBondStakingPosition?.activeStakeRaw,
          claimableRewardRaw: liveBondStakingPosition?.claimableRewardRaw,
          rewardDebtFp: liveBondStakingPosition?.rewardDebtFp,
          estimatedClaimableRewardRaw: estimateBondStakingClaimRaw(
            liveBondStakingPosition,
            liveBondStakingDistributor,
          ),
          lastSyncedSlot: liveBondStakingPosition?.lastSyncedSlot,
        },
      },
      vaultBalances: bondVaultBalances,
      warnings,
    };
  } catch {
    status.bond = {
      exists: false,
      source: "unresolved",
      bondId: token.bondId,
      status: token.bondStatus ?? "missing",
      tier: token.bondTier ?? "none",
      amountRaw: token.bondAmountRaw,
      unlockAvailableAt: token.bondUnlockAvailableAt,
      quotaBand: token.bondQuotaBand,
      derivedScopes: token.bondDerivedScopes ?? [],
      warnings: ["Bond status could not be resolved from local runtime state."],
    };
  }
  if (token.hostedState === "ready" && token.publicUrl) {
    status.hostedProbe = await probeHostedFederationUrl(token.publicUrl, fetchImpl);
  }
  status.sellerLane = deriveFederationSellerLane({
    token,
    bond: status.bond,
    hostedProbe: status.hostedProbe,
  });
  status.routingCapacity = deriveFederationRoutingCapacity({
    token,
    bond: status.bond,
    hostedProbe: status.hostedProbe,
  });
  status.hostedEdge = deriveFederationHostedEdge({
    token,
    bond: status.bond,
    hostedProbe: status.hostedProbe,
  });
  status.directoryIndexer = deriveFederationDirectoryIndexer({
    token,
    bond: status.bond,
  });
  status.artifactAvailability = deriveFederationArtifactAvailability({
    token,
    bond: status.bond,
    hostedProbe: status.hostedProbe,
    sellerLane: status.sellerLane,
    hostedEdge: status.hostedEdge,
    directoryIndexer: status.directoryIndexer,
  });
  return status;
}

function isCanvasPath(pathname: string): boolean {
  return (
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`) ||
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === CANVAS_WS_PATH
  );
}

function isSignedFederationInboundRequest(req: IncomingMessage): boolean {
  return req.method === "POST" && SIGNED_FEDERATION_INBOUND_ROUTES.has(req.url ?? "");
}

function hasAuthorizedWsClientForIp(clients: Set<GatewayWsClient>, clientIp: string): boolean {
  for (const client of clients) {
    if (client.clientIp && client.clientIp === clientIp) {
      return true;
    }
  }
  return false;
}

function hasAuthorizedCanvasCapability(
  clients: Set<GatewayWsClient>,
  capability: string | undefined,
): boolean {
  if (!capability) {
    return false;
  }
  const nowMs = Date.now();
  for (const client of clients) {
    if (
      client.connect.role !== "node" ||
      client.connect.client.mode !== "node" ||
      typeof client.canvasCapabilityExpiresAtMs !== "number" ||
      client.canvasCapabilityExpiresAtMs <= nowMs
    ) {
      continue;
    }
    if (safeEqualSecret(capability, client.canvasCapability)) {
      return true;
    }
  }
  return false;
}

function isCanvasLocalDirectRequest(req: IncomingMessage, trustedProxies: string[]): boolean {
  const remoteAddr = req.socket?.remoteAddress;
  if (isTrustedProxyAddress(remoteAddr, trustedProxies)) {
    return false;
  }
  return isLocalDirectRequest(req, trustedProxies);
}

async function authorizeCanvasRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  clients: Set<GatewayWsClient>;
  rateLimiter?: AuthRateLimiter;
  canvasCapability?: string;
  requireCanvasCapability?: boolean;
  malformedCanvasCapabilityPath?: boolean;
}): Promise<GatewayAuthResult> {
  const {
    req,
    auth,
    trustedProxies,
    clients,
    rateLimiter,
    canvasCapability,
    requireCanvasCapability,
    malformedCanvasCapabilityPath,
  } = params;
  if (isCanvasLocalDirectRequest(req, trustedProxies)) {
    return { ok: true };
  }

  if (malformedCanvasCapabilityPath) {
    return { ok: false, reason: "unauthorized" };
  }
  if (canvasCapability) {
    return hasAuthorizedCanvasCapability(clients, canvasCapability)
      ? { ok: true }
      : { ok: false, reason: "unauthorized" };
  }
  if (requireCanvasCapability) {
    return { ok: false, reason: "unauthorized" };
  }

  let lastAuthFailure: GatewayAuthResult | null = null;
  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
      rateLimiter,
    });
    if (authResult.ok) {
      return authResult;
    }
    lastAuthFailure = authResult;
  }

  const clientIp = resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: getHeader(req, "x-forwarded-for"),
    realIp: getHeader(req, "x-real-ip"),
    trustedProxies,
  });
  if (!clientIp) {
    return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
  }

  // IP-based fallback is only safe for machine-scoped addresses.
  // Only allow IP-based fallback for private/loopback addresses to prevent
  // cross-session access in shared-IP environments (corporate NAT, cloud).
  if (!isPrivateOrLoopbackAddress(clientIp)) {
    return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
  }
  if (hasAuthorizedWsClientForIp(clients, clientIp)) {
    return { ok: true };
  }
  return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
}

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type GatewayHttpRequestStage = {
  name: string;
  run: () => Promise<boolean> | boolean;
};

export async function runGatewayHttpRequestStages(
  stages: readonly GatewayHttpRequestStage[],
): Promise<boolean> {
  for (const stage of stages) {
    try {
      if (await stage.run()) {
        return true;
      }
    } catch (err) {
      console.error(`[gateway-http] stage "${stage.name}" threw — skipping:`, err);
    }
  }
  return false;
}

async function canRevealReadinessDetails(params: {
  req: IncomingMessage;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<boolean> {
  if (isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)) {
    return true;
  }
  if (params.resolvedAuth.mode === "none") {
    return false;
  }

  const bearerToken = getBearerToken(params.req);
  if (!bearerToken) {
    return false;
  }
  if (params.resolvedAuth.mode === "token" && params.resolvedAuth.token) {
    return safeEqualSecret(params.resolvedAuth.token, bearerToken);
  }
  if (params.resolvedAuth.mode === "password" && params.resolvedAuth.password) {
    return safeEqualSecret(params.resolvedAuth.password, bearerToken);
  }
  return false;
}

function normalizePrometheusMetricsPath(raw: unknown): string {
  if (typeof raw !== "string") {
    return "/metrics";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/metrics";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return canonicalizePathVariant(withSlash) ?? "/metrics";
}

function renderPrometheusMetrics(params: {
  includeRuntime: boolean;
  getReadiness?: ReadinessChecker;
}): string {
  const lines: string[] = [
    "# HELP fased_gateway_up Whether the Fased gateway metrics endpoint is serving.",
    "# TYPE fased_gateway_up gauge",
    "fased_gateway_up 1",
  ];
  if (params.includeRuntime) {
    const memory = process.memoryUsage();
    lines.push(
      "# HELP fased_gateway_uptime_seconds Gateway process uptime in seconds.",
      "# TYPE fased_gateway_uptime_seconds gauge",
      `fased_gateway_uptime_seconds ${process.uptime().toFixed(3)}`,
      "# HELP fased_gateway_memory_rss_bytes Gateway process resident memory in bytes.",
      "# TYPE fased_gateway_memory_rss_bytes gauge",
      `fased_gateway_memory_rss_bytes ${memory.rss}`,
      "# HELP fased_gateway_heap_used_bytes Gateway process V8 heap used in bytes.",
      "# TYPE fased_gateway_heap_used_bytes gauge",
      `fased_gateway_heap_used_bytes ${memory.heapUsed}`,
    );
  }
  try {
    const snapshot = getDiagnosticStabilitySnapshot({ limit: 0 });
    lines.push(
      "# HELP fased_diagnostics_events_total Sanitized diagnostic stability events retained in memory.",
      "# TYPE fased_diagnostics_events_total gauge",
      `fased_diagnostics_events_total ${snapshot.count}`,
      "# HELP fased_diagnostics_events_dropped_total Sanitized diagnostic stability events dropped due to retention cap.",
      "# TYPE fased_diagnostics_events_dropped_total counter",
      `fased_diagnostics_events_dropped_total ${snapshot.dropped}`,
    );
  } catch {
    lines.push(
      "# HELP fased_diagnostics_events_total Sanitized diagnostic stability events retained in memory.",
      "# TYPE fased_diagnostics_events_total gauge",
      "fased_diagnostics_events_total 0",
    );
  }
  if (params.getReadiness) {
    try {
      const readiness = params.getReadiness();
      lines.push(
        "# HELP fased_gateway_ready Whether the gateway readiness check currently passes.",
        "# TYPE fased_gateway_ready gauge",
        `fased_gateway_ready ${readiness.ready ? 1 : 0}`,
        "# HELP fased_gateway_readiness_failing_total Count of readiness checks currently failing.",
        "# TYPE fased_gateway_readiness_failing_total gauge",
        `fased_gateway_readiness_failing_total ${readiness.failing.length}`,
      );
    } catch {
      lines.push(
        "# HELP fased_gateway_ready Whether the gateway readiness check currently passes.",
        "# TYPE fased_gateway_ready gauge",
        "fased_gateway_ready 0",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function handlePrometheusMetricsRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  config: ReturnType<typeof loadConfig>;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  getReadiness?: ReadinessChecker;
}): Promise<boolean> {
  const prometheus = params.config.diagnostics?.prometheus;
  if (prometheus?.enabled !== true) {
    return false;
  }
  const metricsPath = normalizePrometheusMetricsPath(prometheus.path);
  if (params.requestPath !== metricsPath) {
    return false;
  }
  const method = (params.req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "GET, HEAD");
    params.res.setHeader("Content-Type", "text/plain; charset=utf-8");
    params.res.end("Method Not Allowed");
    return true;
  }
  const requireAuth = prometheus.requireAuth !== false;
  if (
    requireAuth &&
    !(await canRevealReadinessDetails({
      req: params.req,
      resolvedAuth: params.resolvedAuth,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
      rateLimiter: params.rateLimiter,
    }))
  ) {
    params.res.statusCode = 401;
    params.res.setHeader("Content-Type", "text/plain; charset=utf-8");
    params.res.setHeader("Cache-Control", "no-store");
    params.res.end("authentication required");
    return true;
  }

  params.res.statusCode = 200;
  params.res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  params.res.setHeader("Cache-Control", "no-store");
  params.res.end(
    method === "HEAD"
      ? undefined
      : renderPrometheusMetrics({
          includeRuntime: prometheus.includeRuntime !== false,
          getReadiness: params.getReadiness,
        }),
  );
  return true;
}

async function handleGatewayProbeRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  getReadiness?: ReadinessChecker;
}): Promise<boolean> {
  const status = GATEWAY_PROBE_STATUS_BY_PATH.get(params.requestPath);
  if (!status) {
    return false;
  }

  const method = (params.req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "GET, HEAD");
    params.res.setHeader("Content-Type", "text/plain; charset=utf-8");
    params.res.end("Method Not Allowed");
    return true;
  }

  params.res.setHeader("Content-Type", "application/json; charset=utf-8");
  params.res.setHeader("Cache-Control", "no-store");

  let statusCode = 200;
  let body: string;
  if (status === "ready" && params.getReadiness) {
    const includeDetails = await canRevealReadinessDetails({
      req: params.req,
      resolvedAuth: params.resolvedAuth,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
      rateLimiter: params.rateLimiter,
    });
    try {
      const result = params.getReadiness();
      statusCode = result.ready ? 200 : 503;
      body = JSON.stringify(
        includeDetails ? buildGatewayReadinessPayload(result) : { ready: result.ready },
      );
    } catch {
      statusCode = 503;
      body = JSON.stringify(
        includeDetails ? { ready: false, failing: ["internal"], uptimeMs: 0 } : { ready: false },
      );
    }
  } else {
    body = JSON.stringify(buildGatewayProbePayload(status));
  }

  params.res.statusCode = statusCode;
  params.res.end(method === "HEAD" ? undefined : body);
  return true;
}

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const {
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
    dispatchWorkflowHook,
  } = opts;
  const hookAuthFailures = new Map<string, HookAuthFailure>();

  const resolveHookClientKey = (req: IncomingMessage): string => {
    return (
      resolveGatewayClientIp({
        remoteAddr: req.socket?.remoteAddress ?? "",
      }) ?? "unknown"
    );
  };

  const recordHookAuthFailure = (
    clientKey: string,
    nowMs: number,
  ): { throttled: boolean; retryAfterSeconds?: number } => {
    if (!hookAuthFailures.has(clientKey) && hookAuthFailures.size >= HOOK_AUTH_FAILURE_TRACK_MAX) {
      // Prune expired entries instead of clearing all state.
      for (const [key, entry] of hookAuthFailures) {
        if (nowMs - entry.windowStartedAtMs >= HOOK_AUTH_FAILURE_WINDOW_MS) {
          hookAuthFailures.delete(key);
        }
      }
      // If still at capacity after pruning, drop the oldest half.
      if (hookAuthFailures.size >= HOOK_AUTH_FAILURE_TRACK_MAX) {
        let toRemove = Math.floor(hookAuthFailures.size / 2);
        for (const key of hookAuthFailures.keys()) {
          if (toRemove <= 0) {
            break;
          }
          hookAuthFailures.delete(key);
          toRemove--;
        }
      }
    }
    const current = hookAuthFailures.get(clientKey);
    const expired = !current || nowMs - current.windowStartedAtMs >= HOOK_AUTH_FAILURE_WINDOW_MS;
    const next: HookAuthFailure = expired
      ? { count: 1, windowStartedAtMs: nowMs }
      : { count: current.count + 1, windowStartedAtMs: current.windowStartedAtMs };
    // Delete-before-set refreshes Map insertion order so recently-active
    // clients are not evicted before dormant ones during oldest-half eviction.
    if (hookAuthFailures.has(clientKey)) {
      hookAuthFailures.delete(clientKey);
    }
    hookAuthFailures.set(clientKey, next);
    if (next.count <= HOOK_AUTH_FAILURE_LIMIT) {
      return { throttled: false };
    }
    const retryAfterMs = Math.max(1, next.windowStartedAtMs + HOOK_AUTH_FAILURE_WINDOW_MS - nowMs);
    return {
      throttled: true,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  };

  const clearHookAuthFailure = (clientKey: string) => {
    hookAuthFailures.delete(clientKey);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    const url = new URL(req.url ?? "/", `http://${formatBindHostForOrigin(bindHost)}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or x-fased-token header (query parameters are not allowed).",
      );
      return true;
    }

    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!safeEqualSecret(token, hooksConfig.token)) {
      const throttle = recordHookAuthFailure(clientKey, Date.now());
      if (throttle.throttled) {
        const retryAfter = throttle.retryAfterSeconds ?? 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    clearHookAuthFailure(clientKey);

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        source: "request",
        sessionKey: normalized.value.sessionKey,
      });
      if (!sessionKey.ok) {
        sendJson(res, 400, { ok: false, error: sessionKey.error });
        return true;
      }
      const runId = dispatchAgentHook({
        ...normalized.value,
        sessionKey: sessionKey.value,
        agentId: resolveHookTargetAgentId(hooksConfig, normalized.value.agentId),
      });
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          if (mapped.action.kind === "workflow") {
            if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
              sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
              return true;
            }
            const sessionKey = resolveHookSessionKey({
              hooksConfig,
              source: "mapping",
              sessionKey: mapped.action.sessionKey,
            });
            if (!sessionKey.ok) {
              sendJson(res, 400, { ok: false, error: sessionKey.error });
              return true;
            }
            const runId = dispatchWorkflowHook({
              workflowDefinitionId: mapped.action.workflowDefinitionId,
              name: mapped.action.name ?? "Workflow hook",
              triggerId: mapped.action.triggerId,
              agentId: resolveHookTargetAgentId(hooksConfig, mapped.action.agentId),
              sessionKey: sessionKey.value,
              notifyPolicy: mapped.action.notifyPolicy,
            });
            sendJson(res, 202, { ok: true, runId });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source: "mapping",
            sessionKey: mapped.action.sessionKey,
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            triggerId: mapped.action.triggerId,
            agentId: resolveHookTargetAgentId(hooksConfig, mapped.action.agentId),
            wakeMode: mapped.action.wakeMode,
            sessionKey: sessionKey.value,
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            notifyPolicy: mapped.action.notifyPolicy,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export interface GatewayHttpServerOpts {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: HooksRequestHandler;
  controlUiLogin?: {
    exchangeGrant: (params: { grant: string; host: string }) => LoginGrantExchangeResult;
    issueSession: (params: { host: string }) =>
      | {
          ok: true;
          sessionToken: string;
          expiresAtMs: number;
          idleTimeoutMs: number;
        }
      | { ok: false; code: string };
    authorizeSessionToken: (params: { token: string; host: string }) => {
      ok: boolean;
      expiresAtMs?: number;
      code?: string;
    };
    revokeSessionToken: (params: { token: string; host: string }) => { ok: boolean; code?: string };
  };
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  tlsOptions?: TlsOptions;
  /** Optional HSTS header value. */
  strictTransportSecurityHeader?: string;
  getReadiness?: ReadinessChecker;
}

export function createGatewayHttpServer(opts: GatewayHttpServerOpts): HttpServer {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    controlUiLogin,
    resolvedAuth,
    rateLimiter,
    strictTransportSecurityHeader,
    getReadiness,
  } = opts;

  const fedifyHandler = createFedifyHandler({
    origin: resolveAgentPublicOrigin(process.env),
  });
  const a2aHandler = createA2aHandler({
    origin: resolveAgentPublicOrigin(process.env),
  });

  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    const rawRequestUrl = req.url ?? "/";
    const parsedUrl = new URL(rawRequestUrl, "http://localhost");
    const requestPath = parsedUrl.pathname;
    const canvasScopedUrl = normalizeCanvasScopedUrl(rawRequestUrl);
    const canvasParsedUrl = new URL(
      canvasScopedUrl.rewrittenUrl ?? rawRequestUrl,
      "http://localhost",
    );
    const canvasRequestPath = canvasParsedUrl.pathname;
    try {
      setDefaultSecurityHeaders(res, {
        strictTransportSecurity: strictTransportSecurityHeader,
      });
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const host = resolveControlUiPublicHost(req, trustedProxies, {
        allowLoopbackHttpsOriginFallback: configSnapshot.gateway?.tailscale?.mode === "serve",
      });
      const loopbackCorsApplied = applyLoopbackCorsIfAllowed(req, res, host);
      if (
        req.method === "OPTIONS" &&
        String(getHeader(req, "access-control-request-method") ?? "").trim()
      ) {
        res.statusCode = loopbackCorsApplied ? 204 : 403;
        res.end();
        return;
      }
      const secureCookie = isSecureRequest(req, host);
      const sendLoginResponse = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(body));
      };
      const sendSatMiningGatewayError = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendLoginResponse(503, {
          ok: false,
          error: { code: "unavailable", message },
        });
      };
      const isRemoteHost = host ? !isLocalHostName(host) : true;
      const tailscaleProxyConfigured =
        resolvedAuth.allowTailscale || (configSnapshot.gateway?.tailscale?.mode ?? "off") !== "off";
      const directLocalRequest =
        !tailscaleProxyConfigured && isDirectLoopbackRequest(req, trustedProxies);
      const ensureWalletApiAuthorized = async (): Promise<boolean> => {
        if (directLocalRequest) {
          const requestOrigin = String(getHeader(req, "origin") ?? "").trim();
          if (!requestOrigin || isLoopbackBrowserOrigin(requestOrigin)) {
            return true;
          }
          if (!loopbackCorsApplied) {
            sendLoginResponse(403, {
              ok: false,
              error: {
                code: "forbidden_origin",
                message: "cross-origin browser requests are not allowed on the loopback wallet API",
              },
            });
            return false;
          }
        }
        let authorized = false;
        const bearer = getBearerToken(req);
        if (controlUiLogin && host) {
          const sessionToken = resolveControlUiSessionCookie(req) || bearer;
          if (sessionToken) {
            authorized = controlUiLogin.authorizeSessionToken({ token: sessionToken, host }).ok;
          }
        }
        if (!authorized && bearer) {
          const authResult = await authorizeGatewayConnect({
            auth: { ...resolvedAuth, allowTailscale: false },
            connectAuth: { token: bearer, password: bearer },
            req,
            trustedProxies,
            rateLimiter,
          });
          authorized = authResult.ok;
        }
        if (!authorized) {
          sendLoginResponse(401, {
            ok: false,
            error: { code: "unauthorized", message: "authentication required" },
          });
          return false;
        }
        return true;
      };
      const ensureWalletApprovalAuthorized = (params: {
        operation:
          | "wallet.rotate"
          | "wallet.reset"
          | "wallet.approve"
          | "wallet.passkey-enroll"
          | "wallet.passkey-remove"
          | "wallet.execution-mode"
          | "wallet.send"
          | "wallet.settings"
          | "wallet.policy"
          | "wallet.provider-credentials"
          | "wallet.network"
          | "wallet.archive"
          | "mining.capital"
          | "mining.policy";
        requestId?: string;
        cfg?: ReturnType<typeof loadConfig>;
        requireReady?: boolean;
      }): boolean => {
        const approvalMode = resolveWalletApprovalAuthMode(process.env, params.cfg);
        if (approvalMode !== "webauthn") {
          return true;
        }
        const approvalAuth = readWalletApprovalAuthSnapshot(process.env, params.cfg);
        if (approvalAuth.passkeyCount <= 0) {
          sendLoginResponse(401, {
            ok: false,
            error: {
              code: "wallet_control_passkey_not_ready",
              message:
                "Wallet Control Passkey is enabled but no passkey is enrolled. Enroll a passkey or turn passkey approval off.",
            },
          });
          return false;
        }
        const approvalToken = String(getHeader(req, "x-wallet-approval-token") ?? "").trim();
        const consumed = consumeWalletApprovalGrant({
          host,
          operation: params.operation,
          requestId: params.requestId,
          token: approvalToken,
          env: process.env,
          cfg: params.cfg,
        });
        if (!consumed.ok) {
          sendLoginResponse(401, {
            ok: false,
            error: { code: consumed.code, message: consumed.message },
          });
          return false;
        }
        return true;
      };
      if (requestPath === CONTROL_UI_BOOT_CHECK_PATH) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET, HEAD");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET or HEAD" },
          });
          return;
        }
        const bootCheck = resolveControlUiBootCheck({
          basePath: controlUiBasePath,
          root: controlUiRoot,
          origin: `${secureCookie ? "https" : "http"}://${host || "localhost"}`,
          serve: configSnapshot.gateway?.tailscale?.mode === "serve" ? "tailscale" : "direct",
        });
        res.statusCode = bootCheck.index === "ok" ? 200 : 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(JSON.stringify(bootCheck));
        return;
      }
      if (requestPath === "/api/control-ui/login/exchange") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!controlUiLogin) {
          sendLoginResponse(503, {
            ok: false,
            error: { code: "login_unavailable", message: "control ui login is unavailable" },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const grant =
          typeof (body.value as { grant?: unknown } | null)?.grant === "string"
            ? (body.value as { grant: string }).grant.trim()
            : "";
        if (!grant) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "grant is required" },
          });
          return;
        }
        if (!host) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "request host is required" },
          });
          return;
        }
        const exchanged = controlUiLogin.exchangeGrant({ grant, host });
        if (!exchanged.ok) {
          const status =
            exchanged.code === "invalid_or_used_grant" ||
            exchanged.code === "host_mismatch" ||
            exchanged.code === "expired_grant"
              ? 401
              : 400;
          sendLoginResponse(status, {
            ok: false,
            error: {
              code: exchanged.code,
              message: exchanged.code.replace(/_/g, " "),
            },
          });
          return;
        }
        setControlUiSessionCookie(res, exchanged.sessionToken, secureCookie);
        sendLoginResponse(200, {
          ok: true,
          sessionToken: exchanged.sessionToken,
          expiresAt: new Date(exchanged.expiresAtMs).toISOString(),
          idleTimeoutSeconds: Math.floor(exchanged.idleTimeoutMs / 1000),
        });
        return;
      }
      if (requestPath === "/api/control-ui/login/token") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!controlUiLogin) {
          sendLoginResponse(503, {
            ok: false,
            error: { code: "login_unavailable", message: "control ui login is unavailable" },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const token =
          typeof (body.value as { token?: unknown } | null)?.token === "string"
            ? (body.value as { token: string }).token.trim()
            : "";
        if (!token) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "gateway token is required" },
          });
          return;
        }
        if (!host) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "request host is required" },
          });
          return;
        }
        const authResult = await authorizeGatewayConnect({
          auth: { ...resolvedAuth, allowTailscale: false },
          connectAuth: { token, password: token },
          req,
          trustedProxies,
          rateLimiter,
        });
        if (!authResult.ok) {
          const existingSession = controlUiLogin.authorizeSessionToken({ token, host });
          if (existingSession.ok) {
            setControlUiSessionCookie(res, token, secureCookie);
            sendLoginResponse(200, {
              ok: true,
              sessionToken: token,
              expiresAt: existingSession.expiresAtMs
                ? new Date(existingSession.expiresAtMs).toISOString()
                : undefined,
            });
            return;
          }
          sendLoginResponse(401, {
            ok: false,
            error: { code: authResult.reason ?? "unauthorized", message: "invalid gateway token" },
          });
          return;
        }
        const issued = controlUiLogin.issueSession({ host });
        if (!issued.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: issued.code, message: issued.code.replace(/_/g, " ") },
          });
          return;
        }
        setControlUiSessionCookie(res, issued.sessionToken, secureCookie);
        sendLoginResponse(200, {
          ok: true,
          sessionToken: issued.sessionToken,
          expiresAt: new Date(issued.expiresAtMs).toISOString(),
          idleTimeoutSeconds: Math.floor(issued.idleTimeoutMs / 1000),
        });
        return;
      }
      if (requestPath === "/api/control-ui/login/logout") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!controlUiLogin) {
          sendLoginResponse(503, {
            ok: false,
            error: { code: "login_unavailable", message: "control ui login is unavailable" },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const tokenFromBody =
          typeof (body.value as { token?: unknown } | null)?.token === "string"
            ? (body.value as { token: string }).token.trim()
            : "";
        const tokenFromCookie = resolveControlUiSessionCookie(req);
        const token = tokenFromBody || getBearerToken(req) || tokenFromCookie;
        if (!token) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "session token is required" },
          });
          return;
        }
        if (!host) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "request host is required" },
          });
          return;
        }
        const revoked = controlUiLogin.revokeSessionToken({ token, host });
        if (!revoked.ok) {
          const code = revoked.code ?? "logout_failed";
          sendLoginResponse(401, {
            ok: false,
            error: { code, message: code.replace(/_/g, " ") },
          });
          return;
        }
        clearControlUiSessionCookie(res, secureCookie);
        sendLoginResponse(200, { ok: true });
        return;
      }
      if (requestPath === "/api/federation/status") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }

        if (!directLocalRequest) {
          let authorized = false;
          const bearer = getBearerToken(req);
          if (controlUiLogin && host) {
            const sessionToken = resolveControlUiSessionCookie(req) || bearer;
            if (sessionToken) {
              authorized = controlUiLogin.authorizeSessionToken({ token: sessionToken, host }).ok;
            }
          }
          if (!authorized && bearer) {
            const authResult = await authorizeGatewayConnect({
              auth: { ...resolvedAuth, allowTailscale: false },
              connectAuth: { token: bearer, password: bearer },
              req,
              trustedProxies,
              rateLimiter,
            });
            authorized = authResult.ok;
          }
          if (!authorized) {
            sendLoginResponse(401, {
              ok: false,
              error: { code: "unauthorized", message: "authentication required" },
            });
            return;
          }
        }

        sendLoginResponse(200, {
          ok: true,
          status: await readLocalFederationStatus(process.env),
        });
        return;
      }
      if (requestPath === "/api/federation/bond/wallet") {
        if (req.method === "GET") {
          if (!(await ensureWalletApiAuthorized())) {
            return;
          }
          const cfg = loadConfig();
          sendLoginResponse(200, {
            ok: true,
            walletId: resolveFederationBondDefaultWalletId(cfg) ?? null,
            status: await readLocalFederationStatus(process.env),
          });
          return;
        }
        if (req.method === "PUT" || req.method === "DELETE") {
          if (!(await ensureWalletApiAuthorized())) {
            return;
          }
          const body =
            req.method === "PUT"
              ? await readJsonBody(req, 64 * 1024)
              : ({ ok: true, value: { walletId: null } } as const);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const parsed = parseFederationBondWalletInput(body.value);
          const nextWalletId = req.method === "DELETE" ? null : (parsed.walletId ?? null);
          if (nextWalletId) {
            const cfg = loadConfig();
            const validBondWallet = validateFederationBondVaultWallet(cfg, nextWalletId);
            if (!validBondWallet.ok) {
              sendLoginResponse(validBondWallet.status, {
                ok: false,
                error: { code: validBondWallet.code, message: validBondWallet.message },
              });
              return;
            }
          }
          const updated = await updateWalletConfig({
            env: process.env,
            mutate: (cfg) => {
              applyFederationBondWalletConfig(cfg, nextWalletId);
            },
          });
          if (!updated.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_federation_bond_wallet", message: updated.message },
            });
            return;
          }
          sendLoginResponse(200, {
            ok: true,
            walletId: resolveFederationBondDefaultWalletId(updated.cfg) ?? null,
            status: await readLocalFederationStatus(process.env),
          });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, PUT, DELETE");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET, PUT, or DELETE" },
        });
        return;
      }
      if (
        requestPath === "/api/federation/bond/open" ||
        requestPath === "/api/federation/bond/increase" ||
        requestPath === "/api/federation/bond/request-unlock" ||
        requestPath === "/api/federation/bond/cancel-unlock" ||
        requestPath === "/api/federation/bond/finalize-unlock" ||
        requestPath === "/api/federation/bond/prove" ||
        requestPath === "/api/federation/bond/staking/init" ||
        requestPath === "/api/federation/bond/staking/sync" ||
        requestPath === "/api/federation/bond/staking/claim"
      ) {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 128 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const parsed = parseFederationBondMutationInput(body.value);
        const headerIdempotencyKey = Array.isArray(req.headers["idempotency-key"])
          ? req.headers["idempotency-key"][0]
          : req.headers["idempotency-key"];
        let idempotencyKey: string;
        try {
          idempotencyKey = normalizeFederationBondIdempotencyKey(
            parsed.idempotencyKey ??
              (typeof headerIdempotencyKey === "string" && headerIdempotencyKey.trim()
                ? headerIdempotencyKey
                : `derived:${digestSatSubmissionIntent(body.value)}`),
          );
        } catch (error) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "invalid_idempotency_key",
              message: error instanceof Error ? error.message : String(error),
            },
          });
          return;
        }
        const runBondSubmission = async <T>(step: string, task: () => Promise<T>): Promise<T> =>
          await runWithSatSubmissionWorkflow(`http:${requestPath}:${idempotencyKey}:${step}`, task);
        const cfg = loadConfig();
        const walletId = parsed.walletId ?? resolveFederationBondDefaultWalletId(cfg);
        if (!walletId) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "bond_vault_required",
              message: "Set a federation bond Vault first or provide walletId explicitly.",
            },
          });
          return;
        }
        const validBondWallet = validateFederationBondVaultWallet(cfg, walletId);
        if (!validBondWallet.ok) {
          sendLoginResponse(validBondWallet.status, {
            ok: false,
            error: { code: validBondWallet.code, message: validBondWallet.message },
          });
          return;
        }
        const bondCfg = buildSatWalletOverrideConfig(cfg, walletId);
        let liveBond: Awaited<ReturnType<typeof inspectSatBondPosition>> | null = null;
        try {
          const resolvedWallet = await resolveFederationBondWallet({
            env: process.env,
            cfg,
            walletId,
          });
          const readBond = async () =>
            await retrySolanaRateLimit(
              "read federation bond position",
              async () =>
                await inspectSatBondPosition(bondCfg as never, {
                  authority: resolvedWallet.walletAddress,
                }),
            ).catch(() => null);
          liveBond = await readBond();
          let tx:
            | {
                txHash: string;
                signer?: string;
              }
            | undefined;
          let proofSubmitted = false;
          let proofWarning: string | undefined;
          let stakingClaimedRaw: string | undefined;
          const syncBondStakingPositionForAction = async () => {
            const distributor = await retrySolanaRateLimit(
              "read bond staking distributor",
              async () => await inspectSatBondStakingDistributor(bondCfg as never),
            ).catch(() => null);
            if (!distributor || distributor.statusLabel !== "active") {
              return;
            }
            try {
              await retrySolanaRateLimit(
                "sync bond staking rewards",
                async () =>
                  await runBondSubmission(
                    "sync-staking-rewards",
                    async () => await submitSatSyncBondStakingRewards(bondCfg as never),
                  ),
              );
              await retrySolanaRateLimit(
                "sync bond staking position",
                async () =>
                  await runBondSubmission(
                    "sync-staking-position",
                    async () => await submitSatSyncBondStakingPosition(bondCfg as never),
                  ),
              );
              invalidateSatReadCaches({ preserveStable: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              proofWarning = appendActionWarning(
                proofWarning,
                `Staking position sync did not complete: ${message}`,
              );
            }
          };
          const readBondStakingPosition = async () =>
            await retrySolanaRateLimit(
              "read bond staking position",
              async () =>
                await inspectSatBondStakingPosition(bondCfg as never, {
                  authority: resolvedWallet.walletAddress,
                }),
            );
          if (requestPath === "/api/federation/bond/open") {
            const amountSat = parsed.amountSat ?? resolveDefaultBondAmountSat(parsed.tier);
            const amount = parseSatAmountToRawNumber(amountSat);
            tx = await runBondSubmission(
              "open",
              async () =>
                await submitSatOpenBondPosition(bondCfg as never, {
                  amountRaw: amount.safeInteger,
                }),
            );
            invalidateSatReadCaches({ preserveStable: true });
            liveBond = await readBond();
            if (liveBond?.statusLabel === "active") {
              await syncBondStakingPositionForAction();
              liveBond = await readBond();
            }
            if ((parsed.autoSubmitProof ?? true) && liveBond?.statusLabel === "active") {
              const proof = await runBondSubmission(
                "refresh-proof",
                async () => await tryRunFederationBondProof({ cfg, walletId, liveBond }),
              );
              proofSubmitted = proof.submitted;
              proofWarning = appendActionWarning(proofWarning, proof.warning ?? "");
            }
          } else if (requestPath === "/api/federation/bond/increase") {
            const amountSat = parsed.amountSat ?? "1";
            const amount = parseSatAmountToRawNumber(amountSat);
            tx = await runBondSubmission(
              "increase",
              async () =>
                await submitSatIncreaseBondPosition(bondCfg as never, {
                  amountRaw: amount.safeInteger,
                }),
            );
            invalidateSatReadCaches({ preserveStable: true });
            liveBond = await readBond();
            if (liveBond?.statusLabel === "active") {
              await syncBondStakingPositionForAction();
              liveBond = await readBond();
            }
            if ((parsed.autoSubmitProof ?? true) && liveBond?.statusLabel === "active") {
              const proof = await runBondSubmission(
                "refresh-proof",
                async () => await tryRunFederationBondProof({ cfg, walletId, liveBond }),
              );
              proofSubmitted = proof.submitted;
              proofWarning = appendActionWarning(proofWarning, proof.warning ?? "");
            }
          } else if (requestPath === "/api/federation/bond/request-unlock") {
            tx = await runBondSubmission(
              "request-unlock",
              async () => await submitSatRequestBondUnlock(bondCfg as never),
            );
            invalidateSatReadCaches({ preserveStable: true });
            liveBond = await readBond();
            await syncBondStakingPositionForAction();
            liveBond = await readBond();
          } else if (requestPath === "/api/federation/bond/cancel-unlock") {
            tx = await runBondSubmission(
              "cancel-unlock",
              async () => await submitSatCancelBondUnlock(bondCfg as never),
            );
            invalidateSatReadCaches({ preserveStable: true });
            liveBond = await readBond();
            if (liveBond?.statusLabel === "active") {
              await syncBondStakingPositionForAction();
              liveBond = await readBond();
            }
          } else if (requestPath === "/api/federation/bond/finalize-unlock") {
            if (liveBond?.statusLabel === "unlocking" && liveBond.unlockAvailableAtSlot > 0) {
              const currentSlot = await inspectSatChainSlot(bondCfg as never).catch(() => 0);
              if (currentSlot > 0 && currentSlot < liveBond.unlockAvailableAtSlot) {
                throw new Error(
                  `bond unlock is not ready yet: current slot ${currentSlot}, unlock available at ${liveBond.unlockAvailableAtSlot}`,
                );
              }
            }
            tx = await runBondSubmission(
              "finalize-unlock",
              async () => await submitSatFinalizeBondUnlock(bondCfg as never),
            );
            invalidateSatReadCaches({ preserveStable: true });
            liveBond = await readBond();
            await syncBondStakingPositionForAction();
            liveBond = await readBond();
          } else if (requestPath === "/api/federation/bond/prove") {
            liveBond = await readBond();
            await runBondSubmission(
              "proof",
              async () => await runFederationBondProof({ cfg, walletId, liveBond }),
            );
            proofSubmitted = true;
            liveBond = await readBond();
          } else if (requestPath === "/api/federation/bond/staking/init") {
            throw new Error(
              "SAT bond staking distributor initialization is a protocol-genesis operation; use the approved token/sat operator workflow",
            );
          } else if (requestPath === "/api/federation/bond/staking/sync") {
            tx = await retrySolanaRateLimit(
              "sync bond staking rewards",
              async () =>
                await runBondSubmission(
                  "sync-staking-rewards",
                  async () => await submitSatSyncBondStakingRewards(bondCfg as never),
                ),
            );
            await retrySolanaRateLimit(
              "sync bond staking position",
              async () =>
                await runBondSubmission(
                  "sync-staking-position",
                  async () => await submitSatSyncBondStakingPosition(bondCfg as never),
                ),
            );
            invalidateSatReadCaches({ preserveStable: true });
            liveBond = await readBond();
          } else if (requestPath === "/api/federation/bond/staking/claim") {
            invalidateSatReadCaches({ preserveStable: true });
            const stakingPositionBeforeClaim = await readBondStakingPosition().catch(() => null);
            const stakingDistributorBeforeClaim = await retrySolanaRateLimit(
              "read bond staking distributor",
              async () => await inspectSatBondStakingDistributor(bondCfg as never),
            ).catch(() => null);
            const estimatedClaimRaw = estimateBondStakingClaimRaw(
              stakingPositionBeforeClaim,
              stakingDistributorBeforeClaim,
            );
            if (isPositiveSatRawAmount(estimatedClaimRaw)) {
              stakingClaimedRaw = estimatedClaimRaw;
              tx = await retrySolanaRateLimit(
                "claim bond staking rewards",
                async () =>
                  await runBondSubmission(
                    "claim-staking-rewards",
                    async () => await submitSatClaimBondStakingRewards(bondCfg as never),
                  ),
              );
            } else {
              proofWarning = "No claimable distributor SAT after sync.";
            }
            invalidateFederationBondReadCaches();
            liveBond = await readBond();
          }
          invalidateFederationBondReadCaches();
          sendLoginResponse(200, {
            ok: true,
            walletId,
            tx,
            proofSubmitted,
            proofWarning,
            stakingClaimedRaw,
            liveBond,
            status: await retrySolanaRateLimit(
              "refresh federation status",
              async () => await readLocalFederationStatus(process.env),
            ),
          });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendLoginResponse(400, {
            ok: false,
            error: { code: "bond_action_failed", message },
          });
          return;
        }
      }
      if (requestPath === "/api/federation/offers/content-summarize/run-paid") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 256 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "payload must be a JSON object" },
          });
          return;
        }
        const result = await runPaidFederatedContentSummarize(body.value as never);
        sendLoginResponse(200, result);
        return;
      }
      if (requestPath === "/api/wallet/settings") {
        if (req.method === "GET") {
          if (!(await ensureWalletApiAuthorized())) {
            return;
          }
          const cfg = loadConfig();
          const selectedWalletId = parsedUrl.searchParams.get("walletId")?.trim() || undefined;
          sendLoginResponse(200, {
            ok: true,
            settings: await buildWalletSettingsPayload(cfg, selectedWalletId, process.env),
          });
          return;
        }
        if (req.method === "PATCH") {
          if (!(await ensureWalletApiAuthorized())) {
            return;
          }
          const body = await readJsonBody(req, 256 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const settingsPayload = (body.value ?? {}) as Record<string, unknown>;
          if (settingsPayload.providerId === "embedded-keystore") {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_legacy_embedded_keystore_migration_required",
                message: LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE,
              },
            });
            return;
          }
          if (settingsPayload.providerId === "privy") {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "provider_unavailable",
                message: "Privy wallet creation and signing are unavailable.",
              },
            });
            return;
          }
          const patch = parseWalletSettingsPatchInput(body.value);
          if (!isManagedGatewayMode(process.env) && !isWalletPolicyPatch(patch)) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "managed_mode_required",
                message:
                  "wallet settings mutation is restricted to managed mode except for policy/limits updates",
              },
            });
            return;
          }
          const currentCfg = loadConfig();
          const currentProviderId = resolveWalletProviderId(currentCfg, process.env);
          const selectedWalletId = patch.walletId?.trim() || undefined;
          const hasScopedPolicyPatch = isWalletScopedPolicyPatch(patch);
          const hasGlobalConfigPatch =
            patch.providerId !== undefined ||
            patch.executionMode !== undefined ||
            patch.approvalAuthMode !== undefined ||
            patch.approvalChallengeTtlSeconds !== undefined ||
            patch.approvalGrantTtlSeconds !== undefined ||
            patch.toolAccessMode !== undefined ||
            patch.toolAccessAllowAgents !== undefined ||
            (!selectedWalletId && hasScopedPolicyPatch);
          if (resolveWalletApprovalAuthMode(process.env, currentCfg) === "webauthn") {
            const approvalAuth = readWalletApprovalAuthSnapshot(process.env, currentCfg);
            const disablingUnenrolledPasskey =
              patch.approvalAuthMode === "none" && approvalAuth.passkeyCount <= 0;
            if (!disablingUnenrolledPasskey) {
              const approvalOperation = isWalletPolicyPatch(patch)
                ? "wallet.policy"
                : "wallet.settings";
              if (
                !ensureWalletApprovalAuthorized({
                  operation: approvalOperation,
                  cfg: currentCfg,
                })
              ) {
                return;
              }
            }
          }
          const currentWallet = resolveWalletRuntimeConfig(currentCfg, process.env);
          const targetProviderId = patch.providerId ?? currentProviderId;
          const switchingToAutonomous =
            patch.executionMode === "autonomous" && currentWallet.execution.mode !== "autonomous";
          if (patch.executionMode === "autonomous" && targetProviderId !== "local-socket-signer") {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "provider_execution_mode_unsupported",
                message: "Autonomous wallet execution currently requires local-socket-signer",
              },
            });
            return;
          }
          if (
            patch.providerId === "turnkey" &&
            !hasTurnkeyPolicyCredentialsConfigured(process.env)
          ) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "provider_prerequisite_missing",
                message:
                  "turnkey cannot be set as default until its dedicated API key, organization, policy, and Solana RPC are configured",
              },
            });
            return;
          }
          if (
            switchingToAutonomous &&
            resolveWalletApprovalAuthMode(process.env, currentCfg) === "webauthn" &&
            !ensureWalletApprovalAuthorized({
              operation: "wallet.execution-mode",
              cfg: currentCfg,
            })
          ) {
            return;
          }

          const effectiveEnv = {
            ...process.env,
            ...currentCfg.env?.vars,
          } as NodeJS.ProcessEnv;
          const registry = readWalletProviderRegistry(effectiveEnv);
          const selectedRegistryWallet = selectedWalletId
            ? registry.wallets.find((wallet) => wallet.id === selectedWalletId)
            : undefined;
          if (
            hasScopedPolicyPatch &&
            !selectedWalletId &&
            currentProviderId === "local-socket-signer"
          ) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "wallet_id_required",
                message:
                  "Signer-backed policy changes require an explicit walletId so one immutable signer policy can acknowledge the change.",
              },
            });
            return;
          }

          let preparedScopedPolicy: PreparedWalletPolicyConfigUpdate | undefined;
          if (selectedWalletId && hasScopedPolicyPatch) {
            try {
              preparedScopedPolicy = prepareWalletPolicyConfigUpdate({
                cfg: currentCfg,
                env: effectiveEnv,
                walletId: selectedWalletId,
                patch: {
                  template: patch.policyTemplate,
                  capsEnabled: patch.capsEnabled,
                  directSigning: patch.directSigning,
                  skillsEnabled: patch.skillsEnabled,
                  solanaAllowPrograms: patch.solanaAllowPrograms,
                  solanaMaxPerTx: patch.solanaMaxPerTx,
                  solanaMaxDaily: patch.solanaMaxDaily,
                  solanaTokenCaps: patch.solanaTokenCaps,
                  recurringTransfer: patch.recurringTransfer,
                },
              });
            } catch (err) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_wallet_settings",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              return;
            }
          }

          let acknowledgedSignerPolicy: LocalSocketSignerPolicyV2 | undefined;
          if (
            preparedScopedPolicy &&
            selectedRegistryWallet?.providerId === "local-socket-signer"
          ) {
            try {
              const scopedWalletId = resolveNativeSignerWalletId(selectedRegistryWallet);
              const signer = new LocalSocketSignerAdapter(
                resolveLocalSignerSocketPath(effectiveEnv),
              );
              const currentSignerPolicy = await signer.getSignerPolicy(scopedWalletId);
              const currentGatewayPolicy = resolveWalletPolicyConfig(
                currentCfg,
                effectiveEnv,
                scopedWalletId,
              ).policy;
              const candidate = buildLocalSignerPolicyTightening({
                current: currentSignerPolicy,
                expectedRole: preparedScopedPolicy.role,
                gatewayPolicy: {
                  capsEnabled: currentGatewayPolicy.capsEnabled,
                  directSigning: currentGatewayPolicy.directSigning,
                  skillsEnabled: currentGatewayPolicy.skillsEnabled,
                  solana: {
                    allowPrograms: currentGatewayPolicy.solana.allowPrograms,
                    maxPerTx: currentGatewayPolicy.solana.caps.maxPerTx.toString(),
                    maxDaily: currentGatewayPolicy.solana.caps.maxDaily.toString(),
                    tokenCaps: Object.fromEntries(
                      Object.entries(currentGatewayPolicy.solana.tokenCaps).map(([mint, cap]) => [
                        mint,
                        {
                          maxPerTx: cap.maxPerTx.toString(),
                          maxDaily: cap.maxDaily.toString(),
                        },
                      ]),
                    ),
                  },
                },
                patch,
                hosting:
                  String(effectiveEnv.FASED_HOST_PROFILE ?? "")
                    .trim()
                    .toLowerCase() === "hosting",
              });
              acknowledgedSignerPolicy = await signer.tightenSignerPolicy({
                walletId: scopedWalletId,
                expectedVersion: currentSignerPolicy.version,
                policy: candidate,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (err instanceof LocalSignerPolicyAdminRequiredError) {
                sendLoginResponse(409, {
                  ok: false,
                  error: { code: err.code, message },
                });
                return;
              }
              if (/version conflict/i.test(message)) {
                sendLoginResponse(409, {
                  ok: false,
                  error: {
                    code: "signer_policy_conflict",
                    message:
                      "Signer policy changed concurrently. Reload the wallet policy and review the new version/hash before retrying.",
                  },
                });
                return;
              }
              if (/cannot (?:add|alter|raise)|policy expansion/i.test(message)) {
                sendLoginResponse(409, {
                  ok: false,
                  error: {
                    code: "signer_policy_admin_required",
                    message: `${message} Policy expansion or role changes require the native signer control socket and an authenticated host administrator; the Gateway cannot perform them.`,
                  },
                });
                return;
              }
              sendLoginResponse(502, {
                ok: false,
                error: {
                  code: "signer_policy_unavailable",
                  message:
                    "Signer policy acknowledgement failed. No wallet policy settings or metadata were saved.",
                },
              });
              return;
            }
          }

          if (acknowledgedSignerPolicy && selectedRegistryWallet) {
            try {
              const latestRegistryWallet = readWalletProviderRegistry(effectiveEnv).wallets.find(
                (wallet) => wallet.id === selectedRegistryWallet.id,
              );
              if (latestRegistryWallet?.providerId !== "local-socket-signer") {
                throw new Error("signer-backed wallet registry entry changed concurrently");
              }
              upsertNamedWallet({
                walletId: latestRegistryWallet.id,
                name: latestRegistryWallet.name,
                providerId: latestRegistryWallet.providerId,
                addresses: latestRegistryWallet.addresses,
                metadata: {
                  ...latestRegistryWallet.metadata,
                  role: acknowledgedSignerPolicy.role,
                  purpose: acknowledgedSignerPolicy.role,
                  policyState: localSignerPolicyState(acknowledgedSignerPolicy),
                  policyVersion: acknowledgedSignerPolicy.version,
                  policyHash: acknowledgedSignerPolicy.hash,
                },
                env: effectiveEnv,
              });
            } catch (err) {
              sendLoginResponse(409, {
                ok: false,
                error: {
                  code: "signer_policy_metadata_conflict",
                  message:
                    `The signer acknowledged policy version ${acknowledgedSignerPolicy.version} (${acknowledgedSignerPolicy.hash}), but its wallet metadata could not be recorded: ` +
                    `${err instanceof Error ? err.message : String(err)}. No app policy settings were saved; reload before retrying.`,
                },
              });
              return;
            }
          }

          let nextCfg = currentCfg;
          if (hasGlobalConfigPatch) {
            const updated = await updateWalletConfig({
              env: process.env,
              mutate: (cfg) => {
                cfg.wallet = cfg.wallet ?? {};
                cfg.wallet.provider = cfg.wallet.provider ?? {};
                cfg.wallet.runtime = cfg.wallet.runtime ?? {};
                cfg.wallet.approvalAuth = cfg.wallet.approvalAuth ?? {};
                cfg.wallet.execution = cfg.wallet.execution ?? {};

                if (patch.providerId) {
                  cfg.wallet.provider.id = patch.providerId;
                }
                if (patch.executionMode) {
                  cfg.wallet.execution.mode = patch.executionMode;
                }
                if (patch.approvalAuthMode) {
                  cfg.wallet.approvalAuth.mode = patch.approvalAuthMode;
                }
                if (typeof patch.approvalChallengeTtlSeconds === "number") {
                  cfg.wallet.approvalAuth.challengeTtlSeconds = patch.approvalChallengeTtlSeconds;
                }
                if (typeof patch.approvalGrantTtlSeconds === "number") {
                  cfg.wallet.approvalAuth.grantTtlSeconds = patch.approvalGrantTtlSeconds;
                }
                if (!selectedWalletId && typeof patch.capsEnabled === "boolean") {
                  cfg.wallet.runtime.policy = cfg.wallet.runtime.policy ?? {};
                  cfg.wallet.runtime.policy.capsEnabled = patch.capsEnabled;
                }
                if (!selectedWalletId && typeof patch.directSigning === "boolean") {
                  cfg.wallet.runtime.policy = cfg.wallet.runtime.policy ?? {};
                  cfg.wallet.runtime.policy.directSigning = patch.directSigning;
                }
                if (!selectedWalletId && typeof patch.skillsEnabled === "boolean") {
                  cfg.wallet.runtime.policy = cfg.wallet.runtime.policy ?? {};
                  cfg.wallet.runtime.policy.skillsEnabled = patch.skillsEnabled;
                }
                if (!selectedWalletId && patch.solanaAllowPrograms !== undefined) {
                  cfg.wallet.runtime.policy = cfg.wallet.runtime.policy ?? {};
                  cfg.wallet.runtime.policy.solana = cfg.wallet.runtime.policy.solana ?? {};
                  cfg.wallet.runtime.policy.solana.allowPrograms = patch.solanaAllowPrograms;
                }
                if (!selectedWalletId && patch.solanaMaxPerTx !== undefined) {
                  cfg.wallet.runtime.policy = cfg.wallet.runtime.policy ?? {};
                  cfg.wallet.runtime.policy.solana = cfg.wallet.runtime.policy.solana ?? {};
                  cfg.wallet.runtime.policy.solana.maxPerTx = patch.solanaMaxPerTx;
                }
                if (!selectedWalletId && patch.solanaMaxDaily !== undefined) {
                  cfg.wallet.runtime.policy = cfg.wallet.runtime.policy ?? {};
                  cfg.wallet.runtime.policy.solana = cfg.wallet.runtime.policy.solana ?? {};
                  cfg.wallet.runtime.policy.solana.maxDaily = patch.solanaMaxDaily;
                }
                if (!selectedWalletId && patch.solanaTokenCaps !== undefined) {
                  cfg.wallet.runtime.policy = cfg.wallet.runtime.policy ?? {};
                  cfg.wallet.runtime.policy.solana = cfg.wallet.runtime.policy.solana ?? {};
                  cfg.wallet.runtime.policy.solana.tokenCaps = patch.solanaTokenCaps;
                }
                if (patch.toolAccessMode !== undefined) {
                  cfg.wallet.runtime.toolAccess = cfg.wallet.runtime.toolAccess ?? {};
                  cfg.wallet.runtime.toolAccess.mode = patch.toolAccessMode;
                }
                if (patch.toolAccessAllowAgents !== undefined) {
                  cfg.wallet.runtime.toolAccess = cfg.wallet.runtime.toolAccess ?? {};
                  cfg.wallet.runtime.toolAccess.allowAgents = patch.toolAccessAllowAgents;
                }
              },
            });
            if (!updated.ok) {
              sendLoginResponse(400, {
                ok: false,
                error: { code: "invalid_wallet_settings", message: updated.message },
              });
              return;
            }
            nextCfg = updated.cfg;
          }
          if (preparedScopedPolicy) {
            try {
              commitWalletPolicyConfigUpdate(preparedScopedPolicy, effectiveEnv);
            } catch (err) {
              sendLoginResponse(409, {
                ok: false,
                error: {
                  code: "wallet_policy_conflict",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              return;
            }
          }
          if (isWalletPolicyPatch(patch)) {
            appendWalletAuditEntry({
              action: "wallet_policy_updated",
              actor: "control-ui",
              details: {
                walletId: selectedWalletId,
                global: !selectedWalletId,
                fields: Object.keys(patch).filter((key) => key !== "walletId"),
              },
              env: process.env,
            });
          }
          sendLoginResponse(200, {
            ok: true,
            settings: await buildWalletSettingsPayload(
              nextCfg,
              selectedWalletId,
              effectiveEnv,
              acknowledgedSignerPolicy,
            ),
          });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, PATCH");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET or PATCH" },
        });
        return;
      }
      if (requestPath === "/api/wallet/solana-token-search") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const query = parsedUrl.searchParams.get("query")?.trim() || "";
        if (!query) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "query is required" },
          });
          return;
        }
        const walletId = parsedUrl.searchParams.get("walletId")?.trim() || undefined;
        const rpcUrl = resolveScopedRpcUrlForWallet({
          env: process.env,
          chains: ["solana"],
          walletId,
        });
        const tokens = await searchSolanaTokens({ query, rpcUrl });
        sendLoginResponse(200, {
          ok: true,
          query,
          tokens,
        });
        return;
      }
      if (requestPath === "/api/wallet/providers") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method === "GET") {
          const cfg = loadConfig();
          const includeDerivedWallets =
            new URL(req.url ?? "/", "http://localhost").searchParams.get("includeDerived") === "1";
          sendLoginResponse(200, {
            ok: true,
            ...(await buildWalletProviderPayload({
              cfg,
              env: process.env,
              includeDerivedWallets,
            })),
          });
          return;
        }
        if (req.method === "PATCH") {
          if (!isManagedGatewayMode(process.env)) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "managed_mode_required",
                message: "wallet provider mutation is restricted to managed mode",
              },
            });
            return;
          }
          const body = await readJsonBody(req, 128 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          if (body.value != null && (typeof body.value !== "object" || Array.isArray(body.value))) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_request",
                message: "signer-reviewed approval body must be a JSON object",
              },
            });
            return;
          }
          const payload = (body.value ?? {}) as Record<string, unknown>;
          if (payload.providerId === "embedded-keystore") {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_legacy_embedded_keystore_migration_required",
                message: LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE,
              },
            });
            return;
          }
          if (payload.providerId === "privy") {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "provider_unavailable",
                message: "Privy wallet creation and signing are unavailable.",
              },
            });
            return;
          }
          const providerId = parseWalletProviderId(payload.providerId);
          if (!providerId) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: "providerId is required" },
            });
            return;
          }
          if (typeof payload.enabled === "boolean" || typeof payload.label === "string") {
            setWalletProviderEnabled({
              providerId,
              enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
              label: typeof payload.label === "string" ? payload.label : undefined,
              env: process.env,
            });
          }
          if (payload.setDefault === true) {
            if (providerId === "turnkey" && !hasTurnkeyPolicyCredentialsConfigured(process.env)) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "provider_prerequisite_missing",
                  message:
                    "turnkey cannot be set as default until its dedicated API key, organization, policy, and Solana RPC are configured",
                },
              });
              return;
            }
            const updated = await updateWalletConfig({
              env: process.env,
              mutate: (cfg) => {
                cfg.wallet = cfg.wallet ?? {};
                cfg.wallet.provider = cfg.wallet.provider ?? {};
                cfg.wallet.provider.id = providerId;
              },
            });
            if (!updated.ok) {
              sendLoginResponse(400, {
                ok: false,
                error: { code: "invalid_wallet_settings", message: updated.message },
              });
              return;
            }
          }
          const cfg = loadConfig();
          sendLoginResponse(200, {
            ok: true,
            ...(await buildWalletProviderPayload({ cfg, env: process.env })),
          });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, PATCH");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET or PATCH" },
        });
        return;
      }
      if (requestPath === "/api/wallet/wallets") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method === "GET") {
          const cfg = loadConfig();
          const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
          const registry = readWalletProviderRegistry(effectiveEnv);
          const wallets = registry.wallets.map((wallet) => {
            const solanaRpc = resolveWalletRpcUrlFromEnv(effectiveEnv, "solana", wallet.id);
            return {
              ...wallet,
              rpc: {
                configured: Boolean(solanaRpc),
                ...(maskWalletRpcUrl(solanaRpc) ? { maskedUrl: maskWalletRpcUrl(solanaRpc) } : {}),
              },
              readiness: {
                keystore:
                  wallet.providerId !== "embedded-keystore" && wallet.providerId !== "privy",
                rpc: Boolean(solanaRpc),
              },
            };
          });
          sendLoginResponse(200, {
            ok: true,
            wallets,
            assignments: registry.assignments,
            defaultWalletId: registry.defaultWalletId,
            checkedAt: new Date().toISOString(),
          });
          return;
        }
        if (!isManagedGatewayMode(process.env)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "managed_mode_required",
              message: "wallet mutation is restricted to managed mode",
            },
          });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req, 128 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const payload = (body.value ?? {}) as Record<string, unknown>;
          if (payload.providerId === "embedded-keystore") {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_legacy_embedded_keystore_migration_required",
                message: LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE,
              },
            });
            return;
          }
          if (payload.providerId === "privy") {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "provider_unavailable",
                message: "Privy wallet creation and signing are unavailable.",
              },
            });
            return;
          }
          const cfg = loadConfig();
          const walletCfg = resolveWalletRuntimeConfig(cfg, process.env);
          const providerId =
            parseWalletProviderId(payload.providerId) ?? resolveWalletProviderId(cfg, process.env);
          const requestedWalletName = typeof payload.name === "string" ? payload.name.trim() : "";
          const requestedWalletId =
            typeof payload.walletId === "string" ? payload.walletId.trim() : "";
          const roleProvided = Object.prototype.hasOwnProperty.call(payload, "role");
          const normalizedRole = roleProvided ? normalizeWalletUserRole(payload.role) : undefined;
          const requestedRole =
            normalizedRole === "agent" || normalizedRole === "mining" || normalizedRole === "vault"
              ? normalizedRole
              : undefined;
          if (roleProvided && !requestedRole) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_wallet_role",
                message: "role must be agent, mining, or vault",
              },
            });
            return;
          }
          const generatedLocalSignerIdentity =
            providerId === "local-socket-signer" && requestedRole
              ? nextRoleWalletIdentity(
                  requestedRole,
                  readWalletProviderRegistry(process.env).wallets,
                )
              : undefined;
          const localSignerWalletId =
            providerId === "local-socket-signer" && requestedRole
              ? requestedWalletId || generatedLocalSignerIdentity?.walletId || ""
              : requestedWalletId;
          const walletName = requestedWalletName || generatedLocalSignerIdentity?.walletName || "";
          const activeMiningWalletId = readSatMiningWalletIdFromConfig(loadConfig());
          if (
            requestedRole === "mining" &&
            activeMiningWalletId &&
            localSignerWalletId !== activeMiningWalletId
          ) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_in_use",
                message: `Mining already uses the singleton wallet ${activeMiningWalletId}; use the reviewed Replace/Archive flow instead of creating a second Mining wallet`,
              },
            });
            return;
          }
          if (!walletName) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: "name is required" },
            });
            return;
          }
          if (providerId === "wallet-standard") {
            const address = typeof payload.address === "string" ? payload.address.trim() : "";
            if (!address || !isValidSolanaAddress(address)) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_solana_address",
                  message: "a valid browser-selected Solana account is required",
                },
              });
              return;
            }
            if (requestedRole && requestedRole !== "vault") {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_wallet_role",
                  message: "Wallet Standard accounts are supported as reviewed Vault wallets only",
                },
              });
              return;
            }
            try {
              const wallet = upsertNamedWallet({
                walletId: requestedWalletId || undefined,
                name: walletName,
                providerId,
                addresses: { solana: address },
                metadata: {
                  role: "vault",
                  purpose: "vault",
                  browserSigner: true,
                  selfHosted: false,
                },
                env: process.env,
              });
              appendWalletAuditEntry({
                action: "wallet_named_created",
                actor: "control-ui",
                details: {
                  walletId: wallet.id,
                  walletName: wallet.name,
                  providerId: wallet.providerId,
                  addresses: wallet.addresses,
                },
                env: process.env,
              });
              sendLoginResponse(200, { ok: true, wallet });
            } catch (err) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_request",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
            }
            return;
          }
          if (providerId === "local-socket-signer") {
            if (!requestedRole) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_wallet_role",
                  message: "choose agent, mining, or vault; the native signer never infers a role",
                },
              });
              return;
            }
            const chain = inferLocalSignerCreateChain({
              payloadChain: payload.chain,
              walletId: localSignerWalletId,
              walletName,
              runtimeChains: walletCfg.chains,
            });
            if (!chain) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_request",
                  message: "chain is required for local signer wallet creation; use chain=solana",
                },
              });
              return;
            }
            const rpcUrl = typeof payload.rpcUrl === "string" ? payload.rpcUrl.trim() : "";
            if (!rpcUrl) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_request",
                  message:
                    "one primary Solana RPC URL is required for native signer wallet creation",
                },
              });
              return;
            }
            try {
              // Wallet setup writes through the CLI lifecycle. Refresh the Gateway's
              // runtime snapshot before and after it so repeated UI creations cannot
              // overwrite a prior wallet RPC and the new wallet is usable immediately.
              await activateLatestWalletRuntimeConfig();
              await walletSetupCommand(silentWalletSetupRuntime, {
                mode: "local-signer-create",
                chain,
                walletId: localSignerWalletId,
                walletName,
                rpcUrl,
                role: requestedRole,
                // Resume an exact deny-all signer wallet if a prior RPC/bootstrap
                // attempt failed after durable key creation. The signer validates
                // the wallet ID and role and never overwrites the existing key.
                force: true,
                nonInteractive: true,
                noSignerHints: true,
                noDoctor: true,
              });
              await activateLatestWalletRuntimeConfig();
              const registry = readWalletProviderRegistry(process.env);
              const wallet = registry.wallets.find((entry) => entry.id === localSignerWalletId);
              if (!wallet) {
                throw new Error("local signer wallet was created but not registered");
              }
              appendWalletAuditEntry({
                action: "wallet_named_created",
                actor: "control-ui",
                details: {
                  walletId: wallet.id,
                  walletName: wallet.name,
                  providerId: wallet.providerId,
                  addresses: wallet.addresses,
                },
                env: process.env,
              });
              sendLoginResponse(200, { ok: true, wallet });
              return;
            } catch (err) {
              sendLoginResponse(502, {
                ok: false,
                error: {
                  code: "wallet_provider_error",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              return;
            }
          }
          const adapter = createWalletProviderAdapter({
            cfg,
            wallet: walletCfg,
            env: process.env,
            providerIdOverride: providerId,
            walletId: requestedWalletId || undefined,
          });
          let addresses: { solana?: string } | undefined;
          let metadata: Record<string, unknown> | undefined;
          let providerWalletId: string | undefined;
          try {
            if (adapter.createWallet) {
              const created = await adapter.createWallet();
              addresses = created.addresses;
              metadata = {
                ...created.metadata,
                ...(requestedRole ? { role: requestedRole, purpose: requestedRole } : {}),
              };
              providerWalletId = created.walletId?.trim() || undefined;
            } else {
              addresses = await adapter.getAddresses({
                walletId: requestedWalletId || undefined,
              });
              metadata = requestedRole
                ? { role: requestedRole, purpose: requestedRole }
                : undefined;
            }
          } catch (err) {
            sendLoginResponse(502, {
              ok: false,
              error: {
                code: "wallet_provider_error",
                message: String(err),
              },
            });
            return;
          }
          let wallet: ReturnType<typeof upsertNamedWallet>;
          try {
            wallet = upsertNamedWallet({
              walletId: requestedWalletId || providerWalletId,
              name: walletName,
              providerId,
              addresses,
              metadata,
              env: process.env,
            });
          } catch (err) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_request",
                message: err instanceof Error ? err.message : String(err),
              },
            });
            return;
          }
          appendWalletAuditEntry({
            action: "wallet_named_created",
            actor: "control-ui",
            details: {
              walletId: wallet.id,
              walletName: wallet.name,
              providerId: wallet.providerId,
              addresses: wallet.addresses,
            },
            env: process.env,
          });
          sendLoginResponse(200, { ok: true, wallet });
          return;
        }
        if (req.method === "PATCH") {
          const body = await readJsonBody(req, 64 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const payload = (body.value ?? {}) as Record<string, unknown>;
          const walletId = typeof payload.walletId === "string" ? payload.walletId.trim() : "";
          const name =
            typeof payload.name === "string" && payload.name.trim()
              ? payload.name.trim()
              : undefined;
          const roleProvided = Object.prototype.hasOwnProperty.call(payload, "role");
          const normalizedRole = roleProvided ? normalizeWalletUserRole(payload.role) : undefined;
          const requestedRole =
            normalizedRole === "agent" || normalizedRole === "mining" || normalizedRole === "vault"
              ? normalizedRole
              : undefined;
          const rpcUrl = typeof payload.rpcUrl === "string" ? payload.rpcUrl.trim() : "";
          const rpcProvided = Object.prototype.hasOwnProperty.call(payload, "rpcUrl");
          if (!walletId || (!name && !roleProvided && !rpcProvided)) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_request",
                message: "walletId and role or rpcUrl are required",
              },
            });
            return;
          }
          if (roleProvided && !requestedRole) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_wallet_role",
                message: "role must be agent, mining, or vault",
              },
            });
            return;
          }
          if (name) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_name_locked",
                message:
                  "wallet display name is fixed after creation; create a new wallet if you need a different permanent label",
              },
            });
            return;
          }
          const registry = readWalletProviderRegistry(process.env);
          const existing = registry.wallets.find((entry) => entry.id === walletId);
          if (!existing) {
            sendLoginResponse(404, {
              ok: false,
              error: { code: "wallet_not_found", message: "walletId not found" },
            });
            return;
          }
          if (rpcProvided) {
            if (!rpcUrl) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_request",
                  message: "RPC is required",
                },
              });
              return;
            }
            if (existing.providerId !== "local-socket-signer") {
              sendLoginResponse(409, {
                ok: false,
                error: {
                  code: "invalid_provider",
                  message: "RPC editing is available only for local wallets",
                },
              });
              return;
            }
            const cfg = loadConfig();
            if (!ensureWalletApprovalAuthorized({ operation: "wallet.network", cfg })) {
              return;
            }
            try {
              const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
              const signerWalletId = resolveNativeSignerWalletId(existing);
              const network = await configureSignerOwnedWalletNetwork({
                walletId: signerWalletId,
                primaryRpcUrl: rpcUrl,
                env: effectiveEnv,
                socketPath: resolveLocalSignerSocketPath(effectiveEnv),
              });
              const suffix = normalizeWalletIdForEnvSuffix(walletId)?.toUpperCase();
              const rpcKey = suffix
                ? `FASED_WALLET_SOLANA_RPC_URL__${suffix}`
                : "FASED_WALLET_SOLANA_RPC_URL";
              const configUpdate = await updateWalletConfig({
                env: effectiveEnv,
                mutate: (next) => {
                  next.env = { ...next.env, vars: { ...next.env?.vars, [rpcKey]: rpcUrl } };
                },
              });
              if (!configUpdate.ok) {
                throw new Error(
                  `signer accepted network version ${network.version}, but app configuration persistence failed: ${configUpdate.message}`,
                );
              }
              upsertNamedWallet({
                walletId: existing.id,
                name: existing.name,
                providerId: existing.providerId,
                addresses: existing.addresses,
                metadata: {
                  ...existing.metadata,
                  networkHash: network.hash,
                  networkVersion: network.version,
                  networkReady: network.ready,
                },
                env: process.env,
              });
              appendWalletAuditEntry({
                action: "wallet_rpc_updated",
                actor: "control-ui",
                details: { walletId, networkVersion: network.version, networkReady: network.ready },
                env: process.env,
              });
            } catch (err) {
              const rawMessage = err instanceof Error ? err.message : String(err);
              const message = /does not match|no longer agrees|disagree/iu.test(rawMessage)
                ? "This RPC is on a different Solana network. Use a provider URL for this wallet's current network."
                : /genesis verification failed|returned an invalid genesis hash/iu.test(rawMessage)
                  ? "This URL did not answer as a Solana RPC. Check the provider URL and API key, then try again."
                  : rawMessage;
              sendLoginResponse(502, {
                ok: false,
                error: {
                  code: "wallet_rpc_update_failed",
                  message,
                },
              });
              return;
            }
          }
          const activeMiningWalletId = readSatMiningWalletIdFromConfig(loadConfig());
          if (requestedRole === "mining") {
            const miningConflict = resolveMiningAgentWalletConflict(walletId);
            if (miningConflict) {
              sendLoginResponse(409, {
                ok: false,
                error: { code: "wallet_in_use", message: miningConflict },
              });
              return;
            }
          }
          if (requestedRole && requestedRole !== "mining" && walletId === activeMiningWalletId) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_in_use",
                message:
                  "walletId is the singleton SAT Mining wallet; use the guarded Archive/Replace flow before creating a wallet with a different role",
              },
            });
            return;
          }
          if (requestedRole) {
            if (existing.providerId === "local-socket-signer") {
              try {
                const cfg = loadConfig();
                const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
                const signerPolicy = await new LocalSocketSignerAdapter(
                  resolveLocalSignerSocketPath(effectiveEnv),
                ).getSignerPolicy(resolveNativeSignerWalletId(existing));
                if (signerPolicy.role !== requestedRole) {
                  sendLoginResponse(409, {
                    ok: false,
                    error: {
                      code: "signer_wallet_role_immutable",
                      message:
                        `The native signer owns this wallet as role=${signerPolicy.role}; the Gateway cannot change it to ${requestedRole}. ` +
                        "Create a new signer-owned wallet with the required locked role, then use the guarded Archive/Replace flow for the old wallet.",
                    },
                  });
                  return;
                }
              } catch {
                sendLoginResponse(502, {
                  ok: false,
                  error: {
                    code: "signer_policy_unavailable",
                    message:
                      "The native signer role could not be verified, so wallet role metadata was not changed.",
                  },
                });
                return;
              }
            }
            const currentRole =
              resolveWalletUserRole(existing) ??
              (registry.defaultWalletId === walletId ? "agent" : undefined);
            if (currentRole && currentRole !== requestedRole) {
              sendLoginResponse(409, {
                ok: false,
                error: {
                  code: "wallet_purpose_locked",
                  message:
                    "wallet purpose is permanent after creation; create a new wallet for the requested purpose",
                },
              });
              return;
            }
          }
          if (requestedRole) {
            setNamedWalletRole({
              walletId,
              role: requestedRole,
              env: process.env,
            });
          }
          const updatedRegistry = readWalletProviderRegistry(process.env);
          const wallet = updatedRegistry.wallets.find((entry) => entry.id === walletId);
          sendLoginResponse(200, { ok: true, wallet });
          return;
        }
        if (req.method === "DELETE") {
          const body = await readJsonBody(req, 64 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const payload = (body.value ?? {}) as Record<string, unknown>;
          const walletId = typeof payload.walletId === "string" ? payload.walletId.trim() : "";
          const archiveRequested = payload.archive === true;
          const archiveConfirmation =
            typeof payload.confirmWalletId === "string" ? payload.confirmWalletId.trim() : "";
          if (!walletId) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: "walletId is required" },
            });
            return;
          }
          if (archiveRequested && archiveConfirmation !== walletId) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "archive_confirmation_required",
                message: "confirmWalletId must exactly match walletId",
              },
            });
            return;
          }
          const activeMiningWalletId = readSatMiningWalletIdFromConfig(loadConfig());
          if (activeMiningWalletId === walletId && !archiveRequested) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_in_use",
                message:
                  "walletId is the singleton SAT Mining wallet; request the guarded Archive flow instead of ordinary delete",
              },
            });
            return;
          }
          const registry = readWalletProviderRegistry(process.env);
          const existing = registry.wallets.find((entry) => entry.id === walletId);
          if (!existing) {
            sendLoginResponse(404, {
              ok: false,
              error: { code: "wallet_not_found", message: "walletId not found" },
            });
            return;
          }
          if (resolveWalletUserRole(existing) === "mining") {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "mining_retirement_required",
                message:
                  "Mining wallets cannot be deleted directly; use Retire and replace Mining wallet so signer acknowledgement precedes registry detachment",
              },
            });
            return;
          }
          const deletionSafety = checkNamedWalletDeletionSafety({
            walletId,
            env: process.env,
          });
          if (!deletionSafety.ok) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: deletionSafety.code,
                message: deletionSafety.message,
                details: deletionSafety.details,
              },
            });
            return;
          }
          if (existing.providerId === "local-socket-signer" && archiveRequested) {
            const cfg = loadConfig();
            if (!ensureWalletApprovalAuthorized({ operation: "wallet.archive", cfg })) {
              return;
            }
            let archivedPolicy;
            try {
              const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
              archivedPolicy = await lockSignerOwnedWalletForArchive({
                wallet: existing,
                socketPath: resolveLocalSignerSocketPath(effectiveEnv),
              });
              const federationWalletId = resolveFederationBondDefaultWalletId(cfg);
              const suffix = normalizeWalletIdForEnvSuffix(walletId)?.toUpperCase();
              const rpcKey = suffix
                ? `FASED_WALLET_SOLANA_RPC_URL__${suffix}`
                : "FASED_WALLET_SOLANA_RPC_URL";
              const updated = await updateWalletConfig({
                env: effectiveEnv,
                mutate: (next) => {
                  if (next.env?.vars) {
                    delete next.env.vars[rpcKey];
                  }
                  const currentEntry = next.plugins?.entries?.["sat-mining"];
                  const currentSatConfig =
                    currentEntry?.config &&
                    typeof currentEntry.config === "object" &&
                    !Array.isArray(currentEntry.config)
                      ? { ...currentEntry.config }
                      : {};
                  if ((currentSatConfig as { walletId?: unknown }).walletId === walletId) {
                    delete (currentSatConfig as { walletId?: unknown }).walletId;
                    next.plugins = {
                      ...next.plugins,
                      entries: {
                        ...next.plugins?.entries,
                        "sat-mining": { enabled: true, ...currentEntry, config: currentSatConfig },
                      },
                    };
                  }
                  if (federationWalletId === walletId) {
                    applyFederationBondWalletConfig(next, null);
                  }
                },
              });
              if (!updated.ok) {
                throw new Error(
                  `signer locked the wallet, but attachment cleanup failed: ${updated.message}`,
                );
              }
            } catch (err) {
              sendLoginResponse(502, {
                ok: false,
                error: {
                  code: "wallet_archive_failed",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              return;
            }
            const removed = deleteNamedWallet({ walletId, env: process.env });
            appendWalletAuditEntry({
              action: "wallet_archived",
              actor: "control-ui",
              details: {
                walletId,
                signerWalletId: archivedPolicy.walletId,
                denyAllPolicyVersion: archivedPolicy.version,
              },
              env: process.env,
            });
            sendLoginResponse(200, { ok: true, removed: removed.removed, archived: true });
            return;
          }
          if (
            existing.providerId === "local-socket-signer" ||
            existing.providerId === "embedded-keystore" ||
            existing.metadata?.selfHosted === true
          ) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_requires_onboarding_delete",
                message:
                  "signer-owned wallets must be removed through the native signer/onboarding flow so signer state and mining attachments are handled safely",
              },
            });
            return;
          }
          const removed = deleteNamedWallet({
            walletId,
            env: process.env,
            protectedWalletIds: activeMiningWalletId ? [activeMiningWalletId] : [],
          });
          sendLoginResponse(200, { ok: true, removed: removed.removed });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST, PATCH, DELETE");
        sendLoginResponse(405, {
          ok: false,
          error: {
            code: "method_not_allowed",
            message: "method must be GET, POST, PATCH, or DELETE",
          },
        });
        return;
      }
      if (requestPath === "/api/wallet/receive-qr") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        const walletId = parsedUrl.searchParams.get("walletId")?.trim() ?? "";
        const wallet = readWalletProviderRegistry(process.env).wallets.find(
          (entry) => entry.id === walletId,
        );
        const address = wallet?.addresses?.solana?.trim() ?? "";
        if (!walletId || !address || !isValidSolanaAddress(address)) {
          sendLoginResponse(404, {
            ok: false,
            error: { code: "wallet_address_not_found", message: "wallet address not found" },
          });
          return;
        }
        const png = Buffer.from(await renderQrPngBase64(`solana:${address}`), "base64");
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Length", String(png.byteLength));
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.end(png);
        return;
      }
      if (requestPath === "/api/wallet/assignments") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method === "GET") {
          const registry = readWalletProviderRegistry(process.env);
          sendLoginResponse(200, {
            ok: true,
            assignments: registry.assignments,
            defaultWalletId: registry.defaultWalletId,
          });
          return;
        }
        if (!isManagedGatewayMode(process.env)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "managed_mode_required",
              message: "wallet assignment mutation is restricted to managed mode",
            },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payload = (body.value ?? {}) as Record<string, unknown>;
        if (req.method === "PUT") {
          if (typeof payload.defaultWalletId === "string" || payload.defaultWalletId === null) {
            const nextDefaultWalletId =
              typeof payload.defaultWalletId === "string" ? payload.defaultWalletId.trim() : "";
            const activeMiningWalletId = readSatMiningWalletIdFromConfig(loadConfig());
            if (nextDefaultWalletId && nextDefaultWalletId === activeMiningWalletId) {
              sendLoginResponse(409, {
                ok: false,
                error: {
                  code: "wallet_in_use",
                  message:
                    "walletId is the singleton SAT Mining wallet; Archive/Replace Mining with an Agent wallet before making it the Default Agent wallet fallback",
                },
              });
              return;
            }
            if (nextDefaultWalletId) {
              const registry = readWalletProviderRegistry(process.env);
              const wallet = registry.wallets.find((entry) => entry.id === nextDefaultWalletId);
              const role =
                resolveWalletUserRole(wallet) ??
                (registry.defaultWalletId === nextDefaultWalletId ? "agent" : undefined);
              if (role !== "agent") {
                sendLoginResponse(409, {
                  ok: false,
                  error: {
                    code: "wallet_purpose_locked",
                    message:
                      "only an explicit Agent wallet can become the Default Agent wallet fallback; create or select an Agent wallet instead",
                  },
                });
                return;
              }
            }
            setDefaultWallet({
              walletId: nextDefaultWalletId || undefined,
              env: process.env,
            });
          }
          const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
          if (agentId) {
            const assignedWalletId =
              typeof payload.walletId === "string" ? payload.walletId.trim() : "";
            if (assignedWalletId) {
              const registry = readWalletProviderRegistry(process.env);
              const wallet = registry.wallets.find((entry) => entry.id === assignedWalletId);
              if (!wallet) {
                sendLoginResponse(404, {
                  ok: false,
                  error: { code: "wallet_not_found", message: "walletId does not exist" },
                });
                return;
              }
              if (resolveWalletUserRole(wallet) !== "agent") {
                sendLoginResponse(409, {
                  ok: false,
                  error: {
                    code: "wallet_purpose_locked",
                    message: "only an explicit Agent wallet can be assigned to an Agent",
                  },
                });
                return;
              }
            }
            setAgentWalletAssignment({
              agentId,
              walletId: assignedWalletId || undefined,
              env: process.env,
            });
          }
          const registry = readWalletProviderRegistry(process.env);
          sendLoginResponse(200, {
            ok: true,
            assignments: registry.assignments,
            defaultWalletId: registry.defaultWalletId,
          });
          return;
        }
        if (req.method === "DELETE") {
          const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
          if (!agentId) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: "agentId is required" },
            });
            return;
          }
          setAgentWalletAssignment({
            agentId,
            walletId: undefined,
            env: process.env,
          });
          const registry = readWalletProviderRegistry(process.env);
          sendLoginResponse(200, {
            ok: true,
            assignments: registry.assignments,
            defaultWalletId: registry.defaultWalletId,
          });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, PUT, DELETE");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET, PUT, or DELETE" },
        });
        return;
      }
      if (requestPath === "/api/wallet/settings/rpc") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (!isManagedGatewayMode(process.env)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "managed_mode_required",
              message: "wallet settings mutation is restricted to managed mode",
            },
          });
          return;
        }
        if (req.method === "PUT") {
          const cfg = loadConfig();
          if (
            resolveWalletApprovalAuthMode(process.env, cfg) === "webauthn" &&
            !ensureWalletApprovalAuthorized({
              operation: "wallet.provider-credentials",
              cfg,
            })
          ) {
            return;
          }
          const body = await readJsonBody(req, 128 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          sendLoginResponse(410, {
            ok: false,
            error: {
              code: "removed",
              message:
                "wallet RPC secret endpoint was removed with the legacy Docker signer. Configure provider credentials or provider-specific RPC settings instead.",
            },
          });
          return;
        }
        if (req.method === "DELETE") {
          const cfg = loadConfig();
          if (
            resolveWalletApprovalAuthMode(process.env, cfg) === "webauthn" &&
            !ensureWalletApprovalAuthorized({
              operation: "wallet.provider-credentials",
              cfg,
            })
          ) {
            return;
          }
          const providerId =
            parseWalletProviderId(
              new URL(req.url || "/", "http://localhost").searchParams.get("providerId"),
            ) ?? null;
          const _ = providerId;
          sendLoginResponse(410, {
            ok: false,
            error: {
              code: "removed",
              message: "wallet RPC secret endpoint was removed with the legacy Docker signer.",
            },
          });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "PUT, DELETE");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be PUT or DELETE" },
        });
        return;
      }
      if (requestPath === "/api/wallet/settings/provider-credentials") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (!isManagedGatewayMode(process.env)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "managed_mode_required",
              message: "wallet settings mutation is restricted to managed mode",
            },
          });
          return;
        }
        const cfg = loadConfig();
        const configuredProviderId = resolveWalletProviderId(cfg, process.env);
        const resolveProviderFromInput = (value: unknown): WalletProviderId | null =>
          parseWalletProviderId(value);
        if (req.method === "GET") {
          const queryProviderId = parseWalletProviderId(
            new URL(req.url || "/", "http://localhost").searchParams.get("providerId"),
          );
          const providerId = queryProviderId ?? configuredProviderId;
          const walletCfg = resolveWalletRuntimeConfig(cfg, process.env);
          sendLoginResponse(200, {
            ok: true,
            provider: providerId,
            status: resolveProviderCredentialStatus({
              providerId,
              wallet: walletCfg,
              env: process.env,
            }),
          });
          return;
        }
        if (req.method === "PUT") {
          if (
            resolveWalletApprovalAuthMode(process.env, cfg) === "webauthn" &&
            !ensureWalletApprovalAuthorized({
              operation: "wallet.provider-credentials",
              cfg,
            })
          ) {
            return;
          }
          const body = await readJsonBody(req, 128 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const payload = (body.value ?? {}) as Record<string, unknown>;
          if (payload.providerId === "embedded-keystore") {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_legacy_embedded_keystore_migration_required",
                message: LEGACY_EMBEDDED_KEYSTORE_MIGRATION_MESSAGE,
              },
            });
            return;
          }
          if (payload.providerId === "privy") {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "provider_unavailable",
                message: "Privy wallet creation and signing are unavailable.",
              },
            });
            return;
          }
          const providerId = resolveProviderFromInput(payload.providerId) ?? configuredProviderId;
          if (providerId !== "alchemy" && providerId !== "turnkey") {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "provider_credentials_not_accepted",
                message: `${providerId} does not accept Gateway-held provider credentials.`,
              },
            });
            return;
          }
          let credentials: Record<string, string> = {};
          if (providerId === "alchemy") {
            const apiKey = toOptionalString(payload.apiKey);
            const serverSignerAccessKey = toOptionalString(payload.serverSignerAccessKey);
            if (!apiKey || !serverSignerAccessKey) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_request",
                  message: "apiKey and serverSignerAccessKey are required for alchemy",
                },
              });
              return;
            }
            credentials = {
              apiKey,
              serverSignerAccessKey,
              ...(toOptionalString(payload.serverSignerAccountId)
                ? { serverSignerAccountId: String(payload.serverSignerAccountId).trim() }
                : {}),
              ...(toOptionalString(payload.walletApiBaseUrl)
                ? { walletApiBaseUrl: String(payload.walletApiBaseUrl).trim() }
                : {}),
              ...(toOptionalString(payload.signerApiBaseUrl)
                ? { signerApiBaseUrl: String(payload.signerApiBaseUrl).trim() }
                : {}),
              ...(toOptionalString(payload.defaultSolanaAddress)
                ? { defaultSolanaAddress: String(payload.defaultSolanaAddress).trim() }
                : {}),
            };
          } else {
            const rawCredentials = payload.credentials;
            if (
              !rawCredentials ||
              typeof rawCredentials !== "object" ||
              Array.isArray(rawCredentials)
            ) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_request",
                  message: "credentials object is required for this provider",
                },
              });
              return;
            }
            for (const [key, value] of Object.entries(rawCredentials as Record<string, unknown>)) {
              const normalizedKey = key.trim();
              const normalizedValue = typeof value === "string" ? value.trim() : "";
              if (!normalizedKey || !normalizedValue) {
                continue;
              }
              credentials[normalizedKey] = normalizedValue;
            }
            if (Object.keys(credentials).length === 0) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "invalid_request",
                  message: "credentials object must include at least one non-empty string value",
                },
              });
              return;
            }
            if (providerId === "turnkey") {
              const allowedTurnkeyFields = new Set([
                "apiPublicKey",
                "apiPrivateKey",
                "organizationId",
                "policyId",
                "baseUrl",
                "rpcUrl",
                "defaultSolanaAddress",
                "providerWalletId",
              ]);
              const unsupportedField = Object.keys(credentials).find(
                (field) => !allowedTurnkeyFields.has(field),
              );
              if (unsupportedField) {
                sendLoginResponse(400, {
                  ok: false,
                  error: {
                    code: "invalid_request",
                    message: `unsupported turnkey credential field: ${unsupportedField}`,
                  },
                });
                return;
              }
              if (
                typeof credentials.apiPublicKey !== "string" ||
                typeof credentials.apiPrivateKey !== "string" || // pragma: allowlist secret
                typeof credentials.organizationId !== "string" ||
                typeof credentials.policyId !== "string" ||
                typeof credentials.rpcUrl !== "string"
              ) {
                sendLoginResponse(400, {
                  ok: false,
                  error: {
                    code: "invalid_request",
                    message:
                      "turnkey credentials must include apiPublicKey, apiPrivateKey, organizationId, policyId, and rpcUrl",
                  },
                });
                return;
              }
            }
          }
          const saved = saveWalletProviderSecret(
            {
              providerId,
              credentials,
            },
            process.env,
          );
          sendLoginResponse(200, {
            ok: true,
            provider: providerId,
            status: readWalletProviderSecretStatus(providerId, process.env),
            savedAt: saved.updatedAt,
          });
          return;
        }
        if (req.method === "DELETE") {
          if (
            resolveWalletApprovalAuthMode(process.env, cfg) === "webauthn" &&
            !ensureWalletApprovalAuthorized({
              operation: "wallet.provider-credentials",
              cfg,
            })
          ) {
            return;
          }
          const providerId =
            parseWalletProviderId(
              new URL(req.url || "/", "http://localhost").searchParams.get("providerId"),
            ) ?? configuredProviderId;
          const removed = deleteWalletProviderSecret(providerId, process.env);
          sendLoginResponse(200, {
            ok: true,
            provider: providerId,
            removed,
          });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, PUT, DELETE");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET, PUT, or DELETE" },
        });
        return;
      }
      if (requestPath === "/api/wallet/settings/validate") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        const payloadRaw = body.ok ? body.value : {};
        const payload =
          payloadRaw && typeof payloadRaw === "object" && !Array.isArray(payloadRaw)
            ? (payloadRaw as Record<string, unknown>)
            : {};
        const cfg = loadConfig();
        const walletCfg = resolveWalletRuntimeConfig(cfg, process.env);
        const requestedProviderId =
          typeof payload.providerId === "string"
            ? parseWalletProviderId(payload.providerId)
            : undefined;
        const providerId = requestedProviderId ?? resolveWalletProviderId(cfg, process.env);
        const providerSecret = readWalletProviderSecretStatus(providerId, process.env);
        const rpc = readWalletRpcSecretStatus(process.env, { providerId });
        const checks: Array<{ id: string; ok: boolean; message: string }> = [];
        const status = await readWalletStatusSnapshot({ config: cfg, env: process.env });
        checks.push({
          id: "wallet.service.healthy",
          ok: status.service.healthy,
          message: status.service.healthy
            ? "wallet service healthy"
            : (status.error ?? "wallet service unhealthy"),
        });
        if (walletCfg.mode === "external") {
          checks.push({
            id: "wallet.rpc.configured",
            ok: true,
            message: `${providerId} uses signer/provider-owned network configuration`,
          });
        }
        checks.push({
          id: "wallet.provider.credentials",
          ok:
            providerId === "local-socket-signer" ||
            providerId === "wallet-standard" ||
            providerSecret.configured,
          message:
            providerId === "local-socket-signer" || providerId === "wallet-standard"
              ? `${providerId} does not use Gateway-held provider credentials`
              : providerSecret.configured
                ? `${providerId} provider credentials configured`
                : `${providerId} provider credentials are missing`,
        });
        if (providerId === "turnkey") {
          const hasTurnkeyPolicyCredentials = hasTurnkeyPolicyCredentialsConfigured(process.env);
          checks.push({
            id: "wallet.provider.turnkey.policy_credentials",
            ok: hasTurnkeyPolicyCredentials,
            message: hasTurnkeyPolicyCredentials
              ? "turnkey dedicated API credential, organization, policy, and Solana RPC are configured"
              : "turnkey requires a dedicated API user covered by a restrictive organization policy, plus organizationId, policyId, and rpcUrl",
          });
        }
        try {
          const providerAdapter = createWalletProviderAdapter({
            cfg,
            wallet: walletCfg,
            env: process.env,
            providerIdOverride: providerId,
          });
          const providerCapabilities = buildWalletProviderCapabilityMatrix(providerAdapter);
          const supportsSettlementOps =
            providerCapabilities.operations.prepare && providerCapabilities.operations.send;
          checks.push({
            id: "wallet.provider.operations",
            ok: supportsSettlementOps,
            message: supportsSettlementOps
              ? `${providerId} provider implements prepare/send operations`
              : `${providerId} provider operations are not implemented yet`,
          });
          checks.push({
            id: "wallet.provider.integration_mode",
            ok: providerCapabilities.integrationMode === "native",
            message:
              providerCapabilities.integrationMode === "native"
                ? `${providerId} uses native provider integration`
                : `${providerId} integration mode is non-native`,
          });
          checks.push({
            id: "wallet.provider.chain_ops.solana_send",
            ok:
              providerCapabilities.chains.solana.send ||
              !providerCapabilities.chains.solana.receiveAddress,
            message: providerCapabilities.chains.solana.send
              ? `${providerId} supports Solana send`
              : providerCapabilities.chains.solana.receiveAddress
                ? `${providerId} does not support Solana send`
                : `${providerId} has no Solana wallet support configured`,
          });
          checks.push({
            id: "wallet.provider.supported_chains",
            ok: providerCapabilities.supportedChains.length > 0,
            message:
              providerCapabilities.supportedChains.length > 0
                ? `${providerId} chains: ${providerCapabilities.supportedChains.join(", ")}`
                : `${providerId} has no supported chains configured`,
          });
        } catch (err) {
          checks.push({
            id: "wallet.provider.integration",
            ok: false,
            message: `provider integration unavailable: ${String(err)}`,
          });
        }
        if (walletCfg.runtime === "external-docker") {
          checks.push({
            id: "wallet.stack.configured",
            ok: Boolean(status.stack?.configured),
            message: status.stack?.configured
              ? "docker stack scaffold configured"
              : "docker stack scaffold is missing",
          });
        }
        const valid = checks.every((check) => check.ok);
        sendLoginResponse(200, {
          ok: valid,
          valid,
          checks,
          mode: walletCfg.mode,
          runtime: walletCfg.runtime,
          executionMode: walletCfg.execution.mode,
          rpc,
        });
        return;
      }
      if (requestPath === "/api/wallet/status") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }

        if (!(await ensureWalletApiAuthorized())) {
          return;
        }

        const cfg = loadConfig();
        const effectiveEnv = { ...process.env, ...cfg.env?.vars };
        const selectedWalletId = parsedUrl.searchParams.get("walletId")?.trim() || undefined;
        const configuredProviderId = resolveWalletProviderId(cfg, effectiveEnv);
        let snapshot = await readWalletStatusSnapshot({
          config: cfg,
          env: effectiveEnv,
          walletId: selectedWalletId,
        });
        if (configuredProviderId === "local-socket-signer" && !snapshot.service.healthy) {
          try {
            const { restartLocalSocketSigner } = await import("../wizard/onboarding.wallet.js");
            await restartLocalSocketSigner(undefined, effectiveEnv);
            snapshot = await readWalletStatusSnapshot({
              config: cfg,
              env: effectiveEnv,
              walletId: selectedWalletId,
            });
          } catch {
            // Keep original unhealthy snapshot; signer doctor endpoint provides deeper detail.
          }
        }
        const activeSignerMode = (() => {
          if (configuredProviderId === "local-socket-signer") {
            return "local-native-signer" as const;
          }
          if (
            configuredProviderId === "turnkey" ||
            configuredProviderId === "privy" ||
            configuredProviderId === "alchemy"
          ) {
            return "hosted-provider" as const;
          }
          return "local-native-signer" as const;
        })();
        const providerSummary = {
          id: configuredProviderId,
          label:
            configuredProviderId === "local-socket-signer"
              ? "Local signer socket"
              : configuredProviderId === "turnkey"
                ? "Turnkey"
                : configuredProviderId === "privy"
                  ? "Privy"
                  : configuredProviderId === "alchemy"
                    ? "Alchemy"
                    : configuredProviderId,
          category:
            activeSignerMode === "hosted-provider"
              ? ("hosted-provider" as const)
              : activeSignerMode === "local-native-signer"
                ? ("local-signer" as const)
                : ("embedded" as const),
          signerMode: activeSignerMode,
        };
        const statusPayload: Record<string, unknown> = {
          ...snapshot,
          configuredProviderId,
          activeSignerMode,
          providerSummary,
        };
        const registry = readWalletProviderRegistry(process.env);
        type ChainEntry = { walletId: string; rpcConfigured: boolean; decryptReady: boolean };
        const snapshotAny = snapshot as typeof snapshot & {
          chainWallets?: { solana?: ChainEntry[] };
        };
        statusPayload.capabilities = {
          canEditPolicy: true,
          canSend: true,
          canSetupWallets: false,
          canEditProviders: false,
          canEditRpc: false,
        };
        statusPayload.policyDisplay = {
          solana: {
            maxPerTx: {
              raw: snapshot.policy.solana.maxPerTx,
              human: formatLamportsToSol(snapshot.policy.solana.maxPerTx),
            },
            maxDaily: {
              raw: snapshot.policy.solana.maxDaily,
              human: formatLamportsToSol(snapshot.policy.solana.maxDaily),
            },
          },
        };
        statusPayload.wallets = registry.wallets.map((wallet) => {
          const liveWallet = snapshot.wallets?.find((entry) => entry.id === wallet.id);
          const solana = findWalletChainEntry(snapshotAny.chainWallets?.solana, wallet.id);
          const readiness = liveWallet?.readiness ?? {
            keystore: Boolean(solana?.decryptReady ?? false),
            rpc: Boolean(solana?.rpcConfigured),
            ready: false,
          };
          return {
            id: wallet.id,
            walletId: wallet.id,
            name: wallet.name,
            providerId: wallet.providerId,
            provider: wallet.providerId,
            addresses: wallet.addresses,
            readiness,
            chains: wallet.addresses?.solana ? ["solana"] : [],
            rpcConfigured: readiness.rpc,
            health: readiness.ready ? "ok" : "degraded",
          };
        });
        if (configuredProviderId === "local-socket-signer") {
          statusPayload.providerAuthMode = snapshot.authMode;
          statusPayload.providerAuthSource = snapshot.authSource;
          statusPayload.providerAuthDetails = snapshot.authBootstrap
            ? {
                endpoint: snapshot.authBootstrap.endpoint,
                lastError: snapshot.authBootstrap.lastError,
                lastSuccessAt: snapshot.authBootstrap.lastSuccessAt,
                expiresAt: snapshot.authBootstrap.expiresAt,
              }
            : undefined;
        }
        delete (statusPayload as { authMode?: unknown }).authMode;
        delete (statusPayload as { authSource?: unknown }).authSource;
        delete (statusPayload as { authBootstrap?: unknown }).authBootstrap;
        sendLoginResponse(200, {
          ok: true,
          status: statusPayload,
        });
        return;
      }
      if (requestPath === "/api/wallet/signer-doctor") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }

        if (!(await ensureWalletApiAuthorized())) {
          return;
        }

        const { collectWalletSignerDoctorReport } = await import("../commands/wallet.js");
        const cfg = loadConfig();
        const effectiveEnv = { ...process.env, ...cfg.env?.vars };
        const doctor = await collectWalletSignerDoctorReport(effectiveEnv, { config: cfg });
        const registry = readWalletProviderRegistry(effectiveEnv);
        const parseWalletIds = (_chain: "solana") => {
          const ids = new Set<string>();
          for (const wallet of registry.wallets) {
            const hasChain = wallet.addresses?.solana;
            if (hasChain && wallet.id.trim()) {
              ids.add(wallet.id.trim().toLowerCase());
            }
          }
          return [...ids].toSorted();
        };
        const checks = doctor.checks ?? [];
        const lookupWalletCheck = (prefix: string, chain: "solana", walletId: string) =>
          checks.find((entry) => {
            const check = String(entry.check ?? "");
            const expectedPrefix = `${prefix}.${chain}.`;
            if (!check.startsWith(expectedPrefix)) {
              return false;
            }
            return walletIdsMatchForStatus(check.slice(expectedPrefix.length), walletId);
          });
        const buildChainEntries = (chain: "solana", ids: string[]) =>
          ids.map((walletId) => ({
            walletId,
            keystoreReady: lookupWalletCheck("keystore.file", chain, walletId)?.ok ?? false,
            decryptReady: lookupWalletCheck("keystore.decrypt", chain, walletId)?.ok ?? false,
            rpcConfigured: lookupWalletCheck("rpc.configured", chain, walletId)?.ok ?? false,
            keystoreDetail: lookupWalletCheck("keystore.file", chain, walletId)?.detail,
            rpcDetail: lookupWalletCheck("rpc.configured", chain, walletId)?.detail,
          }));
        sendLoginResponse(200, {
          ok: true,
          report: {
            ok: doctor.ok,
            socketPath: doctor.socketPath,
            pidPath: doctor.pidPath,
            auditPath: doctor.auditPath,
            running: doctor.checks.find((c) => c.check === "socket.health")?.ok ?? false,
            checks: doctor.checks,
          },
          chainWallets: {
            solana: buildChainEntries("solana", parseWalletIds("solana")),
          },
        });
        return;
      }
      if (requestPath === "/api/wallet/rpc") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const cfg = loadConfig();
        if (!ensureWalletApprovalAuthorized({ operation: "wallet.network", cfg })) {
          return;
        }
        const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
        const parsedUrl = new URL(req.url || "/", "http://localhost");
        const walletId = parsedUrl.searchParams.get("walletId")?.trim() ?? "";
        const wallet = readWalletProviderRegistry(effectiveEnv).wallets.find(
          (entry) => entry.id === walletId,
        );
        if (!wallet) {
          sendLoginResponse(404, {
            ok: false,
            error: { code: "wallet_not_found", message: "walletId not found" },
          });
          return;
        }
        if (wallet.providerId !== "local-socket-signer") {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "invalid_provider",
              message: "saved RPC display is available only for native signer wallets",
            },
          });
          return;
        }
        const rpcUrl = resolveWalletRpcUrlFromEnv(effectiveEnv, "solana", wallet.id);
        if (!rpcUrl) {
          sendLoginResponse(404, {
            ok: false,
            error: { code: "wallet_rpc_not_found", message: "wallet RPC is not configured" },
          });
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          walletId: wallet.id,
          rpcUrl,
          maskedUrl: maskWalletRpcUrl(rpcUrl),
        });
        return;
      }
      if (requestPath === "/api/wallet/rpc-metrics") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const assetMetrics = summarizeSolanaAssetRpcMetrics();
        const gatewayMetrics = summarizeWalletGatewayRpcMetrics();
        sendLoginResponse(200, {
          ok: true,
          metrics: {
            startedAt: walletGatewayRpcStartedAt,
            methods: [
              ...gatewayMetrics.methods.map((entry) => ({
                ...entry,
                method: `wallet.${entry.method}`,
              })),
              ...assetMetrics.methods.map((entry) => ({
                ...entry,
                method: `asset.${entry.method}`,
              })),
            ].toSorted((left, right) => left.method.localeCompare(right.method)),
            gateway: gatewayMetrics,
            assets: assetMetrics,
          },
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      if (requestPath === "/api/wallet/balances") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const cfg = loadConfig();
        const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
        const walletCfg = resolveWalletRuntimeConfig(cfg, effectiveEnv);
        const probeTimeoutMs = resolveWalletProbeTimeoutMs(effectiveEnv);
        const parsedUrl = new URL(req.url || "/", "http://localhost");
        const walletIdParam = parsedUrl.searchParams.get("walletId")?.trim();
        const providerIdParam = parseWalletProviderId(parsedUrl.searchParams.get("providerId"));
        const selectedProviderId =
          resolveProviderFromWalletSelection({
            walletId: walletIdParam,
            env: effectiveEnv,
          }) ??
          providerIdParam ??
          resolveWalletProviderId(cfg, effectiveEnv);
        const selectedWallet = walletIdParam
          ? readWalletProviderRegistry(effectiveEnv).wallets.find(
              (entry) => entry.id === walletIdParam,
            )
          : undefined;
        if (walletIdParam && !selectedWallet) {
          sendLoginResponse(404, {
            ok: false,
            error: { code: "wallet_not_found", message: "walletId not found" },
          });
          return;
        }
        const provider = createWalletProviderAdapter({
          cfg,
          wallet: walletCfg,
          env: effectiveEnv,
          providerIdOverride: selectedProviderId,
          walletId: selectedWallet?.id,
        });
        const providerCapabilities = buildWalletProviderCapabilityMatrix(provider);
        const chainParam = (() => {
          const raw = (parsedUrl.searchParams.get("chain") ?? "all").trim().toLowerCase();
          if (raw === "solana" || raw === "all") {
            return raw;
          }
          return "all";
        })();
        const includeAssets = (() => {
          const raw = String(parsedUrl.searchParams.get("includeAssets") ?? "").trim();
          return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
        })();
        const requestedChains =
          chainParam === "all"
            ? walletCfg.chains.filter((c) => c === "solana")
            : walletCfg.chains.filter((c) => c === "solana" && c === chainParam);
        let addresses: Record<string, string | undefined> | undefined;
        const shouldFetchAddresses = providerSupportsChainOperation({
          matrix: providerCapabilities,
          chain: "solana",
          operation: "receiveAddress",
        });
        if (shouldFetchAddresses) {
          try {
            const result = await withWalletProbeTimeout(
              recordWalletGatewayRpc(
                "provider.getAddresses.solana",
                provider.getAddresses({ walletId: selectedWallet?.id }),
              ),
              probeTimeoutMs,
              `api.wallet.addresses:${provider.id}`,
            );
            addresses = {
              solana: result.solana,
            };
          } catch {
            incrementWalletObservabilityCounter({
              kind: "rpcFailure",
              key: `${provider.id}:addresses`,
              env: effectiveEnv,
            });
            addresses = undefined;
          }
        } else {
          addresses = undefined;
        }
        const balances: Record<string, unknown> = {};
        for (const chain of requestedChains) {
          if (
            !providerSupportsChainOperation({
              matrix: providerCapabilities,
              chain,
              operation: "getBalance",
            })
          ) {
            balances[chain] = {
              ok: false,
              chain,
              error: `${provider.id} does not support balance on ${chain}`,
            };
            continue;
          }
          try {
            balances[chain] = await withWalletProbeTimeout(
              recordWalletGatewayRpc(
                `provider.getBalance.${chain}`,
                provider.getBalance(chain, { walletId: selectedWallet?.id }),
              ),
              probeTimeoutMs,
              `api.wallet.balances:${provider.id}:${chain}`,
            );
          } catch (err) {
            let fallbackBalance: string | null = null;
            if (chain === "solana") {
              fallbackBalance = await fetchSolanaLamportsViaRpc({
                rpcUrl: resolveWalletRpcUrlFromEnv(effectiveEnv, "solana", selectedWallet?.id),
                address: addresses?.solana ?? selectedWallet?.addresses?.solana,
                timeoutMs: probeTimeoutMs,
              });
            }
            if (fallbackBalance != null) {
              balances[chain] = {
                ok: true,
                chain,
                address: addresses?.solana ?? selectedWallet?.addresses?.solana,
                balance: fallbackBalance,
                unit: "lamports",
              };
              continue;
            }
            incrementWalletObservabilityCounter({
              kind: "rpcFailure",
              key: `${provider.id}:balance:${chain}`,
              env: effectiveEnv,
            });
            balances[chain] = {
              ok: false,
              chain,
              error: String(err),
            };
          }
        }
        const assets: { solana?: Awaited<ReturnType<typeof fetchSolanaWalletAssetsViaRpc>> } = {};
        const assetErrors: { solana?: string } = {};
        if (includeAssets && requestedChains.includes("solana")) {
          const solanaAddress = addresses?.solana ?? selectedWallet?.addresses?.solana ?? undefined;
          const solanaRpcUrl = resolveWalletRpcUrlFromEnv(
            effectiveEnv,
            "solana",
            selectedWallet?.id,
          );
          const solanaBalanceEntry = balances.solana as
            | {
                ok?: boolean;
                balance?: string;
              }
            | undefined;
          const nativeLamports =
            solanaBalanceEntry?.ok && typeof solanaBalanceEntry.balance === "string"
              ? solanaBalanceEntry.balance
              : undefined;
          if (solanaRpcUrl && solanaAddress) {
            try {
              assets.solana = await withWalletProbeTimeout(
                fetchSolanaWalletAssetsViaRpc({
                  rpcUrl: solanaRpcUrl,
                  ownerAddress: solanaAddress,
                  nativeLamports,
                }),
                probeTimeoutMs,
                `api.wallet.assets:${provider.id}:solana`,
              );
            } catch (err) {
              assetErrors.solana = String(err);
            }
          }
        }
        sendLoginResponse(200, {
          ok: true,
          chain: chainParam,
          provider: provider.id,
          walletId: selectedWallet?.id,
          walletName: selectedWallet?.name,
          balances,
          ...(assets.solana ? { assets } : {}),
          ...(assetErrors.solana ? { assetErrors } : {}),
          addresses,
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      if (requestPath === "/api/mining/profile") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method === "GET") {
          const result = await callSatMiningGateway<{ payload?: unknown }>("sat.getMinerProfile");
          sendLoginResponse(200, { ok: true, profile: result.payload ?? null });
          return;
        }
        if (req.method === "PUT") {
          const cfg = loadConfig();
          if (
            !ensureWalletApprovalAuthorized({
              operation: "mining.policy",
              cfg,
              requireReady: true,
            })
          ) {
            return;
          }
          const body = await readJsonBody(req, 128 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const profile =
            body.value && typeof body.value === "object" && !Array.isArray(body.value)
              ? (body.value as { profile?: unknown }).profile
              : undefined;
          const profileRecord =
            profile && typeof profile === "object" && !Array.isArray(profile)
              ? (profile as Record<string, unknown>)
              : {};
          const profileWalletId =
            typeof profileRecord.walletId === "string" ? profileRecord.walletId.trim() : "";
          const roleConflict = resolveMiningAgentWalletConflict(profileWalletId);
          if (roleConflict) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "wallet_role_conflict",
                message: roleConflict,
              },
            });
            return;
          }
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.setMinerProfile",
            body.value,
          );
          if (profileWalletId) {
            setNamedWalletRole({
              walletId: profileWalletId,
              role: "mining",
              env: process.env,
            });
          }
          const automation =
            profileRecord.automation &&
            typeof profileRecord.automation === "object" &&
            !Array.isArray(profileRecord.automation)
              ? (profileRecord.automation as Record<string, unknown>)
              : {};
          const satSweep =
            automation.satSweep &&
            typeof automation.satSweep === "object" &&
            !Array.isArray(automation.satSweep)
              ? (automation.satSweep as Record<string, unknown>)
              : {};
          appendWalletAuditEntry({
            action: "mining_policy_updated",
            actor: "control-ui",
            details: {
              walletId:
                typeof profileRecord.walletId === "string" ? profileRecord.walletId : undefined,
              satSweep: {
                enabled: satSweep.enabled,
                destinationWalletId: satSweep.destinationWalletId,
                destinationAddress: satSweep.destinationAddress,
                mode: satSweep.mode,
                percentage: satSweep.percentage,
                minRaw: satSweep.minRaw,
                keepRaw: satSweep.keepRaw,
              },
              funding:
                profileRecord.funding &&
                typeof profileRecord.funding === "object" &&
                !Array.isArray(profileRecord.funding)
                  ? profileRecord.funding
                  : undefined,
            },
            env: process.env,
          });
          sendLoginResponse(200, { ok: true, profile: result.payload ?? null });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, PUT");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET or PUT" },
        });
        return;
      }
      if (requestPath === "/api/mining/mainnet-sync") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method === "GET") {
          const parsedUrl = new URL(req.url || "/", "http://localhost");
          const manifestUrl = parsedUrl.searchParams.get("manifestUrl")?.trim() || undefined;
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.getMainnetSyncStatus",
            manifestUrl ? { manifestUrl } : undefined,
            { timeoutMs: 30_000 },
          );
          sendLoginResponse(200, { ok: true, sync: result.payload ?? null });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req, 64 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const manifestUrl =
            body.value && typeof body.value === "object" && !Array.isArray(body.value)
              ? typeof (body.value as { manifestUrl?: unknown }).manifestUrl === "string"
                ? String((body.value as { manifestUrl?: unknown }).manifestUrl).trim() || undefined
                : undefined
              : undefined;
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.syncMainnet",
            manifestUrl ? { manifestUrl } : undefined,
            { timeoutMs: 30_000 },
          );
          sendLoginResponse(200, { ok: true, sync: result.payload ?? null });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET or POST" },
        });
        return;
      }
      if (requestPath === "/api/mining/wallet-attachment") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method === "GET") {
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.getMiningWalletAttachment",
          );
          sendLoginResponse(200, { ok: true, attachment: result.payload ?? null });
          return;
        }
        res.statusCode = 405;
        res.setHeader("Allow", "GET");
        sendLoginResponse(405, {
          ok: false,
          error: { code: "method_not_allowed", message: "method must be GET" },
        });
        return;
      }
      if (requestPath === "/api/mining/wallets") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        const result = await callSatMiningGateway<{
          payload?: { wallets?: unknown[]; defaultWalletId?: string };
        }>("sat.listMiningWallets");
        sendLoginResponse(200, {
          ok: true,
          wallets: result.payload?.wallets ?? [],
          defaultWalletId: result.payload?.defaultWalletId,
        });
        return;
      }
      if (requestPath === "/api/mining/readiness") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        const parsedUrl = new URL(req.url || "/", "http://localhost");
        try {
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.getMiningReadiness",
            {
              walletId: parsedUrl.searchParams.get("walletId")?.trim() || undefined,
            },
          );
          sendLoginResponse(200, { ok: true, readiness: result.payload ?? null });
        } catch (error) {
          sendLoginResponse(502, {
            ok: false,
            error: {
              code: "mining_readiness_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (requestPath === "/api/mining/status") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        const parsedUrl = new URL(req.url || "/", "http://localhost");
        const forceFresh = ["1", "true", "yes"].includes(
          String(parsedUrl.searchParams.get("forceFresh") ?? "")
            .trim()
            .toLowerCase(),
        );
        const result = await callSatMiningGateway<{ payload?: unknown }>(
          "sat.getMiningStatus",
          { statusMode: "ui", responsive: true, ...(forceFresh ? { forceFresh: true } : {}) },
          { timeoutMs: 60_000 },
        );
        sendLoginResponse(200, { ok: true, status: result.payload ?? null });
        return;
      }
      if (requestPath === "/api/mining/history") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        const window =
          typeof parsedUrl.searchParams.get("window") === "string"
            ? parsedUrl.searchParams.get("window")?.trim() || undefined
            : undefined;
        const activityWindow =
          typeof parsedUrl.searchParams.get("activityWindow") === "string"
            ? parsedUrl.searchParams.get("activityWindow")?.trim() || undefined
            : undefined;
        const maxPointsRaw = parsedUrl.searchParams.get("maxPoints");
        const maxPoints =
          typeof maxPointsRaw === "string" && maxPointsRaw.trim()
            ? Number(maxPointsRaw)
            : undefined;
        const result = await callSatMiningGateway<{ payload?: unknown }>(
          "sat.getMiningHistory",
          {
            window,
            activityWindow,
            maxPoints,
          },
          { timeoutMs: 60_000 },
        );
        sendLoginResponse(200, { ok: true, history: result.payload ?? null });
        return;
      }
      if (requestPath === "/api/mining/recovery") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        const result = await callSatMiningGateway<{ payload?: unknown }>(
          "sat.getMiningRecovery",
          undefined,
          { timeoutMs: 60_000 },
        );
        sendLoginResponse(200, { ok: true, recovery: result.payload ?? null });
        return;
      }
      if (requestPath === "/api/mining/start") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const requestedWalletId =
          body.value && typeof body.value === "object" && !Array.isArray(body.value)
            ? typeof (body.value as { walletId?: unknown }).walletId === "string"
              ? String((body.value as { walletId?: unknown }).walletId).trim() || undefined
              : undefined
            : undefined;
        const effectiveWalletId =
          requestedWalletId || readSatMiningWalletIdFromConfig(loadConfig());
        const roleConflict = resolveMiningAgentWalletConflict(effectiveWalletId);
        if (roleConflict) {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "wallet_role_conflict",
              message: roleConflict,
            },
          });
          return;
        }
        try {
          const readiness = await callSatMiningGateway<{
            payload?: {
              checks?: Array<{ key?: string; ok?: boolean; remediation?: string; detail?: string }>;
            };
          }>("sat.getMiningReadiness", { walletId: effectiveWalletId });
          const checks = Array.isArray(readiness.payload?.checks) ? readiness.payload?.checks : [];
          const fundingReady = checks.find((check) => check?.key === "fundingReady");
          if (fundingReady?.ok === false) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "mining_start_blocked",
                message:
                  fundingReady.remediation ||
                  fundingReady.detail ||
                  "wallet needs more SOL before SAT can open the next round",
              },
            });
            return;
          }
          const minerInitialized = checks.find((check) => check?.key === "minerInitialized");
          const minerInitializedDetail = String(
            minerInitialized?.detail || minerInitialized?.remediation || "",
          )
            .trim()
            .toLowerCase();
          if (
            minerInitialized?.ok === false &&
            (minerInitializedDetail.includes("owner mismatch") ||
              minerInitializedDetail.includes("invalid owner"))
          ) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "mining_start_blocked",
                message:
                  minerInitialized.remediation ||
                  minerInitialized.detail ||
                  "miner setup is missing for the attached wallet",
              },
            });
            return;
          }
        } catch {
          try {
            const wallets = await callSatMiningGateway<{
              payload?: { wallets?: Array<{ walletId?: string; solBalanceLamports?: string }> };
            }>("sat.listMiningWallets");
            const activeWallet = (wallets.payload?.wallets ?? []).find(
              (wallet) => String(wallet.walletId ?? "").trim() === effectiveWalletId,
            );
            const lamports = activeWallet?.solBalanceLamports
              ? BigInt(String(activeWallet.solBalanceLamports))
              : 0n;
            if (lamports < 5_000_000n) {
              sendLoginResponse(409, {
                ok: false,
                error: {
                  code: "mining_start_blocked",
                  message:
                    "Fund the wallet with at least 0.005 SOL so SAT can open the next round.",
                },
              });
              return;
            }
          } catch {}
        }
        try {
          const result = await callSatMiningGateway<{
            payload?: { started?: boolean; status?: unknown };
          }>("sat.startMining", body.value, { timeoutMs: 90_000 });
          sendLoginResponse(200, {
            ok: true,
            started: Boolean(result.payload?.started),
            status: result.payload?.status ?? null,
          });
        } catch (error) {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "mining_start_blocked",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (requestPath === "/api/mining/capital/init") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (
          !ensureWalletApprovalAuthorized({
            operation: "mining.capital",
            cfg: loadConfig(),
            requireReady: true,
          })
        ) {
          return;
        }
        let result;
        try {
          result = await callSatMiningGateway<{
            payload?: { submitted?: unknown; status?: unknown };
          }>("sat.initMinerCapital", {});
        } catch (error) {
          sendSatMiningGatewayError(error);
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          submitted: result.payload?.submitted ?? null,
          status: result.payload?.status ?? null,
        });
        return;
      }
      if (requestPath === "/api/mining/reserve/top-up") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (
          !ensureWalletApprovalAuthorized({
            operation: "mining.capital",
            cfg: loadConfig(),
            requireReady: true,
          })
        ) {
          return;
        }
        let result;
        try {
          result = await callSatMiningGateway<{
            payload?: { submitted?: unknown; status?: unknown };
          }>("sat.topUpRegistryReserve", { targetBalanceLamports: 0 });
        } catch (error) {
          sendSatMiningGatewayError(error);
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          submitted: result.payload?.submitted ?? null,
          status: result.payload?.status ?? null,
        });
        return;
      }
      if (
        requestPath === "/api/mining/capital/deposit" ||
        requestPath === "/api/mining/capital/withdraw"
      ) {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (
          !ensureWalletApprovalAuthorized({
            operation: "mining.capital",
            cfg: loadConfig(),
            requireReady: true,
          })
        ) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const rawLamports =
          body.value && typeof body.value === "object" && !Array.isArray(body.value)
            ? (body.value as { lamports?: unknown }).lamports
            : undefined;
        const lamports =
          typeof rawLamports === "string" || typeof rawLamports === "number"
            ? Number(rawLamports)
            : NaN;
        if (!Number.isFinite(lamports) || lamports < 0) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "lamports is required" },
          });
          return;
        }
        const method =
          requestPath === "/api/mining/capital/deposit"
            ? "sat.depositMinerCapital"
            : "sat.withdrawMinerCapital";
        let result;
        try {
          result = await callSatMiningGateway<{
            payload?: { submitted?: unknown; status?: unknown };
          }>(method, { lamports: Math.floor(lamports) }, { timeoutMs: 45_000 });
        } catch (error) {
          sendSatMiningGatewayError(error);
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          submitted: result.payload?.submitted ?? null,
          status: result.payload?.status ?? null,
        });
        return;
      }
      if (requestPath === "/api/mining/capital/commit") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (
          !ensureWalletApprovalAuthorized({
            operation: "mining.capital",
            cfg: loadConfig(),
            requireReady: true,
          })
        ) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const rawLamports =
          body.value && typeof body.value === "object" && !Array.isArray(body.value)
            ? (body.value as { lamports?: unknown }).lamports
            : undefined;
        const lamports =
          typeof rawLamports === "string" || typeof rawLamports === "number"
            ? Number(rawLamports)
            : NaN;
        if (!Number.isFinite(lamports) || lamports < 0) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "lamports is required" },
          });
          return;
        }
        const persistConfig =
          body.value && typeof body.value === "object" && !Array.isArray(body.value)
            ? (body.value as { persistConfig?: unknown }).persistConfig
            : undefined;
        let result;
        try {
          result = await callSatMiningGateway<{
            payload?: { submitted?: unknown; status?: unknown };
          }>(
            "sat.setActiveCommit",
            {
              lamports: Math.floor(lamports),
              ...(typeof persistConfig === "boolean" ? { persistConfig } : {}),
            },
            { timeoutMs: 45_000 },
          );
        } catch (error) {
          sendSatMiningGatewayError(error);
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          submitted: result.payload?.submitted ?? null,
          status: result.payload?.status ?? null,
        });
        return;
      }
      if (requestPath === "/api/mining/stop") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        let result;
        try {
          result = await callSatMiningGateway<{
            payload?: { stopped?: boolean; status?: unknown };
          }>("sat.stopMining", undefined, { timeoutMs: 90_000 });
        } catch (error) {
          sendSatMiningGatewayError(error);
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          stopped: Boolean(result.payload?.stopped),
          status: result.payload?.status ?? null,
        });
        return;
      }
      if (requestPath === "/api/mining/action/participate") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        try {
          const status = await readSatMiningStatusPayload();
          const epochId = Number(status.currentEpochId ?? 0);
          const microRoundId = Number(status.currentMicroRoundId ?? 0);
          const bucketHash =
            typeof status.currentBucketHash === "string" ? status.currentBucketHash.trim() : "";
          if (!epochId || !microRoundId || !bucketHash) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "mining_action_blocked",
                message: "No active SAT round is available yet.",
              },
            });
            return;
          }
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.submitParticipation",
            {
              epochId,
              microRoundId,
              bucketHash,
            },
          );
          const refreshedStatus = await readSatMiningStatusPayload().catch(() => null);
          sendLoginResponse(200, {
            ok: true,
            result: result.payload ?? null,
            status: refreshedStatus,
          });
        } catch (error) {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "mining_action_blocked",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (requestPath === "/api/mining/action/crank") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        try {
          const status = await readSatMiningStatusPayload();
          const epochId = Number(status.currentEpochId ?? 0);
          const microRoundId = Number(status.currentMicroRoundId ?? 0);
          if (!epochId || !microRoundId) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "mining_action_blocked",
                message: "No active SAT round is available for crank.",
              },
            });
            return;
          }
          const result = await callSatMiningGateway<{ payload?: unknown }>("sat.miningCrank", {
            epochId,
            microRoundId,
          });
          const refreshedStatus = await readSatMiningStatusPayload().catch(() => null);
          sendLoginResponse(200, {
            ok: true,
            result: result.payload ?? null,
            status: refreshedStatus,
          });
        } catch (error) {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "mining_action_blocked",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (requestPath === "/api/mining/action/finalize-epoch") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        try {
          const status = await readSatMiningStatusPayload();
          const epochId = Number(status.currentEpochId ?? 0);
          const bucketRoot =
            typeof status.currentBucketRoot === "string" ? status.currentBucketRoot.trim() : "";
          const scoreRoot =
            typeof status.currentScoreRoot === "string" ? status.currentScoreRoot.trim() : "";
          if (!epochId || !bucketRoot || !scoreRoot) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "mining_action_blocked",
                message: "Epoch roots are not ready to finalize.",
              },
            });
            return;
          }
          const result = await callSatMiningGateway<{ payload?: unknown }>("sat.finalizeEpoch", {
            epochId,
            bucketRoot,
            scoreRoot,
          });
          const refreshedStatus = await readSatMiningStatusPayload().catch(() => null);
          sendLoginResponse(200, {
            ok: true,
            result: result.payload ?? null,
            status: refreshedStatus,
          });
        } catch (error) {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "mining_action_blocked",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (requestPath === "/api/mining/action/claim") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        try {
          const status = await readSatMiningStatusPayload();
          const claimBacklog = status.claimBacklog as
            | { ready?: unknown; total?: unknown; oldestPendingCycleId?: unknown }
            | undefined;
          const readyBacklogCount = Number(claimBacklog?.ready ?? 0);
          if (Number.isFinite(readyBacklogCount) && readyBacklogCount > 0) {
            const result = await callSatMiningGateway<{ payload?: unknown }>("sat.claimBacklog");
            const refreshedStatus = await readSatMiningStatusPayload().catch(() => null);
            sendLoginResponse(200, {
              ok: true,
              result: result.payload ?? null,
              status: refreshedStatus,
            });
            return;
          }
          const cycleId = Math.max(
            0,
            Number(status.currentCycleId ?? status.currentEpochId ?? 0) - 5,
          );
          if (!Number.isFinite(cycleId) || cycleId < 0) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "mining_action_blocked",
                message: "No SAT cycle is available to claim.",
              },
            });
            return;
          }
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.claimCycleRewards",
            { cycleId },
          );
          const refreshedStatus = await readSatMiningStatusPayload().catch(() => null);
          sendLoginResponse(200, {
            ok: true,
            result: result.payload ?? null,
            status: refreshedStatus,
          });
        } catch (error) {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "mining_action_blocked",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (requestPath === "/api/mining/recovery/claim") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        try {
          const rawCycleId =
            typeof (body.value as { cycleId?: unknown }).cycleId === "number"
              ? Number((body.value as { cycleId?: number }).cycleId)
              : typeof (body.value as { epochId?: unknown }).epochId === "number"
                ? Number((body.value as { epochId?: number }).epochId)
                : NaN;
          if (!Number.isFinite(rawCycleId) || rawCycleId < 0) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_request",
                message: "cycleId (or legacy epochId alias) is required",
              },
            });
            return;
          }
          const result = await callSatMiningGateway<{ payload?: unknown }>(
            "sat.claimCycleRewards",
            {
              cycleId: rawCycleId,
            },
          );
          const refreshedStatus = await readSatMiningStatusPayload().catch(() => null);
          sendLoginResponse(200, {
            ok: true,
            result: result.payload ?? null,
            status: refreshedStatus,
          });
        } catch (error) {
          sendLoginResponse(409, {
            ok: false,
            error: {
              code: "mining_action_blocked",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (requestPath === "/api/mining/recovery/resolve-dispute") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const result = await callSatMiningGateway<{ payload?: unknown }>(
          "sat.resolveDispute",
          body.value,
        );
        sendLoginResponse(200, { ok: true, result: result.payload ?? null });
        return;
      }
      if (requestPath === "/api/mining/recovery/republish-roots") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const result = await callSatMiningGateway<{ payload?: unknown }>(
          "sat.republishEpochRoots",
          body.value,
        );
        sendLoginResponse(200, { ok: true, result: result.payload ?? null });
        return;
      }
      if (requestPath === "/api/mining/history/clear") {
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        const body = await readJsonBody(req, 4 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const result = await callSatMiningGateway<{
          payload?: { cleared?: boolean; status?: unknown };
        }>("sat.clearMiningHistory", body.value);
        sendLoginResponse(200, {
          ok: true,
          cleared: Boolean(result.payload?.cleared),
          status: result.payload?.status ?? null,
        });
        return;
      }

      if (requestPath === "/api/wallet/approval-auth/status") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const cfg = loadConfig();
        sendLoginResponse(200, {
          ok: true,
          status: readWalletApprovalAuthSnapshot(process.env, cfg),
          challengeTtlSeconds: resolveWalletApprovalChallengeTtlSeconds(process.env, cfg),
          grantTtlSeconds: resolveWalletApprovalGrantTtlSeconds(process.env, cfg),
        });
        return;
      }
      if (requestPath === "/api/wallet/approval-auth/passkeys") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const cfg = loadConfig();
        sendLoginResponse(200, {
          ok: true,
          passkeys: listWalletPasskeys(process.env, cfg),
        });
        return;
      }
      if (
        requestPath.startsWith("/api/wallet/approval-auth/passkeys/") &&
        !requestPath.startsWith("/api/wallet/approval-auth/passkeys/register/")
      ) {
        if (req.method !== "DELETE") {
          res.statusCode = 405;
          res.setHeader("Allow", "DELETE");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be DELETE" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const credentialId = decodeURIComponent(
          requestPath.slice("/api/wallet/approval-auth/passkeys/".length),
        ).trim();
        const cfg = loadConfig();
        if (!ensureWalletApprovalAuthorized({ operation: "wallet.passkey-remove", cfg })) {
          return;
        }
        const passkeys = listWalletPasskeys(process.env, cfg);
        const removingExistingPasskey = passkeys.some((passkey) => passkey.id === credentialId);
        const result = removeWalletPasskey({
          credentialId,
          env: process.env,
          cfg,
        });
        if (!result.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: result.code, message: result.message },
          });
          return;
        }
        let snapshotCfg = cfg;
        if (removingExistingPasskey && passkeys.length <= 1) {
          const updated = await updateWalletConfig({
            env: process.env,
            mutate: (nextCfg) => {
              nextCfg.wallet = nextCfg.wallet ?? {};
              nextCfg.wallet.approvalAuth = nextCfg.wallet.approvalAuth ?? {};
              nextCfg.wallet.approvalAuth.mode = "none";
            },
          });
          if (!updated.ok) {
            sendLoginResponse(500, {
              ok: false,
              error: {
                code: "wallet_passkey_config_update_failed",
                message: updated.message,
              },
            });
            return;
          }
          snapshotCfg = updated.cfg;
        }
        appendWalletAuditEntry({
          action: "passkey_removed",
          actor: "control-ui",
          details: {
            passkeyId: result.passkey.id,
            label: result.passkey.label,
            approvalAuthMode: removingExistingPasskey && passkeys.length <= 1 ? "none" : undefined,
          },
          env: process.env,
        });
        sendLoginResponse(200, {
          ok: true,
          passkey: result.passkey,
          snapshot:
            removingExistingPasskey && passkeys.length <= 1
              ? readWalletApprovalAuthSnapshot(process.env, snapshotCfg)
              : result.snapshot,
        });
        return;
      }
      if (requestPath === "/api/wallet/approval-auth/passkeys/register/options") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payloadRaw = (body.value ?? {}) as Record<string, unknown>;
        const label =
          typeof payloadRaw.label === "string" ? payloadRaw.label.trim() || undefined : undefined;
        const cfg = loadConfig();
        const result = beginWalletPasskeyRegistration({
          host,
          label,
          env: process.env,
          cfg,
        });
        if (!result.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: result.code, message: result.message },
          });
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          challengeId: result.challengeId,
          challengeTtlSeconds: result.challengeTtlSeconds,
          options: result.options,
        });
        return;
      }
      if (requestPath === "/api/wallet/approval-auth/passkeys/register/finish") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 256 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payloadRaw = (body.value ?? {}) as Record<string, unknown>;
        const cfg = loadConfig();
        if (listWalletPasskeys(process.env, cfg).length > 0) {
          if (!ensureWalletApprovalAuthorized({ operation: "wallet.passkey-enroll", cfg })) {
            return;
          }
        }
        const result = finishWalletPasskeyRegistration({
          host,
          challengeId:
            typeof payloadRaw.challengeId === "string" ? payloadRaw.challengeId.trim() : "",
          credentialId:
            typeof payloadRaw.credentialId === "string" ? payloadRaw.credentialId.trim() : "",
          clientDataJSON:
            typeof payloadRaw.clientDataJSON === "string" ? payloadRaw.clientDataJSON.trim() : "",
          authenticatorData:
            typeof payloadRaw.authenticatorData === "string"
              ? payloadRaw.authenticatorData.trim()
              : "",
          publicKeySpki:
            typeof payloadRaw.publicKeySpki === "string" ? payloadRaw.publicKeySpki.trim() : "",
          publicKeyAlgorithm:
            typeof payloadRaw.publicKeyAlgorithm === "number"
              ? payloadRaw.publicKeyAlgorithm
              : Number.NaN,
          transports: Array.isArray(payloadRaw.transports)
            ? payloadRaw.transports.map((v) => String(v))
            : undefined,
          env: process.env,
          cfg,
        });
        if (!result.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: result.code, message: result.message },
          });
          return;
        }
        appendWalletAuditEntry({
          action: "passkey_enrolled",
          actor: "control-ui",
          details: { passkeyId: result.passkey.id, label: result.passkey.label },
          env: process.env,
        });
        sendLoginResponse(200, {
          ok: true,
          passkey: result.passkey,
          snapshot: result.snapshot,
        });
        return;
      }
      if (requestPath === "/api/wallet/approval-auth/assert/options") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payloadRaw = (body.value ?? {}) as Record<string, unknown>;
        const operation =
          typeof payloadRaw.operation === "string" ? payloadRaw.operation.trim() : "";
        const requestId =
          typeof payloadRaw.requestId === "string"
            ? payloadRaw.requestId.trim() || undefined
            : undefined;
        if (!operation) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_operation", message: "operation is required" },
          });
          return;
        }
        if (
          operation !== "wallet.approve" &&
          operation !== "wallet.policy" &&
          operation !== "wallet.settings" &&
          operation !== "wallet.provider-credentials" &&
          operation !== "wallet.network" &&
          operation !== "wallet.archive" &&
          operation !== "wallet.passkey-enroll" &&
          operation !== "wallet.passkey-remove" &&
          operation !== "wallet.reset" &&
          operation !== "wallet.rotate" &&
          operation !== "wallet.execution-mode" &&
          operation !== "wallet.send" &&
          operation !== "mining.capital" &&
          operation !== "mining.policy"
        ) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_operation", message: "operation not allowed" },
          });
          return;
        }
        const cfg = loadConfig();
        const result = beginWalletApprovalAssertion({
          host,
          operation,
          requestId,
          env: process.env,
          cfg,
        });
        if (!result.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: result.code, message: result.message },
          });
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          challengeId: result.challengeId,
          challengeTtlSeconds: result.challengeTtlSeconds,
          options: result.options,
        });
        return;
      }
      if (requestPath === "/api/wallet/approval-auth/assert/finish") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 128 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payloadRaw = (body.value ?? {}) as Record<string, unknown>;
        const cfg = loadConfig();
        const result = finishWalletApprovalAssertion({
          host,
          challengeId:
            typeof payloadRaw.challengeId === "string" ? payloadRaw.challengeId.trim() : "",
          credentialId:
            typeof payloadRaw.credentialId === "string" ? payloadRaw.credentialId.trim() : "",
          clientDataJSON:
            typeof payloadRaw.clientDataJSON === "string" ? payloadRaw.clientDataJSON.trim() : "",
          authenticatorData:
            typeof payloadRaw.authenticatorData === "string"
              ? payloadRaw.authenticatorData.trim()
              : "",
          signature: typeof payloadRaw.signature === "string" ? payloadRaw.signature.trim() : "",
          env: process.env,
          cfg,
        });
        if (!result.ok) {
          sendLoginResponse(401, {
            ok: false,
            error: { code: result.code, message: result.message },
          });
          return;
        }
        appendWalletAuditEntry({
          action: "passkey_verified",
          actor: "control-ui",
          details: { operation: result.operation, requestId: result.requestId },
          env: process.env,
        });
        sendLoginResponse(200, {
          ok: true,
          approvalToken: result.approvalToken,
          expiresAt: result.expiresAt,
          ttlSeconds: result.ttlSeconds,
          operation: result.operation,
          requestId: result.requestId,
        });
        return;
      }
      if (requestPath === "/api/wallet/approval-auth/challenge") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payloadRaw = (body.value ?? {}) as Record<string, unknown>;
        const requestId =
          typeof payloadRaw.requestId === "string"
            ? payloadRaw.requestId.trim() || undefined
            : undefined;
        const operation =
          typeof payloadRaw.operation === "string"
            ? payloadRaw.operation.trim() || undefined
            : undefined;
        if (
          operation &&
          operation !== "wallet.approve" &&
          operation !== "wallet.policy" &&
          operation !== "wallet.settings" &&
          operation !== "wallet.provider-credentials" &&
          operation !== "wallet.network" &&
          operation !== "wallet.archive" &&
          operation !== "wallet.passkey-enroll" &&
          operation !== "wallet.passkey-remove" &&
          operation !== "wallet.reset" &&
          operation !== "wallet.rotate" &&
          operation !== "wallet.execution-mode" &&
          operation !== "wallet.send" &&
          operation !== "mining.capital" &&
          operation !== "mining.policy"
        ) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_operation", message: "operation not allowed" },
          });
          return;
        }
        const cfg = loadConfig();
        const challenge = createWalletApprovalChallenge({
          requestId,
          operation,
          ttlSeconds: resolveWalletApprovalChallengeTtlSeconds(process.env, cfg),
          host,
          env: process.env,
          cfg,
        });
        if (!challenge.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: challenge.code, message: challenge.message },
          });
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          challenge: challenge.challenge,
          challengeTtlSeconds: challenge.challengeTtlSeconds,
        });
        return;
      }
      if (requestPath === "/api/wallet/rotate") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        sendLoginResponse(410, {
          ok: false,
          error: {
            code: "gateway_wallet_key_lifecycle_removed",
            message:
              "Wallet key rotation is signer/provider-owned. Use `fased-signerd admin wallet reencrypt` as the control-socket owner, or rotate through Turnkey/hardware wallet authority.",
          },
        });
        return;
      }
      if (requestPath === "/api/wallet/reset") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        sendLoginResponse(410, {
          ok: false,
          error: {
            code: "gateway_wallet_key_lifecycle_removed",
            message:
              "Wallet reset is unavailable through the Gateway. Create or import only in the signer/provider/hardware-wallet authority surface.",
          },
        });
        return;
      }
      if (requestPath === "/api/wallet/policy/simulate") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payloadRaw = (body.value ?? {}) as Record<string, unknown>;
        const chain: WalletChain | null = payloadRaw.chain === "solana" ? "solana" : null;
        if (!chain) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_chain", message: "chain must be solana" },
          });
          return;
        }
        const cfg = loadConfig();
        const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
        const payload = {
          chain,
          assetSymbol:
            typeof payloadRaw.assetSymbol === "string"
              ? payloadRaw.assetSymbol.trim() || undefined
              : undefined,
          amountDisplay:
            typeof payloadRaw.amountDisplay === "string"
              ? payloadRaw.amountDisplay.trim() || undefined
              : undefined,
          providerId: parseWalletProviderId(payloadRaw.providerId),
          to: typeof payloadRaw.to === "string" ? payloadRaw.to.trim() || undefined : undefined,
          contract:
            typeof payloadRaw.contract === "string"
              ? payloadRaw.contract.trim() || undefined
              : undefined,
          program:
            typeof payloadRaw.program === "string"
              ? payloadRaw.program.trim() || undefined
              : undefined,
          walletId:
            typeof payloadRaw.walletId === "string"
              ? payloadRaw.walletId.trim() || undefined
              : undefined,
          walletName:
            typeof payloadRaw.walletName === "string"
              ? payloadRaw.walletName.trim() || undefined
              : undefined,
          amount: undefined as string | undefined,
        };
        const resolvedDestination = await resolveSolanaWalletHandleDestination({
          to: payload.to,
          sourceWalletId: payload.walletId,
          env: effectiveEnv,
        });
        if (!resolvedDestination.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: resolvedDestination.code,
              message: resolvedDestination.message,
            },
          });
          return;
        }
        payload.to = resolvedDestination.to;
        if (payload.to && !isValidSolanaAddress(payload.to)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "invalid_solana_address",
              message: "destination is not a valid Solana address",
            },
          });
          return;
        }
        if (payload.program && !isValidSolanaAddress(payload.program)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "invalid_solana_mint",
              message: "SPL mint is not a valid Solana address",
            },
          });
          return;
        }
        const amountFormat = parseWalletAmountFormat(payloadRaw.amountFormat);
        const normalizedAmount = await normalizeWalletAmountFromFormat({
          amountRaw: typeof payloadRaw.amount === "string" ? payloadRaw.amount : undefined,
          chain,
          amountFormat,
          program: payload.program,
          walletId: payload.walletId,
          env: effectiveEnv,
        });
        if (!normalizedAmount.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: normalizedAmount.message },
          });
          return;
        }
        (payload as { amount?: string }).amount = normalizedAmount.amount;
        let walletSelection: ReturnType<typeof resolveWalletSelection> | undefined;
        try {
          walletSelection = resolveWalletSelection({
            walletId: payload.walletId,
            walletName: payload.walletName,
            providerId: payload.providerId ?? undefined,
            env: process.env,
          });
        } catch (err) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: String(err) },
          });
          return;
        }
        const walletCfg = resolveWalletRuntimeConfig(cfg, effectiveEnv);
        const effectiveWallet = resolveWalletPolicyConfig(
          cfg,
          effectiveEnv,
          walletSelection?.walletId ?? payload.walletId,
        );
        const simulation = simulateWalletPolicy({
          cfg,
          config: effectiveWallet,
          payload: {
            ...payload,
            walletId: walletSelection?.walletId ?? payload.walletId,
            providerId:
              walletSelection?.providerId ??
              payload.providerId ??
              resolveWalletProviderId(cfg, process.env),
          },
          mode: walletCfg.execution.mode === "autonomous" ? "autonomous" : "manual",
          source: "control-ui",
          requireDirectSigning: walletCfg.execution.mode === "autonomous",
          requireSolanaTokenCap: Boolean(payload.program?.trim()),
          env: effectiveEnv,
        });
        sendLoginResponse(200, { ok: true, simulation });
        return;
      }
      if (requestPath === "/api/wallet/approvals/create") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payloadRaw = (body.value ?? {}) as Record<string, unknown>;
        const chain: WalletChain | null = payloadRaw.chain === "solana" ? "solana" : null;
        if (!chain) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_chain", message: "chain must be solana" },
          });
          return;
        }
        const payload = {
          chain,
          assetId:
            typeof payloadRaw.assetId === "string"
              ? payloadRaw.assetId.trim() || undefined
              : undefined,
          assetSymbol:
            typeof payloadRaw.assetSymbol === "string"
              ? payloadRaw.assetSymbol.trim() || undefined
              : undefined,
          assetName:
            typeof payloadRaw.assetName === "string"
              ? payloadRaw.assetName.trim() || undefined
              : undefined,
          amountDisplay:
            typeof payloadRaw.amountDisplay === "string"
              ? payloadRaw.amountDisplay.trim() || undefined
              : undefined,
          providerId: parseWalletProviderId(payloadRaw.providerId),
          to: typeof payloadRaw.to === "string" ? payloadRaw.to.trim() || undefined : undefined,
          contract:
            typeof payloadRaw.contract === "string"
              ? payloadRaw.contract.trim() || undefined
              : undefined,
          program:
            typeof payloadRaw.program === "string"
              ? payloadRaw.program.trim() || undefined
              : undefined,
          memo:
            typeof payloadRaw.memo === "string" ? payloadRaw.memo.trim() || undefined : undefined,
          walletId:
            typeof payloadRaw.walletId === "string"
              ? payloadRaw.walletId.trim() || undefined
              : undefined,
          walletName:
            typeof payloadRaw.walletName === "string"
              ? payloadRaw.walletName.trim() || undefined
              : undefined,
        };
        const cfg = loadConfig();
        const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
        const walletCfg = resolveWalletRuntimeConfig(cfg, effectiveEnv);
        const resolvedDestination = await resolveSolanaWalletHandleDestination({
          to: payload.to,
          sourceWalletId: payload.walletId,
          env: effectiveEnv,
        });
        if (!resolvedDestination.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: resolvedDestination.code,
              message: resolvedDestination.message,
            },
          });
          return;
        }
        payload.to = resolvedDestination.to;
        if (payload.to && !isValidSolanaAddress(payload.to)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "invalid_solana_address",
              message: "destination is not a valid Solana address",
            },
          });
          return;
        }
        if (payload.program && !isValidSolanaAddress(payload.program)) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "invalid_solana_mint",
              message: "SPL mint is not a valid Solana address",
            },
          });
          return;
        }
        const amountFormat = parseWalletAmountFormat(payloadRaw.amountFormat);
        const normalizedAmount = await normalizeWalletAmountFromFormat({
          amountRaw: typeof payloadRaw.amount === "string" ? payloadRaw.amount : undefined,
          chain,
          amountFormat,
          program: payload.program,
          walletId: payload.walletId,
          env: effectiveEnv,
        });
        if (!normalizedAmount.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: normalizedAmount.message },
          });
          return;
        }
        (payload as { amount?: string }).amount = normalizedAmount.amount;
        const registrySnapshot = readWalletProviderRegistry(process.env);
        let walletSelection: ReturnType<typeof resolveWalletSelection> | undefined;
        try {
          walletSelection = resolveWalletSelection({
            walletId: payload.walletId,
            walletName: payload.walletName,
            providerId: payload.providerId ?? undefined,
            env: process.env,
          });
        } catch (err) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: String(err) },
          });
          return;
        }
        const selectedWallet = walletSelection?.walletId
          ? registrySnapshot.wallets.find((entry) => entry.id === walletSelection.walletId)
          : undefined;
        const selectedProviderId =
          walletSelection?.providerId ??
          payload.providerId ??
          resolveWalletProviderId(cfg, process.env);
        const selectedProvider = createWalletProviderAdapter({
          cfg,
          wallet: walletCfg,
          env: process.env,
          providerIdOverride: selectedProviderId,
          walletId: walletSelection?.walletId ?? payload.walletId,
        });
        if (
          selectedProviderId === "turnkey" &&
          !hasTurnkeyPolicyCredentialsConfigured(process.env)
        ) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "provider_prerequisite_missing",
              message:
                "turnkey requires a dedicated API user covered by a restrictive organization policy, plus organizationId, policyId, and rpcUrl before prepare/send",
            },
          });
          return;
        }
        const selectedProviderCapabilities = buildWalletProviderCapabilityMatrix(selectedProvider);
        const supportsServerSend = providerSupportsChainOperation({
          matrix: selectedProviderCapabilities,
          chain,
          operation: "send",
        });
        if (!supportsServerSend && !selectedProviderCapabilities.signing.interactiveSend) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "wallet_provider_unsupported_chain",
              message: `${selectedProviderId} does not support send for chain=${chain}`,
            },
          });
          return;
        }
        const payloadWithSelection = {
          ...payload,
          walletId: walletSelection?.walletId ?? payload.walletId,
          providerId: selectedProviderId,
          walletName: selectedWallet?.name ?? walletSelection?.walletName ?? payload.walletName,
        };
        if (!walletCfg.enabled) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "wallet_disabled", message: "wallet is disabled" },
          });
          return;
        }
        const created = await createOrExecuteWalletSend({
          payload: payloadWithSelection,
          requestedBy: "control-ui",
          sendPath: "reviewed",
          config: walletCfg,
          runtimeConfig: cfg,
          providerIdOverride: selectedProviderId,
          env: process.env,
        });
        if (!created.ok) {
          const authCodes = new Set([
            "approval_token_required",
            "invalid_approval_token",
            "host_mismatch",
            "operation_mismatch",
            "request_mismatch",
          ]);
          const status = authCodes.has(created.code) ? 401 : 400;
          sendLoginResponse(status, {
            ok: false,
            error: {
              code: created.code ?? "wallet_send_failed",
              message: created.message ?? "wallet send failed",
            },
            simulation: created.simulation,
          });
          return;
        }
        if (created.mode === "manual") {
          sendLoginResponse(200, {
            ok: true,
            mode: "manual",
            request: sanitizeWalletSendApprovalRequest(created.request),
          });
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          mode: "autonomous",
          executed: true,
          tx: created.tx,
          payload: sanitizeWalletSendApprovalPayload(created.payload),
        });
        return;
      }
      if (requestPath === "/api/wallet/approvals") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const parsed = new URL(req.url ?? "/", "http://localhost");
        const statusParam = parsed.searchParams.get("status")?.trim() || "pending";
        const limitRaw = Number.parseInt(parsed.searchParams.get("limit") ?? "", 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
        const status =
          statusParam === "all" ||
          statusParam === "pending" ||
          statusParam === "approved" ||
          statusParam === "rejected" ||
          statusParam === "executed" ||
          statusParam === "failed" ||
          statusParam === "expired"
            ? statusParam
            : "pending";
        const requests = listWalletSendApprovalRequests({
          env: process.env,
          limit,
          status,
        }).map(sanitizeWalletSendApprovalRequest);
        sendLoginResponse(200, { ok: true, requests });
        return;
      }
      if (requestPath.startsWith("/api/wallet/approvals/")) {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const parts = requestPath.split("/").filter(Boolean);
        if (
          parts.length !== 5 ||
          parts[0] !== "api" ||
          parts[1] !== "wallet" ||
          parts[2] !== "approvals"
        ) {
          sendLoginResponse(404, { ok: false, error: { code: "not_found", message: "not found" } });
          return;
        }
        const requestId = parts[3] ?? "";
        const action = parts[4] ?? "";
        if (!requestId || (action !== "approve" && action !== "reject" && action !== "execute")) {
          sendLoginResponse(404, { ok: false, error: { code: "not_found", message: "not found" } });
          return;
        }
        if (action === "execute") {
          const request = getWalletSendApprovalRequest({ requestId, env: process.env });
          if (!request || request.payload.providerId !== "wallet-standard") {
            sendLoginResponse(404, {
              ok: false,
              error: { code: "not_found", message: "hardware-wallet approval not found" },
            });
            return;
          }
          if (
            request.status !== "pending" &&
            request.status !== "approved" &&
            request.status !== "executed"
          ) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "invalid_state",
                message: `hardware-wallet approval is ${request.status}`,
              },
            });
            return;
          }
          const body = await readJsonBody(req, 256 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const payload = (body.value ?? {}) as Record<string, unknown>;
          const preparedId = toOptionalString(payload.preparedId);
          const intentDigest = toOptionalString(payload.intentDigest);
          const signedTxBase64 = toOptionalString(payload.signedTxBase64);
          if (!preparedId || !intentDigest || !signedTxBase64) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_request",
                message: "preparedId, intentDigest, and signedTxBase64 are required",
              },
            });
            return;
          }
          const cfg = loadConfig();
          const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
          const walletId = request.payload.walletId?.trim() || "";
          const rpcUrl = resolveScopedRpcUrlForWallet({
            env: effectiveEnv,
            chains: ["solana"],
            walletId: walletId || undefined,
          });
          if (!rpcUrl) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "wallet_provider_invalid_config",
                message: "hardware Vault requires a configured Solana RPC URL",
              },
            });
            return;
          }
          try {
            const executed = await executeWalletStandardReview({
              requestId,
              preparedId,
              intentDigest,
              signedTxBase64,
              rpcUrl,
              env: process.env,
            });
            const updated = await markWalletSendRequestExecutedExternally({
              requestId,
              txHash: executed.txHash,
              signer: executed.signer,
              actor: "control-ui",
              env: process.env,
            });
            sendLoginResponse(200, {
              ok: true,
              request: sanitizeWalletSendApprovalRequest(updated),
              tx: {
                ok: true,
                chain: "solana",
                txHash: executed.txHash,
                signer: executed.signer,
                idempotent: executed.idempotent,
              },
            });
          } catch (error) {
            const code =
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : "wallet_provider_error";
            const message = walletDiagnosticErrorMessage(error);
            if (code === "wallet_provider_ambiguous") {
              await markWalletSendRequestBroadcastUnknown({
                requestId,
                txHash: readWalletStandardReviewTxHash({ requestId, env: process.env }),
                reason: message,
                actor: "control-ui",
                env: process.env,
              });
            }
            sendLoginResponse(code === "wallet_provider_ambiguous" ? 409 : 400, {
              ok: false,
              error: { code, message },
            });
          }
          return;
        }
        if (action === "reject") {
          const cfg = loadConfig();
          if (!ensureWalletApprovalAuthorized({ operation: "wallet.approve", requestId, cfg })) {
            return;
          }
          const body = await readJsonBody(req, 64 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const reason =
            typeof (body.value as { reason?: unknown } | null)?.reason === "string"
              ? (body.value as { reason: string }).reason.trim()
              : "";
          const rejected = rejectWalletSendRequest({
            requestId,
            actor: "control-ui",
            reason,
            env: process.env,
          });
          if (!rejected.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: rejected.code, message: rejected.message },
            });
            return;
          }
          sendLoginResponse(200, {
            ok: true,
            request: sanitizeWalletSendApprovalRequest(rejected.request),
          });
          return;
        }
        const cfg = loadConfig();
        const walletCfg = resolveWalletRuntimeConfig(cfg, process.env);
        const pendingRequest = getWalletSendApprovalRequest({ requestId, env: process.env });
        const signerReviewId = pendingRequest?.payload.signerReviewId?.trim() || "";
        const signerWalletId = pendingRequest?.payload.signerWalletId?.trim() || "";
        const applicationWalletId = pendingRequest?.payload.walletId?.trim() || "";
        const isSignerOwnedReview =
          pendingRequest?.payload.providerId === "local-socket-signer" &&
          Boolean(signerReviewId) &&
          Boolean(signerWalletId) &&
          Boolean(applicationWalletId);
        if (isSignerOwnedReview) {
          if (
            pendingRequest.status !== "pending" &&
            pendingRequest.status !== "expired" &&
            pendingRequest.status !== "executing" &&
            pendingRequest.status !== "unknown"
          ) {
            sendLoginResponse(409, {
              ok: false,
              error: {
                code: "invalid_state",
                message: `signer-reviewed approval is ${pendingRequest.status}`,
              },
            });
            return;
          }
          const body = await readJsonBody(req, 256 * 1024);
          if (!body.ok) {
            sendLoginResponse(400, {
              ok: false,
              error: { code: "invalid_request", message: body.error },
            });
            return;
          }
          const payload = (body.value ?? {}) as Record<string, unknown>;
          const payloadKeys = Object.keys(payload);
          const provider = createWalletProviderAdapter({
            cfg,
            wallet: walletCfg,
            env: process.env,
            providerIdOverride: "local-socket-signer",
            walletId: applicationWalletId,
          });
          const bindingMatchesApproval = (binding: WalletProviderSignerReviewBindingV2) =>
            signerReviewBindingMatchesWalletApprovalPayload(binding, pendingRequest.payload);
          if (payloadKeys.length === 0) {
            if (!provider.getSignerReview || !provider.beginSignerReviewAuthorization) {
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "wallet_signer_webauthn_unavailable",
                  message:
                    "local-socket-signer does not expose exact review recovery and signer-owned WebAuthn begin",
                },
              });
              return;
            }
            const approveFromControlUi = async () => {
              const approved = await approveWalletSendRequest({
                requestId,
                actor: "control-ui",
                config: walletCfg,
                env: process.env,
              });
              if (!approved.ok) {
                sendLoginResponse(approved.code === "wallet_provider_ambiguous" ? 409 : 400, {
                  ok: false,
                  error: { code: approved.code, message: approved.message },
                  request:
                    "request" in approved && approved.request
                      ? sanitizeWalletSendApprovalRequest(approved.request)
                      : undefined,
                });
                return;
              }
              sendLoginResponse(200, {
                ok: true,
                request: sanitizeWalletSendApprovalRequest(approved.request),
                tx: approved.tx,
              });
            };
            try {
              const storedReview = await provider.getSignerReview({
                walletId: signerWalletId,
                requestId: signerReviewId,
              });
              if (!signerReviewMatchesWalletApprovalPayload(storedReview, pendingRequest.payload)) {
                throw new Error("stored signer review does not match the persisted approval");
              }
              if (storedReview.state === "signed") {
                await approveFromControlUi();
                return;
              }
              if (
                pendingRequest.status === "expired" ||
                Date.parse(pendingRequest.expiresAt) <= Date.now()
              ) {
                const expired = await approveWalletSendRequest({
                  requestId,
                  actor: "control-ui",
                  config: walletCfg,
                  env: process.env,
                });
                sendLoginResponse(409, {
                  ok: false,
                  error: {
                    code: expired.ok ? "invalid_state" : expired.code,
                    message: expired.ok
                      ? "expired signer review unexpectedly executed"
                      : expired.message,
                  },
                  request:
                    !expired.ok && "request" in expired && expired.request
                      ? sanitizeWalletSendApprovalRequest(expired.request)
                      : undefined,
                });
                return;
              }
              const authorization = await provider.beginSignerReviewAuthorization({
                walletId: signerWalletId,
                requestId: signerReviewId,
              });
              if (!bindingMatchesApproval(authorization.binding)) {
                throw new Error("signer WebAuthn binding does not match the persisted approval");
              }
              sendLoginResponse(200, {
                ok: true,
                mode: "signer-webauthn",
                request: sanitizeWalletSendApprovalRequest(pendingRequest),
                signerAuthorization: authorization,
              });
            } catch (error) {
              const message = walletDiagnosticErrorMessage(error);
              if (
                message.includes("no signer-owned WebAuthn credential is enrolled") ||
                message.includes("signer WebAuthn is not configured by the host administrator")
              ) {
                await approveFromControlUi();
                return;
              }
              sendLoginResponse(400, {
                ok: false,
                error: {
                  code: "wallet_signer_webauthn_failed",
                  message,
                },
              });
            }
            return;
          }
          if (
            payloadKeys.length !== 1 ||
            payloadKeys[0] !== "signerAuthorization" ||
            !payload.signerAuthorization ||
            typeof payload.signerAuthorization !== "object" ||
            Array.isArray(payload.signerAuthorization)
          ) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_request",
                message: "signer-reviewed approval accepts only signerAuthorization",
              },
            });
            return;
          }
          const signerAuthorization = payload.signerAuthorization as Record<string, unknown>;
          if (
            Object.keys(signerAuthorization).some(
              (key) => key !== "challengeId" && key !== "credential",
            ) ||
            typeof signerAuthorization.challengeId !== "string" ||
            !signerAuthorization.challengeId.trim() ||
            !signerAuthorization.credential ||
            typeof signerAuthorization.credential !== "object" ||
            Array.isArray(signerAuthorization.credential)
          ) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_request",
                message: "challengeId and WebAuthn credential are required",
              },
            });
            return;
          }
          if (!provider.finishSignerReviewAuthorization) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "wallet_signer_webauthn_unavailable",
                message: "local-socket-signer does not expose signer-owned WebAuthn finish",
              },
            });
            return;
          }
          try {
            const finished = await provider.finishSignerReviewAuthorization({
              walletId: signerWalletId,
              challengeId: signerAuthorization.challengeId.trim(),
              credential: signerAuthorization.credential,
            });
            if (!bindingMatchesApproval(finished.binding)) {
              throw new Error("completed signer WebAuthn binding does not match the approval");
            }
            const approved = await approveWalletSendRequest({
              requestId,
              actor: "control-ui",
              config: walletCfg,
              reviewAuthorization: finished.authorization,
              env: process.env,
            });
            if (!approved.ok) {
              sendLoginResponse(approved.code === "wallet_provider_ambiguous" ? 409 : 400, {
                ok: false,
                error: { code: approved.code, message: approved.message },
                request:
                  "request" in approved && approved.request
                    ? sanitizeWalletSendApprovalRequest(approved.request)
                    : undefined,
              });
              return;
            }
            sendLoginResponse(200, {
              ok: true,
              request: sanitizeWalletSendApprovalRequest(approved.request),
              tx: approved.tx,
            });
          } catch (error) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "wallet_signer_webauthn_failed",
                message: walletDiagnosticErrorMessage(error),
              },
            });
          }
          return;
        }
        if (!ensureWalletApprovalAuthorized({ operation: "wallet.approve", requestId, cfg })) {
          return;
        }
        if (pendingRequest?.payload.providerId === "wallet-standard") {
          if (pendingRequest.status !== "pending") {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "invalid_state",
                message: `approval request is ${pendingRequest.status}`,
              },
            });
            return;
          }
          const effectiveEnv = { ...process.env, ...cfg.env?.vars } as NodeJS.ProcessEnv;
          const walletId = pendingRequest.payload.walletId?.trim() || "";
          const registry = readWalletProviderRegistry(effectiveEnv);
          const selectedWallet = registry.wallets.find((wallet) => wallet.id === walletId);
          const signerAddress = selectedWallet?.addresses?.solana?.trim() || "";
          const rpcUrl = resolveScopedRpcUrlForWallet({
            env: effectiveEnv,
            chains: ["solana"],
            walletId: walletId || undefined,
          });
          if (
            !selectedWallet ||
            selectedWallet.providerId !== "wallet-standard" ||
            !signerAddress
          ) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "wallet_provider_invalid_config",
                message: "hardware Vault account is not registered for this approval",
              },
            });
            return;
          }
          if (!rpcUrl) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code: "wallet_provider_invalid_config",
                message: "hardware Vault requires a configured Solana RPC URL",
              },
            });
            return;
          }
          try {
            const browserReview = await prepareWalletStandardReview({
              requestId,
              payload: pendingRequest.payload,
              signerAddress,
              rpcUrl,
              env: process.env,
            });
            sendLoginResponse(200, {
              ok: true,
              mode: "browser",
              request: sanitizeWalletSendApprovalRequest(pendingRequest),
              browserReview,
            });
          } catch (error) {
            sendLoginResponse(400, {
              ok: false,
              error: {
                code:
                  error instanceof Error && "code" in error && typeof error.code === "string"
                    ? error.code
                    : "wallet_provider_error",
                message: walletDiagnosticErrorMessage(error),
              },
            });
          }
          return;
        }
        const approved = await approveWalletSendRequest({
          requestId,
          actor: "control-ui",
          config: walletCfg,
          env: process.env,
        });
        if (!approved.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: approved.code, message: approved.message },
            request:
              "request" in approved && approved.request
                ? sanitizeWalletSendApprovalRequest(approved.request)
                : undefined,
          });
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          request: sanitizeWalletSendApprovalRequest(approved.request),
          tx: approved.tx,
        });
        return;
      }
      if (requestPath === "/api/wallet/audit") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const parsed = new URL(req.url ?? "/", "http://localhost");
        const limitRaw = Number.parseInt(parsed.searchParams.get("limit") ?? "", 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
        const providerFilter = parseWalletProviderId(parsed.searchParams.get("providerId"));
        const walletIdFilter = parsed.searchParams.get("walletId")?.trim();
        const allEntries = readWalletAuditEntries({
          env: process.env,
          limit: Math.max(limit * 4, 200),
        });
        const entries = allEntries
          .filter((entry) => {
            const details = entry.details && typeof entry.details === "object" ? entry.details : {};
            const providerId =
              typeof details.providerId === "string" ? details.providerId : undefined;
            const walletId = typeof details.walletId === "string" ? details.walletId : undefined;
            if (providerFilter && providerId !== providerFilter) {
              return false;
            }
            if (walletIdFilter && walletId !== walletIdFilter) {
              return false;
            }
            return true;
          })
          .slice(0, limit);
        sendLoginResponse(200, { ok: true, entries });
        return;
      }
      if (requestPath === "/api/wallet/observability") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        sendLoginResponse(200, {
          ok: true,
          observability: readWalletObservabilitySnapshot(process.env),
        });
        return;
      }
      if (requestPath === "/api/wallet/inbound") {
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.setHeader("Allow", "GET");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be GET" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const parsed = new URL(req.url ?? "/", "http://localhost");
        const providerId = parseWalletProviderId(parsed.searchParams.get("providerId"));
        const walletId = parsed.searchParams.get("walletId")?.trim() || undefined;
        const chainParam = parsed.searchParams.get("chain")?.trim();
        const chain: WalletChain | undefined = chainParam === "solana" ? "solana" : undefined;
        const statusParam = parsed.searchParams.get("status")?.trim();
        const status =
          statusParam === "detected" ||
          statusParam === "confirmed" ||
          statusParam === "reconciled" ||
          statusParam === "ignored" ||
          statusParam === "all"
            ? statusParam
            : "all";
        const limitRaw = Number.parseInt(parsed.searchParams.get("limit") ?? "", 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
        const events = listWalletInboundEvents({
          env: process.env,
          providerId: providerId ?? undefined,
          walletId,
          chain,
          status,
          limit,
        });
        sendLoginResponse(200, {
          ok: true,
          events,
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      if (requestPath === "/api/wallet/inbound/poll") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const body = await readJsonBody(req, 64 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        const payload = (body.value as Record<string, unknown> | null) ?? {};
        const chain = payload.chain === "solana" || payload.chain === "all" ? payload.chain : "all";
        const cfg = loadConfig();
        const walletCfg = resolveWalletRuntimeConfig(cfg, process.env);
        try {
          const polled = await pollWalletInboundEvents({
            cfg,
            wallet: walletCfg,
            env: process.env,
            providerId: parseWalletProviderId(payload.providerId) ?? undefined,
            walletId: typeof payload.walletId === "string" ? payload.walletId.trim() : undefined,
            walletName:
              typeof payload.walletName === "string" ? payload.walletName.trim() : undefined,
            chain,
            actor: "control-ui",
          });
          sendLoginResponse(200, {
            ok: true,
            result: polled,
          });
        } catch (err) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "wallet_inbound_poll_failed", message: String(err) },
          });
        }
        return;
      }
      if (requestPath === "/api/wallet/inbound/reconcile") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        if (!(await ensureWalletApiAuthorized())) {
          return;
        }
        const result = reconcileWalletInboundEvents({ env: process.env });
        sendLoginResponse(200, { ok: true, result });
        return;
      }
      if (requestPath === "/api/wallet/inbound/webhook") {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Allow", "POST");
          sendLoginResponse(405, {
            ok: false,
            error: { code: "method_not_allowed", message: "method must be POST" },
          });
          return;
        }
        const configuredWebhookSecret =
          String(
            process.env.FASED_WALLET_INBOUND_WEBHOOK_SECRET ??
              process.env.FASED_WALLET_WEBHOOK_SECRET ??
              "",
          ).trim() || "";
        const providedWebhookSecret = String(
          getHeader(req, "x-wallet-webhook-secret") ?? "",
        ).trim();
        if (configuredWebhookSecret) {
          if (!safeEqualSecret(configuredWebhookSecret, providedWebhookSecret)) {
            sendLoginResponse(401, {
              ok: false,
              error: {
                code: "wallet_webhook_unauthorized",
                message: "invalid or missing wallet webhook secret",
              },
            });
            return;
          }
        } else if (!(await ensureWalletApiAuthorized())) {
          return;
        }

        const body = await readJsonBody(req, 128 * 1024);
        if (!body.ok) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: body.error },
          });
          return;
        }
        if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
          sendLoginResponse(400, {
            ok: false,
            error: { code: "invalid_request", message: "payload must be a JSON object" },
          });
          return;
        }
        const cfg = loadConfig();
        const walletCfg = resolveWalletRuntimeConfig(cfg, process.env);
        try {
          const result = recordWalletInboundWebhookEvent({
            cfg,
            wallet: walletCfg,
            payload: body.value as Record<string, unknown>,
            env: process.env,
            actor: "wallet-webhook",
          });
          sendLoginResponse(200, {
            ok: true,
            result,
          });
        } catch (err) {
          sendLoginResponse(400, {
            ok: false,
            error: {
              code: "wallet_webhook_failed",
              message: String(err),
            },
          });
        }
        return;
      }
      if (await handleHooksRequest(req, res)) {
        return;
      }
      if (await a2aHandler(req, res)) {
        return;
      }
      if (
        isPathProtectedByPrefixes(requestPath, FEDERATION_HTTP_ROUTE_PREFIXES) &&
        !isSignedFederationInboundRequest(req) &&
        !(await ensureWalletApiAuthorized())
      ) {
        return;
      }
      if (
        await handleFederationHttpRequest(req, res, {
          peerAuthClientIp: resolveGatewayClientIp({
            remoteAddr: req.socket?.remoteAddress ?? "",
            forwardedFor: getHeader(req, "x-forwarded-for"),
            realIp: getHeader(req, "x-real-ip"),
            trustedProxies,
          }),
        })
      ) {
        return;
      }
      if (await fedifyHandler(req, res)) {
        return;
      }
      if (
        await handleToolsInvokeHttpRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies,
          rateLimiter,
        })
      ) {
        return;
      }
      if (await (await import("../slack/http/index.js")).handleSlackHttpRequest(req, res)) {
        return;
      }
      if (handlePluginRequest) {
        const canonicalPluginPath = canonicalizePathVariant(requestPath);
        const rawChannelCandidatePath = requestPath.toLowerCase().replace(/\/+/g, "/");
        // Channel HTTP endpoints are gateway-auth protected by default.
        // Non-channel plugin routes remain plugin-owned and must enforce
        // their own auth when exposing sensitive functionality.
        if (
          canonicalPluginPath === "/api/channels" ||
          canonicalPluginPath.startsWith("/api/channels/") ||
          rawChannelCandidatePath.startsWith("/api/channels")
        ) {
          const bearerToken = getBearerToken(req);
          let pluginAuthOk = false;
          if (resolvedAuth.mode === "token" && resolvedAuth.token) {
            pluginAuthOk = Boolean(bearerToken && safeEqualSecret(resolvedAuth.token, bearerToken));
          } else if (resolvedAuth.mode === "password" && resolvedAuth.password) {
            pluginAuthOk = Boolean(
              bearerToken && safeEqualSecret(resolvedAuth.password, bearerToken),
            );
          } else {
            const authResult = await authorizeGatewayConnect({
              auth: resolvedAuth,
              connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
              req,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            });
            if (!authResult.ok) {
              sendGatewayAuthFailure(res, authResult);
              return;
            }
            pluginAuthOk = true;
          }
          if (!pluginAuthOk) {
            sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
            return;
          }
        }
        if (await handlePluginRequest(req, res)) {
          return;
        }
      }
      if (openResponsesEnabled) {
        const { handleOpenResponsesHttpRequest } = await import("./openresponses-http.js");
        if (
          await handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (openAiChatCompletionsEnabled) {
        if (
          await handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies,
            rateLimiter,
          })
        ) {
          return;
        }
      }
      if (
        await handlePrometheusMetricsRequest({
          req,
          res,
          requestPath,
          config: configSnapshot,
          resolvedAuth,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
          getReadiness,
        })
      ) {
        return;
      }
      if (canvasHost) {
        if (canvasScopedUrl.scopedPath || isCanvasPath(canvasRequestPath)) {
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            clients,
            rateLimiter,
            canvasCapability: canvasScopedUrl.capability,
            requireCanvasCapability: canvasScopedUrl.scopedPath,
            malformedCanvasCapabilityPath: canvasScopedUrl.malformedScopedPath,
          });
          if (!ok.ok) {
            sendGatewayAuthFailure(res, ok);
            return;
          }
        }
        const originalUrl = req.url;
        if (canvasScopedUrl.rewrittenUrl) {
          req.url = canvasScopedUrl.rewrittenUrl;
        }
        try {
          if (await handleA2uiHttpRequest(req, res)) {
            return;
          }
          if (await canvasHost.handleHttpRequest(req, res)) {
            return;
          }
        } finally {
          req.url = originalUrl;
        }
      }
      if (controlUiEnabled) {
        const isControlUiRequest =
          (req.method === "GET" || req.method === "HEAD") &&
          isControlUiCandidatePath(requestPath, controlUiBasePath);
        if (
          isControlUiRequest &&
          isRemoteHost &&
          isControlUiStaticAssetPath(requestPath, controlUiBasePath) &&
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
            root: controlUiRoot,
          })
        ) {
          return;
        }
        if (isControlUiRequest && controlUiLogin && isRemoteHost) {
          const sessionToken = resolveControlUiSessionCookie(req);
          if (!sessionToken) {
            const redirectLocation = resolveControlUiLoopbackRedirect({
              host,
              path: requestPath,
              search: parsedUrl.search,
              secure: secureCookie,
            });
            if (redirectLocation) {
              res.statusCode = 302;
              res.setHeader("Location", redirectLocation);
              res.setHeader("Cache-Control", "no-store");
              res.end();
              return;
            }
          }
          const sessionOk =
            sessionToken && host
              ? controlUiLogin.authorizeSessionToken({ token: sessionToken, host }).ok
              : false;
          if (!sessionOk) {
            const redirectLocation = resolveControlUiLoopbackRedirect({
              host,
              path: requestPath,
              search: parsedUrl.search,
              secure: secureCookie,
            });
            if (redirectLocation) {
              res.statusCode = 302;
              res.setHeader("Location", redirectLocation);
              res.setHeader("Cache-Control", "no-store");
              clearControlUiSessionCookie(res, secureCookie);
              res.end();
              return;
            }
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            clearControlUiSessionCookie(res, secureCookie);
            res.end(controlUiLoginPageHtml());
            return;
          }
        }
        if (
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
          })
        ) {
          return;
        }
        if (
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot,
            root: controlUiRoot,
          })
        ) {
          return;
        }
      }

      if (
        await handleGatewayProbeRequest({
          req,
          res,
          requestPath,
          resolvedAuth,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
          getReadiness,
        })
      ) {
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch (error) {
      if (!res.headersSent && requestPath.startsWith("/api/")) {
        const message = error instanceof Error ? error.message : String(error);
        const legacyMigrationRequired =
          error instanceof LegacyEmbeddedKeystoreMigrationRequiredError;
        res.statusCode = legacyMigrationRequired ? 409 : 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          JSON.stringify({
            ok: false,
            error: {
              code: legacyMigrationRequired
                ? "wallet_legacy_embedded_keystore_migration_required"
                : "internal_server_error",
              message: message || "Internal Server Error",
            },
          }),
        );
        return;
      }
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export async function handleGatewayUpgradeRequest(opts: {
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
}) {
  const { wss, canvasHost, clients, resolvedAuth, rateLimiter, req, socket, head } = opts;
  if (canvasHost) {
    const rawRequestUrl = req.url ?? "/";
    const canvasScopedUrl = normalizeCanvasScopedUrl(rawRequestUrl);
    const canvasParsedUrl = new URL(
      canvasScopedUrl.rewrittenUrl ?? rawRequestUrl,
      "http://localhost",
    );
    if (canvasScopedUrl.scopedPath || canvasParsedUrl.pathname === CANVAS_WS_PATH) {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const ok = await authorizeCanvasRequest({
        req,
        auth: resolvedAuth,
        trustedProxies,
        clients,
        rateLimiter,
        canvasCapability: canvasScopedUrl.capability,
        requireCanvasCapability: canvasScopedUrl.scopedPath,
        malformedCanvasCapabilityPath: canvasScopedUrl.malformedScopedPath,
      });
      if (!ok.ok) {
        writeUpgradeAuthFailure(socket, ok);
        socket.destroy();
        return;
      }
    }
    const originalUrl = req.url;
    if (canvasScopedUrl.rewrittenUrl) {
      req.url = canvasScopedUrl.rewrittenUrl;
    }
    try {
      if (canvasHost.handleUpgrade(req, socket, head)) {
        return;
      }
    } finally {
      req.url = originalUrl;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
}) {
  const { httpServer } = opts;
  httpServer.on("upgrade", (req, socket, head) => {
    void handleGatewayUpgradeRequest({ ...opts, req, socket, head }).catch(() => {
      socket.destroy();
    });
  });
}
