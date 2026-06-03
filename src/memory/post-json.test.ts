import { beforeEach, describe, expect, it, vi } from "vitest";
import { postJson } from "./post-json.js";
import { withRemoteHttpResponse } from "./remote-http.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

describe("postJson", () => {
  const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses JSON payload on successful response", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 }),
      );
    });

    const result = await postJson({
      url: "https://memory.example/v1/post",
      headers: { Authorization: "Bearer test" },
      body: { input: ["x"] },
      errorPrefix: "post failed",
      parse: (payload) => payload,
    });

    expect(result).toEqual({ data: [{ embedding: [1, 2] }] });
  });

  it("attaches status to thrown error when requested", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(new Response("bad gateway", { status: 502 }));
    });

    await expect(
      postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        attachStatus: true,
        parse: () => ({}),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("post failed: 502 bad gateway"),
      status: 502,
    });
  });

  it("redacts sensitive remote error response text", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        new Response(
          "Authorization: Bearer memory-secret-token https://memory.example/file?api_key=url-secret",
          { status: 401 },
        ),
      );
    });

    let error: unknown;
    try {
      await postJson({
        url: "https://memory.example/v1/post",
        headers: {},
        body: {},
        errorPrefix: "post failed",
        parse: () => ({}),
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/post failed: 401 authorization: Bearer memory.+oken/);
    expect(message).not.toMatch(/memory-secret-token|url-secret/);
  });
});
