export const WALLET_CUSTODY_COMPANION_PROTOCOL_VERSION = 1;
export const WALLET_CUSTODY_COMPANION_PORT = 18795;
export const WALLET_CUSTODY_COMPANION_BASE_URL = `http://127.0.0.1:${WALLET_CUSTODY_COMPANION_PORT}`;
export const WALLET_CUSTODY_COMPANION_HEALTH_PATH = "/v1/custody/health";
export const WALLET_CUSTODY_COMPANION_DEVICE_SHARE_STATUS_PATH = "/v1/custody/device-share/status";
export const WALLET_CUSTODY_COMPANION_DEVICE_SHARE_STORE_PATH = "/v1/custody/device-share/store";
export const WALLET_CUSTODY_COMPANION_DEVICE_SHARE_LOAD_PATH = "/v1/custody/device-share/load";
export const WALLET_CUSTODY_COMPANION_DEVICE_SHARE_DELETE_PATH = "/v1/custody/device-share/delete";

export type WalletCustodyCompanionHealthResponse = {
  ok: true;
  protocolVersion: number;
  helper: string;
  platform: "macos" | "linux" | "windows" | "mock";
  storageMode: "os-keychain" | "secret-service" | "windows-dpapi" | "mock-memory" | "unavailable";
  availableRoutes: string[];
  storedWalletCount: number;
  warning?: string;
};

export type WalletCustodyCompanionDeviceShareStatusResponse = {
  ok: true;
  stored: boolean;
};

export type WalletCustodyCompanionDeviceShareStoreResponse = {
  ok: true;
  stored: boolean;
  storageMode: "os-keychain" | "secret-service" | "windows-dpapi" | "mock-memory" | "unavailable";
};

export type WalletCustodyCompanionDeviceShareLoadResponse = {
  ok: true;
  deviceShare: string;
};

export type WalletCustodyCompanionDeviceShareDeleteResponse = {
  ok: true;
  removed: boolean;
};

function isHealthResponse(value: unknown): value is WalletCustodyCompanionHealthResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<WalletCustodyCompanionHealthResponse>;
  return (
    candidate.ok === true &&
    typeof candidate.protocolVersion === "number" &&
    typeof candidate.helper === "string" &&
    (candidate.platform === "macos" ||
      candidate.platform === "linux" ||
      candidate.platform === "windows" ||
      candidate.platform === "mock") &&
    (candidate.storageMode === "os-keychain" ||
      candidate.storageMode === "secret-service" ||
      candidate.storageMode === "windows-dpapi" ||
      candidate.storageMode === "mock-memory" ||
      candidate.storageMode === "unavailable") &&
    Array.isArray(candidate.availableRoutes) &&
    candidate.availableRoutes.every((route) => typeof route === "string") &&
    typeof candidate.storedWalletCount === "number"
  );
}

export function walletCustodyCompanionSupportsSecureStorage(
  health:
    | Pick<WalletCustodyCompanionHealthResponse, "storageMode" | "availableRoutes">
    | null
    | undefined,
): boolean {
  if (!health || health.storageMode === "unavailable") {
    return false;
  }
  const requiredRoutes = [
    WALLET_CUSTODY_COMPANION_DEVICE_SHARE_STATUS_PATH,
    WALLET_CUSTODY_COMPANION_DEVICE_SHARE_STORE_PATH,
    WALLET_CUSTODY_COMPANION_DEVICE_SHARE_LOAD_PATH,
    WALLET_CUSTODY_COMPANION_DEVICE_SHARE_DELETE_PATH,
  ];
  return requiredRoutes.every((route) => health.availableRoutes.includes(route));
}

function resolveWalletCustodyCompanionBaseUrl(): string {
  const overrideValue =
    typeof globalThis === "object" &&
    globalThis &&
    "__FASED_WALLET_CUSTODY_COMPANION_BASE_URL__" in globalThis
      ? (
          globalThis as typeof globalThis & {
            __FASED_WALLET_CUSTODY_COMPANION_BASE_URL__?: unknown;
          }
        ).__FASED_WALLET_CUSTODY_COMPANION_BASE_URL__
      : "";
  const override = typeof overrideValue === "string" ? overrideValue.trim() : "";
  return override || WALLET_CUSTODY_COMPANION_BASE_URL;
}

