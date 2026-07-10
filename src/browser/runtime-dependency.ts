import { importOptionalRuntimeDependency } from "../infra/optional-runtime-dependency.js";

export async function loadPlaywrightCore(): Promise<typeof import("playwright-core")> {
  return await importOptionalRuntimeDependency({
    componentId: "browser-runtime",
    packageName: "@fased/browser-runtime",
    dependency: "playwright-core",
  });
}

export async function loadReadability(): Promise<typeof import("@mozilla/readability")> {
  return await importOptionalRuntimeDependency({
    componentId: "browser-runtime",
    packageName: "@fased/browser-runtime",
    dependency: "@mozilla/readability",
  });
}

export async function loadLinkedom(): Promise<typeof import("linkedom")> {
  return await importOptionalRuntimeDependency({
    componentId: "browser-runtime",
    packageName: "@fased/browser-runtime",
    dependency: "linkedom",
  });
}
