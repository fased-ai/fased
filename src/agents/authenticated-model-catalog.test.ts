import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolveAuthenticatedModelCatalog } from "./authenticated-model-catalog.js";

const discover = vi.hoisted(() => vi.fn());
vi.mock("../providers/runtime-model-catalog.js", () => ({
  applyRuntimeProviderModelDiscovery: discover,
  filterCatalogToAuthoritativeAvailability: (catalog: unknown) => catalog,
}));
const catalog = [
  { provider: "openai", id: "gpt-current", name: "GPT" },
  { provider: "anthropic", id: "claude-current", name: "Claude" },
];
const store: AuthProfileStore = {
  version: 1,
  profiles: {
    "openai:test": { type: "api_key", provider: "openai", key: "test" },
    "anthropic:test": { type: "api_key", provider: "anthropic", key: "test" },
  },
};
const params = { cfg: {}, store, catalog, defaultProvider: "openai" };

describe("execution-scoped authenticated catalog", () => {
  beforeEach(() => {
    discover.mockReset();
    discover.mockImplementation(async (request) => request.catalog);
  });
  it("probes only the selected route while preserving configured fallback catalog", async () => {
    const result = await resolveAuthenticatedModelCatalog({
      ...params,
      discoveryRoutes: ["openai"],
    });
    expect([...discover.mock.calls[0][0].routes]).toEqual(["openai"]);
    expect(result.usableCatalog).toEqual(catalog);
    await resolveAuthenticatedModelCatalog({ ...params, discoveryRoutes: ["anthropic"] });
    expect([...discover.mock.calls[1][0].routes]).toEqual(["anthropic"]);
  });
  it("keeps explicit interactive refresh across authenticated providers", async () => {
    await resolveAuthenticatedModelCatalog(params);
    expect([...discover.mock.calls[0][0].routes].toSorted((a, b) => a.localeCompare(b))).toEqual([
      "anthropic",
      "openai",
    ]);
  });
  it("does not probe a requested route without usable credentials", async () => {
    await resolveAuthenticatedModelCatalog({ ...params, discoveryRoutes: ["unknown"] });
    expect([...discover.mock.calls[0][0].routes]).toEqual([]);
  });
});
