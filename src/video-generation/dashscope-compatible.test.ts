import { describe, expect, it, vi } from "vitest";
import { downloadDashscopeGeneratedVideos } from "./dashscope-compatible.js";

describe("downloadDashscopeGeneratedVideos", () => {
  it("redacts sensitive source URL metadata", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(Buffer.from("mp4"), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    }) as unknown as typeof fetch;

    const videos = await downloadDashscopeGeneratedVideos({
      providerLabel: "Provider",
      urls: ["https://cdn.example/video.mp4?token=secret&ok=1"],
      fetchFn,
      timeoutMs: 1000,
    });

    expect(videos).toHaveLength(1);
    expect(videos[0]?.metadata?.sourceUrl).toBe("https://cdn.example/video.mp4?token=***&ok=1");
  });
});
