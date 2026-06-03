import { expect } from "vitest";

export const MEMORY_DOCTOR_UNSAFE_FIELD_KEYS = new Set([
  "apply",
  "auditPath",
  "backupPath",
  "body",
  "cli",
  "command",
  "confirmation",
  "content",
  "endpoint",
  "execute",
  "executor",
  "fsOperation",
  "gatewayHandler",
  "handler",
  "href",
  "method",
  "params",
  "request",
  "rollbackPath",
  "route",
  "token",
  "transcript",
  "url",
  "writePath",
]);

export function collectObjectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") {
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectObjectKeys(entry, out);
    }
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    out.add(key);
    collectObjectKeys(entry, out);
  }
  return out;
}

export function expectNoUnsafeMemoryDoctorFields(value: unknown) {
  const keys = collectObjectKeys(value);
  for (const key of MEMORY_DOCTOR_UNSAFE_FIELD_KEYS) {
    expect(keys).not.toContain(key);
  }
}

export const expectNoExecutableRepairFields = expectNoUnsafeMemoryDoctorFields;

export function expectNoMemoryDoctorTranscriptLeak(value: unknown, secretBody: string) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(secretBody);
  expect(serialized).not.toContain("seed phrase");
  expect(serialized).not.toMatch(/transcript body|message body/i);
}

export function describeJsonShape(value: unknown): unknown {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return value.length ? [mergeJsonShapes(value.map((entry) => describeJsonShape(entry)))] : [];
  }
  if (typeof value !== "object") {
    return typeof value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, describeJsonShape(entry)]),
  );
}

function mergeJsonShapes(shapes: unknown[]): unknown {
  if (shapes.length === 0) {
    return "unknown";
  }
  if (shapes.every(Array.isArray)) {
    const entries = shapes.flat();
    return entries.length ? [mergeJsonShapes(entries)] : [];
  }
  if (shapes.every(isPlainObjectShape)) {
    const keys = new Set<string>();
    for (const shape of shapes) {
      for (const key of Object.keys(shape)) {
        keys.add(key);
      }
    }
    return Object.fromEntries(
      [...keys]
        .toSorted()
        .map((key) => [
          key,
          mergeJsonShapes(shapes.map((shape) => shape[key]).filter((entry) => entry !== undefined)),
        ]),
    );
  }
  const serialized = [...new Set(shapes.map((shape) => JSON.stringify(shape)))].toSorted();
  if (serialized.length === 1 && serialized[0]) {
    return JSON.parse(serialized[0]) as unknown;
  }
  return serialized.map((entry) => JSON.parse(entry) as unknown);
}

function isPlainObjectShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
