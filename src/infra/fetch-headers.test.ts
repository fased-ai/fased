import { describe, expect, it } from "vitest";
import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "./fetch-headers.js";

describe("fetch header normalization", () => {
  it("drops symbol keys from plain header dictionaries", () => {
    const symbolHeader = Symbol("symbol-header");
    const headers = Object.assign(Object.create(null) as Record<PropertyKey, string>, {
      "X-Trace": "1",
      [symbolHeader]: "must-not-forward",
    });

    const normalized = normalizeHeadersInitForFetch(headers as HeadersInit);

    expect(new Headers(normalized).get("x-trace")).toBe("1");
    expect(Object.getOwnPropertySymbols(normalized as object)).toHaveLength(0);
  });

  it("preserves non-symbol header init forms", () => {
    const headers = new Headers({ "X-Trace": "1" });
    const tupleHeaders: HeadersInit = [["X-Trace", "1"]];
    const plainHeaders: HeadersInit = { "X-Trace": "1" };

    expect(normalizeHeadersInitForFetch(headers)).toBe(headers);
    expect(normalizeHeadersInitForFetch(tupleHeaders)).toBe(tupleHeaders);
    expect(normalizeHeadersInitForFetch(plainHeaders)).toBe(plainHeaders);
  });

  it("copies request init only when headers need normalization", () => {
    const symbolHeader = Symbol("symbol-header");
    const headers = Object.assign(Object.create(null) as Record<PropertyKey, string>, {
      "X-Trace": "1",
      [symbolHeader]: "must-not-forward",
    });
    const cleanInit = { headers: { "X-Trace": "1" } };
    const dirtyInit = { method: "GET", headers: headers as HeadersInit };

    expect(normalizeRequestInitHeadersForFetch(cleanInit)).toBe(cleanInit);

    const normalized = normalizeRequestInitHeadersForFetch(dirtyInit);
    expect(normalized).not.toBe(dirtyInit);
    expect(normalized?.method).toBe("GET");
    expect(new Headers(normalized?.headers).get("x-trace")).toBe("1");
    expect(Object.getOwnPropertySymbols(normalized?.headers as object)).toHaveLength(0);
  });
});
