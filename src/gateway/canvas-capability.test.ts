import { describe, expect, test } from "vitest";
import {
  buildCanvasScopedHostUrl,
  CANVAS_CAPABILITY_PATH_PREFIX,
  CANVAS_CAPABILITY_QUERY_PARAM,
  LEGACY_CANVAS_CAPABILITY_QUERY_PARAM,
  normalizeCanvasScopedUrl,
} from "./canvas-capability.js";

describe("canvas capability URLs", () => {
  test("builds scoped host URLs without exposing query capability by default", () => {
    const scoped = buildCanvasScopedHostUrl("http://127.0.0.1:18789", "node-token");

    expect(scoped).toBe(`http://127.0.0.1:18789${CANVAS_CAPABILITY_PATH_PREFIX}/node-token`);
  });

  test("rewrites scoped paths to canonical canvas paths with fased capability query", () => {
    const normalized = normalizeCanvasScopedUrl(
      `${CANVAS_CAPABILITY_PATH_PREFIX}/node-token/__fased__/canvas/`,
    );

    expect(normalized.scopedPath).toBe(true);
    expect(normalized.malformedScopedPath).toBe(false);
    expect(normalized.pathname).toBe("/__fased__/canvas/");
    expect(normalized.capability).toBe("node-token");
    expect(normalized.rewrittenUrl).toBe(
      `/__fased__/canvas/?${CANVAS_CAPABILITY_QUERY_PARAM}=node-token`,
    );
  });

  test("accepts fased and legacy query capability names", () => {
    expect(
      normalizeCanvasScopedUrl(`/__fased__/ws?${CANVAS_CAPABILITY_QUERY_PARAM}=new-token`)
        .capability,
    ).toBe("new-token");
    expect(
      normalizeCanvasScopedUrl(`/__fased__/ws?${LEGACY_CANVAS_CAPABILITY_QUERY_PARAM}=old-token`)
        .capability,
    ).toBe("old-token");
  });

  test("marks scoped paths without canonical canvas path as malformed", () => {
    const normalized = normalizeCanvasScopedUrl(`${CANVAS_CAPABILITY_PATH_PREFIX}/broken`);

    expect(normalized.scopedPath).toBe(true);
    expect(normalized.malformedScopedPath).toBe(true);
    expect(normalized.capability).toBeUndefined();
    expect(normalized.rewrittenUrl).toBeUndefined();
  });
});
