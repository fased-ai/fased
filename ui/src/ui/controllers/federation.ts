import type { FasedAgentApp } from "../app.js";
import { createFederationApi, type FederationStatus } from "../federation-api.js";
type FederationApi = ReturnType<typeof createFederationApi>;
let cachedApi: FederationApi | null = null;
function describeFederationError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getApi(): FederationApi {
  if (!cachedApi) {
    cachedApi = createFederationApi();
  }
  return cachedApi;
}

function resolveFederationHandle(host: FasedAgentApp): string | undefined {
  const handle =
    host.federationStatus?.token?.handle?.trim() ??
    host.federationStatus?.configured?.handle?.trim() ??
    host.federationToken?.handle?.trim() ??
    "";
  return handle || undefined;
}

function syncConfiguredFederationIdentity(host: FasedAgentApp, status: FederationStatus) {
  if (status.token) {
    host.federationToken = status.token;
    host.federationHandle = status.token.handle;
  } else if (!status.joined) {
    host.federationToken = null;
    const configuredHandle = status.configured?.handle?.trim() ?? "";
    if (configuredHandle && !String(host.federationHandle ?? "").trim()) {
      host.federationHandle = configuredHandle;
    }
  }

  const configuredNodeEndpoint = status.configured?.nodeEndpoint?.trim() ?? "";
  if (configuredNodeEndpoint && !String(host.federationNodeEndpoint ?? "").trim()) {
    host.federationNodeEndpoint = configuredNodeEndpoint;
  }
}

function isFederationUnauthorizedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unauthorized/i.test(message);
}

export async function registerFederationHandle(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const requestedHandle =
      String(host.federationHandle ?? "").trim() || resolveFederationHandle(host) || "";
    const nodeEndpoint =
      String(host.federationNodeEndpoint ?? "").trim() ||
      host.federationStatus?.configured?.nodeEndpoint?.trim() ||
      "";
    let handle = requestedHandle;
    try {
      const registered = await getApi().registerHandle({ requestedHandle, nodeEndpoint });
      const registrationStatus = (registered as { status?: string }).status;
      if (registrationStatus === "rejected") {
        host.federationError = registered.reason ?? "Handle rejected";
        return;
      }
      if (registrationStatus === "unauthorized" && !handle) {
        host.federationError = "Fased Network registry registration requires authentication.";
        return;
      }
      handle = registered.handle?.trim() || handle;
    } catch (err) {
      if (!isFederationUnauthorizedError(err) || !handle) {
        throw err;
      }
    }
    if (!handle) {
      host.federationError = "Federation registry did not return a handle.";
      return;
    }
    host.federationHandle = handle;

    const challenge = await getApi().enrollChallenge({ handle, nodeEndpoint });
    if (challenge.status === "rejected") {
      host.federationError = challenge.reason ?? "Federation challenge rejected";
      return;
    }
    const challengeId = challenge.challengeId?.trim() ?? "";
    const nonce = challenge.nonce?.trim() ?? "";
    if (!challengeId || !nonce) {
      host.federationError = "Federation challenge did not return a complete enrollment payload.";
      return;
    }
    const enrolled = await getApi().enroll({ challengeId, nonce, handle });
    if (enrolled.status === "rejected") {
      host.federationError = enrolled.reason ?? "Federation enrollment rejected";
      return;
    }
    host.federationToken = enrolled.token ?? null;
    host.federationMessage = enrolled.token
      ? `Joined Fased Network as ${enrolled.token.handle}.`
      : "Fased Network enrollment accepted.";
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function attestFederation(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const handle = String(host.federationHandle ?? "").trim();
    const res = await getApi().attest({ handle });
    if (res.status === "rejected") {
      host.federationError = res.reason ?? "Attestation rejected";
      return;
    }
    host.federationToken = res.token ?? null;
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function renewFederationToken(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const handle = String(host.federationHandle ?? "").trim();
    const res = await getApi().renew({ handle });
    if (res.status === "rejected") {
      host.federationError = res.reason ?? "Token renewal rejected";
      return;
    }
    host.federationToken = res.token ?? null;
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function revokeFederationToken(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const tokenId = host.federationToken?.tokenId;
    const handle = String(host.federationHandle ?? "").trim();
    if (!tokenId && !handle) {
      host.federationError = "Missing token or handle";
      return;
    }
    const res = await getApi().revoke({
      tokenId: tokenId ?? undefined,
      handle: handle || undefined,
    });
    if (res.status === "rejected") {
      host.federationError = res.reason ?? "Token revoke rejected";
      return;
    }
    host.federationToken = null;
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function loadFederation(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  try {
    const result = await getApi().getStatus();
    host.federationStatus = result.status;
    syncConfiguredFederationIdentity(host, result.status);
    host.federationDirectory = await getApi().listDirectory();
  } catch (error) {
    host.federationError = describeFederationError(error);
  } finally {
    host.federationLoading = false;
  }
}
export async function refreshFederationStatus(
  host: FasedAgentApp,
  options: { quiet?: boolean } = {},
) {
  if (host.federationLoading) {
    return;
  }
  try {
    const result = await getApi().getStatus();
    host.federationStatus = result.status;
    syncConfiguredFederationIdentity(host, result.status);
  } catch (error) {
    if (!options.quiet) {
      host.federationError = describeFederationError(error);
    }
  }
}
