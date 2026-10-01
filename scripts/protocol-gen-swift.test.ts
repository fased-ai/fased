import { describe, expect, it } from "vitest";
import { ProtocolSchemas } from "../src/gateway/protocol/schema.js";
import { generateSwiftProtocol } from "./protocol-gen-swift.js";

describe("Swift protocol named schema declarations", () => {
  it("declares string unions before using their named types", () => {
    const sourceSchema = { anyOf: [{ type: "string" }, { type: "string" }] };
    const unknownSchema = {};
    const source = generateSwiftProtocol({
      Source: sourceSchema,
      Unknown: unknownSchema,
      Entry: { type: "object", properties: { source: sourceSchema, unknown: unknownSchema } },
    });
    expect(source).toContain("public typealias Source = String");
    expect(source).toContain("public let source: Source?");
    expect(source).toContain("public let unknown: AnyCodable?");
  });

  it("declares every named string union in the current gateway protocol", () => {
    const source = generateSwiftProtocol();
    for (const [name, schema] of Object.entries(ProtocolSchemas)) {
      const union = schema as { anyOf?: Array<{ type?: string }> };
      if (union.anyOf?.length && union.anyOf.every((member) => member.type === "string")) {
        expect(source, name).toContain(`public typealias ${name} = String`);
      }
    }
    expect(source).toContain("public let source: ToolEffectiveSource");
    expect(source).toContain("public let action: PluginMarketplaceMutationAction");
  });
  it("declares every generated property type or uses an existing Swift primitive", () => {
    const source = generateSwiftProtocol();
    const declared = new Set([
      "String",
      "Int",
      "Double",
      "Bool",
      "AnyCodable",
      ...Array.from(
        source.matchAll(/public (?:struct|enum|typealias) (\w+)/gu),
        (match) => match[1],
      ),
    ]);
    for (const property of source.matchAll(/^    public let \w+: (.+)$/gmu)) {
      for (const typeName of property[1].match(/\b[A-Z]\w*/gu) ?? []) {
        expect(declared.has(typeName), `${property[0]} references undeclared ${typeName}`).toBe(
          true,
        );
      }
    }
  });
});
