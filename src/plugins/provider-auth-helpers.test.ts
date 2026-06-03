import { describe, expect, it } from "vitest";
import { applyAuthProfileConfig, buildApiKeyCredential } from "./provider-auth-helpers.js";

describe("buildApiKeyCredential", () => {
  it("keeps plaintext keys as inline api_key credentials", () => {
    expect(buildApiKeyCredential("openai", "secret-key")).toEqual({
      type: "api_key",
      provider: "openai",
      key: "secret-key",
    });
  });

  it("turns env-template keys into env SecretRefs", () => {
    expect(buildApiKeyCredential("openai", "${OPENAI_API_KEY}")).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef: {
        source: "env",
        provider: "default",
        id: "OPENAI_API_KEY",
      },
    });
  });

  it("uses provider defaults when secret-input-mode is ref", () => {
    expect(
      buildApiKeyCredential("z-ai", "secret-key", undefined, { secretInputMode: "ref" }),
    ).toEqual({
      type: "api_key",
      provider: "z-ai",
      keyRef: {
        source: "env",
        provider: "default",
        id: "ZAI_API_KEY",
      },
    });
  });
});

describe("applyAuthProfileConfig", () => {
  it("normalizes provider aliases when updating auth.order", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "zai:legacy": { provider: "z.ai", mode: "api_key" },
          },
          order: {
            "z.ai": ["zai:legacy"],
          },
        },
      },
      {
        profileId: "zai:new",
        provider: "z-ai",
        mode: "oauth",
      },
    );

    expect(next.auth?.profiles?.["zai:new"]).toEqual({
      provider: "z-ai",
      mode: "oauth",
    });
    expect(next.auth?.order).toEqual({
      zai: ["zai:new", "zai:legacy"],
    });
  });
});
