import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai/compat";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { formatErrorMessage } from "../infra/errors.js";

export const OLLAMA_NATIVE_BASE_URL = "http://127.0.0.1:11434";

type ProviderRuntimeModel = {
  id?: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  headers?: unknown;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  params?: Record<string, unknown>;
};

type ProviderWrapStreamFnContext = {
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  streamFn?: StreamFn;
  config?: unknown;
  thinkingLevel?: unknown;
  extraParams?: Record<string, unknown>;
};

type OllamaThinkValue = boolean | "low" | "medium" | "high";

const MAX_SAFE_INTEGER_ABS_STR = String(Number.MAX_SAFE_INTEGER);
const CHARS_PER_TOKEN_ESTIMATE = 4;
const OLLAMA_OPTION_PARAM_KEYS = new Set([
  "num_keep",
  "seed",
  "num_predict",
  "top_k",
  "top_p",
  "min_p",
  "typical_p",
  "repeat_last_n",
  "temperature",
  "repeat_penalty",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "num_ctx",
  "num_batch",
  "num_gpu",
  "main_gpu",
  "use_mmap",
  "num_thread",
]);
const OLLAMA_TOP_LEVEL_PARAM_KEYS = new Set(["format", "keep_alive", "truncate", "shift"]);

const GARBLED_VISIBLE_TEXT_MODEL_RE = /\b(?:glm|kimi)\b/i;
const GARBLED_VISIBLE_TEXT_MIN_CHARS = 80;
const GARBLED_VISIBLE_TEXT_SYMBOL_RE = /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]/gu;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/gu;

interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream: boolean;
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  think?: OllamaThinkValue;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: {
    role: "assistant";
    content: string;
    thinking?: string;
    reasoning?: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

type InputContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown };

type StreamModelDescriptor = {
  api: string;
  provider: string;
  id: string;
};

type OllamaUsageFallback = {
  input?: number;
  output?: number;
};

function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function parseJsonNumberToken(
  input: string,
  start: number,
): { token: string; end: number; isInteger: boolean } | null {
  let idx = start;
  if (input[idx] === "-") {
    idx += 1;
  }
  if (idx >= input.length) {
    return null;
  }
  if (input[idx] === "0") {
    idx += 1;
  } else if (isAsciiDigit(input[idx]) && input[idx] !== "0") {
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  } else {
    return null;
  }
  let isInteger = true;
  if (input[idx] === ".") {
    isInteger = false;
    idx += 1;
    if (!isAsciiDigit(input[idx])) {
      return null;
    }
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  }
  if (input[idx] === "e" || input[idx] === "E") {
    isInteger = false;
    idx += 1;
    if (input[idx] === "+" || input[idx] === "-") {
      idx += 1;
    }
    if (!isAsciiDigit(input[idx])) {
      return null;
    }
    while (isAsciiDigit(input[idx])) {
      idx += 1;
    }
  }
  return { token: input.slice(start, idx), end: idx, isInteger };
}

function isUnsafeIntegerLiteral(token: string): boolean {
  const digits = token[0] === "-" ? token.slice(1) : token;
  if (digits.length < MAX_SAFE_INTEGER_ABS_STR.length) {
    return false;
  }
  if (digits.length > MAX_SAFE_INTEGER_ABS_STR.length) {
    return true;
  }
  return digits > MAX_SAFE_INTEGER_ABS_STR;
}

function quoteUnsafeIntegerLiterals(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let idx = 0;
  while (idx < input.length) {
    const ch = input[idx] ?? "";
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      idx += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      idx += 1;
      continue;
    }
    if (ch === "-" || isAsciiDigit(ch)) {
      const parsed = parseJsonNumberToken(input, idx);
      if (parsed) {
        out +=
          parsed.isInteger && isUnsafeIntegerLiteral(parsed.token)
            ? `"${parsed.token}"`
            : parsed.token;
        idx = parsed.end;
        continue;
      }
    }
    out += ch;
    idx += 1;
  }
  return out;
}

