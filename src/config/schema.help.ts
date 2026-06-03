import { IRC_FIELD_HELP } from "./schema.irc.js";

const FIELD_HELP_BASE: Record<string, string> = {
  "meta.lastTouchedVersion": "Auto-set when Fased Agent writes the config.",
  "meta.lastTouchedAt": "ISO timestamp of the last config write (auto-set).",
  acp: "Advanced ACP runtime configuration for external coding harness sessions.",
  "acp.enabled": "Global ACP runtime gate. Set false to block ACP sessions.",
  "acp.dispatch.enabled":
    "Allow normal reply routing to dispatch turns to bound ACP sessions. Disabled unless explicitly enabled.",
  "acp.backend": 'ACP runtime backend id, for example "acpx".',
  "acp.defaultAgent": "Default ACP harness id when a spawn request omits agentId.",
  "acp.allowedAgents": "Optional allowlist of ACP harness ids that may be spawned.",
  "acp.maxConcurrentSessions": "Maximum concurrent ACP runtime sessions.",
  "acp.stream.coalesceIdleMs": "Idle window before ACP streamed text is flushed.",
  "acp.stream.maxChunkChars": "Maximum text characters per ACP streamed chunk.",
  "acp.runtime.ttlMinutes": "Idle lifetime for ACP runtime workers.",
  "acp.runtime.installCommand":
    "Operator install/setup command shown by /acp install and /acp doctor.",
  "update.channel":
    'Built-in self-update channel for package installs ("stable", "beta", or "dev").',
  "update.checkOnStart":
    "Check for package self-updates when the gateway starts (default: false; opt-in).",
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.remote.tlsFingerprint":
    "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).",
  "gateway.remote.sshTarget":
    "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
  "gateway.remote.sshIdentity": "Optional SSH identity file path (passed to ssh -i).",
  "agents.list.*.skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  "agents.list[].skills":
    "Optional allowlist of skills for this agent (omit = all skills; empty = no skills).",
  "agents.list[].identity.avatar":
    "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.",
  "agents.list.*.activeModelProvider":
    "Legacy migration field for old provider-scoped Agent model settings. New config should save model refs in agents.list[].model and agents.list[].taskModels.",
  "agents.list[].activeModelProvider":
    "Legacy migration field for old provider-scoped Agent model settings. New config should save model refs in agents.list[].model and agents.list[].taskModels.",
  "agents.list.*.modelProviders":
    "Legacy migration field for old provider-scoped Agent model settings. Provider credentials are global; new Agent config stores full model refs.",
  "agents.list[].modelProviders":
    "Legacy migration field for old provider-scoped Agent model settings. Provider credentials are global; new Agent config stores full model refs.",
  "agents.list.*.modelProviders.*.profileId":
    "Legacy migration field for old provider-scoped Agent credential selection.",
  "agents.list[].modelProviders.*.profileId":
    "Legacy migration field for old provider-scoped Agent credential selection.",
  "agents.list.*.modelProviders.*.primary":
    "Legacy migration field for old provider-scoped Agent primary model.",
  "agents.list[].modelProviders.*.primary":
    "Legacy migration field for old provider-scoped Agent primary model.",
  "agents.list.*.modelProviders.*.fallbacks":
    "Legacy migration field for old provider-scoped Agent fallback models.",
  "agents.list[].modelProviders.*.fallbacks":
    "Legacy migration field for old provider-scoped Agent fallback models.",
  "agents.list.*.modelProviders.*.taskModels.cheapCheck":
    "Legacy migration field for old provider-scoped Agent cheap/check task model.",
  "agents.list[].modelProviders.*.taskModels.cheapCheck":
    "Legacy migration field for old provider-scoped Agent cheap/check task model.",
  "agents.list.*.modelProviders.*.taskModels.strong":
    "Legacy migration field for old provider-scoped Agent strong task model.",
  "agents.list[].modelProviders.*.taskModels.strong":
    "Legacy migration field for old provider-scoped Agent strong task model.",
  "agents.list.*.modelProviders.*.taskModels.escalation":
    "Legacy migration field for old provider-scoped Agent escalation task model.",
  "agents.list[].modelProviders.*.taskModels.escalation":
    "Legacy migration field for old provider-scoped Agent escalation task model.",
  "agents.list.*.modelProviders.*.taskModels.coding":
    "Legacy migration field for old provider-scoped Agent coding task model.",
  "agents.list[].modelProviders.*.taskModels.coding":
    "Legacy migration field for old provider-scoped Agent coding task model.",
  "agents.list.*.modelProviders.*.taskModels.summarizer":
    "Legacy migration field for old provider-scoped Agent summarizer task model.",
  "agents.list[].modelProviders.*.taskModels.summarizer":
    "Legacy migration field for old provider-scoped Agent summarizer task model.",
  "agents.list.*.taskModels.cheapCheck":
    "Per-agent cheap/check task model role. Tasks inherit this before global defaults.",
  "agents.list.*.taskModels.strong":
    "Per-agent strong task model role. Tasks inherit this before global defaults.",
  "agents.list.*.taskModels.escalation":
    "Per-agent escalation task model role. Cheap/check follow-up runs inherit this before global defaults.",
  "agents.list.*.taskModels.coding":
    "Per-agent coding task model role for coding-specialized task runs.",
  "agents.list.*.taskModels.summarizer":
    "Per-agent summarizer task model role for summary and compression task runs.",
  "agents.list[].taskModels.cheapCheck":
    "Per-agent cheap/check task model role. Tasks inherit this before global defaults.",
  "agents.list[].taskModels.strong":
    "Per-agent strong task model role. Tasks inherit this before global defaults.",
  "agents.list[].taskModels.escalation":
    "Per-agent escalation task model role. Cheap/check follow-up runs inherit this before global defaults.",
  "agents.list[].taskModels.coding":
    "Per-agent coding task model role for coding-specialized task runs.",
  "agents.list[].taskModels.summarizer":
    "Per-agent summarizer task model role for summary and compression task runs.",
  "agents.defaults.strictAgentic.mode":
    'Warning-only strict-agentic completion policy for all agents ("off" or "warn"). Warn reports planned-without-action or empty-output runs without changing delivery or retry behavior.',
  "agents.list.*.strictAgentic.mode":
    'Per-agent strict-agentic policy override ("off" or "warn"). Enforcement is intentionally unavailable until retry/delivery semantics are product-defined.',
  "agents.list[].strictAgentic.mode":
    'Per-agent strict-agentic policy override ("off" or "warn"). Enforcement is intentionally unavailable until retry/delivery semantics are product-defined.',
  "discovery.mdns.mode":
    'mDNS broadcast mode ("minimal" default, "full" includes cliPath/sshPort, "off" disables mDNS).',
  "gateway.auth.token":
    "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "gateway.controlUi.basePath": "Optional URL prefix where the Control UI is served (e.g. /fased).",
  "gateway.controlUi.root":
    "Optional filesystem root for Control UI assets (defaults to dist/control-ui).",
  "gateway.controlUi.allowedOrigins":
    "Allowed browser origins for Control UI/WebChat websocket connections (full origins only, e.g. https://control.example.com).",
  "gateway.controlUi.allowInsecureAuth":
    "Allow localhost Control UI auth over insecure HTTP when device identity cannot be generated. Remote clients still fail device/security checks.",
  "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback":
    "DANGEROUS. Allow Host-header origin fallback for deliberate reverse-proxy deployments when explicit allowedOrigins cannot be used.",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "DANGEROUS. Disable Control UI device identity checks (token/password only).",
  "gateway.customBindHost":
    'Custom IPv4 bind address used when gateway.bind is "custom". Prefer loopback or tailnet unless you need a fixed host address.',
  "gateway.trustedProxies":
    "Reverse proxy IPs trusted for forwarded client identity and trusted-proxy authentication. Keep this list minimal.",
  "gateway.allowRealIpFallback":
    "Allow X-Real-IP fallback when X-Forwarded-For is missing. Disabled by default because it can weaken proxy-origin checks.",
  "gateway.http.securityHeaders.strictTransportSecurity":
    "Optional Strict-Transport-Security header value for HTTPS deployments, or false to disable explicitly.",
  "channels.discord.threadBindings.enabled":
    "Bind Discord threads to agent, subagent, or ACP sessions for follow-up routing.",
  "channels.discord.threadBindings.idleHours":
    "How long an inactive Discord thread binding remains active before idle cleanup.",
  "channels.discord.threadBindings.maxAgeHours":
    "Maximum age for a Discord thread binding before cleanup.",
  "channels.discord.threadBindings.spawnSubagentSessions":
    "Allow Discord thread flows to spawn Fased-native subagent sessions.",
  "channels.discord.threadBindings.spawnAcpSessions":
    "Allow Discord thread flows to spawn ACP harness sessions such as Codex or Claude Code.",
  "gateway.http.endpoints.chatCompletions.enabled":
    "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
  "models.providers.*.request.allowPrivateNetwork":
    "Allow this model provider to call local/LAN/private network base URLs. Required for Ollama, vLLM, LiteLLM, and private VPS endpoints.",
  "gateway.reload.mode": 'Hot reload strategy for config changes ("hybrid" recommended).',
  "gateway.reload.debounceMs": "Debounce window (ms) before applying config changes.",
  "gateway.nodes.browser.mode":
    'Node browser routing ("auto" = pick single connected browser node, "manual" = require node param, "off" = disable).',
  "gateway.nodes.browser.node": "Pin browser routing to a specific node id or name (optional).",
  "gateway.nodes.allowCommands":
    "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings).",
  "gateway.nodes.denyCommands":
    "Commands to block even if present in node claims or default allowlist.",
  "nodeHost.browserProxy.enabled": "Expose the local browser control server via node proxy.",
  "nodeHost.browserProxy.allowProfiles":
    "Optional allowlist of browser profile names exposed via the node proxy.",
  "diagnostics.flags":
    'Enable targeted diagnostics logs by flag (e.g. ["telegram.http"]). Supports wildcards like "telegram.*" or "*".',
  "diagnostics.cacheTrace.enabled":
    "Log cache trace snapshots for embedded agent runs (default: false).",
  "diagnostics.cacheTrace.filePath":
    "JSONL output path for cache trace logs (default: $FASED_STATE_DIR/logs/cache-trace.jsonl).",
  "diagnostics.cacheTrace.includeMessages":
    "Include full message payloads in trace output (default: true).",
  "diagnostics.cacheTrace.includePrompt": "Include prompt text in trace output (default: true).",
  "diagnostics.cacheTrace.includeSystem": "Include system prompt in trace output (default: true).",
  "diagnostics.prometheus.enabled":
    "Expose a lightweight Prometheus text endpoint for gateway/runtime diagnostics. Configure it from Advanced > Debug.",
  "diagnostics.prometheus.path":
    "HTTP path for Prometheus metrics. Keep the default /metrics unless a reverse proxy requires another path.",
  "diagnostics.prometheus.requireAuth":
    "Require gateway auth for remote Prometheus scrapes. Local loopback scrapes stay allowed for operator tooling.",
  "diagnostics.prometheus.includeRuntime":
    "Include process/runtime gauges such as uptime and memory usage in the Prometheus endpoint.",
  "tools.exec.applyPatch.enabled":
    "Experimental. Enables apply_patch for OpenAI models when allowed by tool policy.",
  "tools.exec.applyPatch.workspaceOnly":
    "Restrict apply_patch paths to the workspace directory (default: true). Set false to allow writing outside the workspace (dangerous).",
  "tools.exec.applyPatch.allowModels":
    'Optional allowlist of model ids (e.g. "gpt-5.2" or "openai/gpt-5.2").',
  "tools.exec.notifyOnExit":
    "When true (default), backgrounded exec sessions enqueue a system event and request a heartbeat on exit.",
  "tools.exec.notifyOnExitEmptySuccess":
    "When true, successful backgrounded exec exits with empty output still enqueue a completion system event (default: false).",
  "tools.exec.pathPrepend": "Directories to prepend to PATH for exec runs (gateway/sandbox).",
  "tools.exec.safeBins":
    "Allow stdin-only safe binaries to run without explicit allowlist entries.",
  "tools.fs.workspaceOnly":
    "Restrict filesystem tools (read/write/edit/apply_patch) to the workspace directory (default: false).",
  "tools.message.allowCrossContextSend":
    "Legacy override: allow cross-context sends across all providers.",
  "tools.message.crossContext.allowWithinProvider":
    "Allow sends to other channels within the same provider (default: true).",
  "tools.message.crossContext.allowAcrossProviders":
    "Allow sends across different providers (default: false).",
  "tools.message.crossContext.marker.enabled":
    "Add a visible origin marker when sending cross-context (default: true).",
  "tools.message.crossContext.marker.prefix":
    'Text prefix for cross-context markers (supports "{channel}").',
  "tools.message.crossContext.marker.suffix":
    'Text suffix for cross-context markers (supports "{channel}").',
  "tools.message.broadcast.enabled": "Enable broadcast action (default: true).",
  "tools.web.search.enabled": "Enable the web_search tool.",
  "tools.web.search.provider":
    'Search provider id. Built-ins include "brave", "duckduckgo", "exa", "firecrawl", "gemini", "grok", "kimi", "perplexity", "searxng", and "tavily"; plugins can add more.',
  "tools.web.search.apiKey": "Brave Search API key or SecretRef (fallback: BRAVE_API_KEY env var).",
  "tools.web.search.maxResults": "Default number of results to return (1-10).",
  "tools.web.search.timeoutSeconds": "Timeout in seconds for web_search requests.",
  "tools.web.search.cacheTtlMinutes": "Cache TTL in minutes for web_search results.",
  "tools.web.search.duckduckgo.region": 'DuckDuckGo region such as "us-en" (optional).',
  "tools.web.search.duckduckgo.safeSearch":
    'DuckDuckGo safe search level: "strict", "moderate", or "off".',
  "tools.web.search.exa.apiKey": "Exa API key or SecretRef (fallback: EXA_API_KEY env var).",
  "tools.web.search.exa.baseUrl": "Optional Exa-compatible base URL.",
  "tools.web.search.exa.type": 'Exa search type, usually "auto".',
  "tools.web.search.firecrawl.apiKey":
    "Firecrawl API key or SecretRef for web_search (fallback: FIRECRAWL_API_KEY env var).",
  "tools.web.search.firecrawl.baseUrl":
    "Firecrawl search base URL (e.g. https://api.firecrawl.dev or custom endpoint).",
  "tools.web.search.perplexity.apiKey":
    "Perplexity or OpenRouter API key (fallback: PERPLEXITY_API_KEY or OPENROUTER_API_KEY env var).",
  "tools.web.search.perplexity.baseUrl":
    "Perplexity base URL override (default: https://openrouter.ai/api/v1 or https://api.perplexity.ai).",
  "tools.web.search.perplexity.model":
    'Perplexity model override (default: "perplexity/sonar-pro").',
  "tools.web.search.searxng.baseUrl": "SearXNG instance base URL.",
  "tools.web.search.searxng.categories": 'Optional SearXNG categories such as "general".',
  "tools.web.search.searxng.language": "Optional SearXNG language.",
  "tools.web.search.tavily.apiKey":
    "Tavily API key or SecretRef (fallback: TAVILY_API_KEY env var).",
  "tools.web.search.tavily.baseUrl": "Tavily base URL.",
  "tools.web.search.tavily.includeAnswer": "Include Tavily answer summaries when available.",
  "tools.web.search.tavily.searchDepth": 'Tavily search depth: "basic" or "advanced".',
  "tools.web.search.tavily.topic": "Optional Tavily topic filter.",
  "tools.web.fetch.enabled": "Enable the web_fetch tool (lightweight HTTP fetch).",
  "tools.web.fetch.maxChars": "Max characters returned by web_fetch (truncated).",
  "tools.web.fetch.maxCharsCap":
    "Hard cap for web_fetch maxChars (applies to config and tool calls).",
  "tools.web.fetch.timeoutSeconds": "Timeout in seconds for web_fetch requests.",
  "tools.web.fetch.cacheTtlMinutes": "Cache TTL in minutes for web_fetch results.",
  "tools.web.fetch.maxRedirects": "Maximum redirects allowed for web_fetch (default: 3).",
  "tools.web.fetch.userAgent": "Override User-Agent header for web_fetch requests.",
  "tools.web.fetch.readability":
    "Use Readability to extract main content from HTML (fallbacks to basic HTML cleanup).",
  "tools.web.fetch.firecrawl.enabled": "Enable Firecrawl fallback for web_fetch (if configured).",
  "tools.web.fetch.firecrawl.apiKey":
    "Firecrawl API key or SecretRef (fallback: FIRECRAWL_API_KEY env var).",
  "tools.web.fetch.firecrawl.baseUrl":
    "Firecrawl base URL (e.g. https://api.firecrawl.dev or custom endpoint).",
  "tools.web.fetch.firecrawl.onlyMainContent":
    "When true, Firecrawl returns only the main content (default: true).",
  "tools.web.fetch.firecrawl.maxAgeMs":
    "Firecrawl maxAge (ms) for cached results when supported by the API.",
  "tools.web.fetch.firecrawl.timeoutSeconds": "Timeout in seconds for Firecrawl requests.",
  "channels.slack.allowBots":
    "Allow bot-authored messages to trigger Slack replies (default: false).",
  "channels.slack.thread.historyScope":
    'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).',
  "channels.slack.thread.inheritParent":
    "If true, Slack thread sessions inherit the parent channel transcript (default: false).",
  "channels.slack.thread.initialHistoryLimit":
    "Maximum number of existing Slack thread messages to fetch when starting a new thread session (default: 20, set to 0 to disable).",
  "channels.mattermost.botToken":
    "Bot token from Mattermost System Console -> Integrations -> Bot Accounts.",
  "channels.mattermost.baseUrl":
    "Base URL for your Mattermost server (e.g., https://chat.example.com).",
  "channels.mattermost.chatmode":
    'Reply to channel messages on mention ("oncall"), on trigger chars (">" or "!") ("onchar"), or on every message ("onmessage").',
  "channels.mattermost.oncharPrefixes": 'Trigger prefixes for onchar mode (default: [">", "!"]).',
  "channels.mattermost.requireMention":
    "Require @mention in channels before responding (default: true).",
  "auth.profiles": "Named auth profiles (provider + mode + optional email).",
  "auth.order": "Ordered auth profile IDs per provider (used for automatic failover).",
  "auth.cooldowns.billingBackoffHours":
    "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).",
  "auth.cooldowns.billingBackoffHoursByProvider":
    "Optional per-provider overrides for billing backoff (hours).",
  "auth.cooldowns.billingMaxHours": "Cap (hours) for billing backoff (default: 24).",
  "auth.cooldowns.failureWindowHours": "Failure window (hours) for backoff counters (default: 24).",
  "agents.defaults.bootstrapMaxChars":
    "Max characters of each workspace bootstrap file injected into the system prompt before truncation (default: 20000).",
  "agents.defaults.bootstrapTotalMaxChars":
    "Max total characters across all injected workspace bootstrap files (default: 24000).",
  "agents.defaults.repoRoot":
    "Optional repository root shown in the system prompt runtime line (overrides auto-detect).",
  "agents.defaults.envelopeTimezone":
    'Timezone for message envelopes ("utc", "local", "user", or an IANA timezone string).',
  "agents.defaults.envelopeTimestamp":
    'Include absolute timestamps in message envelopes ("on" or "off").',
  "agents.defaults.envelopeElapsed": 'Include elapsed time in message envelopes ("on" or "off").',
  "agents.defaults.models": "Configured model catalog (keys are full provider/model IDs).",
  "agents.defaults.memorySearch":
    "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).",
  "agents.defaults.memorySearch.sources":
    'Sources to index for memory search (default: ["memory"]; add "sessions" to include session transcripts).',
  "agents.defaults.memorySearch.extraPaths":
    "Extra paths to include in memory search (directories or .md files; relative paths resolved from workspace).",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Enable experimental session transcript indexing for memory search (default: false).",
  "agents.defaults.memorySearch.provider":
    'Embedding provider ("openai", "gemini", "voyage", or "local").',
  "agents.defaults.memorySearch.remote.baseUrl":
    "Custom base URL for remote embeddings (OpenAI-compatible proxies or Gemini overrides).",
  "agents.defaults.memorySearch.remote.apiKey": "Custom API key for the remote embedding provider.",
  "agents.defaults.memorySearch.remote.headers":
    "Extra headers for remote embeddings (merged; remote overrides OpenAI headers).",
  "agents.defaults.memorySearch.remote.batch.enabled":
    "Enable batch API for memory embeddings (OpenAI/Gemini; default: true).",
  "agents.defaults.memorySearch.remote.batch.wait":
    "Wait for batch completion when indexing (default: true).",
  "agents.defaults.memorySearch.remote.batch.concurrency":
    "Max concurrent embedding batch jobs for memory indexing (default: 2).",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs":
    "Polling interval in ms for batch status (default: 2000).",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes":
    "Timeout in minutes for batch indexing (default: 60).",
  "agents.defaults.memorySearch.local.modelPath":
    "Local GGUF model path or hf: URI (node-llama-cpp).",
  "agents.defaults.memorySearch.fallback":
    'Fallback provider when embeddings fail ("openai", "gemini", "local", or "none").',
  "agents.defaults.memorySearch.store.path":
    "SQLite index path (default: ~/.fased/memory/{agentId}.sqlite).",
  "agents.defaults.memorySearch.store.vector.enabled":
    "Enable sqlite-vec extension for vector search (default: true).",
  "agents.defaults.memorySearch.store.vector.extensionPath":
    "Optional override path to sqlite-vec extension library (.dylib/.so/.dll).",
  "agents.defaults.memorySearch.query.hybrid.enabled":
    "Enable hybrid BM25 + vector search for memory (default: true).",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight":
    "Weight for vector similarity when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.textWeight":
    "Weight for BM25 text relevance when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier":
    "Multiplier for candidate pool size (default: 4).",
  "agents.defaults.memorySearch.cache.enabled":
    "Cache chunk embeddings in SQLite to speed up reindexing and frequent updates (default: true).",
  memory: "Memory backend configuration (global).",
  "memory.backend": 'Memory backend ("builtin" for FasedAgent embeddings, "qmd" for QMD sidecar).',
  "memory.citations": 'Default citation behavior ("auto", "on", or "off").',
  "memory.qmd.command": "Path to the qmd binary (default: resolves from PATH).",
  "memory.qmd.includeDefaultMemory":
    "Whether to automatically index MEMORY.md + memory/**/*.md (default: true).",
  "memory.qmd.paths":
    "Additional directories/files to index with QMD (path + optional glob pattern).",
  "memory.qmd.paths.path": "Absolute or ~-relative path to index via QMD.",
  "memory.qmd.paths.pattern": "Glob pattern relative to the path root (default: **/*.md).",
  "memory.qmd.paths.name":
    "Optional stable name for the QMD collection (default derived from path).",
  "memory.qmd.sessions.enabled":
    "Enable QMD session transcript indexing (experimental, default: false).",
  "memory.qmd.sessions.exportDir":
    "Override directory for sanitized session exports before indexing.",
  "memory.qmd.sessions.retentionDays":
    "Retention window for exported sessions before pruning (default: unlimited).",
  "memory.qmd.update.interval":
    "How often the QMD sidecar refreshes indexes (duration string, default: 5m).",
  "memory.qmd.update.debounceMs":
    "Minimum delay between successive QMD refresh runs (default: 15000).",
  "memory.qmd.update.onBoot": "Run QMD update once on gateway startup (default: true).",
  "memory.qmd.update.waitForBootSync":
    "Block startup until the boot QMD refresh finishes (default: false).",
  "memory.qmd.update.embedInterval":
    "How often QMD embeddings are refreshed (duration string, default: 60m). Set to 0 to disable periodic embed.",
  "memory.qmd.update.commandTimeoutMs":
    "Timeout for QMD maintenance commands like collection list/add (default: 30000).",
  "memory.qmd.update.updateTimeoutMs": "Timeout for `qmd update` runs (default: 120000).",
  "memory.qmd.update.embedTimeoutMs": "Timeout for `qmd embed` runs (default: 120000).",
  "memory.qmd.limits.maxResults": "Max QMD results returned to the agent loop (default: 6).",
  "memory.qmd.limits.maxSnippetChars": "Max characters per snippet pulled from QMD (default: 700).",
  "memory.qmd.limits.maxInjectedChars": "Max total characters injected from QMD hits per turn.",
  "memory.qmd.limits.timeoutMs": "Per-query timeout for QMD searches (default: 4000).",
  "memory.qmd.scope":
    "Session/channel scope for QMD recall (same syntax as session.sendPolicy; default: direct-only). Use match.rawKeyPrefix to match full agent-prefixed session keys.",
  wallet: "Wallet subsystem configuration.",
  "wallet.provider.id":
    'Wallet backend provider id for the current self-hosted runtime ("local-socket-signer" preferred; "embedded-keystore" legacy). Hosted provider ids are CLI/admin-only compatibility plumbing.',
  "wallet.execution.mode":
    'Wallet send execution mode ("manual" queues approvals; "autonomous" executes immediately when policy allows).',
  "wallet.approvalAuth.mode":
    'Approval auth mode for sensitive wallet actions ("none" or "webauthn").',
  "wallet.approvalAuth.challengeTtlSeconds":
    "Wallet WebAuthn challenge TTL in seconds (default: 300).",
  "wallet.approvalAuth.grantTtlSeconds": "Wallet approval grant TTL in seconds (default: 120).",
  "wallet.keystore.enabled":
    "Enable embedded encrypted keystore provider for local self-hosted signing.",
  "wallet.keystore.path":
    "Path to encrypted embedded keystore file (defaults under wallet state dir).",
  "wallet.keystore.chainSupport":
    "Enabled chains for embedded keystore. Normal Fased wallet setup is Solana-first.",
  "wallet.keystore.autoLockSeconds": "Optional idle auto-lock timeout for embedded keystore.",
  "wallet.runtime.enabled":
    "Enable wallet runtime compatibility settings (provider-agnostic replacement for legacy wallet runtime config).",
  "wallet.runtime.mode": 'Wallet runtime mode ("managed" or "external").',
  "wallet.runtime.runtime": 'Wallet runtime source ("external-docker" or "external-custom").',
  "wallet.runtime.external.kind": 'External wallet runtime kind ("docker" or "custom").',
  "wallet.runtime.auth.mode": 'Runtime auth mode ("jwt-bootstrap" or "static-token-compat").',
  "wallet.runtime.auth.bootstrapUrl":
    "Optional auth bootstrap URL override for runtime compatibility.",
  "wallet.runtime.source.ref": "Optional source reference for advanced runtime integrations.",
  "wallet.runtime.chains":
    "Enabled chains for wallet operations. Normal Fased wallet setup is Solana-first.",
  "wallet.runtime.service.host": "Wallet service bind host (default: 127.0.0.1).",
  "wallet.runtime.service.port": "Wallet service bind port.",
  "wallet.runtime.install.enabled":
    "Whether onboarding/install flows should record wallet runtime install metadata.",
  "wallet.runtime.install.version":
    "Installed wallet runtime version recorded by onboarding/install flows.",
  "wallet.runtime.policy.directSigning":
    "Allow background/agent wallet execution from wallet tooling (must be paired with caps/allowlists). Manual reviewed sends are separate.",
  "wallet.runtime.policy.capsEnabled":
    "Enable wallet spend cap enforcement. When false, role, custody, signer, allowlist, and audit gates still apply, but SOL/token cap comparisons are skipped.",
  "wallet.runtime.policy.solana.allowPrograms":
    "Optional Solana program allowlist. For Agent market swaps this restricts inspected Jupiter DEX route programs; empty allows inspected routes.",
  "wallet.runtime.policy.solana.tokenCaps":
    "Per-mint SPL token caps for token sends, token-input swaps, and token-input limit orders. Keys are mint addresses; values are base-unit maxPerTx/maxDaily strings.",
  "wallet.runtime.policy.solana.maxPerTx":
    "Maximum Solana value allowed per transaction (base unit string; e.g. lamports).",
  "wallet.runtime.policy.solana.maxDaily":
    "Maximum cumulative Solana value allowed per UTC day (base unit string).",
  "wallet.runtime.toolAccess.mode": 'Wallet tool scope ("owner-only", "allowlist", or "all").',
  "wallet.runtime.toolAccess.allowAgents": "Agent IDs allowed when toolAccess.mode=allowlist.",
  "wallet.runtime.toolAccess.allowSkills": "Skill IDs allowed to invoke wallet tools.",
  "wallet.runtime.toolAccess.denySkills": "Skill IDs denied from invoking wallet tools.",
  "wallet.runtime.toolAccess.allowSources": "Allowed invocation sources for wallet tools.",
  "skills.marketplace.allowRegistries":
    "Registries trusted for installed skills that request wallet actions. Defaults to https://clawhub.com.",
  "agents.defaults.memorySearch.cache.maxEntries":
    "Optional cap on cached embeddings (best-effort).",
  "agents.defaults.memorySearch.sync.onSearch":
    "Lazy sync: schedule a reindex on search after changes.",
  "agents.defaults.memorySearch.sync.watch": "Watch memory files for changes (chokidar).",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes":
    "Minimum appended bytes before session transcripts trigger reindex (default: 100000).",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages":
    "Minimum appended JSONL lines before session transcripts trigger reindex (default: 50).",
  "plugins.enabled": "Enable plugin/extension loading (default: true).",
  "plugins.allow": "Optional allowlist of plugin ids; when set, only listed plugins load.",
  "plugins.deny": "Optional denylist of plugin ids; deny wins over allowlist.",
  "plugins.load.paths": "Additional plugin files or directories to load.",
  "plugins.slots": "Select which plugins own exclusive slots (memory, etc.).",
  "plugins.slots.memory":
    'Select the active memory plugin by id, or "none" to disable memory plugins.',
  "plugins.entries": "Per-plugin settings keyed by plugin id (enable/disable + config payloads).",
  "plugins.entries.*.enabled": "Overrides plugin enable/disable for this entry (restart required).",
  "plugins.entries.*.config": "Plugin-defined config payload (schema is provided by the plugin).",
  "plugins.entries.*.runtime.helpers.sessions.read":
    "Allow a plugin to use future read-only session metadata/status runtime helpers. This does not grant session mutation or gateway write access.",
  "plugins.entries.*.runtime.adminRpcActions":
    "Explicit per-plugin grants for future fixed admin/write RPC helpers. This does not expose a generic gateway dispatcher and does not bypass operator scope, audit, or rate limits.",
  "plugins.entries.*.runtime.adminRpcActions.allow":
    "List of exact admin/write RPC methods a trusted plugin may request through future fixed helpers. Empty or missing means denied.",
  "plugins.entries.*.runtime.adminRpcActions.allow[].method":
    'Exact admin/write RPC method id ("chat.inject", "push.test", "web.login.start", or "web.login.wait").',
  "plugins.entries.*.runtime.adminRpcActions.allow[].sources":
    'Trusted source keys allowed to use the grant, such as "origin:bundled" or "source:/opt/fased/plugins/demo". Missing sources fail closed.',
  "plugins.entries.*.runtime.adminRpcActions.allow[].requireOperatorApproval":
    "Must be true for the first plugin-admin RPC model; false or missing grants are denied before any RPC can run.",
  "plugins.installs":
    "CLI-managed install metadata (used by `fased plugins update` to locate install sources).",
  "plugins.installs.*.source": 'Install source ("npm", "archive", "path", or "clawhub").',
  "plugins.installs.*.spec": "Original npm spec used for install (if source is npm).",
  "plugins.installs.*.sourcePath": "Original archive/path used for install (if any).",
  "plugins.installs.*.installPath":
    "Resolved install directory (usually ~/.fased/extensions/<id>).",
  "plugins.installs.*.version": "Version recorded at install time (if available).",
  "plugins.installs.*.installedAt": "ISO timestamp of last install/update.",
  "agents.list.*.identity.avatar":
    "Agent avatar (workspace-relative path, http(s) URL, or data URI).",
  "agents.defaults.model.primary": "Primary model (provider/model).",
  "agents.defaults.model.fallbacks":
    "Ordered fallback models (provider/model). Used when the primary model fails.",
  "agents.defaults.taskModels.cheapCheck":
    "Explicit cheap/check task model (provider/model). Used for cheap-model tasks when the task does not set its own model.",
  "agents.defaults.taskModels.strong":
    "Explicit strong task model (provider/model). Used when the planner chooses strong-model and the task does not set its own model.",
  "agents.defaults.taskModels.escalation":
    "Explicit escalation model (provider/model). Used for cheap-check follow-up runs when the task does not set its own escalation model.",
  "agents.defaults.taskModels.coding":
    "Explicit coding task model (provider/model). Reserved for coding-specialized task runs.",
  "agents.defaults.taskModels.summarizer":
    "Explicit summarizer task model (provider/model). Reserved for summary and compression task runs.",
  "agents.defaults.imageModel.primary":
    "Optional image model (provider/model) used when the primary model lacks image input.",
  "agents.defaults.imageModel.fallbacks": "Ordered fallback image models (provider/model).",
  "agents.defaults.cliBackends": "Optional CLI backends for text-only fallback (claude-cli, etc.).",
  "agents.defaults.humanDelay.mode": 'Delay style for block replies ("off", "natural", "custom").',
  "agents.defaults.humanDelay.minMs": "Minimum delay in ms for custom humanDelay (default: 800).",
  "agents.defaults.humanDelay.maxMs": "Maximum delay in ms for custom humanDelay (default: 2500).",
  "commands.native":
    "Register native commands with channels that support it (Discord/Slack/Telegram).",
  "commands.nativeSkills":
    "Register native skill commands (user-invocable skills) with channels that support it.",
  "commands.text": "Allow text command parsing (slash commands only).",
  "commands.bash":
    "Allow bash chat command (`!`; `/bash` alias) to run host shell commands (default: false; requires tools.elevated).",
  "commands.bashForegroundMs":
    "How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately).",
  "commands.config": "Allow /config chat command to read/write config on disk (default: false).",
  "commands.debug": "Allow /debug chat command for runtime-only overrides (default: false).",
  "commands.restart": "Allow /restart and gateway restart tool actions (default: true).",
  "commands.useAccessGroups": "Enforce access-group allowlists/policies for commands.",
  "commands.ownerAllowFrom":
    "Explicit owner allowlist for owner-only tools/commands. Use channel-native IDs (optionally prefixed like \"whatsapp:+15551234567\"). '*' is ignored.",
  "session.dmScope":
    'DM session scoping: "main" keeps continuity; "per-peer", "per-channel-peer", or "per-account-channel-peer" isolates DM history (recommended for shared inboxes/multi-account).',
  "session.identityLinks":
    "Map canonical identities to provider-prefixed peer IDs for DM session linking (example: telegram:123456).",
  "channels.telegram.configWrites":
    "Allow Telegram to write config in response to channel events/commands (default: true).",
  "channels.slack.configWrites":
    "Allow Slack to write config in response to channel events/commands (default: true).",
  "channels.mattermost.configWrites":
    "Allow Mattermost to write config in response to channel events/commands (default: true).",
  "channels.discord.configWrites":
    "Allow Discord to write config in response to channel events/commands (default: true).",
  "channels.discord.proxy":
    "Proxy URL for Discord gateway WebSocket connections. Set per account via channels.discord.accounts.<id>.proxy.",
  "channels.whatsapp.configWrites":
    "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  "channels.signal.configWrites":
    "Allow Signal to write config in response to channel events/commands (default: true).",
  "channels.imessage.configWrites":
    "Allow iMessage to write config in response to channel events/commands (default: true).",
  "channels.msteams.configWrites":
    "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  "channels.msteams.preserveFilenames":
    "Preserve original Microsoft Teams attachment filenames when inbound media is saved. Leave off unless downstream tools need the sender's filename.",
  ...IRC_FIELD_HELP,
  "channels.discord.commands.native": 'Override native commands for Discord (bool or "auto").',
  "channels.discord.commands.nativeSkills":
    'Override native skill commands for Discord (bool or "auto").',
  "channels.telegram.commands.native": 'Override native commands for Telegram (bool or "auto").',
  "channels.telegram.commands.nativeSkills":
    'Override native skill commands for Telegram (bool or "auto").',
  "channels.slack.commands.native": 'Override native commands for Slack (bool or "auto").',
  "channels.slack.commands.nativeSkills":
    'Override native skill commands for Slack (bool or "auto").',
  "session.agentToAgent.maxPingPongTurns":
    "Max reply-back turns between requester and target (0–5).",
  "channels.telegram.customCommands":
    "Additional Telegram bot menu commands (merged with native; conflicts ignored).",
  "messages.suppressToolErrors":
    "When true, suppress ⚠️ tool-error warnings from being shown to the user. The agent already sees errors in context and can retry. Default: false.",
  "messages.ackReaction": "Emoji reaction used to acknowledge inbound messages (empty disables).",
  "messages.ackReactionScope":
    'When to send ack reactions ("group-mentions", "group-all", "direct", "all").',
  "messages.inbound.debounceMs":
    "Debounce window (ms) for batching rapid inbound messages from the same sender (0 to disable).",
  "channels.telegram.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].',
  "channels.telegram.streamMode":
    "Live stream preview mode for Telegram replies (off | partial | block). Separate from block streaming; uses sendMessage + editMessageText.",
  "channels.telegram.draftChunk.minChars":
    'Minimum chars before emitting a Telegram stream preview update when channels.telegram.streamMode="block" (default: 200).',
  "channels.telegram.draftChunk.maxChars":
    'Target max size for a Telegram stream preview chunk when channels.telegram.streamMode="block" (default: 800; clamped to channels.telegram.textChunkLimit).',
  "channels.telegram.draftChunk.breakPreference":
    "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence). Default: paragraph.",
  "channels.telegram.retry.attempts":
    "Max retry attempts for outbound Telegram API calls (default: 3).",
  "channels.telegram.retry.minDelayMs": "Minimum retry delay in ms for Telegram outbound calls.",
  "channels.telegram.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Telegram outbound calls.",
  "channels.telegram.retry.jitter": "Jitter factor (0-1) applied to Telegram retry delays.",
  "channels.telegram.network.autoSelectFamily":
    "Override Node autoSelectFamily for Telegram (true=enable, false=disable).",
  "channels.telegram.timeoutSeconds":
    "Max seconds before Telegram API requests are aborted (default: 500 per grammY).",
  "channels.whatsapp.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
  "channels.whatsapp.selfChatMode": "Same-phone setup (bot uses your personal WhatsApp number).",
  "channels.whatsapp.debounceMs":
    "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  "channels.signal.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].',
  "channels.imessage.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.imessage.allowFrom=["*"].',
  "channels.bluebubbles.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].',
  "channels.discord.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"].',
  "channels.discord.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"] (legacy: channels.discord.dm.allowFrom).',
  "channels.discord.retry.attempts":
    "Max retry attempts for outbound Discord API calls (default: 3).",
  "channels.discord.retry.minDelayMs": "Minimum retry delay in ms for Discord outbound calls.",
  "channels.discord.retry.maxDelayMs": "Maximum retry delay cap in ms for Discord outbound calls.",
  "channels.discord.retry.jitter": "Jitter factor (0-1) applied to Discord retry delays.",
  "channels.discord.maxLinesPerMessage": "Soft max line count per Discord message (default: 17).",
  "channels.discord.intents.presence":
    "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.",
  "channels.discord.intents.guildMembers":
    "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.",
  "channels.discord.pluralkit.enabled":
    "Resolve PluralKit proxied messages and treat system members as distinct senders.",
  "channels.discord.pluralkit.token":
    "Optional PluralKit token for resolving private systems or members.",
  "channels.discord.activity": "Discord presence activity text (defaults to custom status).",
  "channels.discord.status": "Discord presence status (online, dnd, idle, invisible).",
  "channels.discord.activityType":
    "Discord presence activity type (0=Playing,1=Streaming,2=Listening,3=Watching,4=Custom,5=Competing).",
  "channels.discord.activityUrl": "Discord presence streaming URL (required for activityType=1).",
  "channels.slack.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"] (legacy: channels.slack.dm.allowFrom).',
  "channels.slack.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.slack.allowFrom=["*"].',
};

