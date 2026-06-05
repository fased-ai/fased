import type { ConnectParams } from "../../protocol/index.js";
import type { GatewayRole } from "../../role-policy.js";
import { roleCanSkipDeviceIdentity } from "../../role-policy.js";

export type ControlUiAuthPolicy = {
  allowInsecureAuthConfigured: boolean;
  dangerouslyDisableDeviceAuth: boolean;
  allowBypass: boolean;
  device: ConnectParams["device"] | null | undefined;
};

export function resolveControlUiAuthPolicy(params: {
  isControlUi: boolean;
  controlUiConfig:
    | {
        allowInsecureAuth?: boolean;
        dangerouslyDisableDeviceAuth?: boolean;
      }
    | undefined;
  deviceRaw: ConnectParams["device"] | null | undefined;
}): ControlUiAuthPolicy {
  const allowInsecureAuthConfigured =
    params.isControlUi && params.controlUiConfig?.allowInsecureAuth === true;
  const dangerouslyDisableDeviceAuth =
    params.isControlUi && params.controlUiConfig?.dangerouslyDisableDeviceAuth === true;
  return {
    allowInsecureAuthConfigured,
    dangerouslyDisableDeviceAuth,
    // `allowInsecureAuth` must not bypass secure-context/device-auth requirements.
    allowBypass: dangerouslyDisableDeviceAuth,
    device: dangerouslyDisableDeviceAuth ? null : params.deviceRaw,
  };
}

export function shouldSkipControlUiPairing(
  policy: ControlUiAuthPolicy,
  sharedAuthOk: boolean,
  trustedProxyAuthOk = false,
  trustedTailscaleServeControlUiContext = false,
): boolean {
  if (trustedProxyAuthOk) {
    return true;
  }
  if (trustedTailscaleServeControlUiContext && sharedAuthOk) {
    return true;
  }
  return policy.allowBypass && sharedAuthOk;
}

export function isTrustedProxyControlUiOperatorAuth(params: {
  isControlUi: boolean;
  role: GatewayRole;
  authMode: string;
  authOk: boolean;
  authMethod: string | undefined;
}): boolean {
  if (!params.isControlUi || !params.authOk) {
    return false;
  }
  // Trusted-proxy auth (Tailscale, etc.) bypasses device pairing.
  if (
    params.role === "operator" &&
    params.authMode === "trusted-proxy" &&
    params.authMethod === "trusted-proxy"
  ) {
    return true;
  }
  // Session-token auth is a secure, gateway-issued credential. When the
  // Control UI holds a valid session token, device pairing is redundant —
  // the session is already scoped to an authenticated owner.
  if (params.authMethod === "session-token") {
    return true;
  }
  return false;
}

export type MissingDeviceIdentityDecision =
  | { kind: "allow" }
  | { kind: "reject-control-ui-insecure-auth" }
  | { kind: "reject-unauthorized" }
  | { kind: "reject-device-required" };

export function evaluateMissingDeviceIdentity(params: {
  hasDeviceIdentity: boolean;
  role: GatewayRole;
  isControlUi: boolean;
  controlUiAuthPolicy: ControlUiAuthPolicy;
  trustedProxyAuthOk?: boolean;
  sharedAuthOk: boolean;
  authOk: boolean;
  hasSharedAuth: boolean;
  isLocalClient: boolean;
  trustedTailscaleServeControlUiContext?: boolean;
}): MissingDeviceIdentityDecision {
  if (params.hasDeviceIdentity) {
    return { kind: "allow" };
  }
  if (params.isControlUi && params.trustedProxyAuthOk) {
    return { kind: "allow" };
  }
  if (params.isControlUi && !params.controlUiAuthPolicy.allowBypass) {
    // Allow token/password-only Control UI connections when allowInsecureAuth
    // is configured and the browser context is either localhost or hosted
    // Tailscale Serve HTTPS. Other remote browser contexts are still rejected
    // to preserve the MitM protection that the security fix (#20684) intended.
    if (
      !params.controlUiAuthPolicy.allowInsecureAuthConfigured ||
      (!params.isLocalClient && !params.trustedTailscaleServeControlUiContext)
    ) {
      return { kind: "reject-control-ui-insecure-auth" };
    }
  }
  if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) {
    return { kind: "allow" };
  }
  if (!params.authOk && params.hasSharedAuth) {
    return { kind: "reject-unauthorized" };
  }
  return { kind: "reject-device-required" };
}
