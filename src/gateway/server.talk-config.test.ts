import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SecretRef } from "../config/types.secrets.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import {
  connectOk,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
} from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewaySocket = Parameters<Parameters<typeof withServer>[0]>[0];
const TALK_CONFIG_DEVICE_PATH = path.join(
  os.tmpdir(),
  `fased-talk-config-device-${process.pid}.json`,
);
const TALK_CONFIG_DEVICE = loadOrCreateDeviceIdentity(TALK_CONFIG_DEVICE_PATH);

async function createFreshOperatorDevice(scopes: string[], nonce: string) {
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: TALK_CONFIG_DEVICE.deviceId,
    clientId: "test",
    clientMode: "test",
    role: "operator",
    scopes,
    signedAtMs,
    token: "secret",
    nonce,
  });

  return {
    id: TALK_CONFIG_DEVICE.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(TALK_CONFIG_DEVICE.publicKeyPem),
    signature: signDevicePayload(TALK_CONFIG_DEVICE.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };
}

async function connectOperator(ws: GatewaySocket, scopes: string[]) {
  const nonce = await readConnectChallengeNonce(ws);
  expect(nonce).toBeTruthy();
  await connectOk(ws, {
    token: "secret",
    scopes,
    device: await createFreshOperatorDevice(scopes, String(nonce)),
  });
}

async function writeTalkConfig(config: { apiKey?: string | SecretRef; voiceId?: string }) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({ talk: config });
}

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        voiceId: "voice-123",
        apiKey: "secret-key-abc",
      },
      session: {
        mainKey: "main-test",
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await rpcReq<{
        config?: {
          talk?: {
            provider?: string;
            providers?: {
              elevenlabs?: { voiceId?: string; apiKey?: string };
            };
            apiKey?: string;
            voiceId?: string;
          };
        };
      }>(ws, "talk.config", {});
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.provider).toBe("elevenlabs");
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.voiceId).toBe("voice-123");
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.apiKey).toBe("__FASED_REDACTED__");
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-123");
      expect(res.payload?.config?.talk?.apiKey).toBe("__FASED_REDACTED__");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await rpcReq(ws, "talk.config", { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it("returns secrets for operator.talk.secrets scope", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read", "operator.write", "operator.talk.secrets"]);
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string } } }>(ws, "talk.config", {
        includeSecrets: true,
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.apiKey).toBe("secret-key-abc");
    });
  });

  it("redacts SecretRef talk api keys without dropping provider context", async () => {
    const secretRef: SecretRef = {
      source: "env",
      provider: "default",
      id: "ELEVENLABS_API_KEY",
    };
    await writeTalkConfig({ apiKey: secretRef, voiceId: "voice-secretref" });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await rpcReq<{
        config?: {
          talk?: {
            provider?: string;
            providers?: {
              elevenlabs?: { voiceId?: string; apiKey?: SecretRef };
            };
            apiKey?: SecretRef;
            voiceId?: string;
          };
        };
      }>(ws, "talk.config", {});
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.provider).toBe("elevenlabs");
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-secretref");
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.voiceId).toBe("voice-secretref");
      expect(res.payload?.config?.talk?.apiKey).toEqual({
        source: "__FASED_REDACTED__",
        provider: "__FASED_REDACTED__",
        id: "__FASED_REDACTED__",
      });
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.apiKey).toEqual({
        source: "__FASED_REDACTED__",
        provider: "__FASED_REDACTED__",
        id: "__FASED_REDACTED__",
      });
    });
  });

  it("prefers normalized provider payload over conflicting legacy talk keys", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            voiceId: "voice-normalized",
          },
        },
        voiceId: "voice-legacy",
      },
    });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await rpcReq<{
        config?: {
          talk?: {
            provider?: string;
            providers?: {
              elevenlabs?: { voiceId?: string };
            };
            voiceId?: string;
          };
        };
      }>(ws, "talk.config", {});
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.provider).toBe("elevenlabs");
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.voiceId).toBe("voice-normalized");
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-normalized");
    });
  });
});
