import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  ModelsAuthClearResult,
  ConfigSchemaResponse,
  ConfigSnapshot,
  ConfigUiHints,
  ModelsAuthConfigureResult,
  ModelsAuthInteractiveStartResult,
  ModelsAuthStatusResult,
  ModelsCatalogStatusResult,
  ModelsAuthStoreMode,
  ModelsAuthStoreResult,
  WizardNextResult,
  WizardStatusResult,
  WizardStep,
} from "../types.ts";
import type { JsonSchema } from "../views/config-form.shared.ts";
import { coerceFormValues } from "./config/form-coerce.ts";
import {
  cloneConfigObject,
  removePathValue,
  serializeConfigForm,
  setPathValue,
} from "./config/form-utils.ts";

export type ConfigAuthActionTone = "info" | "success" | "warn" | "danger";

export type ConfigAuthActionState = {
  profileId: string | null;
  provider?: string | null;
  actionKind?: "store" | "clear" | "interactive";
  tone: ConfigAuthActionTone;
  title: string;
  message: string;
  detail?: string;
  stepType?: WizardStep["type"] | null;
  active: boolean;
  hasUrl?: boolean;
  url?: string | null;
  retryable?: boolean;
  prompt?: {
    stepId: string;
    type: WizardStep["type"];
    message: string;
    placeholder?: string;
    initialValue?: unknown;
    options?: WizardStep["options"];
  } | null;
};

export type ConfigAuthPromptAnswer = { cancelled: true } | { cancelled: false; value: unknown };

export type ConfigAuthPromptResolver = (answer: ConfigAuthPromptAnswer) => void;

export type ConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey: string;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  configSnapshot: ConfigSnapshot | null;
  configAuthStatus: ModelsAuthStatusResult | null;
  configModelCatalogStatus: ModelsCatalogStatusResult | null;
  configAuthActionBusyProfileId: string | null;
  configAuthAction: ConfigAuthActionState | null;
  configAuthPromptResolver?: ConfigAuthPromptResolver | null;
  configAuthActionRunId?: number;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  lastError: string | null;
};

function setConfigAuthAction(state: ConfigState, next: ConfigAuthActionState | null) {
  state.configAuthAction = next;
}

function toErrorDetail(err: unknown) {
  const message = String(err).trim();
  return message.startsWith("Error: ") ? message.slice(7) : message;
}

function isInteractiveStartUnexpectedPropertyError(err: unknown, property: string) {
  const detail = toErrorDetail(err);
  return (
    detail.includes("models.auth.interactive.start") &&
    detail.includes(property) &&
    detail.includes("unexpected property")
  );
}

function isReplaceRunningUnsupportedError(err: unknown) {
  return isInteractiveStartUnexpectedPropertyError(err, "replaceRunning");
}

function isBrowserLocalUnsupportedError(err: unknown) {
  return isInteractiveStartUnexpectedPropertyError(err, "browserLocal");
}

export function buildConfigAuthActionState(params: {
  profileId: string | null;
  provider?: string | null;
  actionKind?: "store" | "clear" | "interactive";
  tone: ConfigAuthActionTone;
  title: string;
  message: string;
  detail?: string;
  stepType?: WizardStep["type"] | null;
  active?: boolean;
  hasUrl?: boolean;
  url?: string | null;
  retryable?: boolean;
  prompt?: ConfigAuthActionState["prompt"];
}): ConfigAuthActionState {
  return {
    profileId: params.profileId,
    provider: params.provider ?? null,
    actionKind: params.actionKind,
    tone: params.tone,
    title: params.title,
    message: params.message,
    detail: params.detail,
    stepType: params.stepType ?? null,
    active: params.active ?? false,
    hasUrl: params.hasUrl ?? false,
    url: params.url ?? null,
    retryable: params.retryable ?? false,
    prompt: params.prompt ?? null,
  };
}

export function submitConfigAuthPrompt(state: ConfigState, value: unknown) {
  const resolver = state.configAuthPromptResolver;
  state.configAuthPromptResolver = null;
  resolver?.({ cancelled: false, value });
}

export function cancelConfigAuthPrompt(state: ConfigState) {
  const resolver = state.configAuthPromptResolver;
  state.configAuthPromptResolver = null;
  resolver?.({ cancelled: true });
}

