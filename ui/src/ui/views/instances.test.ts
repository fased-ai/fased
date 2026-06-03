/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderInstances } from "./instances.ts";

describe("renderInstances", () => {
  it("shows runtime client summary without revealing host data by default", () => {
    const container = document.createElement("div");
    render(
      renderInstances({
        loading: false,
        entries: [
          {
            host: "workstation",
            ip: "10.0.0.2",
            mode: "desktop",
            lastInputSeconds: 42,
            roles: ["operator"],
            scopes: ["operator.read", "operator.admin"],
          },
        ],
        lastError: null,
        statusMessage: null,
        onRefresh: () => undefined,
      }),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("runtime clients");
    expect(text).toContain("recently active");
    expect(text).toContain("Runtime/client status is read-only here");
    expect(container.querySelector(".redacted")?.textContent).toContain("workstation");
  });
});
