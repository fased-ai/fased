---
summary: "Use webhook helper commands, including the Gmail Pub/Sub setup flow."
read_when:
  - You want to wire Gmail Pub/Sub events into Fased
  - You want webhook helper commands
title: "webhooks"
---

# `fased webhooks`

Webhook helpers and related integrations, including the Gmail Pub/Sub setup flow.

Related:

- Webhooks: [Webhook](/automation/webhook)
- Gmail Pub/Sub: [Gmail Pub/Sub](/automation/gmail-pubsub)

## Gmail

```bash
fased webhooks gmail setup --account you@example.com
fased webhooks gmail run
```

Useful setup options:

- `--project <id>`: GCP project id.
- `--topic <name>` / `--subscription <name>`: Pub/Sub resources.
- `--label <label>`: Gmail label to watch.
- `--hook-url <url>` / `--hook-token <token>`: Fased hook destination.
- `--tailscale <funnel|serve|off>`: supported exposure mode.
- `--push-endpoint <url>`: explicit Pub/Sub push endpoint.
- `--json`: print setup summary as JSON.

Useful run options:

- `--account <email>`: Gmail account to watch.
- `--hook-url <url>` / `--hook-token <token>`: override hook destination.
- `--include-body` / `--max-bytes <n>`: include bounded message content.
- `--renew-minutes <n>`: renew the watch on an interval.

See [Gmail Pub/Sub documentation](/automation/gmail-pubsub) for details.
