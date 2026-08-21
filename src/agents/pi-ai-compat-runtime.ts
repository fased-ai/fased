import type { StreamFn } from "@mariozechner/pi-agent-core";
import { lazyStream } from "@mariozechner/pi-ai";
import type { Api } from "@mariozechner/pi-ai";

type Compat = typeof import("@mariozechner/pi-ai/compat");
type CompatProvider = NonNullable<ReturnType<Compat["getApiProvider"]>>;

let compatPromise: Promise<Compat> | undefined;
const pendingProviders = new Map<Api, { provider: CompatProvider; sourceId: string }>();
const registeredProviderApis = new Set<Api>();

async function loadCompat(): Promise<Compat> {
  const compat = await (compatPromise ??= import("@mariozechner/pi-ai/compat"));
  for (const [api, entry] of pendingProviders) {
    if (!compat.getApiProvider(api)) {
      compat.registerApiProvider(entry.provider, entry.sourceId);
    }
    pendingProviders.delete(api);
  }
  return compat;
}

export const streamSimple: Compat["streamSimple"] = (model, context, options) =>
  lazyStream(model, async () => (await loadCompat()).streamSimple(model, context, options));

export const complete: Compat["complete"] = async (model, context, options) =>
  (await loadCompat()).complete(model, context, options);

export async function getEnvApiKey(
  provider: Parameters<Compat["getEnvApiKey"]>[0],
  env?: Parameters<Compat["getEnvApiKey"]>[1],
): Promise<string | undefined> {
  return (await loadCompat()).getEnvApiKey(provider, env);
}

export function ensureLazyCompatApiRegistered(api: Api, streamFn: StreamFn): boolean {
  if (registeredProviderApis.has(api)) {
    return false;
  }
  const stream = ((model, context, options) =>
    streamFn(model, context, options)) as CompatProvider["stream"];
  pendingProviders.set(api, {
    provider: {
      api,
      stream,
      streamSimple: stream as CompatProvider["streamSimple"],
    },
    sourceId: `fased-custom-api:${api}`,
  });
  registeredProviderApis.add(api);
  return true;
}
