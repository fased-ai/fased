import {
  beginWalletPasskeyAssertion,
  beginWalletPasskeyRegistration,
  finishWalletPasskeyAssertion,
  finishWalletPasskeyRegistration,
  type WalletSignerReviewAuthorizationBegin,
} from "./wallet-api.ts";
import {
  probeWalletCustodyCompanionHealth,
  walletCustodyCompanionSupportsSecureStorage,
} from "./wallet-custody-companion.ts";

export type WalletPasskeySupportState = "supported" | "unsupported" | "unknown";

export type WalletCustodyNativeHelperSupport =
  | {
      status: "available";
      helper: string;
      platform: "macos" | "linux" | "windows" | "mock";
      storageMode:
        | "os-keychain"
        | "secret-service"
        | "windows-dpapi"
        | "mock-memory"
        | "unavailable";
      protocolVersion: number;
      storedWalletCount: number;
      availableRoutes: string[];
      warning?: string;
    }
  | {
      status: "unreachable";
    };

export type WalletCustodyClientCompatibility = {
  secureContext: boolean;
  webauthn: boolean;
  webCrypto: boolean;
  localStorage: boolean;
  platformAuthenticator: WalletPasskeySupportState;
  conditionalMediation: WalletPasskeySupportState;
  prf: WalletPasskeySupportState;
  storageMode:
    | "encrypted-browser-storage"
    | "encrypted-browser-storage-untested"
    | "manual-share-only";
  nativeHelper: WalletCustodyNativeHelperSupport;
  notes: string[];
};

function toBase64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const buffer = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return buffer;
}

async function sha256Bytes(text: string): Promise<ArrayBuffer> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required for passkey-gated local custody storage.");
  }
  const bytes = new TextEncoder().encode(text);
  return await globalThis.crypto.subtle.digest("SHA-256", bytes);
}

function ensureWebAuthnAvailable(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new Error("WebAuthn is only available in browser runtime.");
  }
  if (!window.isSecureContext) {
    throw new Error(
      "Passkeys require a secure browser context. Open the dashboard on HTTPS or http://localhost:18789 on the gateway host.",
    );
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new Error("Passkeys are not supported in this browser.");
  }
}

function currentPasskeyOrigin(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin || "";
}

function isLoopbackIpHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

type WebAuthnCredentialCtor = typeof PublicKeyCredential & {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
  isConditionalMediationAvailable?: () => Promise<boolean>;
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
};

function getWebAuthnCtor(): WebAuthnCredentialCtor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.PublicKeyCredential as WebAuthnCredentialCtor | undefined;
}