function parseJsonPreservingUnsafeIntegers(input: string): unknown {
  return JSON.parse(quoteUnsafeIntegerLiterals(input)) as unknown;
}

function parseJsonObjectPreservingUnsafeIntegers(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = parseJsonPreservingUnsafeIntegers(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeOllamaWireModelId(modelId: string, providerId?: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const candidates = [providerId?.trim(), normalizeProviderId(providerId ?? ""), "ollama"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of new Set(candidates)) {
    const prefix = `${candidate}/`;
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re)).length;
}

function maxCharacterFrequency(text: string): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const char of text) {
    const count = (counts.get(char) ?? 0) + 1;
    counts.set(char, count);
    max = Math.max(max, count);
  }
  return max;
}

function isLikelyGarbledVisibleText(params: { text: string; modelId: string }): boolean {
  if (!GARBLED_VISIBLE_TEXT_MODEL_RE.test(params.modelId)) {
    return false;
  }
  const compact = params.text.replace(/\s+/g, "");
  if (compact.length < GARBLED_VISIBLE_TEXT_MIN_CHARS) {
    return false;
  }
  const letterOrDigitCount = countMatches(compact, LETTER_OR_DIGIT_RE);
  const symbolCount = countMatches(compact, GARBLED_VISIBLE_TEXT_SYMBOL_RE);
  const maxFrequency = maxCharacterFrequency(compact);
  return (
    letterOrDigitCount / compact.length < 0.08 &&
    symbolCount / compact.length > 0.6 &&
    (maxFrequency / compact.length > 0.22 ||
      /[$#%&="'_~`^|\\/*+\-[\]{}()<>:;,.!?]{12,}/u.test(compact))
  );
}

export function resolveOllamaBaseUrlForRun(params: {
  modelBaseUrl?: string;
  providerBaseUrl?: string;
}): string {
  return params.providerBaseUrl?.trim() || params.modelBaseUrl?.trim() || OLLAMA_NATIVE_BASE_URL;
}

function resolveConfiguredProvider(params: { config?: unknown; providerId?: string }) {
  const providers = (
    params.config as { models?: { providers?: Record<string, unknown> } } | undefined
  )?.models?.providers;
  const providerId = params.providerId?.trim();
  if (!providers || !providerId) {
    return undefined;
  }
  const direct = providers[providerId];
  if (direct) {
    return direct as Record<string, unknown>;
  }
  const normalized = normalizeProviderId(providerId);
  for (const [candidateId, candidate] of Object.entries(providers)) {
    if (normalizeProviderId(candidateId) === normalized) {
      return candidate as Record<string, unknown>;
    }
  }
  return undefined;
}

export function isOllamaCompatProvider(model: {
  provider?: string;
  baseUrl?: string;
  api?: string;
}): boolean {
  const providerId = normalizeProviderId(model.provider ?? "");
  if (providerId === "ollama" || providerId.includes("ollama")) {
    return true;
  }
  if (!model.baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(model.baseUrl);
    const host = parsed.hostname.toLowerCase();
    const localhost = host === "localhost" || host === "127.0.0.1" || host === "::1";
    return localhost && parsed.port === "11434";
  } catch {
    return false;
  }
}

export function resolveOllamaCompatNumCtxEnabled(params: {
  config?: unknown;
  providerId?: string;
}): boolean {
  return resolveConfiguredProvider(params)?.injectNumCtxForOpenAICompat !== false;
}

export function shouldInjectOllamaCompatNumCtx(params: {
  model: { api?: string; provider?: string; baseUrl?: string };
  config?: unknown;
  providerId?: string;
}): boolean {
  return (
    params.model.api === "openai-completions" &&
    isOllamaCompatProvider(params.model) &&
    resolveOllamaCompatNumCtxEnabled({ config: params.config, providerId: params.providerId })
  );
}

function streamWithPayloadPatch(
  baseFn: StreamFn | undefined,
  model: Parameters<StreamFn>[0],
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  patch: (payload: Record<string, unknown>) => void,
) {
  const streamFn = baseFn ?? streamSimple;
  return streamFn(model, context, {
    ...options,
    onPayload: (payload: unknown, payloadModel?: unknown) => {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        patch(payload as Record<string, unknown>);
      }
      (options?.onPayload as ((payload: unknown, payloadModel?: unknown) => void) | undefined)?.(
        payload,
        payloadModel,
      );
    },
  } as never);
}

export function wrapOllamaCompatNumCtx(baseFn: StreamFn | undefined, numCtx: number): StreamFn {
  return (model, context, options) =>
    streamWithPayloadPatch(baseFn, model, context, options, (payloadRecord) => {
      if (!payloadRecord.options || typeof payloadRecord.options !== "object") {
        payloadRecord.options = {};
      }
      (payloadRecord.options as Record<string, unknown>).num_ctx = numCtx;
      normalizeOllamaCompatMessageToolArgs(payloadRecord);
    });
}

function resolveOllamaThinkValue(thinkingLevel: unknown): OllamaThinkValue | undefined {
  if (thinkingLevel === "off") {
    return false;
  }
  if (thinkingLevel === "low" || thinkingLevel === "medium" || thinkingLevel === "high") {
    return thinkingLevel;
  }
  if (thinkingLevel === "minimal") {
    return "low";
  }
  if (thinkingLevel === "xhigh" || thinkingLevel === "adaptive" || thinkingLevel === "max") {
    return "high";
  }
  return undefined;
}

function resolveOllamaThinkParamValue(
  params: Record<string, unknown> | undefined,
): OllamaThinkValue | undefined {
  const raw = params?.think ?? params?.thinking;
  if (typeof raw === "boolean") {
    return raw;
  }
  return resolveOllamaThinkValue(raw);
}

function shouldForwardNativeOllamaThink(
  model: ProviderRuntimeModel | undefined,
  think: OllamaThinkValue,
): boolean {
  return think === false || model?.reasoning !== false;
}

function resolveOllamaConfiguredNumCtx(model: ProviderRuntimeModel): number | undefined {
  const raw = model.params?.num_ctx;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

function resolveOllamaNumCtx(model: ProviderRuntimeModel): number {
  return (
    resolveOllamaConfiguredNumCtx(model) ??
    Math.max(1, Math.floor(model.contextWindow ?? model.maxTokens ?? DEFAULT_CONTEXT_TOKENS))
  );
}

function createOllamaThinkingWrapper(
  baseFn: StreamFn | undefined,
  think: OllamaThinkValue,
): StreamFn {
  return (model, context, options) =>
    streamWithPayloadPatch(baseFn, model, context, options, (payloadRecord) => {
      payloadRecord.think = think;
    });
}

export function createConfiguredOllamaCompatStreamWrapper(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  let streamFn = ctx.streamFn;
  const model = ctx.model;
  if (
    model &&
    shouldInjectOllamaCompatNumCtx({
      model,
      config: ctx.config,
      providerId: typeof model.provider === "string" ? model.provider : ctx.provider,
    })
  ) {
    streamFn = wrapOllamaCompatNumCtx(streamFn, resolveOllamaNumCtx(model));
  }

  const configuredThink = model ? resolveOllamaThinkParamValue(model.params) : undefined;
  const runtimeThink =
    model?.api === "ollama" ? resolveOllamaThinkValue(ctx.thinkingLevel) : undefined;
  const think = runtimeThink === false && configuredThink !== undefined ? undefined : runtimeThink;
  if (think !== undefined && shouldForwardNativeOllamaThink(model, think)) {
    streamFn = createOllamaThinkingWrapper(streamFn, think);
  }
  return streamFn;
}

export const createConfiguredOllamaCompatNumCtxWrapper = createConfiguredOllamaCompatStreamWrapper;

export function buildOllamaChatRequest(params: {
  modelId: string;
  providerId?: string;
  messages: OllamaChatMessage[];
  tools?: OllamaTool[];
  options?: Record<string, unknown>;
  requestParams?: Record<string, unknown>;
  stream?: boolean;
}): OllamaChatRequest {
  return {
    model: normalizeOllamaWireModelId(params.modelId, params.providerId),
    messages: params.messages,
    stream: params.stream ?? true,
    ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params.options ? { options: params.options } : {}),
    ...params.requestParams,
  };
}

function buildUsageWithNoCost(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}): Usage {
  const input = params.input ?? 0;
  const output = params.output ?? 0;
  const cacheRead = params.cacheRead ?? 0;
  const cacheWrite = params.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: params.totalTokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildStreamAssistantMessage(params: {
  model: StreamModelDescriptor;
  content: AssistantMessage["content"];
  stopReason: StopReason;
  usage: Usage;
  timestamp?: number;
}): AssistantMessage {
  return {
    role: "assistant",
    content: params.content,
    stopReason: params.stopReason,
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: params.usage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

function buildStreamErrorAssistantMessage(params: {
  model: StreamModelDescriptor;
  errorMessage: string;
}) {
  return {
    ...buildStreamAssistantMessage({
      model: params.model,
      content: [],
      stopReason: "error" as StopReason,
      usage: buildUsageWithNoCost({}),
    }),
    stopReason: "error",
    errorMessage: params.errorMessage,
  };
}

function safeJsonLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : 0;
  } catch {
    return 0;
  }
}

function estimateTokensFromChars(chars: number): number {
  return Number.isFinite(chars) && chars > 0
    ? Math.max(1, Math.round(chars / CHARS_PER_TOKEN_ESTIMATE))
    : 0;
}

function estimateOllamaPromptTokens(params: {
  messages: OllamaChatMessage[];
  tools: OllamaTool[];
}): number {
  let chars = 0;
  for (const message of params.messages) {
    chars += message.content.length;
    chars += safeJsonLength(message.images);
    chars += safeJsonLength(message.tool_calls);
    chars += message.tool_name?.length ?? 0;
  }
  chars += safeJsonLength(params.tools);
  return estimateTokensFromChars(chars);
}

function estimateOllamaCompletionTokens(response: OllamaChatResponse): number {
  return estimateTokensFromChars(
    response.message.content.length +
      (response.message.thinking?.length ?? 0) +
      (response.message.reasoning?.length ?? 0) +
      safeJsonLength(response.message.tool_calls),
  );
}

function resolveUsageCount(value: number | undefined, fallback: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function extractOllamaImages(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return (content as InputContentPart[])
    .filter((part): part is { type: "image"; data: string } => part.type === "image")
    .map((part) => part.data);
}

function ensureArgsObject(value: unknown): Record<string, unknown> {
  return parseJsonObjectPreservingUnsafeIntegers(value) ?? {};
}

function normalizeOllamaCompatMessageToolArgs(payloadRecord: Record<string, unknown>): void {
  const messages = payloadRecord.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    const functionCall = messageRecord.function_call;
    if (functionCall && typeof functionCall === "object" && !Array.isArray(functionCall)) {
      const functionRecord = functionCall as Record<string, unknown>;
      if (Object.hasOwn(functionRecord, "arguments")) {
        functionRecord.arguments = ensureArgsObject(functionRecord.arguments);
      }
    }
    const toolCalls = messageRecord.tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const toolCall of toolCalls) {
      const fn =
        toolCall && typeof toolCall === "object"
          ? (toolCall as Record<string, unknown>).function
          : undefined;
      if (fn && typeof fn === "object" && !Array.isArray(fn) && Object.hasOwn(fn, "arguments")) {
        (fn as Record<string, unknown>).arguments = ensureArgsObject(
          (fn as Record<string, unknown>).arguments,
        );
      }
    }
  }
}

