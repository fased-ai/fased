import { expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import "./wen-campaign.js";
import type { WenCampaignPanel } from "./wen-campaign.js";
declare module "vitest/browser" {
  interface BrowserCommands {
    campaignWireStart(origin: string, operation?: "bond-claim" | "bond-purchase"): Promise<string>;
    campaignWireStop(): Promise<string[]>;
  }
}
it("joins Bond claim browser, real passkey, gateway and private signer", async () => {
  const url = await commands.campaignWireStart(window.location.origin, "bond-claim");
  const panel = document.createElement("wen-campaign-panel") as WenCampaignPanel;
  panel.client = {
    async request<T>(method: string, params: unknown): Promise<T> {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ method, params }),
      });
      if (!response.ok) {
        throw Error("gateway unavailable");
      }
      return response.json();
    },
  };
  panel.domain = "bond-claim";
  panel.connected = true;
  document.body.append(panel);
  let events: string[] = [];
  let primaryError: unknown;
  let cleanupError: unknown;
  try {
    const begin = await panel.client.request<{
      challengeId: string;
      options: {
        publicKey: Omit<PublicKeyCredentialCreationOptions, "challenge" | "user"> & {
          challenge: string;
          user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
        };
      };
    }>("test.registration.begin", {
      label: "Chromium test credential",
    });
    const decode = (v: string) =>
      Uint8Array.from(atob(v.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const encode = (v: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(v)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    const options = begin.options.publicKey;
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: decode(options.challenge),
        user: { ...options.user, id: decode(options.user.id) },
        excludeCredentials: [],
      },
    })) as PublicKeyCredential;
    expect(credential).not.toBeNull();
    const response = credential.response as AuthenticatorAttestationResponse;
    await panel.client.request("test.registration.finish", {
      challengeId: begin.challengeId,
      credential: {
        id: credential.id,
        rawId: encode(credential.rawId),
        type: "public-key",
        response: {
          clientDataJSON: encode(response.clientDataJSON),
          attestationObject: encode(response.attestationObject),
          transports: response.getTransports(),
        },
        clientExtensionResults: credential.getClientExtensionResults(),
      },
    });
    await panel.updateComplete;
    await panel.loadConfigured();
    await panel.updateComplete;
    expect(panel.host).not.toBeNull();
    await panel.refresh();
    await panel.updateComplete;
    expect(panel.verified).not.toBeNull();
    await Promise.all([panel.approve(), panel.approve()]);
    await panel.updateComplete;
    expect(panel.pending).not.toBeNull();
    const client = panel.client;
    panel.remove();
    const reloaded = document.createElement("wen-campaign-panel") as WenCampaignPanel;
    reloaded.domain = "bond-claim";
    reloaded.client = client;
    reloaded.connected = true;
    document.body.append(reloaded);
    try {
      await reloaded.updateComplete;
      await reloaded.loadConfigured();
      await reloaded.updateComplete;
      await reloaded.refresh();
      await reloaded.updateComplete;
      expect(reloaded.pending).not.toBeNull();
      await reloaded.recover();
      await reloaded.updateComplete;
      expect(reloaded.textContent).toContain("finalized-success");
      expect(reloaded.pending).toBeNull();
    } finally {
      reloaded.remove();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    panel.remove();
    vi.restoreAllMocks();
    sessionStorage.clear();
    try {
      events = await commands.campaignWireStop();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  expect(events.filter((e) => e.endsWith(":execute"))).toHaveLength(1);
  expect(events.filter((e) => e.endsWith(":recover"))).toHaveLength(2);
  expect(events).toContain("v2.review.authorization.finish:");
  expect(events).toContain("cryptographic-assertion-verified");
});