export function dismissConfigAuthAction(state: ConfigState) {
  const resolver = state.configAuthPromptResolver;
  state.configAuthPromptResolver = null;
  state.configAuthActionRunId = (state.configAuthActionRunId ?? 0) + 1;
  setConfigAuthAction(state, null);
  resolver?.({ cancelled: true });
}

export function describeWizardStepForConfigAction(
  profileId: string,
  step: WizardStep,
  provider?: string,
) {
  const url = findFirstWizardUrl(step);
  const hasUrl = Boolean(url);
  const title = step.title?.trim() || "Continue sign-in";
  const rawMessage = step.message?.trim() || "Follow the next prompt to continue.";
  const message =
    hasUrl && rawMessage.includes(url ?? "")
      ? "Open the sign-in link below, then return here."
      : rawMessage;

  switch (step.type) {
    case "note":
    case "action":
      return buildConfigAuthActionState({
        profileId,
        provider,
        actionKind: "interactive",
        tone: "info",
        title,
        message,
        stepType: step.type,
        active: true,
        hasUrl,
        url,
      });
    case "confirm":
      return buildConfigAuthActionState({
        profileId,
        provider,
        actionKind: "interactive",
        tone: "info",
        title,
        message,
        detail: "Confirm the browser prompt to keep the sign-in flow moving.",
        stepType: step.type,
        active: true,
        hasUrl,
        url,
      });
    case "text":
      return buildConfigAuthActionState({
        profileId,
        provider,
        actionKind: "interactive",
        tone: "info",
        title,
        message,
        stepType: step.type,
        active: true,
        hasUrl,
        url,
      });
    case "select":
    case "multiselect":
      return buildConfigAuthActionState({
        profileId,
        provider,
        actionKind: "interactive",
        tone: "info",
        title,
        message,
        detail: "Choose from the prompt dialog, then return here for the next step.",
        stepType: step.type,
        active: true,
        hasUrl,
        url,
      });
    default:
      return buildConfigAuthActionState({
        profileId,
        provider,
        actionKind: "interactive",
        tone: "info",
        title,
        message,
        stepType: step.type,
        active: true,
        hasUrl,
        url,
      });
  }
}

export async function loadConfig(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.configLoading = true;
  state.lastError = null;
  try {
    const [snapshot, authStatus, modelCatalogStatus] = await Promise.allSettled([
      state.client.request<ConfigSnapshot>("config.get", {}),
      state.client.request<ModelsAuthStatusResult>("models.auth.status", {}),
      state.client.request<ModelsCatalogStatusResult>("models.catalog.status", {}),
    ]);
    if (snapshot.status !== "fulfilled") {
      throw snapshot.reason;
    }
    applyConfigSnapshot(state, snapshot.value);
    state.configAuthStatus = authStatus.status === "fulfilled" ? authStatus.value : null;
    state.configModelCatalogStatus =
      modelCatalogStatus.status === "fulfilled" ? modelCatalogStatus.value : null;
  } catch (err) {
    state.configAuthStatus = null;
    state.configModelCatalogStatus = null;
    state.lastError = String(err);
  } finally {
    state.configLoading = false;
  }
}

export async function storeProviderAuthCredential(
  state: ConfigState,
  params: {
    profileId: string;
    provider: string;
    mode: ModelsAuthStoreMode;
    secret: string;
    email?: string;
  },
) {
  if (!state.client || !state.connected) {
    return false;
  }
  state.configAuthActionBusyProfileId = params.profileId;
  setConfigAuthAction(
    state,
    buildConfigAuthActionState({
      profileId: params.profileId,
      provider: params.provider,
      actionKind: "store",
      tone: "info",
      title: `Saving credential for ${params.profileId}`,
      message: `Updating stored ${params.mode} credential…`,
      detail: "The provider-auth card will refresh after the credential is stored.",
      active: true,
    }),
  );
  state.lastError = null;
  try {
    const result = await state.client.request<ModelsAuthStoreResult>("models.auth.store", params);
    setConfigAuthAction(
      state,
      buildConfigAuthActionState({
        profileId: result.profileId,
        provider: params.provider,
        actionKind: "store",
        tone: "success",
        title: `Credential updated for ${result.profileId}`,
        message: `Stored ${result.mode} credential successfully.`,
        detail: "Live runtime status will refresh below after the reload completes.",
      }),
    );
    await loadConfig(state);
    return true;
  } catch (err) {
    setConfigAuthAction(
      state,
      buildConfigAuthActionState({
        profileId: params.profileId,
        provider: params.provider,
        actionKind: "store",
        tone: "danger",
        title: `Failed to save credential for ${params.profileId}`,
        message: "The credential was not updated.",
        detail: toErrorDetail(err),
        retryable: true,
      }),
    );
    state.lastError = String(err);
    return false;
  } finally {
    state.configAuthActionBusyProfileId = null;
  }
}

