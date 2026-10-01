import { describe, expect, it } from "vitest";
import { buildCatalogModelOptions } from "./chat-model-ref.ts";
import { createModelCatalog } from "./chat-model.test-helpers.ts";

describe("shared account catalog options", () => {
  it("preserves discovery order and keeps subscription and API routes distinct", () => {
    const options = buildCatalogModelOptions(
      createModelCatalog(
        { id: "account-new-model", name: "New model", provider: "openai-codex" },
        { id: "account-new-model", name: "New model", provider: "openai" },
        { id: "ACCOUNT-NEW-MODEL", name: "Duplicate", provider: "openai-codex" },
      ),
    );
    expect(options.map((option) => option.value)).toEqual([
      "openai-codex/account-new-model",
      "openai/account-new-model",
    ]);
  });
});
