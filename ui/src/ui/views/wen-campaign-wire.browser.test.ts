import { expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import "./wen-campaign.js";
import type { WenCampaignPanel } from "./wen-campaign.js";
declare module "vitest/browser" {
  interface BrowserCommands {
    campaignWireStart(origin: string): Promise<string>;
    campaignWireStop(): Promise<string[]>;
  }
}
it("joins mounted browser, HTTP gateway handlers and private Unix transport", async () => {
  const url = await commands.campaignWireStart(window.location.origin);
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
  panel.connected = true;
  document.body.append(panel);
  let events: string[] = [];
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
    expect(panel.textContent).toContain("finalized-success");
    expect(panel.pending).toBeNull();
  } finally {
    panel.remove();
    vi.restoreAllMocks();
    sessionStorage.clear();
    events = await commands.campaignWireStop();
  }
  expect(events.filter((e) => e.endsWith(":execute"))).toHaveLength(1);
  expect(events.filter((e) => e.endsWith(":recover"))).toHaveLength(1);
  expect(events).toContain("v2.review.authorization.finish:");
  expect(events).toContain("cryptographic-assertion-verified");
});
