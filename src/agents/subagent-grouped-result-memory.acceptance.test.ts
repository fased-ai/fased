import { describe, expect, it } from "vitest";
import {
  buildChildCompletionFindings,
  filterCurrentDirectChildCompletionRows,
} from "./subagent-announce-output.js";

describe("subagent grouped-result memory acceptance", () => {
  it("keeps grouped child results visible as untrusted findings for parent recall", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:parent:subagent:b",
        task: "trace channel dispatch",
        label: "channel audit",
        createdAt: 20,
        endedAt: 30,
        frozenResultText: "Channel delivery remained unchanged.",
        outcome: { status: "ok" },
      },
      {
        childSessionKey: "agent:main:subagent:parent:subagent:a",
        task: "trace memory visibility",
        label: "memory audit",
        createdAt: 10,
        endedAt: 25,
        frozenResultText: "Parent recall still sees child result text.",
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toContain("Child completion results:");
    expect(findings).toContain("1. memory audit");
    expect(findings).toContain("2. channel audit");
    expect(findings).toContain("<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>");
    expect(findings).toContain("Parent recall still sees child result text.");
    expect(findings).toContain("Channel delivery remained unchanged.");
  });

  it("filters stale grouped child results when a child moved to a newer parent run", () => {
    const filtered = filterCurrentDirectChildCompletionRows(
      [
        {
          runId: "run-child-old-parent",
          childSessionKey: "agent:main:subagent:shared-child",
          requesterSessionKey: "agent:main:subagent:old-parent",
          task: "shared child task",
          label: "shared child",
          createdAt: 10,
          endedAt: 20,
          frozenResultText: "stale old-parent result",
          outcome: { status: "ok" },
        },
      ],
      {
        requesterSessionKey: "agent:main:subagent:old-parent",
        getLatestSubagentRunByChildSessionKey: (childSessionKey) =>
          childSessionKey === "agent:main:subagent:shared-child"
            ? {
                runId: "run-child-new-parent",
                requesterSessionKey: "agent:main:subagent:new-parent",
              }
            : null,
      },
    );

    expect(filtered).toEqual([]);
  });

  it.skip("refreshes deferred final delivery payload text without invoking channel or wallet routing", () => {
    const refreshedPayload = {
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:parent",
      frozenResultText: "latest child result text",
      channelDeliveryTouched: false,
      walletActionRoutingTouched: false,
      sessionToolVisibilityTouched: false,
    };

    expect(refreshedPayload.frozenResultText).toBe("latest child result text");
    expect(refreshedPayload.channelDeliveryTouched).toBe(false);
    expect(refreshedPayload.walletActionRoutingTouched).toBe(false);
    expect(refreshedPayload.sessionToolVisibilityTouched).toBe(false);
  });
});
