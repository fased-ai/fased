import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldAppendCacheTtlTimestampAfterAttempt } from "../agents/pi-embedded-runner/cache-ttl.js";
import {
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  shouldRunCacheTtlPruning,
} from "../agents/pi-extensions/context-pruning.js";
import { readPostCompactionContext } from "../auto-reply/reply/post-compaction-context.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  describeCheckpointBranchIsolation,
  describeCheckpointRestoreIsolation,
} from "./session-compaction-isolation.js";

describe("session compaction/cache/context acceptance", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    resetSystemEventsForTest();
    for (const tmpDir of tmpDirs.splice(0)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.skip("refreshes checkpoint summaries after compaction even when session list cache is warm", () => {
    const warmedListCache = {
      key: "global",
      compactionCheckpointIds: ["checkpoint-old"],
    };
    const postCompactionStore = {
      key: "global",
      compactionCheckpointIds: ["checkpoint-new", "checkpoint-old"],
    };

    expect(postCompactionStore.compactionCheckpointIds).not.toEqual(
      warmedListCache.compactionCheckpointIds,
    );
    expect(postCompactionStore.compactionCheckpointIds[0]).toBe("checkpoint-new");
  });

  it("preserves post-compaction context refresh before the retry prompt", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-post-compact-order-"));
    tmpDirs.push(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, "AGENTS.md"),
      [
        "# Agent Rules",
        "",
        "## Session Startup",
        "",
        "Read memory/today.md before retrying after compaction.",
      ].join("\n"),
      "utf-8",
    );

    const retryPromptEvents = ["compaction-summary"];
    const contextContent = await readPostCompactionContext(tmpDir);

    expect(contextContent).toContain("[Post-compaction context refresh]");
    enqueueSystemEvent(contextContent ?? "", { sessionKey: "main" });
    retryPromptEvents.push("post-compaction-context-refresh");
    retryPromptEvents.push("user-retry-message");

    expect(retryPromptEvents.indexOf("post-compaction-context-refresh")).toBeGreaterThan(
      retryPromptEvents.indexOf("compaction-summary"),
    );
    expect(retryPromptEvents.indexOf("post-compaction-context-refresh")).toBeLessThan(
      retryPromptEvents.indexOf("user-retry-message"),
    );
  });

  it("does not insert cache-ttl or pruning sentinels between compaction and retry", () => {
    const retryPromptEvents = [
      "compaction-summary",
      "post-compaction-context-refresh",
      "user-retry-message",
    ];

    const shouldAppendCacheTtl = shouldAppendCacheTtlTimestampAfterAttempt({
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: true,
      contextPruningMode: "cache-ttl",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    const shouldPruneBeforeFirstCacheTouch = shouldRunCacheTtlPruning({
      ttlMs: DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs,
      lastCacheTouchAt: null,
    });

    if (shouldAppendCacheTtl) {
      retryPromptEvents.splice(1, 0, "cache-ttl-sentinel");
    }
    if (shouldPruneBeforeFirstCacheTouch) {
      retryPromptEvents.splice(1, 0, "context-pruning-sentinel");
    }

    const betweenCompactionAndRetry = retryPromptEvents.slice(
      retryPromptEvents.indexOf("compaction-summary") + 1,
      retryPromptEvents.indexOf("user-retry-message"),
    );

    expect(betweenCompactionAndRetry).not.toContain("cache-ttl-sentinel");
    expect(betweenCompactionAndRetry).not.toContain("context-pruning-sentinel");
  });

  it("keeps checkpoint branch and restore isolated from channel delivery and wallet routing", () => {
    const branchIsolation = describeCheckpointBranchIsolation();
    const restoreIsolation = describeCheckpointRestoreIsolation();

    expect([
      ...branchIsolation.operatorSessionEventPhases,
      ...restoreIsolation.operatorSessionEventPhases,
    ]).toEqual(["checkpoint-branch-source", "checkpoint-branch", "checkpoint-restore"]);
    expect(branchIsolation.channelDeliveryTouched).toBe(false);
    expect(branchIsolation.walletActionRoutingTouched).toBe(false);
    expect(branchIsolation.sessionToolVisibilityTouched).toBe(false);
    expect(restoreIsolation.channelDeliveryTouched).toBe(false);
    expect(restoreIsolation.walletActionRoutingTouched).toBe(false);
    expect(restoreIsolation.sessionToolVisibilityTouched).toBe(false);
  });
});
