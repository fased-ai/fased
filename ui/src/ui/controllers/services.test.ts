import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { loadServiceCapabilities } from "./services.ts";

describe("service capability controller", () => {
  it("loads the shared capability lifecycle report", async () => {
    const report = {
      entries: [],
      summary: {
        total: 0,
        coreIncluded: 0,
        optionalInstalled: 0,
        optionalConfigured: 0,
        externalRequired: 0,
        errors: 0,
      },
    };
    const request = vi.fn(async () => report);
    const state = {
      client: { request },
      servicesCapabilities: null,
      servicesCapabilitiesLoading: false,
    } as unknown as AppViewState;
    await loadServiceCapabilities(state);
    expect(request).toHaveBeenCalledWith("services.capabilities", {});
    expect(state.servicesCapabilities).toEqual(report);
    expect(state.servicesCapabilitiesLoading).toBe(false);
  });
});