export async function configureProviderApiKeyCredential(
  state: ConfigState,
  params: {
    provider: string;
    profileId?: string;
    secret?: string;
    baseUrl?: string;
    modelId?: string;
    compatibility?: "openai" | "anthropic" | "unknown";
    customProviderId?: string;
    alias?: string;
    allowPrivateNetwork?: boolean;
    accountId?: string;
    gatewayId?: string;
    setDefaultModel?: boolean;
  },
) {
  if (!state.client || !state.connected) {
    return false;
  }
  const provider = params.provider.trim();
  const profileId = params.profileId?.trim() || `${provider}:default`;
  state.configAuthActionBusyProfileId = profileId;
  setConfigAuthAction(
    state,
    buildConfigAuthActionState({
      profileId,
      provider,
      actionKind: "store",
      tone: "info",
      title: `Configuring ${provider}`,
      message: "Saving the API key and syncing provider model config…",
      detail:
        "This uses the same provider-specific setup path as CLI/onboarding, then refreshes Providers.",
      active: true,
    }),
  );
  state.lastError = null;
  try {
    const result = await state.client.request<ModelsAuthConfigureResult>("models.auth.configure", {
      provider,
      ...(params.secret ? { secret: params.secret } : {}),
      ...(params.profileId ? { profileId: params.profileId } : {}),
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
      ...(params.modelId ? { modelId: params.modelId } : {}),
      ...(params.compatibility ? { compatibility: params.compatibility } : {}),
      ...(params.customProviderId ? { customProviderId: params.customProviderId } : {}),
      ...(params.alias ? { alias: params.alias } : {}),
      ...(params.allowPrivateNetwork !== undefined
        ? { allowPrivateNetwork: params.allowPrivateNetwork }
        : {}),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.gatewayId ? { gatewayId: params.gatewayId } : {}),
      ...(params.setDefaultModel !== undefined ? { setDefaultModel: params.setDefaultModel } : {}),
    });
    setConfigAuthAction(
      state,
      buildConfigAuthActionState({
        profileId: result.profileId ?? profileId,
        provider: result.provider,
        actionKind: "store",
        tone: "success",
        title: `${result.provider} configured`,
        message: result.defaultModel
          ? `Provider auth is ready. Suggested model: ${result.defaultModel}.`
          : "Provider auth is ready. Choose a default model below.",
        detail:
          result.detail ??
          "Chat and Agents can use this provider after you choose or attach a model.",
      }),
    );
    await loadConfig(state);
    return true;
  } catch (err) {
    setConfigAuthAction(
      state,
      buildConfigAuthActionState({
        profileId,
        provider,
        actionKind: "store",
        tone: "danger",
        title: `Failed to configure ${provider}`,
        message: "The provider-specific setup path did not complete.",
        detail: toErrorDetail(err),
        retryable: true,
      }),
    );
    state.lastError = String(err);
    return false;
  } finally {
    state.configAuthActionBusyProfileId = null;
  }
}

export async function clearProviderAuthCredential(state: ConfigState, profileId: string) {
  if (!state.client || !state.connected) {
    return false;
  }
  state.configAuthActionBusyProfileId = profileId;
  setConfigAuthAction(
    state,
    buildConfigAuthActionState({
      profileId,
      actionKind: "clear",
      tone: "info",
      title: `Clearing stored credential for ${profileId}`,
      message: "Removing the currently stored credential…",
      detail: "The provider-auth card will refresh after the credential is cleared.",
      active: true,
    }),
  );
  state.lastError = null;
  try {
    const result = await state.client.request<ModelsAuthClearResult>("models.auth.clear", {
      profileId,
    });
    setConfigAuthAction(
      state,
      buildConfigAuthActionState({
        profileId: result.profileId,
        actionKind: "clear",
        tone: result.cleared ? "success" : "warn",
        title: result.cleared
          ? `Credential cleared for ${result.profileId}`
          : `No stored credential for ${result.profileId}`,
        message: result.cleared
          ? "Stored credential removed successfully."
          : "There was nothing stored to clear for this profile.",
      }),
    );
    await loadConfig(state);
    return true;
  } catch (err) {
    setConfigAuthAction(
      state,
      buildConfigAuthActionState({
        profileId,
        actionKind: "clear",
        tone: "danger",
        title: `Failed to clear credential for ${profileId}`,
        message: "The stored credential could not be removed.",
        detail: toErrorDetail(err),
        retryable: true,
      }),
    );
    state.lastError = String(err);
    return false;
  } finally {
    state.configAuthActionBusyProfileId = null;
  }
}

