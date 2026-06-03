import type { ErrorObject } from "ajv";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  formatValidationErrors,
  HelloOkSchema,
  validateChannelsRuntimeControlParams,
} from "./index.js";

const makeError = (overrides: Partial<ErrorObject>): ErrorObject => ({
  keyword: "type",
  instancePath: "",
  schemaPath: "#/",
  params: {},
  message: "validation error",
  ...overrides,
});

describe("formatValidationErrors", () => {
  it("returns unknown validation error when missing errors", () => {
    expect(formatValidationErrors(undefined)).toBe("unknown validation error");
    expect(formatValidationErrors(null)).toBe("unknown validation error");
  });

  it("returns unknown validation error when errors list is empty", () => {
    expect(formatValidationErrors([])).toBe("unknown validation error");
  });

  it("formats additionalProperties at root", () => {
    const err = makeError({
      keyword: "additionalProperties",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at root: unexpected property 'token'");
  });

  it("formats additionalProperties with instancePath", () => {
    const err = makeError({
      keyword: "additionalProperties",
      instancePath: "/auth",
      params: { additionalProperty: "token" },
    });

    expect(formatValidationErrors([err])).toBe("at /auth: unexpected property 'token'");
  });

  it("formats message with path for other errors", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err])).toBe("at /auth: must have required property 'token'");
  });

  it("de-dupes repeated entries", () => {
    const err = makeError({
      keyword: "required",
      instancePath: "/auth",
      message: "must have required property 'token'",
    });

    expect(formatValidationErrors([err, err])).toBe(
      "at /auth: must have required property 'token'",
    );
  });
});

describe("HelloOkSchema", () => {
  const AjvCtor = Ajv as unknown as {
    new (opts: { strict: boolean }): {
      compile: (schema: unknown) => (data: unknown) => boolean;
    };
  };
  const ajv = new AjvCtor({ strict: false });
  const validate = ajv.compile(HelloOkSchema);
  const baseHelloOk = {
    type: "hello-ok",
    protocol: 3,
    server: { version: "dev", connId: "conn-1" },
    features: { methods: ["status"], events: ["health"] },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 1,
    },
    policy: {
      maxPayload: 1,
      maxBufferedBytes: 1,
      tickIntervalMs: 1,
    },
  };

  it("requires hello-ok auth with role and scopes", () => {
    expect(validate(baseHelloOk)).toBe(false);
    expect(
      validate({
        ...baseHelloOk,
        auth: { role: "operator", scopes: [] },
      }),
    ).toBe(true);
  });
});

describe("channels runtime control params", () => {
  it("accepts bounded channel/account params", () => {
    expect(validateChannelsRuntimeControlParams({ channel: "telegram" })).toBe(true);
    expect(
      validateChannelsRuntimeControlParams({ channel: "telegram", accountId: "default" }),
    ).toBe(true);
  });

  it("rejects extra properties and empty channel", () => {
    expect(validateChannelsRuntimeControlParams({ channel: "" })).toBe(false);
    expect(validateChannelsRuntimeControlParams({ channel: "telegram", token: "secret" })).toBe(
      false,
    );
  });
});
