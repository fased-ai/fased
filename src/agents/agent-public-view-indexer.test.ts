import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAgentPublicViewSourceEvent,
  readAgentPublicViewIndex,
  rebuildAgentPublicViewIndex,
  type AgentPublicViewSourceEvent,
} from "./agent-public-view-indexer.js";

const roots: string[] = [];

function testEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fased-agent-public-index-"));
  roots.push(root);
  return { FASED_STATE_DIR: root };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function evidence(label: string, trust: "declared" | "signed" | "finalized") {
  return {
    schema: "fased.agent-evidence-ref.v1" as const,
    evidenceId: `evidence-${label}`,
    source:
      trust === "finalized"
        ? ("satcoin_program" as const)
        : trust === "signed"
          ? ("fased_network" as const)
          : ("owner_declaration" as const),
    trust,
    observedAt: "2026-09-02T12:00:00.000Z",
    digestSha256: (trust === "finalized" ? "c" : trust === "signed" ? "b" : "a").repeat(64),
  };
}

function event(params: {
  id: string;
  ordinal: number;
  source: "owner-declared" | "fased-signed" | "solana-finalized";
  label?: string;
}): AgentPublicViewSourceEvent {
  const trust =
    params.source === "solana-finalized"
      ? "finalized"
      : params.source === "fased-signed"
        ? "signed"
        : "declared";
  return {
    schema: "fased.agent-public-view-source-event.v1",
    eventId: params.id,
    subjectId: "wally",
    viewKind: "evidence",
    source: params.source,
    sourceRef: `${params.source}:${params.ordinal}`,
    ordinal: String(params.ordinal),
    observedAt: "2026-09-02T12:00:00.000Z",
    view: evidence(params.label ?? params.id, trust),
  };
}

describe("finalized Agent public-view index", () => {
  it("applies declared, signed, then finalized source precedence without hiding conflicts", async () => {
    const env = testEnv();
    await applyAgentPublicViewSourceEvent({
      event: event({ id: "declared-1", ordinal: 1, source: "owner-declared" }),
      env,
    });
    await applyAgentPublicViewSourceEvent({
      event: event({ id: "signed-1", ordinal: 1, source: "fased-signed" }),
      env,
    });
    await applyAgentPublicViewSourceEvent({
      event: event({ id: "finalized-1", ordinal: 1, source: "solana-finalized" }),
      env,
    });

    const index = readAgentPublicViewIndex({ env });
    expect(index.records["wally:evidence"]?.eventId).toBe("finalized-1");
    expect(index.conflicts).toHaveLength(2);
    expect(index.conflicts.map((entry) => entry.reason)).toEqual([
      "higher-precedence-source",
      "higher-precedence-source",
    ]);
    expect(index.cursors).toEqual({
      "owner-declared": "1",
      "fased-signed": "1",
      "solana-finalized": "1",
    });
  });

  it("never lets a later lower-precedence observation replace finalized truth", async () => {
    const env = testEnv();
    await applyAgentPublicViewSourceEvent({
      event: event({ id: "finalized-1", ordinal: 1, source: "solana-finalized" }),
      env,
    });
    await applyAgentPublicViewSourceEvent({
      event: event({ id: "declared-9", ordinal: 9, source: "owner-declared" }),
      env,
    });

    const index = readAgentPublicViewIndex({ env });
    expect(index.records["wally:evidence"]?.eventId).toBe("finalized-1");
    expect(index.conflicts[0]).toMatchObject({
      winnerEventId: "finalized-1",
      otherEventId: "declared-9",
      reason: "lower-precedence-source",
    });
  });

  it("makes exact replay idempotent and rejects changed or regressed replay", async () => {
    const env = testEnv();
    const first = event({ id: "finalized-1", ordinal: 1, source: "solana-finalized" });
    await expect(applyAgentPublicViewSourceEvent({ event: first, env })).resolves.toMatchObject({
      replay: false,
    });
    await expect(applyAgentPublicViewSourceEvent({ event: first, env })).resolves.toMatchObject({
      replay: true,
    });
    await expect(
      applyAgentPublicViewSourceEvent({ event: { ...first, sourceRef: "changed:1" }, env }),
    ).rejects.toThrow("different immutable content");
    await expect(
      applyAgentPublicViewSourceEvent({
        event: event({ id: "finalized-other", ordinal: 1, source: "solana-finalized" }),
        env,
      }),
    ).rejects.toThrow("cursor regressed or diverged");
  });

  it("survives restart and clean replay reproduces the exact index digest", async () => {
    const env = testEnv();
    const events = [
      event({ id: "declared-1", ordinal: 1, source: "owner-declared" }),
      event({ id: "signed-1", ordinal: 1, source: "fased-signed" }),
      event({ id: "finalized-1", ordinal: 1, source: "solana-finalized" }),
      event({ id: "finalized-2", ordinal: 2, source: "solana-finalized" }),
    ];
    for (const sourceEvent of events) {
      await applyAgentPublicViewSourceEvent({ event: sourceEvent, env });
    }
    const restarted = readAgentPublicViewIndex({ env });
    const rebuilt = rebuildAgentPublicViewIndex(events);

    expect(restarted.indexDigest).toBe(rebuilt.indexDigest);
    expect(restarted).toEqual(rebuilt);
    expect(restarted.records["wally:evidence"]?.eventId).toBe("finalized-2");
  });

  it("fails closed on tampered durable state and invalid public views", async () => {
    const env = testEnv();
    await applyAgentPublicViewSourceEvent({
      event: event({ id: "finalized-1", ordinal: 1, source: "solana-finalized" }),
      env,
    });
    const filePath = path.join(
      env.FASED_STATE_DIR!,
      "agent-public-index",
      "agent-public-view-index.v1.json",
    );
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      cursors: Record<string, string>;
    };
    stored.cursors["solana-finalized"] = "999";
    fs.writeFileSync(filePath, JSON.stringify(stored));
    expect(() => readAgentPublicViewIndex({ env })).toThrow("index digest is invalid");

    const invalidEnv = testEnv();
    const invalid = event({ id: "signed-1", ordinal: 1, source: "fased-signed" });
    await expect(
      applyAgentPublicViewSourceEvent({
        event: {
          ...invalid,
          view: { ...(invalid.view as Record<string, unknown>), privateMaterial: "must-not-index" },
        },
        env: invalidEnv,
      }),
    ).rejects.toThrow("Agent public view is invalid");

    const trustEnv = testEnv();
    const falseFinalized = event({
      id: "declared-as-finalized",
      ordinal: 1,
      source: "owner-declared",
    });
    await expect(
      applyAgentPublicViewSourceEvent({
        event: {
          ...falseFinalized,
          view: { ...(falseFinalized.view as Record<string, unknown>), trust: "finalized" },
        },
        env: trustEnv,
      }),
    ).rejects.toThrow("trust does not match");
  });
});