function findFirstWizardUrl(step: Pick<WizardStep, "message" | "title">) {
  const match = `${step.title ?? ""}\n${step.message ?? ""}`.match(/https?:\/\/\S+/u);
  return match?.[0] ?? null;
}

function buildWizardStepMessage(step: Pick<WizardStep, "message" | "title">) {
  const title = step.title?.trim();
  const message = step.message?.trim();
  if (title && message) {
    return `${title}\n\n${message}`;
  }
  return title || message || "Continue provider sign-in.";
}

function resolveWizardSelectAnswer(step: WizardStep, rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return step.initialValue;
  }
  const options = step.options ?? [];
  const index = Number.parseInt(trimmed, 10);
  if (Number.isFinite(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.value;
  }
  const matchedOption = options.find(
    (option) =>
      option.label.toLowerCase() === trimmed.toLowerCase() ||
      String(option.value).toLowerCase() === trimmed.toLowerCase(),
  );
  return matchedOption?.value;
}

function resolveWizardMultiSelectAnswer(step: WizardStep, rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return Array.isArray(step.initialValue) ? step.initialValue : [];
  }
  const parts = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const values: unknown[] = [];
  for (const part of parts) {
    const resolved = resolveWizardSelectAnswer(step, part);
    if (resolved === undefined) {
      return undefined;
    }
    values.push(resolved);
  }
  return values;
}

async function promptForWizardStep(
  state: ConfigState,
  step: WizardStep,
  mode: "modal" | "browserPrompt",
) {
  if (step.type === "note" || step.type === "action") {
    return { cancelled: false as const, value: null };
  }

  if (mode === "modal") {
    return await new Promise<ConfigAuthPromptAnswer>((resolve) => {
      state.configAuthPromptResolver = resolve;
      const current = state.configAuthAction;
      setConfigAuthAction(
        state,
        buildConfigAuthActionState({
          profileId: current?.profileId ?? null,
          provider: current?.provider,
          actionKind: current?.actionKind,
          tone: current?.tone ?? "info",
          title: current?.title ?? step.title ?? "Continue sign-in",
          message: current?.message ?? step.message ?? "Continue provider sign-in.",
          detail: current?.detail,
          stepType: step.type,
          active: true,
          hasUrl: current?.hasUrl,
          url: current?.url,
          retryable: current?.retryable,
          prompt: {
            stepId: step.id,
            type: step.type,
            message: buildWizardStepMessage(step),
            ...(step.placeholder ? { placeholder: step.placeholder } : {}),
            ...(step.initialValue !== undefined ? { initialValue: step.initialValue } : {}),
            ...(step.options ? { options: step.options } : {}),
          },
        }),
      );
    });
  }

  if (typeof window === "undefined") {
    throw new Error("Interactive provider auth requires a browser environment.");
  }

  if (step.type === "confirm") {
    return {
      cancelled: false as const,
      value: window.confirm(buildWizardStepMessage(step)),
    };
  }

  if (step.type === "text") {
    const value = window.prompt(
      buildWizardStepMessage(step),
      typeof step.initialValue === "string" ? step.initialValue : "",
    );
    return value === null ? { cancelled: true as const } : { cancelled: false as const, value };
  }

  if (step.type === "select") {
    const options = (step.options ?? [])
      .map(
        (option, index) => `${index + 1}. ${option.label}${option.hint ? ` — ${option.hint}` : ""}`,
      )
      .join("\n");
    while (true) {
      const value = window.prompt(
        `${buildWizardStepMessage(step)}\n\n${options}\n\nChoose a number or exact value.`,
        typeof step.initialValue === "string" ? step.initialValue : "",
      );
      if (value === null) {
        return { cancelled: true as const };
      }
      const resolved = resolveWizardSelectAnswer(step, value);
      if (resolved !== undefined) {
        return { cancelled: false as const, value: resolved };
      }
      window.alert("Invalid selection. Enter a listed number or exact value.");
    }
  }

  if (step.type === "multiselect") {
    const options = (step.options ?? [])
      .map(
        (option, index) => `${index + 1}. ${option.label}${option.hint ? ` — ${option.hint}` : ""}`,
      )
      .join("\n");
    while (true) {
      const value = window.prompt(
        `${buildWizardStepMessage(step)}\n\n${options}\n\nChoose one or more values separated by commas.`,
        Array.isArray(step.initialValue) ? step.initialValue.join(", ") : "",
      );
      if (value === null) {
        return { cancelled: true as const };
      }
      const resolved = resolveWizardMultiSelectAnswer(step, value);
      if (resolved !== undefined) {
        return { cancelled: false as const, value: resolved };
      }
      window.alert("Invalid selection. Use comma-separated numbers or exact values.");
    }
  }

  return { cancelled: false as const, value: null };
}

