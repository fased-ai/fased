import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import {
  installServiceComponent,
  loadServiceCapabilities,
  restartServiceComponent,
} from "./services.ts";

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

  it.each([
    ["install", installServiceComponent, "services.component.install"],
    ["restart", restartServiceComponent, "services.component.restart"],
  ])("runs the %s component action and refreshes readiness", async (_label, action, method) => {
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
    const request = vi.fn(async () => ({ message: "Done", report }));
    const state = {
      client: { request },
      servicesCapabilities: null,
      servicesCapabilitiesLoading: false,
      servicesComponentBusy: {},
      servicesComponentMessage: null,
    } as unknown as AppViewState;
    await action(state, "media-runtime");
    expect(request).toHaveBeenCalledWith(method, { id: "media-runtime" });
    expect(state.servicesCapabilities).toEqual(report);
    expect(state.servicesComponentMessage).toBe("Done");
    expect(state.servicesComponentBusy).toEqual({});
  });
});