function hasLocalStorageSafe(): boolean {
  try {
    if (!globalThis.localStorage) {
      return false;
    }
    const probeKey = "__fased_wallet_custody_storage_probe__";
    globalThis.localStorage.getItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function resolveSupportState(value: unknown): WalletPasskeySupportState {
  if (value === true) {
    return "supported";
  }
  if (value === false) {
    return "unsupported";
  }
  return "unknown";
}

export async function detectWalletCustodyClientCompatibility(): Promise<WalletCustodyClientCompatibility> {
  const secureContext = typeof window !== "undefined" && Boolean(window.isSecureContext);
  const credentialCtor = getWebAuthnCtor();
  const webauthn =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(credentialCtor) &&
    Boolean(navigator.credentials);
  const webCrypto = Boolean(globalThis.crypto?.subtle);
  const localStorage = hasLocalStorageSafe();

  let platformAuthenticator: WalletPasskeySupportState = "unknown";
  let conditionalMediation: WalletPasskeySupportState = "unknown";
  let prf: WalletPasskeySupportState = "unknown";

  if (webauthn && credentialCtor?.isUserVerifyingPlatformAuthenticatorAvailable) {
    try {
      platformAuthenticator = resolveSupportState(
        await credentialCtor.isUserVerifyingPlatformAuthenticatorAvailable(),
      );
    } catch {
      platformAuthenticator = "unknown";
    }
  }

  if (webauthn && credentialCtor?.isConditionalMediationAvailable) {
    try {
      conditionalMediation = resolveSupportState(
        await credentialCtor.isConditionalMediationAvailable(),
      );
    } catch {
      conditionalMediation = "unknown";
    }
  }

  if (webauthn && credentialCtor?.getClientCapabilities) {
    try {
      const capabilities = await credentialCtor.getClientCapabilities();
      prf = resolveSupportState(capabilities?.prf);
    } catch {
      prf = "unknown";
    }
  }

  const notes: string[] = [];
  if (!secureContext) {
    notes.push("Passkeys require HTTPS or http://localhost on the gateway host.");
  }
  if (!webauthn) {
    notes.push("This browser does not expose WebAuthn passkeys.");
  }
  if (!webCrypto) {
    notes.push("Web Crypto is required for encrypted browser-held device shares.");
  }
  if (!localStorage) {
    notes.push("Browser storage is unavailable, so device shares must stay manual on this client.");
  }
  if (prf === "unknown" && secureContext && webauthn && webCrypto && localStorage) {
    notes.push(
      "This browser cannot preflight PRF support. The first custody unlock with browser storage enabled will confirm whether this passkey can protect the stored device share.",
    );
  } else if (prf === "unsupported") {
    notes.push(
      "This browser or authenticator does not expose WebAuthn PRF, so encrypted browser storage is unavailable on this device.",
    );
  }

  let storageMode: WalletCustodyClientCompatibility["storageMode"] = "manual-share-only";
  if (secureContext && webauthn && webCrypto && localStorage) {
    if (prf === "supported") {
      storageMode = "encrypted-browser-storage";
    } else if (prf === "unknown") {
      storageMode = "encrypted-browser-storage-untested";
    }
  }

  const nativeHelperHealth = await probeWalletCustodyCompanionHealth();
  const nativeHelper: WalletCustodyNativeHelperSupport = nativeHelperHealth
    ? {
        status: "available",
        helper: nativeHelperHealth.helper,
        platform: nativeHelperHealth.platform,
        storageMode: nativeHelperHealth.storageMode,
        protocolVersion: nativeHelperHealth.protocolVersion,
        storedWalletCount: nativeHelperHealth.storedWalletCount,
        availableRoutes: nativeHelperHealth.availableRoutes,
        warning: nativeHelperHealth.warning?.trim() || undefined,
      }
    : { status: "unreachable" };

  if (nativeHelper.status === "available") {
    if (nativeHelper.platform === "mock") {
      notes.push(
        `Mock custody helper detected on this device (${nativeHelper.storageMode}, protocol v${nativeHelper.protocolVersion}). This is for development only and does not provide OS-secure storage.`,
      );
    } else if (walletCustodyCompanionSupportsSecureStorage(nativeHelper)) {
      notes.push(
        `Optional native helper detected on this device (${nativeHelper.storageMode}, protocol v${nativeHelper.protocolVersion}). Browser-held encrypted storage remains the primary path when PRF is supported.`,
      );
    } else {
      notes.push(
        `Optional native helper detected on this device, but secure storage is not available yet (${nativeHelper.storageMode}, protocol v${nativeHelper.protocolVersion}).`,
      );
    }
    if (nativeHelper.warning) {
      notes.push(nativeHelper.warning);
    }
  }

  return {
    secureContext,
    webauthn,
    webCrypto,
    localStorage,
    platformAuthenticator,
    conditionalMediation,
    prf,
    storageMode,
    nativeHelper,
    notes,
  };
}

function explainPasskeyFailure(error: unknown, action: "enrollment" | "approval"): Error {
  const message = error instanceof Error ? error.message : String(error);
  const origin = currentPasskeyOrigin();
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const hints: string[] = [];

  if (message.includes("Failed to fetch")) {
    hints.push(`Passkey ${action} failed during the browser WebAuthn ceremony.`);
    if (typeof window !== "undefined" && !window.isSecureContext) {
      hints.push("Use HTTPS or open the dashboard at http://localhost:18789 on the gateway host.");
    } else if (isLoopbackIpHost(hostname)) {
      hints.push(
        "If you opened the dashboard on 127.0.0.1, retry on http://localhost:18789 instead.",
      );
    } else if (origin.startsWith("http://")) {
      hints.push(
        "This browser may reject passkeys on plain HTTP. Use HTTPS or http://localhost:18789.",
      );
    }
    hints.push(`Current dashboard origin: ${origin || "unknown"}`);
    return new Error(hints.join(" "));
  }

  return error instanceof Error ? error : new Error(message);
}

export async function enrollWalletPasskey(label?: string, approvalToken?: string): Promise<void> {
  ensureWebAuthnAvailable();
  const begin = await beginWalletPasskeyRegistration({ label });

  const creationOptions: PublicKeyCredentialCreationOptions = {
    challenge: fromBase64Url(begin.options.challenge),
    rp: begin.options.rp,
    user: {
      id: fromBase64Url(begin.options.user.id),
      name: begin.options.user.name,
      displayName: begin.options.user.displayName,
    },
    pubKeyCredParams: begin.options.pubKeyCredParams,
    timeout: begin.options.timeoutMs,
    attestation: begin.options.attestation,
    authenticatorSelection: begin.options.authenticatorSelection,
    excludeCredentials: begin.options.excludeCredentialIds.map((id) => ({
      type: "public-key",
      id: fromBase64Url(id),
    })),
  };

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: creationOptions,
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw explainPasskeyFailure(error, "enrollment");
  }
  if (!credential) {
    throw new Error("Passkey enrollment was canceled.");
  }
  const response = credential.response as AuthenticatorAttestationResponse & {
    getPublicKey?: () => ArrayBuffer | null;
    getPublicKeyAlgorithm?: () => number;
    getAuthenticatorData?: () => ArrayBuffer;
    getTransports?: () => string[];
  };
  const publicKey = response.getPublicKey?.();
  const authenticatorData = response.getAuthenticatorData?.();
  if (!publicKey || !authenticatorData) {
    throw new Error("Browser does not expose required WebAuthn registration fields.");
  }

  await finishWalletPasskeyRegistration(
    {
      challengeId: begin.challengeId,
      credentialId: toBase64Url(credential.rawId),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      publicKeySpki: toBase64Url(publicKey),
      publicKeyAlgorithm: Number(response.getPublicKeyAlgorithm?.() ?? -7),
      transports: response.getTransports?.() ?? [],
    },
    approvalToken,
  );
}

export async function authorizeWalletActionWithPasskey(params: {
  operation: string;
  requestId?: string;
  storageBinding?: string;
  preferredCredentialId?: string;
}): Promise<{
  approvalToken: string;
  expiresAt: string;
  credentialId: string;
  storageKeyBase64?: string;
}> {
  ensureWebAuthnAvailable();
  const begin = await beginWalletPasskeyAssertion({
    operation: params.operation,
    requestId: params.requestId,
  });
  const preferredCredentialId = params.preferredCredentialId?.trim() || "";
  const allowCredentialIds =
    preferredCredentialId && begin.options.allowCredentialIds.includes(preferredCredentialId)
      ? [preferredCredentialId]
      : begin.options.allowCredentialIds;
  const requestOptions: PublicKeyCredentialRequestOptions = {
    challenge: fromBase64Url(begin.options.challenge),
    rpId: begin.options.rpId,
    timeout: begin.options.timeoutMs,
    userVerification: begin.options.userVerification,
    allowCredentials: allowCredentialIds.map((id) => ({
      type: "public-key",
      id: fromBase64Url(id),
    })),
  };
  const storageBinding = params.storageBinding?.trim() || "";
  const publicKeyRequest: PublicKeyCredentialRequestOptions = { ...requestOptions };
  if (storageBinding) {
    publicKeyRequest.extensions = {
      prf: {
        eval: {
          first: await sha256Bytes(storageBinding),
        },
      },
    };
  }
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: publicKeyRequest,
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw explainPasskeyFailure(error, "approval");
  }
  if (!credential) {
    throw new Error("Passkey verification was canceled.");
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  const finish = await finishWalletPasskeyAssertion({
    challengeId: begin.challengeId,
    credentialId: toBase64Url(credential.rawId),
    clientDataJSON: toBase64Url(response.clientDataJSON),
    authenticatorData: toBase64Url(response.authenticatorData),
    signature: toBase64Url(response.signature),
  });
  let storageKeyBase64: string | undefined;
  if (storageBinding) {
    const extensions = credential.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer | Uint8Array } };
    };
    const first = extensions.prf?.results?.first;
    const bytes =
      first instanceof Uint8Array
        ? first
        : first instanceof ArrayBuffer
          ? new Uint8Array(first)
          : null;
    if (!bytes || bytes.byteLength === 0) {
      throw new Error(
        "This passkey or browser does not support secure local custody storage. Use a passkey/device with WebAuthn PRF support or leave browser storage disabled.",
      );
    }
    storageKeyBase64 = toBase64Url(bytes);
  }
  return {
    approvalToken: finish.approvalToken,
    expiresAt: finish.expiresAt,
    credentialId: toBase64Url(credential.rawId),
    storageKeyBase64,
  };
}

