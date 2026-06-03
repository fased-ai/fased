import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

function normalizeVertexBaseUrl(baseUrl: string | undefined, region: string): string | undefined {
  const raw = baseUrl?.trim();
  if (raw) {
    const trimmed = raw.replace(/\/+$/, "");
    return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  }
  if (!region || region === "global") {
    return undefined;
  }
  return `https://${region}-aiplatform.googleapis.com/v1`;
}

function withVertexDefaults(
  streamFn: StreamFn,
  opts: { projectId?: string; region?: string; baseUrl?: string },
): StreamFn {
  return (model, context, options) => {
    const vertexModel = {
      ...model,
      provider: model.provider || "anthropic-vertex",
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    };
    return streamFn(vertexModel as Parameters<StreamFn>[0], context, options);
  };
}

export function createAnthropicVertexStreamFn(
  projectId?: string,
  region = "global",
  baseUrl?: string,
): StreamFn {
  return withVertexDefaults(createAnthropicMessagesTransportStreamFn(), {
    projectId,
    region,
    baseUrl: normalizeVertexBaseUrl(baseUrl, region),
  });
}

export function createAnthropicVertexStreamFnForModel(
  model: Partial<Pick<Model<Api>, "baseUrl">> = {},
  env: { GOOGLE_CLOUD_PROJECT_ID?: string } = process.env,
): StreamFn {
  const baseUrl = normalizeVertexBaseUrl(
    typeof model.baseUrl === "string" ? model.baseUrl : undefined,
    "global",
  );
  return createAnthropicVertexStreamFn(env.GOOGLE_CLOUD_PROJECT_ID, "global", baseUrl);
}
