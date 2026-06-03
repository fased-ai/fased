---
name: coding-agent
description: 'Delegate coding tasks to Codex, Claude Code, OpenCode, or Pi agents via immediate background processes. Use when: (1) building or creating features/apps, (2) reviewing PRs in a temp clone/worktree, (3) refactoring large codebases, (4) iterative coding that needs file exploration. NOT for: simple one-line fixes (just edit), reading code (use read tool), thread-bound ACP harness requests in chat (use sessions_spawn with runtime:"acp"), or any work in ~/.fased workspace. All coding-agent runs start with background:true immediately. Claude Code: use --print --permission-mode bypassPermissions with no PTY. Codex/Pi/OpenCode: pty:true required. Completion notification must use direct fased message send.'
metadata:
  { "fased": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex", "opencode", "pi"] } } }
---

# Coding Agent (always backgrounded)

Use **bash** with **background:true** for all coding-agent work.
Do not start a foreground coding-agent process here.
Start the agent, get the `sessionId`, monitor with `process`, and require the worker to notify the user directly when it finishes.

## PTY Mode: Codex/Pi/OpenCode yes, Claude Code no

For **Codex, Pi, and OpenCode**, PTY is required:

```bash
# Correct for Codex/Pi/OpenCode
bash pty:true background:true command:"codex exec 'Your prompt'"
```

For **Claude Code** (`claude` CLI), use `--print --permission-mode bypassPermissions` instead.
Do not use PTY for Claude Code here.

```bash
# Correct for Claude Code
bash background:true command:"claude --permission-mode bypassPermissions --print 'Your task'"

# Wrong for Claude Code
bash pty:true command:"claude 'task'"
```

### Bash Tool Parameters

| Parameter    | Type    | Description                                 |
| ------------ | ------- | ------------------------------------------- |
| `command`    | string  | The shell command to run                    |
| `pty`        | boolean | Use for Codex/Pi/OpenCode                   |
| `workdir`    | string  | Working directory                           |
| `background` | boolean | **Always true for this skill**              |
| `timeout`    | number  | Timeout in seconds                          |
| `elevated`   | boolean | Run on host instead of sandbox (if allowed) |

### Process Tool Actions

| Action      | Description                                          |
| ----------- | ---------------------------------------------------- |
| `list`      | List all running/recent sessions                     |
| `poll`      | Check if session is still running                    |
| `log`       | Get session output (with optional offset/limit)      |
| `write`     | Send raw data to stdin                               |
| `submit`    | Send data + newline (like typing and pressing Enter) |
| `send-keys` | Send key tokens or hex bytes                         |
| `paste`     | Paste text (with optional bracketed mode)            |
| `kill`      | Terminate the session                                |

---

## Mandatory Pattern

Every coding-agent run follows this pattern:

1. Capture the notification route from the current conversation before spawning:
   - `notifyChannel`
   - `notifyTarget`
   - `notifyAccount` (if applicable)
   - `notifyReplyTo` (if replying to a specific message is desired)
   - `notifyThreadId` (Telegram topic / Slack thread when applicable)
2. Start the coding CLI with `background:true` immediately.
3. Include the notification route in the worker prompt and require the worker to call `fased message send` on completion.
4. Monitor with `process action:log` / `poll`.
5. If the worker needs input or fails before notifying, handle that explicitly yourself. Do not rely on heartbeat.

If you do not have a trustworthy notification route, say so and do not claim that completion will notify the user automatically.

---

## Notification Route

Do not rely on:

- legacy system-event wake commands
- `tools.exec.notifyOnExit`
- heartbeat delivery
- `HEARTBEAT.md`

Use a direct outbound completion message instead:

```bash
fased message send --channel <channel> --target '<target>' --message '<text>'
```

Add optional routing flags only when they are real and applicable:

- `--account <id>`
- `--reply-to <messageId>`
- `--thread-id <threadId>`

`fased message send` is a direct outbound send. It does not depend on heartbeat being enabled.

### Completion Prompt Snippet

Append something like this to every worker prompt:

```text
Notification route for completion:
- channel: <notifyChannel>
- target: <notifyTarget>
- account: <notifyAccount or omit>
- reply_to: <notifyReplyTo or omit>
- thread_id: <notifyThreadId or omit>

When the task is completely finished, send exactly one completion message back to the user with fased message send using that route.
If the task fails fatally, send exactly one failure message back to the user with fased message send using that route.
Do not use legacy system-event wake commands. Do not rely on heartbeat. Do not skip the completion/failure message.
```

---

## Quick Start

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH" && git init

bash pty:true workdir:$SCRATCH background:true command:"codex exec 'Your prompt here.

Notification route for completion:
- channel: <notifyChannel>
- target: <notifyTarget>

When the task is completely finished, send exactly one completion message back to the user with fased message send using that route.
If the task fails fatally, send exactly one failure message back to the user with fased message send using that route.
Do not use legacy system-event wake commands. Do not rely on heartbeat. Do not skip the completion/failure message.'"
```

Codex refuses to run outside a trusted git directory.
Reuse this same notify-route injection block in every example below; only the task-specific prompt body should change.

---

## The Pattern: workdir + background + pty

```bash
# Start agent in target directory (with PTY!)
bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Build a snake game'"
# Returns sessionId for tracking

# Monitor progress
process action:log sessionId:XXX

# Check if done
process action:poll sessionId:XXX

# Send input (if agent asks a question)
process action:write sessionId:XXX data:"y"

# Submit with Enter (like typing "yes" and pressing Enter)
process action:submit sessionId:XXX data:"yes"

# Kill if needed
process action:kill sessionId:XXX
```

**Why workdir matters:** The worker starts in a focused directory and does not scan unrelated files.

---

## Codex CLI

**Model:** `gpt-5.2-codex` is the default (set in ~/.codex/config.toml)

### Flags

| Flag            | Effect                                             |
| --------------- | -------------------------------------------------- |
| `exec "prompt"` | Single-prompt execution, exits when done           |
| `--full-auto`   | Sandboxed but auto-approves in workspace           |
| `--yolo`        | NO sandbox, NO approvals (fastest, most dangerous) |

### Building/Creating

```bash
# Auto-approved background task
bash pty:true workdir:~/project background:true command:"codex exec --full-auto 'Build a dark mode toggle'"

bash pty:true workdir:~/project background:true command:"codex --yolo 'Refactor the auth module'"
```

### Reviewing PRs

**⚠️ CRITICAL: Never review PRs in FasedAgent's own project folder!**
Clone to temp folder or use git worktree.

```bash
# Clone to temp for safe review
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/user/repo.git $REVIEW_DIR
cd $REVIEW_DIR && gh pr checkout 130
bash pty:true workdir:$REVIEW_DIR background:true command:"codex review --base origin/main"
# Clean up after: trash $REVIEW_DIR

# Or use git worktree (keeps main intact)
git worktree add /tmp/pr-130-review pr-130-branch
bash pty:true workdir:/tmp/pr-130-review background:true command:"codex review --base main"
```

### Batch PR Reviews (parallel army!)

```bash
# Fetch all PR refs first
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

# Deploy the army - one Codex per PR (all with PTY!)
bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #86. git diff origin/main...origin/pr/86'"
bash pty:true workdir:~/project background:true command:"codex exec 'Review PR #87. git diff origin/main...origin/pr/87'"

# Monitor all
process action:list

# Post results to GitHub
gh pr comment <PR#> --body "<review content>"
```

---

## Claude Code

```bash
bash workdir:~/project background:true command:"claude --permission-mode bypassPermissions --print 'Your task'"
```

---

## OpenCode

```bash
bash pty:true workdir:~/project background:true command:"opencode run 'Your task'"
```

---

## Pi Coding Agent

```bash
# Install: npm install -g @mariozechner/pi-coding-agent
bash pty:true workdir:~/project background:true command:"pi 'Your task'"

# Non-interactive mode (PTY still recommended)
bash pty:true workdir:~/project background:true command:"pi -p 'Summarize src/'"

# Different provider/model
bash pty:true workdir:~/project background:true command:"pi --provider openai --model gpt-4o-mini -p 'Your task'"
```

**Note:** Pi now has Anthropic prompt caching enabled (PR #584, merged Jan 2026)!

---

## Parallel Issue Fixing with git worktrees

For fixing multiple issues in parallel, use git worktrees:

```bash
# 1. Create worktrees for each issue
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 2. Launch Codex in each (background + PTY!)
bash pty:true workdir:/tmp/issue-78 background:true command:"pnpm install && codex --yolo 'Fix issue #78: <description>. Commit and push.'"
bash pty:true workdir:/tmp/issue-99 background:true command:"pnpm install && codex --yolo 'Fix issue #99 from the approved ticket summary. Implement only the in-scope edits and commit after review.'"

# 3. Monitor progress
process action:list
process action:log sessionId:XXX

# 4. Create PRs after fixes
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 5. Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

---

## ⚠️ Rules

1. **Use the right terminal mode** - Codex, Pi, and OpenCode need `pty:true`; Claude Code print mode does not.
2. **Respect tool choice** - if user asks for Codex, use Codex.
   - Orchestrator mode: do NOT hand-code patches yourself.
   - If an agent fails/hangs, respawn it or ask the user for direction, but don't silently take over.
3. **Be patient** - don't kill sessions because they're "slow"
4. **Monitor with process:log** - check progress without interfering
5. **--full-auto for building** - auto-approves changes
6. **vanilla for reviewing** - no special flags needed
7. **Parallel is OK** - run many Codex processes at once for batch work
8. **Never start coding agents in ~/.fased/** or other runtime/state directories.
9. **Never checkout branches in a live Fased Agent instance.**

---

## Progress Updates (Critical)

When you spawn coding agents in the background, keep the user in the loop.

- Send 1 short message when you start (what's running + where).
- Then only update again when something changes:
  - a milestone completes (build finished, tests passed)
  - the agent asks a question / needs input
  - you hit an error or need user action
  - the agent finishes (include what changed + where)
- If you kill a session, immediately say you killed it and why.

This prevents the user from seeing only "Agent failed before reply" and having no idea what happened.

---

## Completion Notification

For long-running background tasks, append a direct completion send to the prompt:

```
... your task here.

When completely finished, send one completion message:
fased message send --channel <channel> --target '<target>' --message "Done: [brief summary]"
```

**Example:**

```bash
bash pty:true workdir:~/project background:true command:"codex --yolo exec 'Build a REST API for todos.

When completely finished, run:
fased message send --channel <channel> --target \"<target>\" --message \"Done: Built todos REST API with CRUD endpoints\"'"
```

---

## Learnings (Jan 2026)

- **PTY is essential:** Coding agents are interactive terminal apps. Without `pty:true`, output breaks or agent hangs.
- **Git repo required:** Codex won't run outside a git directory. Use `mktemp -d && git init` for scratch work.
- **Use `codex exec` for scoped prompts:** it runs the requested task and exits cleanly inside the background worker.
- **submit vs write:** Use `submit` to send input + Enter, `write` for raw data without newline.