export async function runInteractiveProviderAuthCredential(
  state: ConfigState,
  params: {
    profileId: string;
    provider: string;
    methodId?: string;
    promptMode?: "modal" | "browserPrompt";
    browserLocal?: boolean;
  },
) {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = (state.configAuthActionRunId ?? 0) + 1;
  state.configAuthActionRunId = runId;
  const isCurrentRun = () => state.configAuthActionRunId === runId;
  if (state.configAuthPromptResolver) {
    const resolver = state.configAuthPromptResolver;
    state.configAuthPromptResolver = null;
    resolver({ cancelled: true });
  }
  state.configAuthActionBusyProfileId = params.profileId;
  let lastWizardUrl: string | null = null;
  let activeWizardSessionId: string | null = null;
  setConfigAuthAction(
    state,
    buildConfigAuthActionState({
      profileId: params.profileId,
      provider: params.provider,
      actionKind: "interactive",
      tone: "info",
      title: `Starting sign-in for ${params.profileId}`,
      message: "Preparing the interactive provider flow…",
      detail: "A browser prompt may open depending on the provider method.",
      active: true,
    }),
  );
  state.lastError = null;
  try {
    let next: ModelsAuthInteractiveStartResult;
    try {
      next = await state.client.request<ModelsAuthInteractiveStartResult>(
        "models.auth.interactive.start",
        {
          provider: params.provider,
          ...(params.methodId ? { methodId: params.methodId } : {}),
          replaceRunning: true,
          ...(params.browserLocal === true ? { browserLocal: true } : {}),
        },
      );
    } catch (err) {
      if (isBrowserLocalUnsupportedError(err)) {
        try {
          next = await state.client.request<ModelsAuthInteractiveStartResult>(
            "models.auth.interactive.start",
            {
              provider: params.provider,
              ...(params.methodId ? { methodId: params.methodId } : {}),
              replaceRunning: true,
            },
          );
        } catch (retryErr) {
          if (!isReplaceRunningUnsupportedError(retryErr)) {
            throw retryErr;
          }
          next = await state.client.request<ModelsAuthInteractiveStartResult>(
            "models.auth.interactive.start",
            {
              provider: params.provider,
              ...(params.methodId ? { methodId: params.methodId } : {}),
            },
          );
        }
      } else if (!isReplaceRunningUnsupportedError(err)) {
        throw err;
      } else {
        try {
          next = await state.client.request<ModelsAuthInteractiveStartResult>(
            "models.auth.interactive.start",
            {
              provider: params.provider,
              ...(params.methodId ? { methodId: params.methodId } : {}),
              ...(params.browserLocal === true ? { browserLocal: true } : {}),
            },
          );
        } catch (retryErr) {
          if (!isBrowserLocalUnsupportedError(retryErr)) {
            throw retryErr;
          }
          next = await state.client.request<ModelsAuthInteractiveStartResult>(
            "models.auth.interactive.start",
            {
              provider: params.provider,
              ...(params.methodId ? { methodId: params.methodId } : {}),
            },
          );
        }
      }
    }
    activeWizardSessionId = next.sessionId;
    if (!activeWizardSessionId) {
      throw new Error("interactive provider auth did not return a session id");
    }

    while (!next.done) {
      const step = next.step;
      if (!step) {
        throw new Error("interactive provider auth did not return a prompt step");
      }
      const describedStep = describeWizardStepForConfigAction(
        params.profileId,
        step,
        params.provider,
      );
      if (describedStep.url) {
        lastWizardUrl = describedStep.url;
      }
      setConfigAuthAction(
        state,
        describedStep.url || !lastWizardUrl
          ? describedStep
          : { ...describedStep, hasUrl: true, url: lastWizardUrl },
      );

      const answer = await promptForWizardStep(state, step, params.promptMode ?? "browserPrompt");
      if (answer.cancelled) {
        const showCancelledState = isCurrentRun() && state.configAuthAction !== null;
        await state.client.request<WizardStatusResult>("wizard.cancel", {
          sessionId: activeWizardSessionId,
        });
        activeWizardSessionId = null;
        if (showCancelledState) {
          setConfigAuthAction(
            state,
            buildConfigAuthActionState({
              profileId: params.profileId,
              provider: params.provider,
              actionKind: "interactive",
              tone: "warn",
              title: `Cancelled sign-in for ${params.profileId}`,
              message: "Interactive sign-in was cancelled before completion.",
              detail: "You can retry from this profile card or reopen the last sign-in page.",
              url: lastWizardUrl,
              hasUrl: Boolean(lastWizardUrl),
              retryable: true,
            }),
          );
        }
        return false;
      }

      next = {
        ...(await state.client.request<WizardNextResult>("wizard.next", {
          sessionId: activeWizardSessionId,
          answer: {
            stepId: step.id,
            value: answer.value,
          },
        })),
        sessionId: activeWizardSessionId,
      };
    }

    if (next.status !== "done") {
      throw new Error(next.error ?? `interactive provider auth ended with status ${next.status}`);
    }
    activeWizardSessionId = null;

    setConfigAuthAction(
      state,
      isCurrentRun()
        ? buildConfigAuthActionState({
            profileId: params.profileId,
            provider: params.provider,
            actionKind: "interactive",
            tone: "success",
            title: `Completed sign-in for ${params.profileId}`,
            message: "Interactive sign-in finished successfully.",
            detail: "Live runtime status will refresh below after the reload completes.",
            url: lastWizardUrl,
            hasUrl: Boolean(lastWizardUrl),
          })
        : state.configAuthAction,
    );
    await loadConfig(state);
    return true;
  } catch (err) {
    if (activeWizardSessionId && state.client && state.connected) {
      try {
        await state.client.request<WizardStatusResult>("wizard.cancel", {
          sessionId: activeWizardSessionId,
        });
      } catch {
        // Keep the original provider-auth error visible.
      }
    }
    if (isCurrentRun()) {
      setConfigAuthAction(
        state,
        buildConfigAuthActionState({
          profileId: params.profileId,
          provider: params.provider,
          actionKind: "interactive",
          tone: "danger",
          title: `Sign-in failed for ${params.profileId}`,
          message: "Interactive provider sign-in did not complete.",
          detail: toErrorDetail(err),
          url: lastWizardUrl,
          hasUrl: Boolean(lastWizardUrl),
          retryable: true,
        }),
      );
    }
    state.lastError = String(err);
    return false;
  } finally {
    if (isCurrentRun()) {
      state.configAuthActionBusyProfileId = null;
    }
  }
}

