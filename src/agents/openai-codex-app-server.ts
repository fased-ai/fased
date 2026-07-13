import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Context, Model, Usage } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai/compat";
import { resolvePluginInstallDir } from "../plugins/install.js";

export const OPENAI_CODEX_APP_SERVER_VERSION = "0.144.1";
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

type JsonObject = Record<string, unknown>;
type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type CodexAppServerModel = {
  id: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  inputModalities: Array<"text" | "image">;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeJwtPayload(token: string): JsonObject | null {
  const encoded = token.split(".")[1];
  if (!encoded) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractOpenAICodexAccountId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  if (!isRecord(auth)) {
    return null;
  }
  const accountId = auth.chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
}

function stateDir(): string {
  return (
    process.env.FASED_STATE_DIR?.trim() ||
    path.join(process.env.HOME?.trim() || os.homedir(), ".fased")
  );
}

function executableName(): string {
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export function codexExecutableCandidates(): string[] {
  const configured = process.env.FASED_CODEX_BIN?.trim();
  const componentRoot = resolvePluginInstallDir("openai-runtime");
  const candidates = [
    configured,
    path.join(componentRoot, "node_modules", ".bin", executableName()),
    path.join(componentRoot, "node_modules", "@openai", "codex", "bin", executableName()),
    "codex",
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

export function resolveOpenAICodexExecutable(): string | null {
  for (const candidate of codexExecutableCandidates()) {
    if (candidate === "codex") {
      return candidate;
    }
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Keep checking managed and PATH candidates.
    }
  }
  return null;
}

function managedCodexHome(): string {
  const directory = path.join(stateDir(), "runtime", "openai-codex");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

class CodexAppServerClient {
  private readonly child;
  private readonly lines;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notificationListeners = new Set<(message: JsonRpcMessage) => void>();
  private nextId = 1;
  private closedError: Error | null = null;

  constructor(command: string) {
    this.child = spawn(
      command,
      ["app-server", "--stdio", "--disable", "shell_tool", "--config", 'web_search="disabled"'],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CODEX_HOME: managedCodexHome(),
        },
      },
    );
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closedError && (code !== 0 || signal)) {
        this.closeWithError(
          new Error(
            `OpenAI sign-in runtime exited (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
    });
  }

  onNotification(listener: (message: JsonRpcMessage) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async request<T = unknown>(
    method: string,
    params: JsonObject = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closedError) {
      throw this.closedError;
    }
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenAI sign-in runtime timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return await promise;
  }

  respond(id: number | string, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  close(): void {
    this.lines.close();
    this.child.kill("SIGTERM");
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const request = this.pending.get(message.id);
      if (!request) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(new Error(message.error.message || "OpenAI sign-in runtime request failed"));
      } else {
        request.resolve(message.result);
      }
      return;
    }
    for (const listener of this.notificationListeners) {
      listener(message);
    }
  }

  private closeWithError(error: Error): void {
    this.closedError = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

async function initializeClient(client: CodexAppServerClient, token: string): Promise<void> {
  const accountId = extractOpenAICodexAccountId(token);
  if (!accountId) {
    throw new Error("OpenAI sign-in token does not contain a ChatGPT account ID");
  }
  await client.request("initialize", {
    clientInfo: {
      name: "fased",
      title: "Fased Agent",
      version: OPENAI_CODEX_APP_SERVER_VERSION,
    },
    capabilities: { experimentalApi: true },
  });
  await client.request("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: token,
    chatgptAccountId: accountId,
    chatgptPlanType: null,
  });
  client.onNotification((message) => {
    if (message.id === undefined || message.method !== "account/chatgptAuthTokens/refresh") {
      return;
    }
    client.respond(message.id, {
      accessToken: token,
      chatgptAccountId: accountId,
      chatgptPlanType: null,
    });
  });
}

function parseAppServerModels(value: unknown): CodexAppServerModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }
  return value.data.flatMap((entry): CodexAppServerModel[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      return [];
    }
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((item) =>
          isRecord(item) && typeof item.reasoningEffort === "string" ? [item.reasoningEffort] : [],
        )
      : [];
    const modalities = Array.isArray(entry.inputModalities)
      ? entry.inputModalities.filter(
          (item): item is "text" | "image" => item === "text" || item === "image",
        )
      : [];
    return [
      {
        id: entry.id.trim(),
        displayName:
          typeof entry.displayName === "string" && entry.displayName.trim()
            ? entry.displayName.trim()
            : entry.id.trim(),
        ...(typeof entry.description === "string" && entry.description.trim()
          ? { description: entry.description.trim() }
          : {}),
        hidden: entry.hidden === true,
        inputModalities: modalities.length > 0 ? modalities : ["text"],
        supportedReasoningEfforts: efforts,
        ...(typeof entry.defaultReasoningEffort === "string"
          ? { defaultReasoningEffort: entry.defaultReasoningEffort }
          : {}),
      },
    ];
  });
}

export async function listOpenAICodexAppServerModels(params: {
  token: string;
  executable?: string;
}): Promise<CodexAppServerModel[]> {
  const executable = params.executable ?? resolveOpenAICodexExecutable();
  if (!executable) {
    throw new Error(
      "OpenAI sign-in runtime is not installed. Run `fased components install openai-runtime`.",
    );
  }
  const client = new CodexAppServerClient(executable);
  try {
    await initializeClient(client, params.token);
    return parseAppServerModels(
      await client.request("model/list", { includeHidden: false }, 15_000),
    ).filter((model) => !model.hidden);
  } finally {
    client.close();
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function renderConversationContext(context: Context): { instructions: string; prompt: string } {
  const messages = context.messages;
  const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
  const latest = latestUserIndex >= 0 ? messages[latestUserIndex] : undefined;
  const prior = messages.slice(0, Math.max(0, latestUserIndex));
  const transcript = prior
    .map((message) => {
      if (message.role === "toolResult") {
        return `Tool ${message.toolName}: ${contentText(message.content)}`;
      }
      return `${message.role === "assistant" ? "Assistant" : "User"}: ${contentText(message.content)}`;
    })
    .filter((value) => !value.endsWith(": "))
    .join("\n\n");
  const instructions = [
    context.systemPrompt?.trim(),
    transcript ? `Conversation before the current user message:\n${transcript}` : "",
    "Answer the current user message directly. Fased tools are unavailable in this transport turn.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    instructions,
    prompt: latest ? contentText(latest.content) : "Continue the conversation.",
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function readUsageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseThreadTokenUsage(value: unknown): Usage | null {
  if (!isRecord(value)) {
    return null;
  }
  const last = isRecord(value.last) ? value.last : null;
  if (!last) {
    return null;
  }
  const input = readUsageNumber(last.inputTokens);
  const output = readUsageNumber(last.outputTokens);
  const cacheRead = readUsageNumber(last.cachedInputTokens);
  const totalTokens = readUsageNumber(last.totalTokens) || input + output;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createOpenAICodexAppServerStreamFn(params?: {
  resolveToken?: () => Promise<string | undefined>;
}): StreamFn {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    const stream = eventStream as unknown as { push(event: unknown): void; end(): void };
    void (async () => {
      const output = {
        role: "assistant" as const,
        content: [] as Array<{ type: "text"; text: string }>,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      let client: CodexAppServerClient | undefined;
      try {
        const token = options?.apiKey?.trim() || (await params?.resolveToken?.())?.trim();
        if (!token) {
          throw new Error("OpenAI ChatGPT sign-in is required");
        }
        const executable = resolveOpenAICodexExecutable();
        if (!executable) {
          throw new Error(
            "OpenAI sign-in runtime is not installed. Run `fased components install openai-runtime`.",
          );
        }
        client = new CodexAppServerClient(executable);
        await initializeClient(client, token);
        const { instructions, prompt } = renderConversationContext(context);
        const started = await client.request<JsonObject>("thread/start", {
          model: model.id,
          cwd: process.cwd(),
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          baseInstructions: instructions,
          config: {
            web_search: "disabled",
            features: { shell_tool: false },
          },
        });
        const thread = isRecord(started.thread) ? started.thread : null;
        const threadId = typeof thread?.id === "string" ? thread.id : "";
        if (!threadId) {
          throw new Error("OpenAI sign-in runtime did not create a thread");
        }
        let text = "";
        let settled = false;
        let settle!: () => void;
        let reject!: (error: Error) => void;
        const completed = new Promise<void>((resolve, rejectPromise) => {
          settle = resolve;
          reject = rejectPromise;
        });
        stream.push({ type: "start", partial: output });
        const unsubscribe = client.onNotification((message) => {
          if (message.id !== undefined && message.method) {
            client?.respond(message.id, {
              contentItems: [{ type: "inputText", text: "Tool unavailable in this Fased turn." }],
              success: false,
            });
            return;
          }
          if (message.method === "item/agentMessage/delta") {
            const delta = typeof message.params?.delta === "string" ? message.params.delta : "";
            if (!delta) {
              return;
            }
            if (text.length === 0) {
              output.content = [{ type: "text", text: "" }];
              stream.push({ type: "text_start", contentIndex: 0, partial: output });
            }
            text += delta;
            output.content[0] = { type: "text", text };
            stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
            return;
          }
          if (message.method === "thread/tokenUsage/updated") {
            const usage = parseThreadTokenUsage(message.params?.tokenUsage);
            if (usage) {
              output.usage = usage;
            }
            return;
          }
          if (message.method !== "turn/completed" || settled) {
            return;
          }
          const turn = isRecord(message.params?.turn) ? message.params.turn : null;
          settled = true;
          if (turn?.status === "completed") {
            settle();
          } else {
            const error = isRecord(turn?.error) ? turn.error : null;
            const status = typeof turn?.status === "string" ? turn.status : "unknown";
            reject(
              new Error(
                typeof error?.message === "string"
                  ? error.message
                  : `OpenAI sign-in turn ended with status ${status}`,
              ),
            );
          }
        });
        await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          ...(options?.reasoning ? { effort: options.reasoning } : {}),
        });
        const abort = () => reject(new Error("Request was aborted"));
        options?.signal?.addEventListener("abort", abort, { once: true });
        try {
          await Promise.race([
            completed,
            new Promise<never>((_, rejectTimeout) => {
              const timer = setTimeout(
                () => rejectTimeout(new Error("OpenAI sign-in turn timed out")),
                DEFAULT_REQUEST_TIMEOUT_MS,
              );
              timer.unref?.();
            }),
          ]);
        } finally {
          options?.signal?.removeEventListener("abort", abort);
          unsubscribe();
        }
        if (text.length > 0) {
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        }
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      } catch (error) {
        const failed = {
          ...output,
          stopReason: options?.signal?.aborted ? ("aborted" as const) : ("error" as const),
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        stream.push({ type: "error", reason: failed.stopReason, error: failed });
        stream.end();
      } finally {
        client?.close();
      }
    })();
    return eventStream as unknown as ReturnType<StreamFn>;
  };
}

export function isOpenAICodexAppServerModel(model: Model<Api>): boolean {
  return (
    model.provider === "openai-codex" &&
    (model.compat as { responsesLite?: unknown } | undefined)?.responsesLite === true
  );
}

export const testing = {
  parseAppServerModels,
  parseThreadTokenUsage,
  renderConversationContext,
};
