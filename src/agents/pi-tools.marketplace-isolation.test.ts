import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createFasedAgentCodingTools } from "./pi-tools.js";

describe("Marketplace skill tool isolation", () => {
  it("exposes only read when untrusted Marketplace instructions are present", () => {
    const tools = createFasedAgentCodingTools({ untrustedSkillContent: true });
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });
});
