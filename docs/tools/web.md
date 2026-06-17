---
summary: "Web search + fetch tools (Brave, DuckDuckGo, Exa, Firecrawl, Gemini, Kimi, Grok, Perplexity, SearXNG, or Tavily)"
read_when:
  - You want to enable web_search or web_fetch
  - You need web search provider setup
  - You want to use a hosted, keyless, or self-hosted web search provider
title: "Web Tools"
---

# Web tools

Fased ships two lightweight web tools:

- `web_search` — Search the web via Brave Search API, DuckDuckGo,
  Exa, Firecrawl Search, Perplexity Sonar, Gemini with Google Search
  grounding, Kimi, Grok, SearXNG, or Tavily.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## How it works

- `web_search` calls your configured provider and returns results.
  - **Brave**: returns structured results (title, URL, snippet).
  - **DuckDuckGo**: keyless fallback for lightweight public search.
  - **Exa**: research-oriented results with highlights.
  - **Firecrawl Search**: structured search results from Firecrawl.
  - **Perplexity**: returns AI-synthesized answers with citations from real-time
    web search.
  - **Gemini**: returns AI-synthesized answers grounded in Google Search with
    citations.
  - **Kimi**: uses Moonshot/Kimi search-capable models.
  - **Grok**: uses xAI search-capable models.
  - **SearXNG**: uses your self-hosted metasearch instance.
  - **Tavily**: structured search results and optional answer summaries.
- Results are cached by query for 15 minutes (configurable).
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` is enabled by default (unless explicitly disabled).

## Choosing a search provider

- **Brave**: fast structured search. Needs `BRAVE_API_KEY`.
- **DuckDuckGo**: keyless fallback. Needs no setup.
- **Exa**: research search and highlights. Needs `EXA_API_KEY`.
- **Firecrawl**: structured search + page crawling. Needs `FIRECRAWL_API_KEY`.
- **Gemini**: Google Search grounding. Needs `GEMINI_API_KEY`.
- **Grok**: xAI search-capable answers. Needs `XAI_API_KEY`.
- **Kimi**: long-context answer synthesis. Needs `KIMI_API_KEY` or
  `MOONSHOT_API_KEY`.
- **Perplexity**: AI answers with citations. Needs `OPENROUTER_API_KEY` or
  `PERPLEXITY_API_KEY`.
- **SearXNG**: self-hosted/private metasearch. Needs `SEARXNG_BASE_URL` or the
  Services base URL field.
- **Tavily**: structured search and summaries. Needs `TAVILY_API_KEY`.

See [Brave Search setup](/tools/web#getting-a-brave-api-key) and
[Perplexity Sonar](/tools/web#using-perplexity-direct-or-via-openrouter) for
provider-specific details.

## Where to configure it

Normal setup belongs in **Services -> Web/search** or the CLI wizard:

```bash
fased configure --section web
```

That flow lets you pick the provider, store that provider's API key, enable or
disable `web_search`, enable or disable `web_fetch`, clear the stored key, and
test the connection.

`Agent -> Tools` is not where credentials are stored. Agent Tools only decides
whether a specific Agent may use `web_search`, `web_fetch`, or `group:web`
after the service is configured.

### Auto-detection

If no `provider` is explicitly set, Fased auto-detects which provider to use
based on available API keys, checking in this order:

1. **Brave** — `BRAVE_API_KEY` env var or `search.apiKey` config
2. **Gemini** — `GEMINI_API_KEY` env var or `search.gemini.apiKey` config
3. **Kimi** — `KIMI_API_KEY` / `MOONSHOT_API_KEY` env var or
   `search.kimi.apiKey` config
4. **Perplexity** — `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` env var or
   `search.perplexity.apiKey` config
5. **Grok** — `XAI_API_KEY` env var or `search.grok.apiKey` config
6. **Exa** — `EXA_API_KEY` env var or `search.exa.apiKey` config
7. **Tavily** — `TAVILY_API_KEY` env var or `search.tavily.apiKey` config
8. **Firecrawl** — `FIRECRAWL_API_KEY` env var or `search.firecrawl.apiKey` config
9. **SearXNG** — `SEARXNG_BASE_URL` env var or `search.searxng.baseUrl` config
10. **DuckDuckGo** — keyless fallback when nothing else is configured

### Explicit provider

Set the provider in config:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity", "gemini", "kimi", or "grok"
      },
    },
  },
}
```

For keyless search:

```json5
{
  tools: {
    web: {
      search: {
        provider: "duckduckgo",
        duckduckgo: {
          region: "us-en",
          safeSearch: "moderate",
        },
      },
    },
  },
}
```

For self-hosted metasearch:

```json5
{
  tools: {
    web: {
      search: {
        provider: "searxng",
        searxng: {
          baseUrl: "http://127.0.0.1:8080",
          categories: "general",
          language: "en",
        },
      },
    },
  },
}
```

Example: switch to Perplexity Sonar (direct API):

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Getting a Brave API key