export async function loadConfigSchema(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.configSchemaLoading) {
    return;
  }
  state.configSchemaLoading = true;
  try {
    const res = await state.client.request<ConfigSchemaResponse>("config.schema", {});
    applyConfigSchema(state, res);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configSchemaLoading = false;
  }
}

export function applyConfigSchema(state: ConfigState, res: ConfigSchemaResponse) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

export function applyConfigSnapshot(state: ConfigState, snapshot: ConfigSnapshot) {
  state.configSnapshot = snapshot;
  const hasRawText = typeof snapshot.raw === "string";
  const rawFromSnapshot: string = hasRawText
    ? String(snapshot.raw)
    : snapshot.config && typeof snapshot.config === "object"
      ? serializeConfigForm(snapshot.config)
      : (state.configRaw ?? "");
  if (!hasRawText) {
    state.configFormMode = "form";
  }
  if (!state.configFormDirty || state.configFormMode === "raw") {
    state.configRaw = rawFromSnapshot;
  } else if (state.configForm) {
    state.configRaw = serializeConfigForm(state.configForm);
  } else {
    state.configRaw = rawFromSnapshot;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  if (!state.configFormDirty) {
    state.configForm = cloneConfigObject(snapshot.config ?? {});
    state.configFormOriginal = cloneConfigObject(snapshot.config ?? {});
    state.configRawOriginal = rawFromSnapshot;
  }
}

function asJsonSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

/**
 * Serialize the form state for submission to `config.set` / `config.apply`.
 *
 * HTML `<input>` elements produce string `.value` properties, so numeric and
 * boolean config fields can leak into `configForm` as strings.  We coerce
 * them back to their schema-defined types before JSON serialization so the
 * gateway's Zod validation always sees correctly typed values.
 */
function serializeFormForSubmit(state: ConfigState): string {
  if (state.configFormMode !== "form" || !state.configForm) {
    return state.configRaw;
  }
  const schema = asJsonSchema(state.configSchema);
  const form = schema
    ? (coerceFormValues(state.configForm, schema) as Record<string, unknown>)
    : state.configForm;
  return serializeConfigForm(form);
}

function isConfigStaleWriteError(err: unknown): boolean {
  const detail = toErrorDetail(err).toLowerCase();
  return (
    detail.includes("config changed since last load") ||
    detail.includes("config base hash required") ||
    detail.includes("config base hash unavailable")
  );
}

async function refreshConfigSnapshotForWrite(state: ConfigState): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const snapshot = await state.client.request<ConfigSnapshot>("config.get", {});
  applyConfigSnapshot(state, snapshot);
  return typeof snapshot.hash === "string" && snapshot.hash.trim() ? snapshot.hash : null;
}

