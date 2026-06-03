import { describe, expect, it } from "vitest";
import { assertOkOrThrowHttpError, readErrorResponse } from "./shared.js";

describe("media-understanding provider shared errors", () => {
  it("redacts sensitive provider response text", async () => {
    const response = new Response(
      JSON.stringify({
        error: "failed",
        apiKey: "secret-api-key",
        url: "https://media.example/file?token=secret-token",
      }),
      { status: 500 },
    );

    const text = await readErrorResponse(response);

    expect(text).toContain("apiKey");
    expect(text).toContain("token=***");
    expect(text).not.toContain("secret-api-key");
    expect(text).not.toContain("secret-token");
  });

  it("throws redacted HTTP errors", async () => {
    const response = new Response("Authorization: Bearer provider-secret-token", { status: 401 });

    await expect(assertOkOrThrowHttpError(response, "Audio failed")).rejects.toThrow(
      /Audio failed \(HTTP 401\): Authorization: Bearer provid.+oken/,
    );
    await expect(
      assertOkOrThrowHttpError(
        new Response("Authorization: Bearer provider-secret-token", { status: 401 }),
        "Audio failed",
      ),
    ).rejects.not.toThrow("provider-secret-token");
  });
});
