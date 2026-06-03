import { fetchWithSsrFGuard } from "fased/plugin-sdk";
import { ACPX_STATUS_MCP_TOOL_NAME, type AcpxMcpStatusEndpoint } from "./mcp-status-server.js";

const DEFAULT_STATUS_PREVIEW_TIMEOUT_MS = 1_500;
const MAX_GROUPS = 20;
const MAX_TOOLS_PER_GROUP = 40;
const MAX_CONTEXT_CHARS = 12_000;
const ACPX_STATUS_ENDPOINT_HOST = "127.0.0.1";

type GuardedLookupFn = NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

type PreviewTool = {
  id?: unknown;
  label?: unknown;
  source?: unknown;
  pluginId?: unknown;
  channelId?: unknown;
};

type PreviewGroup = {
  id?: unknown;
  label?: unknown;
  source?: unknown;
  tools?: unknown;
};

type PreviewPayload = {
  bridge?: {
    mode?: unknown;
  };
  agentId?: unknown;
  profile?: unknown;
  groups?: unknown;
};

function asCleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trimToLimit(value: string): string {
  if (value.length <= MAX_CONTEXT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_CONTEXT_CHARS - 32)}\n[truncated]\n`;
}

function firstTextContent(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "";
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      return record.text;
    }
  }
  return "";
}

const loopbackLookupFn = (async (hostname: string) => {
  if (hostname !== ACPX_STATUS_ENDPOINT_HOST) {
    throw new Error("ACPX MCP status preview endpoint must stay on loopback");
  }
  return [{ address: ACPX_STATUS_ENDPOINT_HOST, family: 4 }];
}) as unknown as GuardedLookupFn;

export function renderAcpxMcpStatusPreview(payload: PreviewPayload): string {
  const mode = asCleanText(payload.bridge?.mode) || "status-only";
  const agentId = asCleanText(payload.agentId) || "main";
  const profile = asCleanText(payload.profile) || "unknown";
  const lines = [
    "Fased MCP status preview:",
    `- mode: ${mode}`,
    "- scope: read-only effective-tool inventory",
    "- note: ACPX cannot call these tools through this bridge.",
    `- agent: ${agentId}`,
    `- profile: ${profile}`,
  ];

  const groups = Array.isArray(payload.groups) ? payload.groups.slice(0, MAX_GROUPS) : [];
  for (const rawGroup of groups) {
    if (!rawGroup || typeof rawGroup !== "object") {
      continue;
    }
    const group = rawGroup as PreviewGroup;
    const groupId = asCleanText(group.id);
    if (!groupId) {
      continue;
    }
    const groupLabel = asCleanText(group.label) || groupId;
    const groupSource = asCleanText(group.source) || groupId;
    lines.push(`- group ${groupId}: ${groupLabel} (${groupSource})`);

    const tools = Array.isArray(group.tools) ? group.tools.slice(0, MAX_TOOLS_PER_GROUP) : [];
    for (const rawTool of tools) {
      if (!rawTool || typeof rawTool !== "object") {
        continue;
      }
      const tool = rawTool as PreviewTool;
      const id = asCleanText(tool.id);
      if (!id) {
        continue;
      }
      const label = asCleanText(tool.label) || id;
      const source = asCleanText(tool.source) || "unknown";
      const pluginId = asCleanText(tool.pluginId);
      const channelId = asCleanText(tool.channelId);
      const suffix = [pluginId ? `plugin=${pluginId}` : "", channelId ? `channel=${channelId}` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`  - ${id}: ${label} [${source}${suffix ? ` ${suffix}` : ""}]`);
    }
  }

  return trimToLimit(lines.join("\n"));
}

export async function fetchAcpxMcpStatusPreview(params: {
  endpoint: AcpxMcpStatusEndpoint;
  agentId?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!params.endpoint.toolNames.includes(ACPX_STATUS_MCP_TOOL_NAME)) {
    return null;
  }
  const result = await fetchWithSsrFGuard({
    url: params.endpoint.url,
    timeoutMs: params.timeoutMs ?? DEFAULT_STATUS_PREVIEW_TIMEOUT_MS,
    auditContext: "acpx-mcp-status-preview",
    policy: {
      allowPrivateNetwork: true,
      allowedHostnames: [ACPX_STATUS_ENDPOINT_HOST],
    },
    lookupFn: loopbackLookupFn,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${params.endpoint.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "fased-acpx-status-preview",
        method: "tools/call",
        params: {
          name: ACPX_STATUS_MCP_TOOL_NAME,
          arguments: params.agentId ? { agentId: params.agentId } : {},
        },
      }),
    },
  });
  try {
    const { response } = result;
    if (!response.ok) {
      throw new Error(`MCP status endpoint returned HTTP ${response.status}`);
    }
    const mcpResult = (await response.json()) as { result?: unknown; error?: unknown };
    if (mcpResult.error) {
      throw new Error(`MCP status endpoint returned error: ${JSON.stringify(mcpResult.error)}`);
    }
    const text = firstTextContent(mcpResult.result);
    if (!text) {
      return null;
    }
    const parsed = JSON.parse(text) as PreviewPayload;
    return renderAcpxMcpStatusPreview(parsed);
  } finally {
    await result.release();
  }
}

export async function prependAcpxMcpStatusPreview(params: {
  prompt: string;
  endpoint?: AcpxMcpStatusEndpoint;
  agentId?: string;
  onError?: (error: unknown) => void;
}): Promise<string> {
  if (!params.endpoint) {
    return params.prompt;
  }
  try {
    const preview = await fetchAcpxMcpStatusPreview({
      endpoint: params.endpoint,
      agentId: params.agentId,
    });
    if (!preview) {
      return params.prompt;
    }
    return `${preview}\n\n---\n\n${params.prompt}`;
  } catch (error) {
    params.onError?.(error);
    return params.prompt;
  }
}
