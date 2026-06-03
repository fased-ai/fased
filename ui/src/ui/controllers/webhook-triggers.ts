import type { GatewayBrowserClient } from "../gateway.ts";
import type { WebhookTrigger, WebhookTriggersResult } from "../types.ts";

export type WebhookTriggersState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsSelectedId?: string | null;
  webhookTriggersLoading: boolean;
  webhookTriggersBusy: boolean;
  webhookTriggersError: string | null;
  webhookTriggersMessage: string | null;
  webhookTriggers: WebhookTriggersResult | null;
};

export type WebhookTriggerDraft = {
  id?: string;
  enabled?: boolean;
  name: string;
  path: string;
  action: "agent" | "wake" | "workflow";
  agentId?: string;
  wakeMode?: "now" | "next-heartbeat";
  messageTemplate?: string;
  textTemplate?: string;
  workflowDefinitionId?: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  notifyPolicy?: "silent" | "done_only" | "state_changes";
  allowUnsafeExternalContent?: boolean;
};

export async function loadWebhookTriggers(state: WebhookTriggersState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  if (!opts?.quiet) {
    state.webhookTriggersLoading = true;
  }
  state.webhookTriggersError = null;
  try {
    state.webhookTriggers = await state.client.request<WebhookTriggersResult>(
      "webhookTriggers.list",
      state.agentsSelectedId ? { agentId: state.agentsSelectedId } : {},
    );
  } catch (err) {
    state.webhookTriggersError = String(err);
  } finally {
    if (!opts?.quiet) {
      state.webhookTriggersLoading = false;
    }
  }
}

export async function saveWebhookTrigger(state: WebhookTriggersState, draft: WebhookTriggerDraft) {
  if (!state.client || !state.connected || state.webhookTriggersBusy) {
    return;
  }
  state.webhookTriggersBusy = true;
  state.webhookTriggersError = null;
  state.webhookTriggersMessage = null;
  try {
    const result = await state.client.request<WebhookTriggersResult>(
      "webhookTriggers.upsert",
      draft,
    );
    state.webhookTriggers = result;
    state.webhookTriggersMessage = result.tokenCreated
      ? "Webhook trigger saved. A new hook token was generated and shown once."
      : "Webhook trigger saved.";
  } catch (err) {
    state.webhookTriggersError = String(err);
  } finally {
    state.webhookTriggersBusy = false;
  }
}

export async function removeWebhookTrigger(state: WebhookTriggersState, trigger: WebhookTrigger) {
  if (!state.client || !state.connected || state.webhookTriggersBusy) {
    return;
  }
  state.webhookTriggersBusy = true;
  state.webhookTriggersError = null;
  state.webhookTriggersMessage = null;
  try {
    const result = await state.client.request<WebhookTriggersResult>("webhookTriggers.remove", {
      id: trigger.id,
      ...(trigger.agentId ? { agentId: trigger.agentId } : {}),
    });
    state.webhookTriggers = result;
    state.webhookTriggersMessage = result.removed
      ? "Webhook trigger removed."
      : "Trigger was gone.";
  } catch (err) {
    state.webhookTriggersError = String(err);
  } finally {
    state.webhookTriggersBusy = false;
  }
}

export async function testWebhookTrigger(state: WebhookTriggersState, trigger: WebhookTrigger) {
  if (!state.client || !state.connected || state.webhookTriggersBusy) {
    return null;
  }
  state.webhookTriggersBusy = true;
  state.webhookTriggersError = null;
  state.webhookTriggersMessage = null;
  try {
    const result = await state.client.request<{ ok?: boolean; task?: unknown }>(
      "webhookTriggers.test",
      {
        id: trigger.id,
        ...(trigger.agentId ? { agentId: trigger.agentId } : {}),
        payload: {
          test: true,
          trigger: trigger.id,
          message: "Control UI webhook trigger test",
        },
      },
    );
    state.webhookTriggersMessage = "Webhook trigger test recorded in Agent tasks.";
    return result;
  } catch (err) {
    state.webhookTriggersError = String(err);
    return null;
  } finally {
    state.webhookTriggersBusy = false;
  }
}

export function triggerToDraft(trigger: WebhookTrigger): WebhookTriggerDraft {
  return {
    id: trigger.id,
    enabled: trigger.enabled,
    name: trigger.name,
    path: trigger.path,
    action: trigger.action,
    agentId: trigger.agentId,
    wakeMode: trigger.wakeMode,
    messageTemplate: trigger.messageTemplate,
    textTemplate: trigger.textTemplate,
    workflowDefinitionId: trigger.workflowDefinitionId,
    deliver: trigger.deliver,
    channel: trigger.channel,
    to: trigger.to,
    model: trigger.model,
    thinking: trigger.thinking,
    timeoutSeconds: trigger.timeoutSeconds,
    notifyPolicy: trigger.notifyPolicy,
    allowUnsafeExternalContent: trigger.allowUnsafeExternalContent,
  };
}
