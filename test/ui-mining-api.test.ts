import { afterEach, describe, expect, it, vi } from "vitest";
import { getMiningHistory, postMiningSetActiveCommit } from "../ui/src/ui/mining-api.js";

describe("mining API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces JSON gateway messages for failed commit requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () =>
        JSON.stringify({
          ok: false,
          error: {
            code: "unavailable",
            message: "SAT signer unavailable on VPS",
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(postMiningSetActiveCommit({ lamports: "500000000" })).rejects.toThrow(
      "SAT signer unavailable on VPS",
    );
  });

  it("loads dedicated mining history windows from the new history endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          history: {
            window: "all",
            totalStoredOutcomeCount: 2,
            matchingOutcomeCount: 2,
            sampled: false,
            windowStartAt: null,
            dataStartAt: "2026-04-01T00:00:00.000Z",
            dataEndAt: "2026-04-04T00:00:00.000Z",
            outcomes: [],
            updatedAt: "2026-04-04T00:00:00.000Z",
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await getMiningHistory("all");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/mining/history?window=all",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.history?.window).toBe("all");
    expect(result.history?.totalStoredOutcomeCount).toBe(2);
  });

  it("surfaces plain-text history failures without a JSON parse error wrapper", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "Internal Server Error",
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(getMiningHistory("all")).rejects.toThrow("Internal Server Error");
  });
});
