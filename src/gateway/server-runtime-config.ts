import type {
  GatewayAuthConfig,
  GatewayBindMode,
  GatewayTailscaleConfig,
  loadConfig,
} from "../config/config.js";
import { resolveWalletApprovalAuthMode } from "../wallet/wallet-approval-auth.js";
import { resolveWalletRuntimeConfig } from "../wallet/wallet-runtime-config.js";
import {
  assertGatewayAuthConfigured,
  type ResolvedGatewayAuth,
  resolveGatewayAuth,
} from "./auth.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { resolveHooksConfig } from "./hooks.js";
import {
  isTrustedProxyAddress,
  isLoopbackHost,
  isValidIPv4,
  resolveGatewayBindHost,
} from "./net.js";
import { isCanvasHostConfigured } from "./startup-selection.js";

export type GatewayRuntimeConfig = {
  bindHost: string;
  controlUiEnabled: boolean;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  controlUiBasePath: string;
  controlUiRoot?: string;
  resolvedAuth: ResolvedGatewayAuth;
  authMode: ResolvedGatewayAuth["mode"];
  tailscaleConfig: GatewayTailscaleConfig;
  tailscaleMode: "off" | "serve" | "funnel";
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  canvasHostEnabled: boolean;
  strictTransportSecurityHeader?: string;
  securityWarnings: string[];
};

function hasTrustedLoopbackProxy(trustedProxies: string[]): boolean {
  return (
    isTrustedProxyAddress("127.0.0.1", trustedProxies) ||
    isTrustedProxyAddress("::1", trustedProxies)
  );
}

