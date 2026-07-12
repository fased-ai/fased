import { describe, expect, it } from "vitest";
import { materializeAgentConfigList } from "./agent-config-entry.ts";

describe("materializeAgentConfigList", () => {
  it("adds the implicit default Agent to a defaults-only config", () => {
    expect(
      materializeAgentConfigList({ agents: { defaults: { model: "openai/gpt-5.6" } } }, "main"),
    ).toEqual({ changed: true, index: 0, list: [{ id: "main" }] });
  });

  it("preserves an existing array entry", () => {
    expect(
      materializeAgentConfigList({ agents: { list: [{ id: "main", name: "Assistant" }] } }, "main"),
    ).toEqual({
      changed: false,
      index: 0,
      list: [{ id: "main", name: "Assistant" }],
    });
  });

  it("normalizes a legacy keyed list before adding a new Agent", () => {
    expect(
      materializeAgentConfigList({ agents: { list: { main: { name: "Assistant" } } } }, "research"),
    ).toEqual({
      changed: true,
      index: 1,
      list: [{ id: "main", name: "Assistant" }, { id: "research" }],
    });
  });
});
