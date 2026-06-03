import { describe, expect, it } from "vitest";
import {
  MEMORY_DOCTOR_UNSAFE_FIELD_KEYS,
  collectObjectKeys,
  describeJsonShape,
  expectNoExecutableRepairFields,
  expectNoMemoryDoctorTranscriptLeak,
  expectNoUnsafeMemoryDoctorFields,
} from "./memory-doctor-readonly-test-helpers.js";

describe("memory doctor read-only test helpers", () => {
  it("locks the shared unsafe Memory Doctor field list", () => {
    expect([...MEMORY_DOCTOR_UNSAFE_FIELD_KEYS].toSorted()).toMatchInlineSnapshot(`
      [
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
      ]
    `);
  });

  it("collects nested object keys through arrays", () => {
    expect(
      [...collectObjectKeys({ a: [{ b: true }, { c: { d: 1 } }], e: null })].toSorted(),
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("rejects unsafe executable, request, body, and transcript fields", () => {
    const payload = {
      inventory: {
        workspace: { path: "/tmp/workspace" },
        nested: [{ request: { method: "doctor.memory.repair.execute" } }],
      },
      repairPreview: {
        proposals: [{ execute: true, body: "SECRET_TRANSCRIPT_BODY", transcript: "raw text" }],
      },
    };

    expect(() => expectNoUnsafeMemoryDoctorFields(payload)).toThrow();
    expect(() => expectNoExecutableRepairFields(payload)).toThrow();
  });

  it("accepts the read-only Memory Doctor JSON field shape", () => {
    const payload = {
      reports: [
        {
          agentId: "main",
          inventory: {
            workspace: { path: "/tmp/workspace", exists: true },
            validation: { ok: false },
          },
          validation: { findings: [{ code: "workspace.memory.empty", severity: "warn" }] },
          repairPreview: {
            dryRun: true,
            proposals: [
              {
                id: "preview-1",
                action: "seed_memory",
                wouldMutate: true,
                requiresOperatorWrite: true,
              },
            ],
          },
        },
      ],
    };

    expect(() => expectNoUnsafeMemoryDoctorFields(payload)).not.toThrow();
  });

  it("describes JSON shape without preserving values or local paths", () => {
    const payload = {
      reports: [
        {
          agentId: "main",
          inventory: {
            workspace: { path: "/tmp/a", exists: true },
            backend: { files: 1, dirty: false },
          },
          validation: {
            findings: [
              { code: "a", path: "/private/a" },
              { code: "b", severity: "warn" },
            ],
          },
        },
        {
          agentId: "worker",
          inventory: {
            workspace: { path: "/tmp/b", exists: false },
            backend: { chunks: 3, dirty: true },
          },
          validation: { findings: [] },
        },
      ],
    };

    expect(describeJsonShape(payload)).toMatchInlineSnapshot(`
      {
        "reports": [
          {
            "agentId": "string",
            "inventory": {
              "backend": {
                "chunks": "number",
                "dirty": "boolean",
                "files": "number",
              },
              "workspace": {
                "exists": "boolean",
                "path": "string",
              },
            },
            "validation": {
              "findings": [
                {
                  "code": "string",
                  "path": "string",
                  "severity": "string",
                },
              ],
            },
          },
        ],
      }
    `);
  });

  it("rejects transcript body and seed phrase leakage", () => {
    const secretBody = "SECRET_TRANSCRIPT_BODY: seed phrase should never render";
    expect(() => expectNoMemoryDoctorTranscriptLeak({ preview: "safe" }, secretBody)).not.toThrow();
    expect(() =>
      expectNoMemoryDoctorTranscriptLeak({ preview: `raw ${secretBody}` }, secretBody),
    ).toThrow();
    expect(() =>
      expectNoMemoryDoctorTranscriptLeak({ preview: "contains seed phrase" }, secretBody),
    ).toThrow();
    expect(() =>
      expectNoMemoryDoctorTranscriptLeak({ preview: "transcript body text" }, secretBody),
    ).toThrow();
    expect(() =>
      expectNoMemoryDoctorTranscriptLeak({ preview: "message body text" }, secretBody),
    ).toThrow();
  });
});