const SPECIFIC_FIELD_HELP: Record<string, string> = {
  "memory.citations":
    'Controls source footers in memory_search snippets. "auto" shows citations when useful, "on" always shows source paths, and "off" hides citation footers for compact prompts.',
  "memory.backend":
    'Selects the memory search backend. "builtin" uses the default Markdown index; "qmd" uses the optional local QMD sidecar and falls back if QMD is unavailable.',
  "memory.qmd.searchMode":
    'Selects the QMD command used for recall. Use "query" for QMD query mode, "search" for qmd search --json, or "vsearch" when you explicitly want vector search.',
  "models.mode":
    'Controls how configured model providers combine with defaults. Use "merge" to keep built-ins plus custom providers, or "replace" to use only configured providers.',
  "models.providers.*.auth":
    'Selects provider authentication style. Supported values include "api-key", "token", "oauth", and "aws-sdk"; use the mode the provider runtime actually supports.',
  "gateway.reload.mode":
    'Controls config reload behavior. "off" disables hot reload, "restart" requires restart, "hot" applies in process, and "hybrid" uses the safest available path.',
  "approvals.exec.mode":
    'Controls exec approval routing. "session" replies in the originating session, "targets" sends to configured targets, and "both" uses both paths.',
  "bindings[].match.peer.kind":
    'Matches channel peer type for a route binding. Use "direct", "group", "channel", or "dm" depending on the transport identity being routed.',
  "broadcast.strategy":
    'Controls broadcast delivery. "parallel" sends to destinations concurrently; "sequential" sends in order and is easier to audit when destinations are sensitive.',
  "hooks.mappings[].action":
    'Controls hook mapping behavior. "wake" records a wake event; "agent" starts an Agent run using the mapping templates, routing, and delivery settings.',
  "hooks.mappings[].wakeMode":
    'Controls when hook work runs. "now" requests immediate processing; "next-heartbeat" queues the hook for the next normal heartbeat cycle.',
  "hooks.mappings[].notifyPolicy":
    'Controls task-ledger notifications for this webhook trigger. Use "silent", "done_only", or "state_changes".',
  "hooks.gmail.tailscale.mode":
    'Controls Gmail public push exposure. "off" disables Tailscale setup, "serve" uses Tailscale Serve, and "funnel" uses Tailscale Funnel for public HTTPS.',
  "hooks.gmail.thinking":
    'Optional Gmail hook thinking override. Use "off", "minimal", "low", "medium", or "high" only when the selected Gmail hook model supports that control.',
  "messages.queue.mode":
    'Controls inbound message batching. Use "steer", "followup", "collect", "steer-backlog", "steer+backlog", "queue", or "interrupt" depending on how aggressively the Agent should handle bursts.',
  "messages.queue.drop":
    'Controls queue overflow behavior. "old" drops oldest messages, "new" drops new arrivals, and "summarize" tries to summarize overflow before processing.',
  "channels.defaults.groupPolicy":
    'Default group reply policy for channels. "open" allows group replies, "disabled" blocks them, and "allowlist" only allows configured groups or senders.',
  "gateway.mode":
    'Gateway run mode. "local" is for same-machine Control UI and channels; "remote" is for a separately hosted gateway with explicit auth and routing.',
  "gateway.bind":
    'Gateway bind strategy. "loopback" stays on localhost, "tailnet" binds for Tailscale use, "lan" exposes on LAN, "custom" uses configured host, and "auto" chooses a safe default.',
  "gateway.auth.mode":
    'Gateway authentication mode. "token" is the normal default, "password" supports password auth, and "trusted-proxy" requires a trusted front proxy.',
  "gateway.tailscale.mode":
    'Tailscale publishing mode. "off" disables it, "serve" exposes to the tailnet, and "funnel" exposes public HTTPS when your Tailscale account allows Funnel.',
  "browser.profiles.*.driver":
    'Browser profile driver. "clawd" uses the local browser controller, while "extension" uses the browser extension bridge for that profile.',
  "discovery.mdns.mode":
    'mDNS discovery mode. "off" disables announcements, "minimal" publishes only safe basic identity, and "full" includes extra node routing metadata.',
  "wizard.lastRunMode":
    'Records whether the last onboarding wizard ran in "local" or "remote" mode. This is metadata for diagnostics and should normally be left unchanged.',
  "diagnostics.otel.protocol":
    'OpenTelemetry export protocol. Use "http/protobuf" for most collectors or "grpc" when your collector explicitly expects OTLP over gRPC.',
  "logging.level":
    'File logging verbosity. Use "silent", "fatal", "error", "warn", "info", "debug", or "trace"; higher verbosity increases log size and sensitive context risk.',
  "logging.maxFileBytes":
    "Maximum size of a single log file in bytes before file writes are suppressed. Default is 500 MB.",
  "logging.consoleLevel":
    'Console logging verbosity. Use "silent", "fatal", "error", "warn", "info", "debug", or "trace"; keep production consoles at info or warn.',
  "logging.consoleStyle":
    'Console output format. "pretty" is human-friendly, "compact" reduces terminal noise, and "json" is best for log collectors and structured processing.',
  "logging.redactSensitive":
    'Controls log redaction. "off" disables extra redaction, while "tools" redacts tool arguments and sensitive tool payloads before writing logs.',
  "update.channel":
    'Self-update channel. "stable" is recommended, "beta" gets preview releases, and "dev" follows development builds with more churn.',
  "agents.defaults.compaction.mode":
    'Context compaction mode. "default" uses normal pruning; "safeguard" keeps stricter reserves for long tasks and memory-sensitive sessions.',
  "agents.defaults.compaction.identifierPolicy":
    'Compaction identifier policy. "strict" preserves identifiers, "off" disables special identifier handling, and "custom" uses configured instructions.',
  "memory.qmd.paths.pattern":
    "Glob pattern for a QMD path. Use patterns such as **/*.md to index Markdown below the configured path while avoiding unrelated files.",
  "memory.qmd.update.interval":
    "Use this to control how often QMD should refresh collections, for example 5m. Lower values make recall fresher but increase background CPU and disk activity.",
  "memory.qmd.update.embedInterval":
    "How often QMD should refresh embeddings, for example 60m. Keep this higher than metadata refresh to avoid unnecessary local model work.",
  "agents.defaults.memorySearch.store.path":
    "SQLite path for the per-Agent memory index. The default style is ~/.fased/memory/{agentId}.sqlite; keep {agentId} when multiple Agents share one gateway.",
  "cron.webhook":
    'Deprecated legacy webhook delivery config. New tasks should use delivery.mode="webhook" and delivery.to on the task itself, then migrate old cron.webhook settings.',
  "cron.sessionRetention":
    "Controls task run session retention. Use durations like 24h, 7d, or 1h30m; set false only when you intentionally want to keep task sessions indefinitely.",
  "cron.webhookToken":
    "Bearer token for legacy cron webhook delivery. Treat it as a secret, prefer env or SecretRef storage, and rotate it if it was exposed.",
  "session.sendPolicy.rules":
    'Ordered send policy rules such as { action: "deny", match: { channel: "discord" } }. Use these to block or allow sends by channel/session pattern.',
  "session.sendPolicy.rules[].match.keyPrefix":
    "Matches the normalized session key prefix after provider/session normalization. Use this for stable policy checks across channel formatting changes.",
  "session.sendPolicy.rules[].match.rawKeyPrefix":
    "Matches the raw unnormalized session key prefix exactly as stored. Use only when normalized matching is not specific enough.",
  "session.maintenance.pruneAfter":
    "Retention duration for old session files, for example 30d or 12h. Lower values save disk space but reduce historical context available for diagnostics.",
  "session.maintenance.rotateBytes":
    "Rotate a session transcript once it reaches this size, for example 10mb or 1gb. Use this to avoid giant JSONL files on busy channels.",
  "session.maintenance.pruneDays":
    "Deprecated day-count retention. Use session.maintenance.pruneAfter instead so mixed durations such as 12h or 30d are explicit.",
  "session.maintenance.resetArchiveRetention":
    "Retention for archived .reset. session files. Set a duration to clean old reset archives, or false only when audit policy requires keeping them.",
  "session.maintenance.maxDiskBytes":
    "Maximum disk budget for session storage, for example 500mb. When exceeded, maintenance prunes eligible old sessions according to policy.",
  "session.maintenance.highWaterBytes":
    "High-water mark for session storage, such as 80%. Cleanup starts before the hard max so the gateway avoids sudden disk pressure.",
  "cron.runLog":
    "Task run-log storage under cron/runs. Enable it when you need run diagnostics; tune retention so routine scheduled work does not grow forever.",
  "cron.runLog.maxBytes":
    "Maximum run-log size per task, for example 2mb. Increase only when task debugging needs longer raw logs.",
  "cron.runLog.keepLines":
    "Approximate line retention for task run logs, for example 2000. Lower values keep the UI fast on noisy recurring tasks.",
  "approvals.exec.sessionFilter":
    "Optional substring or regex filter for sessions that can request exec approval, for example discord: or ^agent:ops:. Use this to avoid broad approval prompts.",
  "approvals.exec.agentFilter":
    "Optional Agent filter for exec approvals. Use values such as primary or ops-agent to keep approval prompts tied to trusted Agents.",
  "approvals.exec.targets[].to":
    "Destination channel ID, user ID, or thread root for approval prompts. The meaning differs per provider, so copy it from the channel route/status UI.",
  "broadcast.*":
    "Broadcast map from a source peer ID to Agent IDs. Use it to fan out an eligible inbound channel message to selected Agents without making every channel globally writable.",
  "hooks.mappings[].transform.module":
    "Relative transform module path for hook payload shaping. Absolute paths and path traversal are blocked; keep modules reviewed and controlled.",
  "web.reconnect.maxAttempts":
    "Maximum Control UI reconnect attempts after a failure sequence. 0 means no retries; increase for flaky remote gateways.",
  "plugins.entries.*.apiKey":
    "Plugin credential field. Treat as a secret, prefer env or SecretRef storage, and only configure credentials for plugins you trust.",
  "plugins.entries.*.env":
    "Plugin-scoped environment variables. Use this for plugin-specific runtime environment without leaking settings into unrelated extensions.",
  "models.providers.*.apiKey":
    "Model provider credential. Treat as a secret, prefer env or SecretRef storage, and keep provider credentials separate from Agent model selection.",
  "models.bedrockDiscovery.refreshInterval":
    "Bedrock model discovery refresh interval in seconds. Lower refresh values increase AWS API calls, cost/noise, and startup churn.",
  "auth.cooldowns":
    "Authentication cooldown/backoff settings. Use these to slow repeated retry loops after provider auth failures or invalid credentials.",
  "agents.defaults.compaction.maxHistoryShare":
    "Maximum fraction of context reserved for history, usually 0.1-0.9. Lower the share to leave more room for fresh task input and tools.",
  "agents.defaults.compaction.memoryFlush.enabled":
    "Enables the pre-compaction memory flush when token pressure is high. The Agent gets a chance to write durable memory before old context is compacted.",
};

function genericFieldHelp(key: string): string {
  return `Advanced config field "${key}". Use this setting only when the focused UI does not expose the control yet. The default is usually safest; set it deliberately and keep changes documented.`;
}

export const FIELD_HELP: Record<string, string> = new Proxy(FIELD_HELP_BASE, {
  get(target, prop, receiver) {
    if (typeof prop !== "string") {
      return Reflect.get(target, prop, receiver);
    }
    const explicit = SPECIFIC_FIELD_HELP[prop];
    if (explicit) {
      return `${explicit} ${genericFieldHelp(prop)}`;
    }
    const configured = Reflect.get(target, prop, receiver);
    const fallback = genericFieldHelp(prop);
    return typeof configured === "string" && configured.trim()
      ? `${configured} ${fallback}`
      : fallback;
  },
  has(target, prop) {
    return typeof prop === "string" ? true : Reflect.has(target, prop);
  },
});
