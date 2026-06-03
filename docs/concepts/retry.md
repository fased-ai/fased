---
summary: "Retry policy for outbound channel API calls."
read_when:
  - Updating Telegram or Discord retry behavior
  - Debugging channel send errors or rate limits
title: "Outbound Channel Retry"
---

# Outbound Channel Retry

## Goals

- Retry per outbound HTTP request, not per multi-step flow.
- Preserve ordering by retrying only the current step.
- Avoid duplicating non-idempotent operations.

This page covers Telegram and Discord channel sends. Model-provider retry and
fallback behavior is separate from channel delivery retry.

## Defaults

- Attempts: 3
- Max delay cap: 30000 ms
- Jitter: 0.1 (10 percent)
- Channel defaults:
  - Telegram min delay: 400 ms
  - Discord min delay: 500 ms

## Behavior

### Discord

- Retries only Carbon `RateLimitError` responses.
- Uses Discord `retry_after` when available, otherwise exponential backoff.
- Does not retry ordinary network or permission errors.

### Telegram

- Retries on transient errors: 429, timeout, connect/reset/closed, unavailable,
  or temporarily unavailable.
- Uses `retry_after` when available, otherwise exponential backoff.
- HTML/Markdown parse errors are not retried through the retry runner; Telegram
  send falls back to plain text where the send path supports it.

## Configuration

Set retry policy per channel in `~/.fased/fased.json`:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Notes

- Retries apply per request, such as message send, media upload, reaction, poll,
  sticker, or thread creation where the channel sender wraps the call.
- Composite flows do not retry completed steps.