function signerAssertionOptions(
  input: WalletSignerReviewAuthorizationBegin["options"],
): CredentialRequestOptions {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Signer returned invalid WebAuthn assertion options.");
  }
  const outer = input as Record<string, unknown>;
  const rawPublicKey = outer.publicKey;
  if (!rawPublicKey || typeof rawPublicKey !== "object" || Array.isArray(rawPublicKey)) {
    throw new Error("Signer WebAuthn assertion options omit publicKey.");
  }
  const value = rawPublicKey as Record<string, unknown>;
  if (typeof value.challenge !== "string" || !value.challenge.trim()) {
    throw new Error("Signer WebAuthn assertion challenge is invalid.");
  }
  const allowCredentials = Array.isArray(value.allowCredentials)
    ? value.allowCredentials.map((raw): PublicKeyCredentialDescriptor => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("Signer WebAuthn credential descriptor is invalid.");
        }
        const descriptor = raw as Record<string, unknown>;
        if (descriptor.type !== "public-key" || typeof descriptor.id !== "string") {
          throw new Error("Signer WebAuthn credential descriptor is invalid.");
        }
        const transports = Array.isArray(descriptor.transports)
          ? descriptor.transports.filter(
              (entry): entry is AuthenticatorTransport =>
                entry === "ble" ||
                entry === "hybrid" ||
                entry === "internal" ||
                entry === "nfc" ||
                entry === "smart-card" ||
                entry === "usb",
            )
          : undefined;
        return {
          type: "public-key",
          id: fromBase64Url(descriptor.id),
          ...(transports?.length ? { transports } : {}),
        };
      })
    : [];
  const userVerification =
    value.userVerification === "discouraged" ||
    value.userVerification === "preferred" ||
    value.userVerification === "required"
      ? value.userVerification
      : "required";
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: fromBase64Url(value.challenge),
    userVerification,
    ...(typeof value.rpId === "string" && value.rpId.trim() ? { rpId: value.rpId.trim() } : {}),
    ...(typeof value.timeout === "number" && Number.isFinite(value.timeout)
      ? { timeout: value.timeout }
      : {}),
    ...(allowCredentials.length ? { allowCredentials } : {}),
  };
  const mediation =
    outer.mediation === "conditional" ||
    outer.mediation === "optional" ||
    outer.mediation === "required" ||
    outer.mediation === "silent"
      ? outer.mediation
      : undefined;
  return { publicKey, ...(mediation ? { mediation } : {}) };
}