export async function resolveGatewayRuntimeConfig(params: {
  cfg: ReturnType<typeof loadConfig>;
  port: number;
  bind?: GatewayBindMode;
  host?: string;
  controlUiEnabled?: boolean;
  openAiChatCompletionsEnabled?: boolean;
  openResponsesEnabled?: boolean;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
}): Promise<GatewayRuntimeConfig> {
  const bindMode = params.bind ?? params.cfg.gateway?.bind ?? "loopback";
  const customBindHost = params.cfg.gateway?.customBindHost;
  const bindHost = params.host ?? (await resolveGatewayBindHost(bindMode, customBindHost));
  if (bindMode === "loopback" && !isLoopbackHost(bindHost)) {
    throw new Error("gateway bind=loopback resolved to non-loopback host");
  }
  if (bindMode === "custom") {
    const requestedCustomHost = customBindHost?.trim();
    if (!requestedCustomHost) {
      throw new Error("gateway.bind=custom requires gateway.customBindHost");
    }
    if (!isValidIPv4(requestedCustomHost)) {
      throw new Error("gateway.bind=custom requires a valid IPv4 customBindHost");
    }
    if (bindHost !== requestedCustomHost) {
      throw new Error(
        `gateway bind=custom requested ${requestedCustomHost} but resolved ${bindHost}`,
      );
    }
  }
  const controlUiEnabled =
    params.controlUiEnabled ?? params.cfg.gateway?.controlUi?.enabled ?? true;
  const openAiChatCompletionsEnabled =
    params.openAiChatCompletionsEnabled ??
    params.cfg.gateway?.http?.endpoints?.chatCompletions?.enabled ??
    false;
  const openResponsesConfig = params.cfg.gateway?.http?.endpoints?.responses;
  const openResponsesEnabled = params.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
  const controlUiBasePath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
  const controlUiRootRaw = params.cfg.gateway?.controlUi?.root;
  const controlUiRoot =
    typeof controlUiRootRaw === "string" && controlUiRootRaw.trim().length > 0
      ? controlUiRootRaw.trim()
      : undefined;
  const authBase = params.cfg.gateway?.auth ?? {};
  const authOverrides = params.auth ?? {};
  const authConfig = {
    ...authBase,
    ...authOverrides,
  };
  const tailscaleBase = params.cfg.gateway?.tailscale ?? {};
  const tailscaleOverrides = params.tailscale ?? {};
  const tailscaleConfig = {
    ...tailscaleBase,
    ...tailscaleOverrides,
  };
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const resolvedAuth = resolveGatewayAuth({
    authConfig,
    env: process.env,
    tailscaleMode,
  });
  const authMode: ResolvedGatewayAuth["mode"] = resolvedAuth.mode;
  const hasToken = typeof resolvedAuth.token === "string" && resolvedAuth.token.trim().length > 0;
  const hasPassword =
    typeof resolvedAuth.password === "string" && resolvedAuth.password.trim().length > 0;
  const hasSharedSecret =
    (authMode === "token" && hasToken) || (authMode === "password" && hasPassword);
  const hooksConfig = resolveHooksConfig(params.cfg);
  const canvasHostEnabled =
    process.env.FASED_SKIP_CANVAS_HOST !== "1" && isCanvasHostConfigured(params.cfg);
  const strictTransportSecurity =
    params.cfg.gateway?.http?.securityHeaders?.strictTransportSecurity;
  const strictTransportSecurityHeader =
    typeof strictTransportSecurity === "string" && strictTransportSecurity.trim().length > 0
      ? strictTransportSecurity.trim()
      : undefined;
  const securityWarnings: string[] = [];
  const gatewayMode = (process.env.FASED_GATEWAY_MODE ?? "").trim().toLowerCase();
  const publicOrManaged = gatewayMode === "managed" || !isLoopbackHost(bindHost);
  const execSecurity = params.cfg.tools?.exec?.security;
  const execAsk = params.cfg.tools?.exec?.ask;
  const crossContextLegacy = params.cfg.tools?.message?.allowCrossContextSend === true;
  const crossContextAcrossProviders =
    params.cfg.tools?.message?.crossContext?.allowAcrossProviders === true;
  if (publicOrManaged && execSecurity === "full") {
    securityWarnings.push(
      "public/managed mode with tools.exec.security=full increases host-command risk; prefer allowlist.",
    );
  }
  if (publicOrManaged && execAsk === "off") {
    securityWarnings.push(
      "public/managed mode with tools.exec.ask=off disables approval prompts for misses; prefer on-miss or always.",
    );
  }
  if (publicOrManaged && (crossContextLegacy || crossContextAcrossProviders)) {
    securityWarnings.push(
      "public/managed mode allows cross-provider message sends; consider disabling tools.message.crossContext.allowAcrossProviders.",
    );
  }
  const walletCfg = resolveWalletRuntimeConfig(params.cfg, process.env);
  if (publicOrManaged && walletCfg.enabled && walletCfg.policy.directSigning) {
    if (!walletCfg.policy.capsEnabled) {
      securityWarnings.push(
        "public/managed mode with automated wallet execution enabled and wallet caps disabled; enable wallet.runtime.policy.capsEnabled and set per-tx/daily caps for public operation.",
      );
    } else {
      const weakSolanaCaps =
        walletCfg.policy.solana.caps.maxPerTx <= 0n || walletCfg.policy.solana.caps.maxDaily <= 0n;
      if (weakSolanaCaps) {
        securityWarnings.push(
          "public/managed mode with automated wallet execution enabled but missing/zero tx caps; set wallet.runtime.policy.*.maxPerTx/maxDaily.",
        );
      }
    }
  }
  if (publicOrManaged && walletCfg.enabled && walletCfg.toolAccess.mode !== "owner-only") {
    securityWarnings.push(
      "public/managed mode with wallet tool access wider than owner-only increases signing risk; prefer wallet.runtime.toolAccess.mode=owner-only.",
    );
  }
  const walletApprovalAuthMode = resolveWalletApprovalAuthMode(process.env, params.cfg);
  if (
    publicOrManaged &&
    walletCfg.enabled &&
    walletCfg.execution.mode === "autonomous" &&
    walletApprovalAuthMode !== "webauthn"
  ) {
    securityWarnings.push(
      "public/managed mode with wallet.execution.mode=autonomous and wallet.approvalAuth.mode!=webauthn increases risk; require passkey approval and strict policy caps.",
    );
  }

  const trustedProxies = params.cfg.gateway?.trustedProxies ?? [];

  assertGatewayAuthConfigured(resolvedAuth);
  if (tailscaleMode === "funnel" && authMode !== "password") {
    throw new Error(
      "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or FASED_GATEWAY_PASSWORD)",
    );
  }
  if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) {
    throw new Error("tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)");
  }
  if (!isLoopbackHost(bindHost) && !hasSharedSecret && authMode !== "trusted-proxy") {
    throw new Error(
      `refusing to bind gateway to ${bindHost}:${params.port} without auth (set gateway.auth.token/password, or set FASED_GATEWAY_TOKEN/FASED_GATEWAY_PASSWORD)`,
    );
  }
  const allowedOrigins = params.cfg.gateway?.controlUi?.allowedOrigins ?? [];
  const dangerouslyAllowHostHeaderOriginFallback =
    params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
  if (
    controlUiEnabled &&
    !isLoopbackHost(bindHost) &&
    allowedOrigins.length === 0 &&
    !dangerouslyAllowHostHeaderOriginFallback
  ) {
    throw new Error("non-loopback Control UI requires gateway.controlUi.allowedOrigins");
  }

  if (authMode === "trusted-proxy") {
    if (trustedProxies.length === 0) {
      throw new Error(
        "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP",
      );
    }
    if (isLoopbackHost(bindHost) && !hasTrustedLoopbackProxy(trustedProxies)) {
      throw new Error(
        "gateway auth mode=trusted-proxy with bind=loopback requires gateway.trustedProxies to include 127.0.0.1, ::1, or a loopback CIDR",
      );
    }
  }

  return {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig: openResponsesConfig
      ? { ...openResponsesConfig, enabled: openResponsesEnabled }
      : undefined,
    controlUiBasePath,
    controlUiRoot,
    resolvedAuth,
    authMode,
    tailscaleConfig,
    tailscaleMode,
    hooksConfig,
    canvasHostEnabled,
    strictTransportSecurityHeader,
    securityWarnings,
  };
}