function normalizeOllamaResponseToolArgs(response: OllamaChatResponse): OllamaChatResponse {
  const toolCalls = response.message?.tool_calls;
  if (!toolCalls?.length) {
    return response;
  }
  for (const toolCall of toolCalls) {
    toolCall.function.arguments = ensureArgsObject(toolCall.function.arguments);
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inferOllamaSchemaType(schema: Record<string, unknown>): string | undefined {
  if (schema.properties && isRecord(schema.properties)) {
    return "object";
  }
  if (schema.items) {
    return "array";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((value) => value !== null);
    if (values.length > 0 && values.every((value) => typeof value === "string")) {
      return "string";
    }
    if (values.length > 0 && values.every((value) => typeof value === "number")) {
      return "number";
    }
    if (values.length > 0 && values.every((value) => typeof value === "boolean")) {
      return "boolean";
    }
  }
  return undefined;
}

function normalizeOllamaToolSchema(schema: unknown, isRoot = false): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isRecord(value)) {
      normalized.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, normalizeOllamaToolSchema(child)]),
      );
    } else if (key === "items") {
      normalized.items = Array.isArray(value)
        ? value.map((entry) => normalizeOllamaToolSchema(entry))
        : normalizeOllamaToolSchema(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      normalized[key] = value.map((entry) => normalizeOllamaToolSchema(entry));
    } else {
      normalized[key] = value;
    }
  }
  const schemaType = normalized.type;
  if (
    typeof schemaType !== "string" &&
    (!Array.isArray(schemaType) ||
      !schemaType.some((entry) => typeof entry === "string" && entry !== "null"))
  ) {
    normalized.type = inferOllamaSchemaType(normalized) ?? (isRoot ? "object" : "string");
  }
  if (normalized.type === "object" && !isRecord(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

function readOllamaToolCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOllamaToolCallName(
  rawName: string,
  options: { availableToolNames?: ReadonlySet<string> } = {},
): string {
  const trimmed = rawName.trim();
  const available = options.availableToolNames;
  if (!trimmed || available?.has(trimmed)) {
    return trimmed;
  }
  const stripped = trimmed.replace(/^(?:functions?|tools?)[./_-]+/iu, "").trim();
  if (available) {
    return available.has(stripped) ? stripped : trimmed;
  }
  return stripped;
}

function extractToolCalls(
  content: unknown,
  options: { availableToolNames?: ReadonlySet<string> } = {},
): OllamaToolCall[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const result: OllamaToolCall[] = [];
  for (const part of content as InputContentPart[]) {
    if (part.type === "toolCall") {
      result.push({
        function: {
          name: normalizeOllamaToolCallName(part.name, options),
          arguments: ensureArgsObject(part.arguments),
        },
      });
    } else if (part.type === "tool_use") {
      result.push({
        function: {
          name: normalizeOllamaToolCallName(part.name, options),
          arguments: ensureArgsObject(part.input),
        },
      });
    }
  }
  return result;
}

function buildOllamaToolNameSet(tools: Tool[] | undefined): ReadonlySet<string> | undefined {
  const names = new Set<string>();
  for (const tool of tools ?? []) {
    if (typeof tool.name === "string" && tool.name.trim()) {
      names.add(tool.name.trim());
    }
  }
  return names.size > 0 ? names : undefined;
}

export function convertToOllamaMessages(
  messages: Array<{ role: string; content: unknown }>,
  system?: string,
  options: { availableToolNames?: ReadonlySet<string> } = {},
): OllamaChatMessage[] {
  const result: OllamaChatMessage[] = [];
  if (system) {
    result.push({ role: "system", content: system });
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractTextContent(msg.content);
      const images = extractOllamaImages(msg.content);
      result.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
    } else if (msg.role === "assistant") {
      const text = extractTextContent(msg.content);
      const toolCalls = extractToolCalls(msg.content, options);
      result.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else if (msg.role === "tool" || msg.role === "toolResult") {
      const toolName =
        typeof (msg as { toolName?: unknown }).toolName === "string"
          ? (msg as { toolName?: string }).toolName
          : undefined;
      result.push({
        role: "tool",
        content: extractTextContent(msg.content),
        ...(toolName ? { tool_name: toolName } : {}),
      });
    }
  }
  return result;
}

function extractOllamaTools(tools: Tool[] | undefined): OllamaTool[] {
  return (tools ?? [])
    .filter((tool) => typeof tool.name === "string" && tool.name)
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: normalizeOllamaToolSchema(tool.parameters, true),
      },
    }));
}

