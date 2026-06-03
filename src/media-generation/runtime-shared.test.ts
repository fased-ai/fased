import { describe, expect, it } from "vitest";
import { throwCapabilityGenerationFailure } from "./runtime-shared.js";

describe("throwCapabilityGenerationFailure", () => {
  it("redacts provider error details in single-attempt failures", () => {
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "image generation",
        attempts: [
          {
            provider: "example",
            model: "image",
            error:
              "Authorization: Bearer sk-secret-token failed at https://cdn.example/img?token=url-secret",
          },
        ],
        lastError: new Error("raw provider failure"),
      }),
    ).toThrow(
      /image generation model failed: authorization: Bearer \*\*\* failed at https:\/\/cdn\.example\/img\?token=\*\*\*/,
    );
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "image generation",
        attempts: [
          {
            provider: "example",
            model: "image",
            error:
              "Authorization: Bearer sk-secret-token failed at https://cdn.example/img?token=url-secret",
          },
        ],
        lastError: new Error("raw provider failure"),
      }),
    ).not.toThrow(/url-secret|sk-secret-token/);
  });

  it("redacts provider error details in multi-attempt summaries", () => {
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "video generation",
        attempts: [
          {
            provider: "a",
            model: "m1",
            error: "request failed https://example.com/video?signature=secret-signature",
          },
          {
            provider: "b",
            model: "m2",
            error: "x-api-key: secret-api-key",
          },
        ],
        lastError: new Error("raw provider failure"),
      }),
    ).toThrow(/All video generation models failed/);
    expect(() =>
      throwCapabilityGenerationFailure({
        capabilityLabel: "video generation",
        attempts: [
          {
            provider: "a",
            model: "m1",
            error: "request failed https://example.com/video?signature=secret-signature",
          },
          {
            provider: "b",
            model: "m2",
            error: "x-api-key: secret-api-key",
          },
        ],
        lastError: new Error("raw provider failure"),
      }),
    ).not.toThrow(/secret-signature|secret-api-key/);
  });
});
