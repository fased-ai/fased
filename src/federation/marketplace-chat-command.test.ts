import { describe, expect, it, vi } from "vitest";

const offersExecute = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/marketplace-offer-draft-tool.js", () => ({
  createOffersTool: vi.fn(() => ({
    execute: offersExecute,
  })),
}));

import { executeOffersChatCommand, parseOffersChatCommand } from "./marketplace-chat-command.js";

describe("marketplace offers chat command parser", () => {
  it("parses @offers search requests", () => {
    expect(parseOffersChatCommand("Find @offers for content summary")).toEqual({
      action: "search",
      args: {
        action: "search",
        includeRemote: true,
        limit: 10,
        query: "content summary",
      },
    });
  });

  it("parses paid invoice requests", () => {
    expect(parseOffersChatCommand("Show paid Marketplace invoices")).toEqual({
      action: "paid_invoices",
      args: { action: "paid_invoices", limit: 20 },
    });
  });

  it("formats offer search results", async () => {
    offersExecute.mockResolvedValueOnce({
      details: {
        ok: true,
        offers: [{ offer: { title: "Summary", serviceKind: "content.summarize" } }],
        requests: [],
        orders: [],
        remote: [],
      },
    });
    const command = parseOffersChatCommand("/offers find content summary");
    if (!command) {
      throw new Error("missing command");
    }
    const result = await executeOffersChatCommand({ command });
    expect(result.replyText).toContain("Offers:");
    expect(result.replyText).toContain("Summary");
    expect(result.replyText).toContain("Content Summarize");
  });
});
