import { beforeEach, describe, expect, it } from "vitest";

describe("optional runtime dependency loader", () => {
  beforeEach(async () => {
    const { resetOptionalRuntimeDependencyCacheForTest } =
      await import("./optional-runtime-dependency.js");
    resetOptionalRuntimeDependencyCacheForTest();
  });

  it("uses a dependency already available to the core runtime", async () => {
    const { importOptionalRuntimeDependency } = await import("./optional-runtime-dependency.js");
    const module = await importOptionalRuntimeDependency<typeof import("node:path")>({
      componentId: "test-runtime",
      packageName: "@fased/test-runtime",
      dependency: "node:path",
    });
    expect(typeof module.join).toBe("function");
  });

  it("routes a missing bundled dependency to verified generation repair", async () => {
    const { importOptionalRuntimeDependency } = await import("./optional-runtime-dependency.js");
    await expect(
      importOptionalRuntimeDependency({
        componentId: "media-runtime",
        packageName: "@fased/media-runtime",
        dependency: "fased-package-that-does-not-exist",
      }),
    ).rejects.toThrow("Rerun the verified installer or `fased update`");
  });
});
