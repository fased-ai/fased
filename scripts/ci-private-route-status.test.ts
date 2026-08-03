import { describe, expect, it } from "vitest";
import { resolveTrustedCiRoute, ROUTE_STATUS_CONTEXT } from "./ci-private-route-status.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const planDigest = "c".repeat(64);
const receiptDigest = "d".repeat(64);
const repo = "fased-ai/fased";
const actor = { login: "founder", id: 42 };
const now = new Date("2026-08-03T12:00:00.000Z");

function routeStatus(overrides: Record<string, unknown> = {}, route = "local-update") {
  const target = new URL(`https://github.com/${repo}/commit/${head}`);
  target.searchParams.set("fased-ci-route", "v1");
  target.searchParams.set("entry", route);
  target.searchParams.set("phase", "T1");
  target.searchParams.set("base", base);
  target.searchParams.set("plan", planDigest);
  target.searchParams.set("receipt", receiptDigest);
  target.searchParams.set("expires", "2026-08-03T12:30:00.000Z");
  return {
    id: 100,
    context: ROUTE_STATUS_CONTEXT,
    state: "pending",
    description: `route:${route};r=${receiptDigest.slice(0, 16)}`,
    target_url: target.href,
    creator: actor,
    ...overrides,
  };
}

function resolve(statuses: unknown[]) {
  return resolveTrustedCiRoute({
    statuses,
    repo,
    headCommit: head,
    baseCommit: base,
    trustedActorLogin: actor.login,
    trustedActorId: actor.id,
    now,
  });
}

describe("private receipt-bound CI routing", () => {
  it("selects exact Local update from one trusted pending receipt", () => {
    expect(resolve([routeStatus()])).toEqual({
      status: "selected",
      route: "local-update",
      entryPoint: "local-update",
      phase: "T1",
      planDigest: `sha256:${planDigest}`,
      receiptDigest: `sha256:${receiptDigest}`,
      statusId: 100,
    });
  });

  it("selects dependency remediation without inventing a lifecycle entry point", () => {
    expect(resolve([routeStatus({}, "dependency-remediation")])).toEqual({
      status: "selected",
      route: "dependency-remediation",
      entryPoint: null,
      phase: "T1",
      planDigest: `sha256:${planDigest}`,
      receiptDigest: `sha256:${receiptDigest}`,
      statusId: 100,
    });
  });

  it("ignores an untrusted spoof and falls back broad when no trusted route exists", () => {
    expect(
      resolve([routeStatus({ id: 101, creator: { login: "github-actions[bot]", id: 41898282 } })]),
    ).toEqual({ status: "absent", route: null, entryPoint: null });
  });

  it("does not interpret merge success or revocation as routing authority", () => {
    expect(resolve([routeStatus({ state: "success" })])).toEqual({
      status: "absent",
      route: null,
      entryPoint: null,
    });
    expect(resolve([routeStatus({ state: "error" })])).toEqual({
      status: "absent",
      route: null,
      entryPoint: null,
    });
  });

  it.each([
    ["wrong head", { target_url: String(routeStatus().target_url).replace(head, "e".repeat(40)) }],
    ["wrong base", { target_url: String(routeStatus().target_url).replace(base, "e".repeat(40)) }],
    [
      "expired",
      {
        target_url: String(routeStatus().target_url).replace(
          "2026-08-03T12%3A30%3A00.000Z",
          "2026-08-03T11%3A59%3A59.000Z",
        ),
      },
    ],
    ["wrong description", { description: "route:local-fresh;r=dddddddddddddddd" }],
    ["wrong state", { state: "failure" }],
  ])("fails closed for a trusted malformed pending route: %s", (_name, overrides) => {
    expect(() => resolve([routeStatus(overrides)])).toThrow(/trusted CI route/u);
  });

  it("uses only the newest exact trusted status", () => {
    expect(resolve([routeStatus({ id: 99 }), routeStatus({ id: 100, state: "error" })])).toEqual({
      status: "absent",
      route: null,
      entryPoint: null,
    });
  });
});
