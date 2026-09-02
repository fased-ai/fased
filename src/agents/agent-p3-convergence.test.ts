import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectAgentMiningPassportDirectory } from "./agent-mining-passport.js";
import {
  type AgentPublicViewSourceEvent,
  rebuildAgentPublicViewIndex,
} from "./agent-public-view-indexer.js";
import { validateAgentPublicView } from "./fased-agent-public-views.generated.js";

type Fixture = {
  path: string;
  scenario: string;
  value: Record<string, unknown>;
};

type FixtureBundle = {
  schema: "fased.agent-public-view-fixtures.v1";
  sourceCommit: string;
  valid: Fixture[];
  invalid: Fixture[];
};

const fixtureBundle = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "protocol-generation/public-agent-views.v1.fixtures.json",
    ),
    "utf8",
  ),
) as FixtureBundle;

const expectedState = new Map([
  ["agent:bound", "bound_active"],
  ["agent:complete-drain", "drained"],
  ["agent:conflicting-server-chain-binding", "conflict"],
  ["agent:controller-rotation", "identity_only"],
  ["agent:network-only-agent", "network_only"],
  ["agent:paused-entry", "paused"],
  ["agent:retired-agent", "retired"],
  ["agent:stale-runtime", "stale"],
]);

function subjectFor(scenario: string): string {
  return ["bound-public-mining-agent", "mining-only-record", "mining-ready-qualification"].includes(
    scenario,
  )
    ? "agent:bound"
    : `agent:${scenario}`;
}

function kindFor(schema: unknown): AgentPublicViewSourceEvent["viewKind"] {
  switch (schema) {
    case "fased.agent-identity-view.v1":
      return "identity";
    case "fased.agent-mining-view.v1":
      return "mining";
    case "fased.agent-qualification-view.v1":
      return "qualification";
    case "fased.agent-evidence-ref.v1":
      return "evidence";
    default:
      throw new Error(`Unsupported fixture schema ${String(schema)}`);
  }
}

function sourceEvents(): AgentPublicViewSourceEvent[] {
  const cursors = { signed: 0, finalized: 0 };
  return fixtureBundle.valid.map((fixture) => {
    const signed = fixture.scenario === "network-only-agent";
    const cursor = signed ? ++cursors.signed : ++cursors.finalized;
    const timestamp = fixture.value.observedAt ?? fixture.value.evaluatedAt;
    if (typeof timestamp !== "string") {
      throw new Error(`Fixture ${fixture.scenario} has no observation timestamp`);
    }
    return {
      schema: "fased.agent-public-view-source-event.v1",
      eventId: `fixture:${fixture.scenario}`,
      subjectId: subjectFor(fixture.scenario),
      viewKind: kindFor(fixture.value.schema),
      source: signed ? "fased-signed" : "solana-finalized",
      sourceRef: `fixture:${fixture.scenario}`,
      ordinal: String(cursor),
      observedAt: timestamp,
      view: fixture.value,
    };
  });
}

describe("P3 cross-repository public truth convergence", () => {
  it("pins and validates every canonical Agent-protocol fixture", () => {
    expect(fixtureBundle.schema).toBe("fased.agent-public-view-fixtures.v1");
    expect(fixtureBundle.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(fixtureBundle.valid).toHaveLength(10);
    expect(fixtureBundle.invalid).toHaveLength(5);
    for (const fixture of fixtureBundle.valid) {
      expect(validateAgentPublicView(fixture.value), fixture.scenario).toMatchObject({ ok: true });
    }
    for (const fixture of fixtureBundle.invalid) {
      expect(validateAgentPublicView(fixture.value), fixture.scenario).toMatchObject({ ok: false });
    }
  });

  it("replays canonical fixtures into the exact deterministic passport state matrix", () => {
    const events = sourceEvents();
    const first = projectAgentMiningPassportDirectory(rebuildAgentPublicViewIndex(events));
    const replay = projectAgentMiningPassportDirectory(rebuildAgentPublicViewIndex(events));
    expect(replay).toEqual(first);
    expect(
      new Map(first.passports.map((passport) => [passport.subjectId, passport.state])),
    ).toEqual(expectedState);
  });
});