export function buildAssistantMessage(
  response: OllamaChatResponse,
  modelInfo: StreamModelDescriptor,
  usageFallback?: OllamaUsageFallback,
  options: { availableToolNames?: ReadonlySet<string> } = {},
): AssistantMessage {
  const content: Array<TextContent | ThinkingContent | ToolCall> = [];
  const text = response.message.content || "";
  if (text) {
    content.push({ type: "text", text });
  }
  const toolCalls = response.message.tool_calls;
  if (toolCalls?.length) {
    for (const toolCall of toolCalls) {
      content.push({
        type: "toolCall",
        id: readOllamaToolCallId(toolCall.id) ?? `ollama_call_${randomUUID()}`,
        name: normalizeOllamaToolCallName(toolCall.function.name, options),
        arguments: ensureArgsObject(toolCall.function.arguments),
      });
    }
  }
  return buildStreamAssistantMessage({
    model: modelInfo,
    content,
    stopReason: toolCalls?.length ? "toolUse" : "stop",
    usage: buildUsageWithNoCost({
      input: resolveUsageCount(response.prompt_eval_count, usageFallback?.input),
      output: resolveUsageCount(response.eval_count, usageFallback?.output),
    }),
  });
}

export async function* parseNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<OllamaChatResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        yield normalizeOllamaResponseToolArgs(
          parseJsonPreservingUnsafeIntegers(trimmed) as OllamaChatResponse,
        );
      }
    }
  }
  if (buffer.trim()) {
    yield normalizeOllamaResponseToolArgs(
      parseJsonPreservingUnsafeIntegers(buffer.trim()) as OllamaChatResponse,
    );
  }
}

function resolveOllamaChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const normalizedBase = trimmed.replace(/\/v1$/i, "");
  return `${normalizedBase || OLLAMA_NATIVE_BASE_URL}/api/chat`;
}

function resolveOllamaModelHeaders(model: {
  headers?: unknown;
}): Record<string, string> | undefined {
  return model.headers && typeof model.headers === "object" && !Array.isArray(model.headers)
    ? (model.headers as Record<string, string>)
    : undefined;
}

function resolveOllamaModelOptions(model: ProviderRuntimeModel): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model.params ?? {})) {
    if (key !== "num_ctx" && value !== undefined && OLLAMA_OPTION_PARAM_KEYS.has(key)) {
      options[key] = value;
    }
  }
  const numCtx = resolveOllamaNumCtx(model);
  if (numCtx !== undefined) {
    options.num_ctx = numCtx;
  }
  return options;
}

function resolveOllamaTopLevelParams(
  model: ProviderRuntimeModel,
): Record<string, unknown> | undefined {
  const requestParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model.params ?? {})) {
    if (value !== undefined && OLLAMA_TOP_LEVEL_PARAM_KEYS.has(key)) {
      requestParams[key] = value;
    }
  }
  const think = resolveOllamaThinkParamValue(model.params);
  if (think !== undefined && shouldForwardNativeOllamaThink(model, think)) {
    requestParams.think = think;
  }
  return Object.keys(requestParams).length ? requestParams : undefined;
}

