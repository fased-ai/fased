import { validateToolArguments } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type ToolWithArgumentPreparation = AnyAgentTool & {
  prepareArguments?: (args: unknown) => unknown;
};

function makeTool(params: Partial<AnyAgentTool> & Pick<AnyAgentTool, "parameters">): AnyAgentTool {
  return {
    name: "test_tool",
    label: "Test Tool",
    description: "Test tool",
    execute: vi.fn().mockResolvedValue({ content: [], details: { ok: true } }),
    ...params,
  };
}

describe("normalizeToolParameters", () => {
  it("normalizes empty schemas to parameterless object schemas", () => {
    const normalized = normalizeToolParameters(makeTool({ parameters: {} }));

    expect(normalized.parameters).toEqual({ type: "object", properties: {} });
  });

  it("adds missing properties to object schemas", () => {
    const normalized = normalizeToolParameters(makeTool({ parameters: { type: "object" } }));

    expect(normalized.parameters).toEqual({ type: "object", properties: {} });
  });

  it("prepares null and undefined arguments as empty objects for parameterless object schemas", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const normalized = normalizeToolParameters(
      makeTool({
        parameters: { type: "object", properties: {}, required: [] },
        execute,
      }),
    ) as ToolWithArgumentPreparation;

    expect(normalized.prepareArguments?.(null)).toEqual({});
    expect(normalized.prepareArguments?.(undefined)).toEqual({});
    expect(
      validateToolArguments(normalized, {
        type: "toolCall",
        id: "call-1",
        name: "test_tool",
        arguments: normalized.prepareArguments?.(null) as Record<string, unknown>,
      }),
    ).toEqual({});

    await normalized.execute("call-1", null as never, undefined, undefined);
    expect(execute).toHaveBeenCalledWith("call-1", {}, undefined, undefined);
  });

  it("preserves existing argument preparation before applying the empty-object fallback", () => {
    const normalized = normalizeToolParameters(
      makeTool({
        parameters: { type: "object", properties: {} },
        prepareArguments: vi.fn((args: unknown) => {
          if (args === "blank") {
            return null;
          }
          return { source: args };
        }),
      } as Partial<AnyAgentTool> & Pick<AnyAgentTool, "parameters">),
    ) as ToolWithArgumentPreparation;

    expect(normalized.prepareArguments?.("blank")).toEqual({});
    expect(normalized.prepareArguments?.("value")).toEqual({ source: "value" });
  });

  it("leaves null arguments invalid when the schema has required params", () => {
    const normalized = normalizeToolParameters(
      makeTool({
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }),
    ) as ToolWithArgumentPreparation;

    expect(normalized.prepareArguments).toBeUndefined();
    expect(() =>
      validateToolArguments(normalized, {
        type: "toolCall",
        id: "call-1",
        name: "test_tool",
        arguments: null as never,
      }),
    ).toThrow('Validation failed for tool "test_tool"');
  });

  it("leaves null arguments invalid when required params are nested in composite schemas", () => {
    const normalized = normalizeToolParameters(
      makeTool({
        parameters: {
          type: "object",
          allOf: [
            {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          ],
        },
      }),
    ) as ToolWithArgumentPreparation;

    expect(normalized.prepareArguments).toBeUndefined();
    expect(() =>
      validateToolArguments(normalized, {
        type: "toolCall",
        id: "call-1",
        name: "test_tool",
        arguments: null as never,
      }),
    ).toThrow('Validation failed for tool "test_tool"');
  });
});
