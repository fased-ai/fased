import type { FasedAgentConfig } from "fased/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

import { looksLikeFeishuCredentialPair, resolveFeishuAccount } from "./accounts.js";
import { feishuPlugin } from "./channel.js";

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main_1234567890",
              enabled: true,
            },
          },
        },
      },
    } as FasedAgentConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_main" });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      timeoutMs: 1_000,
      cfg,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main_1234567890",
      }),
    );
    expect(result).toMatchObject({ ok: true, appId: "cli_main" });
  });
});

describe("Feishu credential readiness", () => {
  it("does not treat short dummy credentials as configured", () => {
    expect(looksLikeFeishuCredentialPair({ appId: "vdfgdfg", appSecret: "fdgfd" })).toBe(false);

    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "vdfgdfg",
          appSecret: "fdgfd",
        },
      },
    } as FasedAgentConfig;

    const account = resolveFeishuAccount({ cfg });
    expect(account.enabled).toBe(true);
    expect(account.configured).toBe(false);
  });
});
