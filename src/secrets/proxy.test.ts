import { afterEach, describe, expect, it, vi } from "vitest";
import { runSecretProxyCall } from "./proxy.js";

describe("runSecretProxyCall", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a SecretRef for a bounded callback without returning the secret", async () => {
    vi.stubEnv("FASED_PROXY_TEST_SECRET", "proxy-secret-value");

    const result = await runSecretProxyCall({
      config: {},
      ref: { source: "env", provider: "default", id: "FASED_PROXY_TEST_SECRET" },
      purpose: "provider.test",
      consumer: "unit-test",
      env: process.env,
      execute: ({ secret }) => ({ status: secret === "proxy-secret-value" ? "ok" : "bad" }),
    });

    expect(result).toMatchObject({
      ok: true,
      value: { status: "ok" },
      audit: {
        refKey: "env:default:FASED_PROXY_TEST_SECRET",
        purpose: "provider.test",
        consumer: "unit-test",
      },
    });
  });

  it("blocks callback results that echo the secret", async () => {
    vi.stubEnv("FASED_PROXY_TEST_SECRET", "proxy-secret-value");

    await expect(
      runSecretProxyCall({
        config: {},
        ref: { source: "env", provider: "default", id: "FASED_PROXY_TEST_SECRET" },
        purpose: "provider.test",
        consumer: "unit-test",
        env: process.env,
        execute: ({ secret }) => ({ leaked: secret }),
      }),
    ).rejects.toThrow(/Secret proxy blocked result leak/);
  });

  it("blocks callback results that echo the secret inside circular objects", async () => {
    vi.stubEnv("FASED_PROXY_TEST_SECRET", "proxy-secret-value");
    const circular: Record<string, unknown> = {
      nested: { value: "proxy-secret-value" },
    };
    circular.self = circular;

    await expect(
      runSecretProxyCall({
        config: {},
        ref: { source: "env", provider: "default", id: "FASED_PROXY_TEST_SECRET" },
        purpose: "provider.test",
        consumer: "unit-test",
        env: process.env,
        execute: () => circular,
      }),
    ).rejects.toThrow(/Secret proxy blocked result leak/);
  });
});