export async function probeWalletCustodyCompanionHealth(
  timeoutMs = 350,
): Promise<WalletCustodyCompanionHealthResponse | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer =
    controller != null
      ? globalThis.setTimeout(() => controller.abort(), Math.max(100, timeoutMs))
      : null;
  try {
    const response = await fetch(
      `${resolveWalletCustodyCompanionBaseUrl()}${WALLET_CUSTODY_COMPANION_HEALTH_PATH}`,
      {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        signal: controller?.signal,
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as unknown;
    if (!isHealthResponse(payload)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  } finally {
    if (timer != null) {
      globalThis.clearTimeout(timer);
    }
  }
}

type WalletCustodyCompanionRequestOptions = {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

async function requestWalletCustodyCompanion<T>(
  options: WalletCustodyCompanionRequestOptions,
): Promise<T | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer =
    controller != null
      ? globalThis.setTimeout(() => controller.abort(), Math.max(100, options.timeoutMs ?? 350))
      : null;
  try {
    const baseUrl = resolveWalletCustodyCompanionBaseUrl();
    const url = new URL(`${baseUrl}${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value.trim()) {
        url.searchParams.set(key, value.trim());
      }
    }
    const response = await fetch(url.toString(), {
      method: options.method ?? "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller?.signal,
      headers: {
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    if (timer != null) {
      globalThis.clearTimeout(timer);
    }
  }
}

export async function getWalletCustodyCompanionDeviceShareStatus(
  gatewayOrigin: string | undefined,
  walletId: string | undefined,
): Promise<boolean> {
  const normalizedWalletId = walletId?.trim() || "";
  if (!normalizedWalletId) {
    return false;
  }
  const response =
    await requestWalletCustodyCompanion<WalletCustodyCompanionDeviceShareStatusResponse>({
      method: "GET",
      path: WALLET_CUSTODY_COMPANION_DEVICE_SHARE_STATUS_PATH,
      query: {
        gatewayOrigin: gatewayOrigin?.trim() || globalThis.location?.origin || "",
        walletId: normalizedWalletId,
      },
    });
  return response?.ok === true && response.stored;
}

export async function saveWalletCustodyCompanionDeviceShare(params: {
  gatewayOrigin: string | undefined;
  walletId: string | undefined;
  deviceShare: string | undefined;
  credentialId?: string;
  deviceLabel?: string;
}): Promise<boolean> {
  const normalizedWalletId = params.walletId?.trim() || "";
  const normalizedDeviceShare = params.deviceShare?.trim() || "";
  if (!normalizedWalletId || !normalizedDeviceShare) {
    return false;
  }
  const response =
    await requestWalletCustodyCompanion<WalletCustodyCompanionDeviceShareStoreResponse>({
      method: "POST",
      path: WALLET_CUSTODY_COMPANION_DEVICE_SHARE_STORE_PATH,
      body: {
        gatewayOrigin: params.gatewayOrigin?.trim() || globalThis.location?.origin || "",
        walletId: normalizedWalletId,
        deviceShare: normalizedDeviceShare,
        credentialId: params.credentialId?.trim() || undefined,
        deviceLabel: params.deviceLabel?.trim() || undefined,
      },
      timeoutMs: 10_000,
    });
  return response?.ok === true && response.stored;
}

export async function loadWalletCustodyCompanionDeviceShare(params: {
  gatewayOrigin: string | undefined;
  walletId: string | undefined;
  prompt?: string;
}): Promise<string> {
  const normalizedWalletId = params.walletId?.trim() || "";
  if (!normalizedWalletId) {
    return "";
  }
  const response =
    await requestWalletCustodyCompanion<WalletCustodyCompanionDeviceShareLoadResponse>({
      method: "POST",
      path: WALLET_CUSTODY_COMPANION_DEVICE_SHARE_LOAD_PATH,
      body: {
        gatewayOrigin: params.gatewayOrigin?.trim() || globalThis.location?.origin || "",
        walletId: normalizedWalletId,
        prompt:
          params.prompt?.trim() ||
          `Unlock the stored device share for wallet ${normalizedWalletId}.`,
      },
      timeoutMs: 30_000,
    });
  return response?.ok === true ? response.deviceShare.trim() : "";
}

export async function deleteWalletCustodyCompanionDeviceShare(
  gatewayOrigin: string | undefined,
  walletId: string | undefined,
): Promise<boolean> {
  const normalizedWalletId = walletId?.trim() || "";
  if (!normalizedWalletId) {
    return false;
  }
  const response =
    await requestWalletCustodyCompanion<WalletCustodyCompanionDeviceShareDeleteResponse>({
      method: "POST",
      path: WALLET_CUSTODY_COMPANION_DEVICE_SHARE_DELETE_PATH,
      body: {
        gatewayOrigin: gatewayOrigin?.trim() || globalThis.location?.origin || "",
        walletId: normalizedWalletId,
      },
      timeoutMs: 10_000,
    });
  return response?.ok === true;
}