1. Create a Brave Search API account at [https://brave.com/search/api/](https://brave.com/search/api/)
2. In the dashboard, choose the **Data for Search** plan (not “Data for AI”) and generate an API key.
3. Run `fased configure --section web` to store the key in config
   (recommended), or set `BRAVE_API_KEY` in your environment.

Check the Brave API portal for current limits and pricing.

### Where to set the key (recommended)

**Recommended:** run `fased configure --section web`. It stores the key in
`~/.fased/fased.json` under `tools.web.search.apiKey`.

**Environment alternative:** set `BRAVE_API_KEY` in the Gateway process
environment. For a gateway install, put it in `~/.fased/.env` (or your
service environment). See [Env vars](/help/faq#how-does-fased-load-environment-variables).

## Using Perplexity (direct or via OpenRouter)

Perplexity Sonar models have built-in web search capabilities and return
AI-synthesized answers with citations. You can use them directly or through a
compatible model gateway.

### Getting an OpenRouter API key

1. Create an account at [https://openrouter.ai/](https://openrouter.ai/)
2. Add credits using the payment methods available in your account
3. Generate an API key in your account settings

### Setting up Perplexity search

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Environment alternative:** set `OPENROUTER_API_KEY` or `PERPLEXITY_API_KEY` in
the Gateway environment. For a gateway install, put it in `~/.fased/.env`.

If no base URL is set, Fased chooses a default based on the API key source:

- `PERPLEXITY_API_KEY` or `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` or `sk-or-...` → `https://openrouter.ai/api/v1`
- Unknown key formats → OpenRouter (safe fallback)

### Available Perplexity models

- `perplexity/sonar`: fast Q&A with web search. Best for quick lookups.
- `perplexity/sonar-pro` (default): multi-step reasoning with web search. Best
  for complex questions.
- `perplexity/sonar-reasoning-pro`: chain-of-thought analysis. Best for deep
  research.

## Using Gemini (Google Search grounding)

Gemini models support built-in
[Google Search grounding](https://ai.google.dev/gemini-api/docs/grounding),
which returns AI-synthesized answers backed by live Google Search results with
citations.

### Getting a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Set `GEMINI_API_KEY` in the Gateway environment, or configure `tools.web.search.gemini.apiKey`

### Setting up Gemini search

```json5
{
  tools: {
    web: {
      search: {
        provider: "gemini",
        gemini: {
          // API key (optional if GEMINI_API_KEY is set)
          apiKey: "AIza...",
          // Model (defaults to "gemini-2.5-flash")
          model: "gemini-2.5-flash",
        },
      },
    },
  },
}
```

**Environment alternative:** set `GEMINI_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.fased/.env`.

### Notes

- Citation URLs from Gemini grounding are automatically resolved from Google's
  redirect URLs to direct URLs.
- Redirect resolution uses the SSRF guard path before returning the final
  citation URL. It checks HEAD, redirects, and http/https validity.
- This redirect resolver follows Gateway operator trust assumptions:
  private/internal networks are allowed by default.
- The default model (`gemini-2.5-flash`) is fast and cost-effective.
  Any Gemini model that supports grounding can be used.

## web_search

Search the web using your configured provider.

### Requirements

- `tools.web.search.enabled` must not be `false` (default: enabled)
- API key for your chosen provider:
  - **Brave**: `BRAVE_API_KEY` or `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, or `tools.web.search.perplexity.apiKey`

### Config

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Tool parameters

- `query` (required)
- `count` (1–10; default from config)
- `country` (optional): 2-letter country code for region-specific results, such
  as `"DE"`, `"US"`, or `"ALL"`. If omitted, Brave chooses its default region.
- `search_lang` (optional): ISO language code for search results (e.g., "de", "en", "fr")
- `ui_lang` (optional): ISO language code for UI elements
- `freshness` (optional): filter by discovery time
  - Brave: `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`
  - Perplexity: `pd`, `pw`, `pm`, `py`

**Examples:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Fetch a URL and extract readable content.

### web_fetch requirements

- `tools.web.fetch.enabled` must not be `false` (default: enabled)
- Optional Firecrawl fallback: set `tools.web.fetch.firecrawl.apiKey` or `FIRECRAWL_API_KEY`.

### web_fetch config

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        maxResponseBytes: 2000000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 ... Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### web_fetch tool parameters

- `url` (required, http/https only)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncate long pages)

Notes:

- For HTML, `web_fetch` uses Readability first and falls back to basic HTML
  cleanup when Readability cannot extract main content.
- Firecrawl fallback is used when direct fetch fails, the server returns an
  error, or extraction returns no content and Firecrawl is configured.
- Firecrawl requests use bot-circumvention mode and cache results by default.
- `web_fetch` sends a Chrome-like User-Agent and `Accept-Language` by default; override `userAgent` if needed.
- `web_fetch` blocks private/internal hostnames and re-checks redirects (limit with `maxRedirects`).
- `maxChars` is clamped to `tools.web.fetch.maxCharsCap`.
- `web_fetch` caps the downloaded response body size to
  `tools.web.fetch.maxResponseBytes` before parsing. Oversized responses are
  truncated and include a warning.
- `web_fetch` is best-effort extraction; some sites will need the browser tool.
- See [Firecrawl](/tools/firecrawl) for key setup and service details.
- Responses are cached (default 15 minutes) to reduce repeated fetches.
- If you use tool profiles/allowlists, add `web_search`/`web_fetch` or `group:web`.
- If the selected provider key is missing, `web_search` returns a setup hint and task preflight points to Services -> Web/search.
