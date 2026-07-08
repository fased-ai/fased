import type { Api, Model } from "@mariozechner/pi-ai";
import { getApiProvider } from "@mariozechner/pi-ai/compat";
import type { FasedAgentConfig } from "../config/config.js";
import { createAnthropicVertexStreamFnForModel } from "./anthropic-vertex-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import {
  buildTransportAwareSimpleStreamFn,
  prepareTransportAwareSimpleModel,
} from "./provider-transport-stream.js";

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: FasedAgentConfig;
}): Model<Api> {
  const { model, cfg } = params;
  // Only provider-owned custom APIs need runtime stream registration here.
  if (
    model.api === "ollama" &&
    !getApiProvider(model.api) &&
    registerProviderStreamForModel({ model, cfg })
  ) {
    return model;
  }

  if (model.api === "anthropic-messages" && model.provider === "anthropic-vertex") {
    const streamFn = createAnthropicVertexStreamFnForModel(model);
    const alias = `fased-anthropic-vertex-simple:${encodeURIComponent(String(model.baseUrl ?? ""))}`;
    ensureCustomApiRegistered(alias, streamFn);
    return { ...model, api: alias };
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model);
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model);
    if (streamFn) {
      ensureCustomApiRegistered(transportAwareModel.api, streamFn);
      return transportAwareModel;
    }
  }

  return model;
}
