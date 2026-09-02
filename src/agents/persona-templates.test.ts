import { describe, expect, it } from "vitest";
import { createDenyAllCapitalPolicy } from "./agent-profile-contracts.js";
import {
  DEFAULT_PERSONA_TEMPLATE_ID,
  PERSONA_TEMPLATE_IDS,
  buildTemplateProfilePayloads,
  getPersonaTemplate,
  listPersonaTemplates,
} from "./persona-templates.js";

describe("reviewed PersonaTemplates", () => {
  it("publishes a bounded unique first-party catalog", () => {
    const templates = listPersonaTemplates();
    expect(templates.map((template) => template.id)).toEqual(PERSONA_TEMPLATE_IDS);
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
    expect(DEFAULT_PERSONA_TEMPLATE_ID).toBe("private-operator");
  });

  it("composes capability metadata while forcing zero financial authority", () => {
    const payloads = buildTemplateProfilePayloads({
      templateId: "mining-operator",
      displayName: "Wally",
      taskModelRoutes: { strong: "openai/gpt-5", empty: undefined },
    });

    expect(payloads.persona.displayName).toBe("Wally");
    expect(payloads.strategy.capabilityPacks).toEqual([
      "miner",
      "risk-officer",
      "allocator",
      "public-host",
    ]);
    expect(payloads.strategy.taskModelRoutes).toEqual({ strong: "openai/gpt-5" });
    expect(payloads.capitalPolicy).toEqual(createDenyAllCapitalPolicy());
  });

  it("returns defensive copies instead of mutable catalog entries", () => {
    const first = getPersonaTemplate("private-operator");
    first.persona.tone = "mutated";
    expect(getPersonaTemplate("private-operator").persona.tone).toBe(
      "direct, careful, and concise",
    );
  });
});
