import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { setRegistry } from "../server.agent.gateway-server-agent.mocks.js";
import { channelsHandlers } from "./channels.js";
import type { GatewayRequestContext } from "./types.js";

type RpcResponse = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

function createTestChannel(id: ChannelPlugin["id"]): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id,
      label: String(id),
    }),
    gateway: {
      startAccount: async () => {},
      stopAccount: async () => {},
    },
  };
}

async function callChannelControl(params: {
  method: "channels.start" | "channels.stop";
  rpcParams: Record<string, unknown>;
  startChannel?: GatewayRequestContext["startChannel"];
  stopChannel?: GatewayRequestContext["stopChannel"];
}): Promise<RpcResponse> {
  const responses: RpcResponse[] = [];
  const handler = channelsHandlers[params.method];
  await handler({
    req: {
      type: "req",
      id: "req-1",
      method: params.method,
      params: params.rpcParams,
    },
    params: params.rpcParams,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      responses.push({ ok, payload, error });
    },
    context: {
      startChannel: params.startChannel ?? vi.fn(async () => {}),
      stopChannel: params.stopChannel ?? vi.fn(async () => {}),
    } as unknown as GatewayRequestContext,
  });
  const response = responses.at(-1);
  if (!response) {
    throw new Error(`no response for ${params.method}`);
  }
  return response;
}

describe("channel runtime control handlers", () => {
  beforeEach(() => {
    setRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createTestChannel("telegram"),
        },
      ]),
    );
  });

  it("starts a channel account through the gateway runtime", async () => {
    const startChannel = vi.fn(async () => {});

    const response = await callChannelControl({
      method: "channels.start",
      rpcParams: { channel: "telegram", accountId: "default" },
      startChannel,
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({
      channel: "telegram",
      accountId: "default",
      action: "start",
    });
    expect(startChannel).toHaveBeenCalledWith("telegram", "default");
  });

  it("stops a channel through the gateway runtime", async () => {
    const stopChannel = vi.fn(async () => {});

    const response = await callChannelControl({
      method: "channels.stop",
      rpcParams: { channel: "telegram" },
      stopChannel,
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({
      channel: "telegram",
      accountId: null,
      action: "stop",
    });
    expect(stopChannel).toHaveBeenCalledWith("telegram", undefined);
  });

  it("rejects unknown channels before touching runtime controls", async () => {
    const startChannel = vi.fn(async () => {});

    const response = await callChannelControl({
      method: "channels.start",
      rpcParams: { channel: "missing" },
      startChannel,
    });

    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain("invalid channels.start channel");
    expect(startChannel).not.toHaveBeenCalled();
  });
});