export async function saveConfig(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.configSaving = true;
  state.lastError = null;
  try {
    const raw = serializeFormForSubmit(state);
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return;
    }
    try {
      await state.client.request("config.set", { raw, baseHash });
    } catch (err) {
      if (!isConfigStaleWriteError(err)) {
        throw err;
      }
      const freshHash = await refreshConfigSnapshotForWrite(state);
      if (!freshHash) {
        throw err;
      }
      await state.client.request("config.set", { raw, baseHash: freshHash });
    }
    state.configFormDirty = false;
    await loadConfig(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configSaving = false;
  }
}

export async function applyConfig(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.configApplying = true;
  state.lastError = null;
  try {
    const raw = serializeFormForSubmit(state);
    const baseHash = state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return;
    }
    try {
      await state.client.request("config.apply", {
        raw,
        baseHash,
        sessionKey: state.applySessionKey,
      });
    } catch (err) {
      if (!isConfigStaleWriteError(err)) {
        throw err;
      }
      const freshHash = await refreshConfigSnapshotForWrite(state);
      if (!freshHash) {
        throw err;
      }
      await state.client.request("config.apply", {
        raw,
        baseHash: freshHash,
        sessionKey: state.applySessionKey,
      });
    }
    state.configFormDirty = false;
    await loadConfig(state);
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.configApplying = false;
  }
}

export async function runUpdate(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.updateRunning = true;
  state.lastError = null;
  try {
    const response = await state.client.request<{
      ok?: boolean;
      result?: { status?: string; reason?: string | null };
    }>("update.run", {
      sessionKey: state.applySessionKey,
    });
    if (response?.ok === false || response?.result?.status === "error") {
      const reason = response?.result?.reason?.trim();
      state.lastError = reason ? `Update error: ${reason}` : "Update error";
    }
  } catch (err) {
    state.lastError = String(err);
  } finally {
    state.updateRunning = false;
  }
}

export function updateConfigFormValue(
  state: ConfigState,
  path: Array<string | number>,
  value: unknown,
) {
  const base = cloneConfigObject(state.configForm ?? state.configSnapshot?.config ?? {});
  setPathValue(base, path, value);
  state.configForm = base;
  state.configFormDirty = true;
  if (state.configFormMode === "form") {
    state.configRaw = serializeConfigForm(base);
  }
}

export function removeConfigFormValue(state: ConfigState, path: Array<string | number>) {
  const base = cloneConfigObject(state.configForm ?? state.configSnapshot?.config ?? {});
  removePathValue(base, path);
  state.configForm = base;
  state.configFormDirty = true;
  if (state.configFormMode === "form") {
    state.configRaw = serializeConfigForm(base);
  }
}
