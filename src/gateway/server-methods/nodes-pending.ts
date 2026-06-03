import {
  acknowledgeNodePendingWork,
  drainNodePendingWork,
  enqueueNodePendingWork,
  type NodePendingWorkPriority,
  type NodePendingWorkType,
} from "../node-pending-work.js";
import { maybeWakeNodeWithApns } from "../node-wake-apns.js";
import {
  ErrorCodes,
  errorShape,
  validateNodePendingAckParams,
  validateNodePendingDrainParams,
  validateNodePendingEnqueueParams,
  validateNodePendingPullParams,
} from "../protocol/index.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

function resolveClientNodeId(client: GatewayClient | null): string | null {
  const nodeId = client?.connect.device?.id ?? client?.connect.client.id ?? "";
  const trimmed = nodeId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireConnectedNodeIdentity(params: {
  client: GatewayClient | null;
  respond: RespondFn;
  method: string;
}): string | null {
  const nodeId = resolveClientNodeId(params.client);
  if (nodeId) {
    return nodeId;
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `${params.method} requires a connected node identity`),
  );
  return null;
}

export const nodePendingHandlers: GatewayRequestHandlers = {
  "node.pending.drain": async ({ params, respond, client }) => {
    if (!validateNodePendingDrainParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.drain",
        validator: validateNodePendingDrainParams,
      });
      return;
    }
    const nodeId = requireConnectedNodeIdentity({
      client,
      respond,
      method: "node.pending.drain",
    });
    if (!nodeId) {
      return;
    }
    const p = params as { maxItems?: number };
    const drained = drainNodePendingWork(nodeId, {
      maxItems: p.maxItems,
      includeDefaultStatus: true,
    });
    respond(true, { nodeId, ...drained }, undefined);
  },

  "node.pending.pull": async ({ params, respond, client }) => {
    if (!validateNodePendingPullParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.pull",
        validator: validateNodePendingPullParams,
      });
      return;
    }
    const nodeId = requireConnectedNodeIdentity({
      client,
      respond,
      method: "node.pending.pull",
    });
    if (!nodeId) {
      return;
    }
    const p = params as { maxItems?: number };
    const drained = drainNodePendingWork(nodeId, {
      maxItems: p.maxItems,
      includeDefaultStatus: true,
    });
    respond(
      true,
      {
        nodeId,
        revision: drained.revision,
        actions: drained.items.map((item) => ({
          id: item.id,
          command: item.type,
          paramsJSON: item.payload ? JSON.stringify(item.payload) : null,
          enqueuedAtMs: item.createdAtMs,
        })),
        hasMore: drained.hasMore,
      },
      undefined,
    );
  },

  "node.pending.ack": async ({ params, respond, client }) => {
    if (!validateNodePendingAckParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.ack",
        validator: validateNodePendingAckParams,
      });
      return;
    }
    const nodeId = requireConnectedNodeIdentity({
      client,
      respond,
      method: "node.pending.ack",
    });
    if (!nodeId) {
      return;
    }
    const p = params as { ids: string[] };
    const acked = acknowledgeNodePendingWork({ nodeId, itemIds: p.ids });
    respond(
      true,
      {
        nodeId,
        revision: acked.revision,
        ackedIds: acked.removedItemIds,
        remainingCount: acked.remainingCount,
      },
      undefined,
    );
  },

  "node.pending.enqueue": async ({ params, respond, context }) => {
    if (!validateNodePendingEnqueueParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pending.enqueue",
        validator: validateNodePendingEnqueueParams,
      });
      return;
    }
    const p = params as {
      nodeId: string;
      type: NodePendingWorkType;
      priority?: Exclude<NodePendingWorkPriority, "default">;
      expiresInMs?: number;
      wake?: boolean;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const queued = enqueueNodePendingWork({
        nodeId: p.nodeId,
        type: p.type,
        priority: p.priority,
        expiresInMs: p.expiresInMs,
      });
      const shouldWake = p.wake === true && !queued.deduped && !context.nodeRegistry.get(p.nodeId);
      const wake = shouldWake
        ? await maybeWakeNodeWithApns(p.nodeId, { wakeReason: "node.pending" })
        : null;
      if (wake) {
        context.logGateway.info(
          `node pending wake node=${p.nodeId} type=${p.type} available=${wake.available} ` +
            `throttled=${wake.throttled} path=${wake.path} durationMs=${wake.durationMs} ` +
            `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
        );
      }
      respond(
        true,
        {
          nodeId: p.nodeId,
          revision: queued.revision,
          queued: queued.item,
          wakeTriggered: wake?.path === "sent",
          wake: wake
            ? {
                available: wake.available,
                throttled: wake.throttled,
                path: wake.path,
              }
            : null,
        },
        undefined,
      );
    });
  },
};
