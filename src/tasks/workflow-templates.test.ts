import { describe, expect, it } from "vitest";
import { listTaskWorkflowTemplates } from "./workflow-templates.js";

describe("task workflow templates", () => {
  it("does not ship generic workflow templates by default", () => {
    expect(listTaskWorkflowTemplates()).toEqual({ templates: [] });
  });
});
