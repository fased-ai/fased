import type { Tab } from "./navigation.ts";
import type { TaskSource, TaskRecord } from "./types.ts";
import type { ChannelsView } from "./views/channels.types.ts";
import type { MiningActivityFilter, MiningPlannerWindow } from "./views/mining.ts";

export type TaskLedgerSourceRoute = {
  tab: Tab;
  hash?: string;
  sessionKey?: string;
  agentsPanel?:
    | "overview"
    | "providers"
    | "sessions"
    | "files"
    | "tools"
    | "skills"
    | "memory"
    | "channels"
    | "services"
    | "coordination"
    | "cron";
  channelsView?: ChannelsView;
  taskLedgerSourceFilter?: TaskSource | "all";
  walletMainPanel?: "wallets" | "access" | "skill-grants";
  walletApprovalsFilter?:
    | "all"
    | "pending"
    | "approved"
    | "executed"
    | "failed"
    | "rejected"
    | "expired";
  miningActivityFilter?: MiningActivityFilter;
  miningActivityWindow?: MiningPlannerWindow;
  loadChannels?: boolean;
  loadCron?: boolean;
};

export function taskLedgerAnchorId(prefix: string, raw?: string | null) {
  const normalized = String(raw ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized ? `${prefix}-${normalized}` : prefix;
}

function taskMetadataString(task: TaskRecord, key: string) {
  const value = task.metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function taskMetadataFirstString(task: TaskRecord, keys: string[]) {
  for (const key of keys) {
    const value = taskMetadataString(task, key);
    if (value) {
      return value;
    }
  }
  return "";
}

function taskLedgerSessionKey(task: TaskRecord) {
  return (
    task.sessionKey?.trim() ||
    taskMetadataString(task, "childSessionKey") ||
    taskMetadataString(task, "sessionKey") ||
    task.requesterSessionKey?.trim() ||
    ""
  );
}

function miningFilterForTask(task: TaskRecord): MiningActivityFilter {
  const action = taskMetadataString(task, "action").toLowerCase();
  if (action.includes("wallet") || action.includes("capital") || action.includes("balance")) {
    return "wallet";
  }
  if (
    taskMetadataFirstString(task, ["cycleId", "currentCycleId", "epochId"]) ||
    /(commit|reveal|claim|dispute|recovery|readiness|start|stop)/u.test(action)
  ) {
    return "cycle";
  }
  return "all";
}

export function resolveTaskLedgerSourceRoute(task: TaskRecord): TaskLedgerSourceRoute {
  const sessionKey = taskLedgerSessionKey(task);
  switch (task.source) {
    case "wallet": {
      const approvalId =
        taskMetadataFirstString(task, ["approvalId", "requestId", "walletApprovalId"]) ||
        task.sourceId ||
        task.taskId;
      return {
        tab: "wallet",
        walletMainPanel: "wallets",
        walletApprovalsFilter: "all",
        hash: taskLedgerAnchorId("wallet-approval", approvalId),
      };
    }
    case "marketplace": {
      const orderId = taskMetadataFirstString(task, ["orderId", "sellerOrderId"]);
      const requestId = taskMetadataString(task, "requestId");
      const offerId = taskMetadataString(task, "offerId");
      const rawId = orderId || requestId || offerId || task.sourceId || task.taskId;
      const prefix = orderId
        ? "marketplace-order"
        : requestId
          ? "marketplace-request"
          : "marketplace-offer";
      return {
        tab: "marketplace",
        hash: taskLedgerAnchorId(prefix, rawId),
      };
    }
    case "mining": {
      const cycleId = taskMetadataFirstString(task, ["cycleId", "currentCycleId", "epochId"]);
      const action = taskMetadataString(task, "action");
      return {
        tab: "mining",
        miningActivityFilter: miningFilterForTask(task),
        miningActivityWindow: "all",
        hash: cycleId
          ? taskLedgerAnchorId("mining-cycle", cycleId)
          : action
            ? taskLedgerAnchorId("mining-action", action)
            : "mining-recent-activity",
      };
    }
    case "channel": {
      const messageId = taskMetadataFirstString(task, [
        "messageId",
        "threadId",
        "channelMessageId",
        "accountId",
      ]);
      return {
        tab: "agents",
        agentsPanel: "channels",
        channelsView: "messages",
        loadChannels: true,
        hash: taskLedgerAnchorId("channel-message", messageId || task.sourceId || task.taskId),
      };
    }
    case "media": {
      const mediaId =
        taskMetadataFirstString(task, ["artifactId", "mediaId", "assetId", "requestId"]) ||
        task.sourceId ||
        task.taskId;
      if (sessionKey) {
        return {
          tab: "chat",
          sessionKey,
          hash: taskLedgerAnchorId("media-artifact", mediaId),
        };
      }
      return {
        tab: "agents",
        agentsPanel: "cron",
        taskLedgerSourceFilter: "media",
        hash: taskLedgerAnchorId("task-ledger", task.taskId),
      };
    }
    case "webhook": {
      const triggerId =
        taskMetadataFirstString(task, ["triggerId", "webhookId", "hookId", "name"]) ||
        task.sourceId ||
        task.taskId;
      return {
        tab: "agents",
        agentsPanel: "cron",
        taskLedgerSourceFilter: "webhook",
        loadCron: true,
        hash: taskLedgerAnchorId("webhook-trigger", triggerId),
      };
    }
    case "cron": {
      const definitionId = task.definitionId?.trim() || task.sourceId?.trim();
      return {
        tab: "agents",
        agentsPanel: "cron",
        taskLedgerSourceFilter: "cron",
        loadCron: true,
        hash: definitionId
          ? taskLedgerAnchorId("scheduled-task", definitionId)
          : taskLedgerAnchorId("task-ledger", task.taskId),
      };
    }
    case "subagent":
      if (sessionKey) {
        return {
          tab: "chat",
          sessionKey,
          hash: taskLedgerAnchorId("task-ledger", task.taskId),
        };
      }
      return {
        tab: "agents",
        agentsPanel: "cron",
        taskLedgerSourceFilter: "subagent",
        hash: taskLedgerAnchorId("task-ledger", task.taskId),
      };
    case "CLI":
      return {
        tab: "agents",
        agentsPanel: "cron",
        taskLedgerSourceFilter: "CLI",
        hash: taskLedgerAnchorId("task-ledger", task.taskId),
      };
  }
}
