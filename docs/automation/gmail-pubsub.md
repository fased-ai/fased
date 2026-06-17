---
summary: "Wire Gmail Pub/Sub into Fased webhook ingress via gogcli"
read_when:
  - Connecting Gmail inbox events to Fased
  - Setting up Gmail push delivery for agent wakeups
title: "Gmail Pub/Sub"
---

# Gmail Pub/Sub -> Fased

Recommended flow:

`Gmail watch -> Pub/Sub push -> gog gmail watch serve -> Fased webhook`

This keeps the message content off the public internet as much as possible and
fits Fased's private-ingress model.

## What you need

- `gcloud` installed and logged in
- `gog` / `gogcli` installed and authorized for the Gmail account
- Fased webhook ingress enabled
- `tailscale` logged in if you want the supported public HTTPS path

Supported public endpoint pattern:

- **Tailscale Funnel**

Tailscale Funnel is the documented baseline. Other tunnel providers are
advanced DIY setups.

## Minimal webhook config

```json5
{
  hooks: {
    enabled: true,
    token: "FASED_HOOK_TOKEN",
    path: "/hooks",
    presets: ["gmail"],
  },
}
```

To push Gmail summaries into a chat surface, override the preset with a mapping:

```json5
{
  hooks: {
    enabled: true,
    token: "FASED_HOOK_TOKEN",
    presets: ["gmail"],
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        model: "openai/gpt-5.4-mini",
        deliver: true,
        channel: "last",
        // to: "+15551234567"
      },
    ],
  },
}
```

Notes:

- `channel: "last"` reuses the last route known to the target Agent/session
- if you want deterministic delivery, set both `channel` and `to`
- Gmail hook content is wrapped with external-content safety boundaries by
  default
- to disable that wrapper, set
  `hooks.gmail.allowUnsafeExternalContent: true` only for tightly controlled
  environments

Optional Gmail-specific model overrides:

```json5
{
  hooks: {
    gmail: {
      model: "openai/gpt-5.4-mini",
      thinking: "off",
    },
  },
}
```

Resolution order:

1. mapping-level `model` / `thinking`
2. `hooks.gmail.model` / `hooks.gmail.thinking`
3. normal agent defaults

Use a model that is already configured for the target Agent. Set or review that
model in **Agent > Models** before pinning a Gmail mapping to a specific
`provider/model` ref.

For the simplest setup, omit the mapping-level `model` and let the target Agent
use its configured primary/fallback model.

## Recommended setup: wizard

```bash
fased webhooks gmail setup --account fased@gmail.com
```

What it does:

- enables the Gmail webhook preset
- writes the `hooks.gmail` config used by `fased webhooks gmail run`
- prefers Tailscale Funnel for the public push endpoint

Path note:

- when `tailscale.mode` is enabled, Fased sets `hooks.gmail.serve.path` to `/`
- the public path stays at `hooks.gmail.tailscale.path`, default
  `/gmail-pubsub`
- if you need the backend to keep the prefixed path, set
  `hooks.gmail.tailscale.target` to a full URL like
  `http://127.0.0.1:8788/gmail-pubsub`

Platform note:

- on macOS the helper can install `gcloud`, `gogcli`, and `tailscale` via
  Homebrew
- on Linux, install them yourself first

## Gateway auto-start

When these are set:

- `hooks.enabled = true`
- `hooks.gmail.account` is configured

the gateway starts `gog gmail watch serve` on boot and keeps the watch renewed.

Opt out:

```bash
FASED_SKIP_GMAIL_WATCHER=1
```

Run either gateway auto-start or the manual daemon. Running both at the same
time can hit a port bind conflict.

Manual runner:

```bash
fased webhooks gmail run
```

## One-time Google Cloud setup

1. Select the GCP project that owns the OAuth client used by `gog`

```bash
gcloud auth login
gcloud config set project <project-id>
```

2. Enable the required APIs

```bash
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

3. Create the Pub/Sub topic

```bash
gcloud pubsub topics create gog-gmail-watch
```

4. Let Gmail publish into that topic

```bash
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

Important:

- the Pub/Sub topic must live in the same GCP project as the OAuth client used
  for the Gmail watch

## Start the Gmail watch

```bash
gog gmail watch start \
  --account fased@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

Keep the returned `history_id` if you want a clean debugging baseline.

## Run the push handler directly

```bash
gog gmail watch serve \
  --account fased@gmail.com \
  --bind 127.0.0.1 \
  --port 8788 \
  --path /gmail-pubsub \
  --token <shared> \
  --hook-url http://127.0.0.1:18789/hooks/gmail \
  --hook-token FASED_HOOK_TOKEN \
  --include-body \
  --max-bytes 20000
```

Notes:

- `--token` protects the push endpoint seen by Pub/Sub
- `--hook-url` should point at your Fased webhook mapping such as `/hooks/gmail`
- `--include-body` and `--max-bytes` control how much message content reaches
  Fased

For most setups, `fased webhooks gmail run` is the cleaner wrapper.

## Non-Tailscale public ingress

You can expose the Gmail push handler through another tunnel, but that is an
advanced, unsupported path.

Example:

```bash
cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
```

Then bind the generated URL in the subscription:

```bash
gcloud pubsub subscriptions create gog-gmail-watch-push \
  --topic gog-gmail-watch \
  --push-endpoint "https://<public-url>/gmail-pubsub?token=<shared>"
```

If you move to a stronger production edge, use Pub/Sub OIDC verification and:

```bash
gog gmail watch serve --verify-oidc --oidc-email <svc@...>
```

## Test the flow

Send a message to the watched inbox:

```bash
gog gmail send \
  --account fased@gmail.com \
  --to fased@gmail.com \
  --subject "watch test" \
  --body "ping"
```

Inspect status and history:

```bash
gog gmail watch status --account fased@gmail.com
gog gmail history --account fased@gmail.com --since <historyId>
```

## Troubleshooting

- `Invalid topicName`
  - the topic lives in the wrong project
- `User not authorized`
  - the Gmail push service account is missing publisher access
- empty messages
  - Gmail push only carries `historyId`; fetch message details through
    `gog gmail history`

## Cleanup

```bash
gog gmail watch stop --account fased@gmail.com
gcloud pubsub subscriptions delete gog-gmail-watch-push
gcloud pubsub topics delete gog-gmail-watch
```
