import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api } from "@mariozechner/pi-ai";
import { ensureLazyCompatApiRegistered } from "./pi-ai-compat-runtime.js";

const CUSTOM_API_SOURCE_PREFIX = "fased-custom-api:";

export function getCustomApiRegistrySourceId(api: Api): string {
  return `${CUSTOM_API_SOURCE_PREFIX}${api}`;
}

export function ensureCustomApiRegistered(api: Api, streamFn: StreamFn): boolean {
  return ensureLazyCompatApiRegistered(api, streamFn);
}
