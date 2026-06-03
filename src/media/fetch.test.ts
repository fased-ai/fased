import { describe, expect, it, vi } from "vitest";
import { fetchRemoteMedia } from "./fetch.js";

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("fetchRemoteMedia", () => {
  type LookupFn = NonNullable<Parameters<typeof fetchRemoteMedia>[0]["lookupFn"]>;

  it("rejects when content-length exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3, 4, 5])]), {
        status: 200,
        headers: { "content-length": "5" },
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("redacts sensitive URL parts in fetch errors", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () => {
      throw new Error("upstream denied https://cdn.example.com/private.jpg?token=secret#frag");
    };

    await expect(
      fetchRemoteMedia({
        url: "https://user:pass@cdn.example.com/private.jpg?token=secret#frag",
        fetchImpl,
        maxBytes: 1024,
        lookupFn,
      }),
    ).rejects.toThrow(
      "Failed to fetch media from https://cdn.example.com/private.jpg?redacted#redacted",
    );
    await expect(
      fetchRemoteMedia({
        url: "https://user:pass@cdn.example.com/private.jpg?token=secret#frag",
        fetchImpl,
        maxBytes: 1024,
        lookupFn,
      }),
    ).rejects.not.toThrow(/secret|user:pass|#frag/);
  });

  it("redacts Telegram bot tokens embedded in media download paths", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "149.154.167.220", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () => {
      throw new Error(
        "upstream denied https://api.telegram.org/file/bot123456:ABC_secret/photos/file.jpg",
      );
    };

    await expect(
      fetchRemoteMedia({
        url: "https://api.telegram.org/file/bot123456:ABC_secret/photos/file.jpg",
        fetchImpl,
        maxBytes: 1024,
        lookupFn,
      }),
    ).rejects.toThrow("https://api.telegram.org/file/bot***/photos/file.jpg");
    await expect(
      fetchRemoteMedia({
        url: "https://api.telegram.org/file/bot123456:ABC_secret/photos/file.jpg",
        fetchImpl,
        maxBytes: 1024,
        lookupFn,
      }),
    ).rejects.not.toThrow("123456:ABC_secret");
  });

  it("redacts redirected URL details in HTTP errors", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response("missing", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/start.jpg?download=secret",
        fetchImpl,
        maxBytes: 1024,
        lookupFn,
      }),
    ).rejects.toThrow("https://example.com/start.jpg?redacted");
    await expect(
      fetchRemoteMedia({
        url: "https://example.com/start.jpg?download=secret",
        fetchImpl,
        maxBytes: 1024,
        lookupFn,
      }),
    ).rejects.not.toThrow("download=secret");
  });

  it("rejects when streamed payload exceeds maxBytes", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as unknown as LookupFn;
    const fetchImpl = async () =>
      new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]), {
        status: 200,
      });

    await expect(
      fetchRemoteMedia({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn,
      }),
    ).rejects.toThrow("exceeds maxBytes");
  });

  it("blocks private IP literals before fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchRemoteMedia({
        url: "http://127.0.0.1/secret.jpg",
        fetchImpl,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
