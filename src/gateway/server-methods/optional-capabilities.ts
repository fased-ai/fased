import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

type OptionalCapability = {
  id: string;
  methods: readonly string[];
  load: () => Promise<GatewayRequestHandlers>;
};

export const OPTIONAL_GATEWAY_METHODS = {
  browser: ["browser.request"],
  channels: ["channels.logout", "channels.start", "channels.status", "channels.stop"],
  tts: [
    "tts.convert",
    "tts.disable",
    "tts.enable",
    "tts.personas",
    "tts.providers",
    "tts.setProvider",
    "tts.status",
  ],
  voicewake: ["voicewake.get", "voicewake.routing.get", "voicewake.routing.set", "voicewake.set"],
} as const;

const capabilities: OptionalCapability[] = [
  {
    id: "browser-media-voice",
    methods: OPTIONAL_GATEWAY_METHODS.browser,
    load: async () => (await import("./browser.js")).browserHandlers,
  },
  {
    id: "channels",
    methods: OPTIONAL_GATEWAY_METHODS.channels,
    load: async () => (await import("./channels.js")).channelsHandlers,
  },
  {
    id: "browser-media-voice",
    methods: OPTIONAL_GATEWAY_METHODS.tts,
    load: async () => (await import("./tts.js")).ttsHandlers,
  },
  {
    id: "browser-media-voice",
    methods: OPTIONAL_GATEWAY_METHODS.voicewake,
    load: async () => (await import("./voicewake.js")).voicewakeHandlers,
  },
];

function lazyHandler(capability: OptionalCapability, method: string): GatewayRequestHandler {
  return async (options) => {
    try {
      const handlers = await capability.load();
      const handler = handlers[method];
      if (!handler) {
        throw new Error(`optional capability does not implement ${method}`);
      }
      await handler(options);
    } catch (error) {
      options.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Optional component ${capability.id} is not installed or could not load: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  };
}

export const optionalGatewayHandlers: GatewayRequestHandlers = Object.fromEntries(
  capabilities.flatMap((capability) =>
    capability.methods.map((method) => [method, lazyHandler(capability, method)]),
  ),
);
