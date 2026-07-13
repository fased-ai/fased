import { listProfilesForProvider, resolveApiKeyForProfile } from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { buildCopilotIdeHeaders } from "../agents/copilot-dynamic-headers.js";
import type { FasedAgentConfig } from "../config/types.js";
import { resolveCopilotApiToken } from "./github-copilot-token.js";
import {
  parseGenericModelSnapshotsFromModelsResponse,
  type ProviderRefreshModelSnapshot,
} from "./refresh.js";

const GITHUB_COPILOT_ROUTE = "github-copilot";
const DISCOVERY_TIMEOUT_MS = 8_000;

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export async function discoverGitHubCopilotModels(params: {
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
  agentDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<ProviderRefreshModelSnapshot[]> {
  const profileId = listProfilesForProvider(params.store, GITHUB_COPILOT_ROUTE)[0];
  if (!profileId) {
    return [];
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.cfg,
    store: params.store,
    profileId,
    agentDir: params.agentDir,
  });
  if (!resolved?.apiKey) {
    return [];
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const copilot = await resolveCopilotApiToken({
    githubToken: resolved.apiKey,
    fetchImpl,
  });
  const response = await fetchImpl(modelsUrl(copilot.baseUrl), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${copilot.token}`,
      ...buildCopilotIdeHeaders({ includeApiVersion: true }),
    },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub Copilot model discovery failed (${response.status})`);
  }
  return parseGenericModelSnapshotsFromModelsResponse(await response.json()).map((model) => ({
    ...model,
    source: "github-copilot-account",
  }));
}
