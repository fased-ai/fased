import { describe, expect, it } from "vitest";
import "./test-helpers/fast-core-tools.js";
import { createFasedCompatTools } from "./fased-tools.compat.js";

function readToolByName() {
  return new Map(createFasedCompatTools().map((tool) => [tool.name, tool]));
}

describe("createFasedCompatTools owner authorization", () => {
  it("marks owner-only core tools in raw registration", () => {
    const tools = readToolByName();
    expect(tools.get("cron")?.ownerOnly).toBe(true);
    expect(tools.get("gateway")?.ownerOnly).toBe(true);
    expect(tools.get("nodes")?.ownerOnly).toBe(true);
    expect(tools.get("offers")?.ownerOnly).toBe(true);
    expect(tools.get("marketplace")?.ownerOnly).toBe(true);
    expect(tools.get("marketplace_offer_draft")?.ownerOnly).toBe(true);
    expect(tools.get("marketplace_request_draft")?.ownerOnly).toBe(true);
  });

  it("keeps canvas non-owner-only in raw registration", () => {
    const tools = readToolByName();
    expect(tools.get("canvas")).toBeDefined();
    expect(tools.get("canvas")?.ownerOnly).not.toBe(true);
  });
});
