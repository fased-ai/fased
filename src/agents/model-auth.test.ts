import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  requireApiKey,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
  resolveModelAuthMode,
} from "./model-auth.js";

describe("resolveAwsSdkEnvVarName", () => {
  it("prefers bearer token over access keys and profile", () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("uses access keys when bearer token is missing", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_ACCESS_KEY_ID");
  });

  it("uses profile when no bearer token or access keys exist", () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_PROFILE");
  });

  it("returns undefined when no AWS auth env is set", () => {
    expect(resolveAwsSdkEnvVarName({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolveModelAuthMode", () => {
  it("returns mixed when provider has both token and api key profiles", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "token-value",
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "api-key",
        },
      },
    };

    expect(resolveModelAuthMode("openai", undefined, store)).toBe("mixed");
  });

  it("returns aws-sdk when provider auth is overridden", () => {
    expect(
      resolveModelAuthMode(
        "amazon-bedrock",
        {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [],
                auth: "aws-sdk",
              },
            },
          },
        },
        { version: 1, profiles: {} },
      ),
    ).toBe("aws-sdk");
  });

  it("returns aws-sdk for bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });

  it("returns aws-sdk for aws-bedrock alias without explicit auth override", () => {
    expect(resolveModelAuthMode("aws-bedrock", undefined, { version: 1, profiles: {} })).toBe(
      "aws-sdk",
    );
  });
});

describe("requireApiKey", () => {
  it("normalizes line breaks in resolved API keys", () => {
    const key = requireApiKey(
      {
        apiKey: "\n sk-test-abc\r\n",
        source: "env: OPENAI_API_KEY",
        mode: "api-key",
      },
      "openai",
    );

    expect(key).toBe("sk-test-abc");
  });

  it("throws when no API key is present", () => {
    expect(() =>
      requireApiKey(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      ),
    ).toThrow('No API key resolved for provider "openai"');
  });
});

describe("resolveEnvApiKey provider catalog parity", () => {
  it("resolves API-key env vars for bundled providers surfaced in onboarding", async () => {
    await withEnvAsync(
      {
        ARCEEAI_API_KEY: "arcee-key",
        DEEPSEEK_API_KEY: "deepseek-key",
        FIREWORKS_API_KEY: "fireworks-key",
        STEPFUN_API_KEY: "stepfun-key",
        TENCENT_TOKENHUB_API_KEY: "tencent-key",
        VOLCANO_ENGINE_API_KEY: "volc-key",
        BYTEPLUS_API_KEY: "byteplus-key",
        KIMI_API_KEY: "kimi-key",
      },
      async () => {
        expect(resolveEnvApiKey("arcee")?.apiKey).toBe("arcee-key");
        expect(resolveEnvApiKey("deepseek")?.apiKey).toBe("deepseek-key");
        expect(resolveEnvApiKey("fireworks")?.apiKey).toBe("fireworks-key");
        expect(resolveEnvApiKey("stepfun-plan")?.apiKey).toBe("stepfun-key");
        expect(resolveEnvApiKey("tencent-tokenhub")?.apiKey).toBe("tencent-key");
        expect(resolveEnvApiKey("volcengine-coding")?.apiKey).toBe("volc-key");
        expect(resolveEnvApiKey("volcengine-plan")?.apiKey).toBe("volc-key");
        expect(resolveEnvApiKey("byteplus-coding")?.apiKey).toBe("byteplus-key");
        expect(resolveEnvApiKey("byteplus-plan")?.apiKey).toBe("byteplus-key");
        expect(resolveEnvApiKey("kimi-coding")?.apiKey).toBe("kimi-key");
      },
    );
  });

  it("keeps compatibility aliases for Arcee and Tencent TokenHub env vars", async () => {
    await withEnvAsync(
      {
        ARCEEAI_API_KEY: undefined,
        ARCEE_API_KEY: "arcee-alias-key",
        TENCENT_TOKENHUB_API_KEY: undefined,
        TENCENT_API_KEY: "tencent-alias-key",
      },
      async () => {
        expect(resolveEnvApiKey("arcee")?.apiKey).toBe("arcee-alias-key");
        expect(resolveEnvApiKey("tencent-tokenhub")?.apiKey).toBe("tencent-alias-key");
      },
    );
  });
});