function isNonSecretApiKeyMarker(value: unknown): boolean {
  return typeof value === "string" && /(?:^|[-_])(local|placeholder|none|dummy)$/i.test(value);
}

export function createOllamaStreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  const chatUrl = resolveOllamaChatUrl(baseUrl);
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      try {
        const availableToolNames = buildOllamaToolNameSet(context.tools);
        const toolCallNameOptions = availableToolNames ? { availableToolNames } : {};
        const ollamaMessages = convertToOllamaMessages(
          context.messages ?? [],
          context.systemPrompt,
          toolCallNameOptions,
        );
        const ollamaTools = extractOllamaTools(context.tools);
        const ollamaOptions = resolveOllamaModelOptions(model as ProviderRuntimeModel);
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }
        if (typeof options?.maxTokens === "number") {
          ollamaOptions.num_predict = options.maxTokens;
        }

        const body = buildOllamaChatRequest({
          modelId: model.id,
          providerId: model.provider,
          messages: ollamaMessages,
          tools: ollamaTools,
          options: ollamaOptions,
          requestParams: resolveOllamaTopLevelParams(model as ProviderRuntimeModel),
          stream: true,
        });
        (options?.onPayload as ((payload: unknown, payloadModel?: unknown) => void) | undefined)?.(
          body,
          model,
        );

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...defaultHeaders,
          ...options?.headers,
        };
        const apiKey = (options as { apiKey?: string } | undefined)?.apiKey;
        if (apiKey && (!headers.Authorization || !isNonSecretApiKeyMarker(apiKey))) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`${response.status} ${errorText}`);
        }
        if (!response.body) {
          throw new Error("Ollama API returned empty response body");
        }

        const reader = response.body.getReader();
        let accumulatedContent = "";
        let accumulatedThinking = "";
        const accumulatedToolCalls: OllamaToolCall[] = [];
        let finalResponse: OllamaChatResponse | undefined;
        const modelInfo = { api: model.api, provider: model.provider, id: model.id };
        let streamStarted = false;
        let thinkingStarted = false;
        let thinkingEnded = false;
        let textBlockStarted = false;
        let textBlockClosed = false;
        const textContentIndex = () => (thinkingStarted ? 1 : 0);
        const buildCurrentContent = (): Array<TextContent | ThinkingContent | ToolCall> => {
          const parts: Array<TextContent | ThinkingContent | ToolCall> = [];
          if (accumulatedThinking) {
            parts.push({ type: "thinking", thinking: accumulatedThinking });
          }
          if (accumulatedContent) {
            parts.push({ type: "text", text: accumulatedContent });
          }
          return parts;
        };
        const closeThinkingBlock = () => {
          if (!thinkingStarted || thinkingEnded) {
            return;
          }
          thinkingEnded = true;
          stream.push({
            type: "thinking_end",
            contentIndex: 0,
            content: accumulatedThinking,
            partial: buildStreamAssistantMessage({
              model: modelInfo,
              content: buildCurrentContent(),
              stopReason: "stop",
              usage: buildUsageWithNoCost({}),
            }),
          } as never);
        };
        const closeTextBlock = () => {
          if (!textBlockStarted || textBlockClosed) {
            return;
          }
          textBlockClosed = true;
          stream.push({
            type: "text_end",
            contentIndex: textContentIndex(),
            content: accumulatedContent,
            partial: buildStreamAssistantMessage({
              model: modelInfo,
              content: buildCurrentContent(),
              stopReason: "stop",
              usage: buildUsageWithNoCost({}),
            }),
          } as never);
        };

        for await (const chunk of parseNdjsonStream(reader)) {
          const thinkingDelta = chunk.message?.thinking ?? chunk.message?.reasoning;
          if (thinkingDelta) {
            if (!streamStarted) {
              streamStarted = true;
              stream.push({
                type: "start",
                partial: buildStreamAssistantMessage({
                  model: modelInfo,
                  content: [],
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                }),
              } as never);
            }
            if (!thinkingStarted) {
              thinkingStarted = true;
              stream.push({
                type: "thinking_start",
                contentIndex: 0,
                partial: buildStreamAssistantMessage({
                  model: modelInfo,
                  content: buildCurrentContent(),
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                }),
              } as never);
            }
            accumulatedThinking += thinkingDelta;
            stream.push({
              type: "thinking_delta",
              contentIndex: 0,
              delta: thinkingDelta,
              partial: buildStreamAssistantMessage({
                model: modelInfo,
                content: buildCurrentContent(),
                stopReason: "stop",
                usage: buildUsageWithNoCost({}),
              }),
            } as never);
          }

          if (chunk.message?.content) {
            const delta = chunk.message.content;
            if (thinkingStarted && !thinkingEnded) {
              closeThinkingBlock();
            }
            if (!streamStarted) {
              streamStarted = true;
              stream.push({
                type: "start",
                partial: buildStreamAssistantMessage({
                  model: modelInfo,
                  content: [],
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                }),
              } as never);
            }
            if (!textBlockStarted) {
              textBlockStarted = true;
              stream.push({
                type: "text_start",
                contentIndex: textContentIndex(),
                partial: buildStreamAssistantMessage({
                  model: modelInfo,
                  content: buildCurrentContent(),
                  stopReason: "stop",
                  usage: buildUsageWithNoCost({}),
                }),
              } as never);
            }
            accumulatedContent += delta;
            stream.push({
              type: "text_delta",
              contentIndex: textContentIndex(),
              delta,
              partial: buildStreamAssistantMessage({
                model: modelInfo,
                content: buildCurrentContent(),
                stopReason: "stop",
                usage: buildUsageWithNoCost({}),
              }),
            } as never);
          }
          if (chunk.message?.tool_calls) {
            closeThinkingBlock();
            closeTextBlock();
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }
          if (chunk.done) {
            finalResponse = chunk;
            break;
          }
        }

        if (!finalResponse) {
          throw new Error("Ollama API stream ended without a final response");
        }
        if (isLikelyGarbledVisibleText({ text: accumulatedContent, modelId: model.id })) {
          throw new Error(
            `Ollama returned non-linguistic garbled visible text for ${model.id}; retry or switch models`,
          );
        }
        finalResponse.message.content = accumulatedContent;
        if (accumulatedContent) {
          delete finalResponse.message.thinking;
          delete finalResponse.message.reasoning;
        } else if (accumulatedThinking) {
          finalResponse.message.thinking = "";
        }
        if (accumulatedToolCalls.length > 0) {
          finalResponse.message.tool_calls = accumulatedToolCalls;
        }
        const assistantMessage = buildAssistantMessage(
          finalResponse,
          modelInfo,
          {
            input: estimateOllamaPromptTokens({ messages: ollamaMessages, tools: ollamaTools }),
            output: estimateOllamaCompletionTokens(finalResponse),
          },
          toolCallNameOptions,
        );
        closeThinkingBlock();
        closeTextBlock();
        stream.push({
          type: "done",
          reason: assistantMessage.stopReason === "toolUse" ? "toolUse" : "stop",
          message: assistantMessage,
        } as never);
      } catch (err) {
        stream.push({
          type: "error",
          reason: "error",
          error: buildStreamErrorAssistantMessage({
            model: {
              api: String(model.api),
              provider: String(model.provider),
              id: String(model.id),
            },
            errorMessage: formatErrorMessage(err),
          }),
        } as never);
      } finally {
        stream.end();
      }
    };
    queueMicrotask(() => void run());
    return stream;
  };
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createConfiguredOllamaStreamFn(params: {
  model: { baseUrl?: string; headers?: unknown };
  providerBaseUrl?: string;
}): StreamFn {
  return createOllamaStreamFn(
    resolveOllamaBaseUrlForRun({
      modelBaseUrl: readStringValue(params.model.baseUrl),
      providerBaseUrl: params.providerBaseUrl,
    }),
    resolveOllamaModelHeaders(params.model),
  );
}
