---
summary: "How Providers, Agents, Sessions, Tasks, Chat, and Channels fit together."
read_when:
  - You added a provider and need to attach it to an Agent
  - You want to know where model choice belongs
  - You want Chat and channels to use the same Agent setup
title: "Models, Agents, Sessions, And Chat"
sidebarTitle: "Models to Agents"
---

# Models, Agents, Sessions, And Chat

Use this flow after onboarding finishes.

The control model is:

```text
Provider auth -> Agent model refs -> Session -> Task/Subagent -> Delivery channel
```

Provider auth supplies model access. Agents choose what they can use. Sessions
own conversation/task context. Channels deliver messages.

For task optimization and future task rooms, read
[Task Operating Layer](/concepts/task-operating-layer).

## 1. Agent Models

Open `/agents`, select the Agent, then open **Models**.

Use it to:

- sign in to a provider
- paste an API key or token
- configure local/manual endpoints such as Ollama, LM Studio, vLLM, LiteLLM,
  Cloudflare AI, or Custom Provider
- inspect whether credentials are ready
- choose this Agent's primary, fallback, and task model refs

Provider auth gives Fased model access. The Agent model refs decide which Agent
uses that access. Hidden provider pages may still exist for deep links and
advanced repair, but normal setup is `Agent > Models`.

## 2. Agents

Stay in `/agents` after at least one provider is ready.

Use it to:

- create or select an Agent
- choose the Agent's default provider route and model
- attach skills and services
- route channels to the Agent
- configure memory, hooks, tasks, and wallet policy for that Agent

An Agent is the persistent setup object. It owns the default model, enabled
abilities, workspace, memory, channel routes, schedules, and wallet policy.

## 3. Sessions

Sessions are the working contexts under an Agent.

Examples:

```text
Assistant / Chat 1
Research Agent / Service watch
Operations Agent / Provider monitor
```

WebChat can create named local sessions. Channel chats can create and switch
named sessions with `/session new`, `/session list`, and `/session switch`.

Tasks should attach to a Session, not to a Channel.

## 4. Chat

Open `/chat` to talk to an Agent/session directly.

Chat uses the selected Agent's default model unless you override the model for
the current chat session. A session override affects that chat session; it does
not rewrite the Agent default unless you save the model from `/agents`.

Chat should only show provider routes and models from the current Fased provider
registry. Old runtime provider catalogs are compatibility data, not normal
picker entries.

Use **Schedule this** in the Chat composer to create a scheduled task for the
current Agent/session. If the selected session came from a channel, the task can
optionally deliver back there.

## 5. Channels

Open `Agent > Channels` to connect external apps.

Each channel route should target an Agent. Example:

```text
Telegram ops DM -> Operations
Discord support channel -> Support
```

The channel uses the routed Agent's model, skills, services, memory, and wallet
policy. Use Chat for internal/operator work; use channels for external delivery.

Channels do not own scheduled work. A scheduled report is:

```text
Researcher -> Daily report session -> scheduled task -> delivery target
```

not:

```text
Telegram owns the daily report
```

## 6. Tasks

Tasks are scheduled work attached to Agent + Session. Create and
manage them from:

- Chat composer: **Schedule this**
- channel chat: `/task new`, `/task list`, `/task show`, `/task run`, `/task cancel`
- `/sessions` and `Agent > Sessions`: edit, run, cancel session-owned tasks
- `Agent > Tasks`: full scheduler view for the selected Agent

Channel task creation should be natural first:

```text
/task new every 1h Service watch: Check provider status with a cheap check first and escalate if deeper analysis is needed.
```

That creates a normal scheduled Task for the active Agent/session. The
planner infers the cheap-first evaluator policy and delivery back to the current
channel when the route has a known target.

## Local Models

For local models:

- use vLLM when you run a vLLM server
- use Ollama when you run local, cloud, or hybrid Ollama
- use LM Studio when you run its localhost:1234 server
- use LiteLLM when you proxy multiple model backends
- use Custom Provider for SGLang or another OpenAI-compatible endpoint

Ollama normal UI setup is:

```text
Agent > Models -> Ollama
Base URL: http://127.0.0.1:11434
Model: llama3.3
```

For more local runtime setup details, see [Local models](/gateway/local-models).