export async function authorizeSignerReviewWithPasskey(
  begin: WalletSignerReviewAuthorizationBegin,
): Promise<{ challengeId: string; credential: Record<string, unknown> }> {
  ensureWebAuthnAvailable();
  if (!begin.challengeId?.trim()) {
    throw new Error("Signer WebAuthn challenge identifier is missing.");
  }
  if (
    Date.parse(begin.expiresAt) <= Date.now() ||
    Date.parse(begin.binding.expiresAt) <= Date.now()
  ) {
    throw new Error("Signer WebAuthn review expired; prepare and review the transaction again.");
  }
  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get(
      signerAssertionOptions(begin.options),
    )) as PublicKeyCredential | null;
  } catch (error) {
    throw explainPasskeyFailure(error, "approval");
  }
  if (!credential) {
    throw new Error("Signer WebAuthn verification was canceled.");
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  const rawId = toBase64Url(credential.rawId);
  const userHandle = response.userHandle ? toBase64Url(response.userHandle) : undefined;
  return {
    challengeId: begin.challengeId,
    credential: {
      id: credential.id || rawId,
      rawId,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(response.clientDataJSON),
        authenticatorData: toBase64Url(response.authenticatorData),
        signature: toBase64Url(response.signature),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: credential.getClientExtensionResults(),
      ...(credential.authenticatorAttachment
        ? { authenticatorAttachment: credential.authenticatorAttachment }
        : {}),
    },
  };
}
