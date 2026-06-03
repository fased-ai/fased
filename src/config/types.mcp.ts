export type McpServerConfig = Record<string, unknown>;

export type McpConfig = {
  /** Owner-managed MCP servers exposed to the native Pi runtime. */
  servers?: Record<string, McpServerConfig>;
};
