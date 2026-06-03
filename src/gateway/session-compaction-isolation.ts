import type { SessionEntry } from "../config/sessions.js";

export type SessionCompactionCheckpointIsolation = {
  operatorSessionEventPhases: readonly string[];
  channelDeliveryTouched: false;
  walletActionRoutingTouched: false;
  sessionToolVisibilityTouched: false;
};

export function clearCheckpointBranchIsolationFields(entry: SessionEntry): void {
  delete entry.spawnedBy;
  delete entry.spawnDepth;
  delete entry.channel;
  delete entry.groupId;
  delete entry.subject;
  delete entry.groupChannel;
  delete entry.space;
  delete entry.origin;
  delete entry.deliveryContext;
  delete entry.lastChannel;
  delete entry.lastTo;
  delete entry.lastAccountId;
  delete entry.lastThreadId;
}

export function describeCheckpointBranchIsolation(): SessionCompactionCheckpointIsolation {
  return {
    operatorSessionEventPhases: ["checkpoint-branch-source", "checkpoint-branch"],
    channelDeliveryTouched: false,
    walletActionRoutingTouched: false,
    sessionToolVisibilityTouched: false,
  };
}

export function describeCheckpointRestoreIsolation(): SessionCompactionCheckpointIsolation {
  return {
    operatorSessionEventPhases: ["checkpoint-restore"],
    channelDeliveryTouched: false,
    walletActionRoutingTouched: false,
    sessionToolVisibilityTouched: false,
  };
}
