---
summary: "Agent workspace: location, layout, and backup strategy"
read_when:
  - You need to explain the agent workspace or its file layout
  - You want to back up or migrate an agent workspace
title: "Agent Workspace"
---

# Agent workspace

The workspace is an Agent's home. It is the working directory used for that
Agent's file tools and workspace context. Keep it private and treat it as
memory.

This is separate from `~/.fased/`, which stores config, credentials, and
sessions.

**Important:** the workspace is the **default cwd**, not a hard sandbox. Tools
resolve relative paths against the workspace, but absolute paths can still reach
elsewhere on the host unless sandboxing is enabled. If you need isolation, use
[`agents.defaults.sandbox`](/gateway/sandboxing) (and/or per‑agent sandbox config).
When sandboxing is enabled and `workspaceAccess` is not `"rw"`, tools operate
inside a sandbox workspace under `~/.fased/sandboxes`, not your host workspace.

## Default location

- Default Agent: `~/.fased/workspace`
- If `FASED_PROFILE` is set and not `"default"`, the default becomes
  `~/.fased/workspace-<profile>`.
- Override the default workspace in `~/.fased/fased.json`:

```json5
{
  agents: { defaults: { workspace: "~/.fased/workspace" } },
}
```

Additional Agents can override the workspace per Agent:

```json5
{
  agents: {
    list: [
      { id: "main", default: true, workspace: "~/.fased/workspace" },
      { id: "research", workspace: "~/.fased/workspace-research" },
    ],
  },
}
```

If an additional Agent does not set its own `workspace`, Fased derives one from
the default workspace. With `agents.defaults.workspace` set, the fallback is
`<default-workspace>/<agentId>`. Without a configured default, the fallback is
under the Fased state directory, for example `~/.fased/workspace-research`.

`fased onboard`, `fased configure`, or `fased setup` will create the
workspace and seed the bootstrap files if they are missing.

If you already manage the workspace files yourself, you can disable bootstrap
file creation:

```json5
{ agents: { defaults: { skipBootstrap: true } } }
```

## Extra workspace folders

Older installs may have created `~/fased`. Keeping multiple workspace
directories around can cause confusing auth or state drift, because only one
workspace is active at a time.

**Recommendation:** keep one active workspace per Agent. If you no longer use
extra folders, archive or move them to Trash (for example `trash ~/fased`). If
you intentionally keep multiple workspaces, make sure `agents.defaults.workspace`
and any `agents.list[].workspace` entries point to the right folders.

Fased does not automatically choose among extra folders. Check the active path
in **Agent > Setup**, `fased status`, or `fased agents list` before archiving an
old workspace.

## Workspace file map (what each file means)

These are the standard files Fased expects inside the workspace:

- `AGENTS.md`
  - Operating instructions for the agent and how it should use memory.
  - Loaded at the start of every session.
  - Good place for rules, priorities, and "how to behave" details.

- `SOUL.md`
  - Persona, tone, and boundaries.
  - Loaded every session.

- `USER.md`
  - Who the user is and how to address them.
  - Loaded every session.

- `IDENTITY.md`
  - The agent's name, vibe, and emoji.
  - Created/updated during the bootstrap ritual.

- `TOOLS.md`
  - Notes about your local tools and conventions.
  - Does not control tool availability; it is only guidance.

- `HEARTBEAT.md`
  - Optional tiny checklist for heartbeat runs.
  - Keep it short to avoid token burn.

- `BOOT.md`
  - Optional operator-created startup checklist.
  - Runs on gateway startup only when the bundled `boot-md` internal hook is enabled.
  - Keep it short; use the message tool for outbound sends.

- `BOOTSTRAP.md`
  - One-time first-run ritual.
  - Only created for a brand-new workspace.
  - Delete it after the ritual is complete.

- `memory/*.md`
  - Optional archived session summaries, daily notes, or topic notes.
  - Retrieved through memory tools/search when needed; not all files are injected by default.

- `MEMORY.md` (optional)
  - Curated long-term memory.
  - Only load in the main, private session (not shared/group contexts).

See [Memory](/concepts/memory) for the workflow and automatic memory flush.

- `skills/` (optional)
  - Workspace-specific skills.
  - Overrides managed/bundled skills when names collide.

- `canvas/` (optional)
  - Optional place to keep Canvas UI project files.
  - The Canvas host default root is the Fased state canvas directory. Set `canvasHost.root`
    if you want the Gateway to serve `<workspace>/canvas`.

If any recognized bootstrap file is missing, Fased injects a "missing file" marker into
the session and continues. Large recognized bootstrap files are truncated when injected;
adjust limits with `agents.defaults.bootstrapMaxChars` (default: 20000) and
`agents.defaults.bootstrapTotalMaxChars` (default: 150000).
`fased setup` can recreate missing defaults without overwriting existing
files.

Fased also writes internal workspace state under `<workspace>/.fased/`, such as
bootstrap/onboarding completion markers. Do not edit those files by hand.

## What is NOT in the workspace

These live under `~/.fased/` and should NOT be committed to the workspace repo:

- `~/.fased/fased.json` (config)
- `~/.fased/credentials/` (OAuth tokens, API keys)
- `~/.fased/agents/<agentId>/sessions/` (session transcripts + metadata)
- `~/.fased/skills/` (managed skills)

If you need to migrate sessions or config, copy them separately and keep them
out of version control.

## Git backup (recommended, private)

Treat the workspace as private memory. Put it in a **private** git repo so it is
backed up and recoverable.

Run these steps on the machine where the Gateway runs (that is where the
workspace lives).

### 1) Initialize the repo

If git is installed, brand-new workspaces are initialized automatically. If this
workspace is not already a repo, run:

```bash
cd ~/.fased/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2) Add a private remote (beginner-friendly options)

Option A: GitHub web UI

1. Create a new **private** repository on GitHub.
2. Do not initialize with a README (avoids merge conflicts).
3. Copy the HTTPS remote URL.
4. Add the remote and push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Option B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create fased-workspace --private --source . --remote origin --push
```

Option C: GitLab web UI

1. Create a new **private** repository on GitLab.
2. Do not initialize with a README (avoids merge conflicts).
3. Copy the HTTPS remote URL.
4. Add the remote and push:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3) Ongoing updates

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Do not commit secrets

Even in a private repo, avoid storing secrets in the workspace:

- API keys, OAuth tokens, passwords, or private credentials.
- Anything under `~/.fased/`.
- Raw dumps of chats or sensitive attachments.

If you must store sensitive references, use placeholders and keep the real
secret elsewhere (password manager, environment variables, or `~/.fased/`).

Suggested `.gitignore` starter:

```gitignore
.DS_Store
.fased/
.env
**/*.key
**/*.pem
**/secrets*
```

## Moving the workspace to a new machine

1. Clone the repo to the desired path (default `~/.fased/workspace`).
2. Set `agents.defaults.workspace` or the selected `agents.list[].workspace` to
   that path in `~/.fased/fased.json`.
3. Run `fased setup --workspace <path>` to seed any missing files.
4. If you need sessions, copy `~/.fased/agents/<agentId>/sessions/` from the
   old machine separately.

## Advanced notes

- Multi-agent routing can use different workspaces per Agent. See
  [Channel routing](/channels/channel-routing) for routing configuration.
- If `agents.defaults.sandbox` is enabled, non-main sessions can use per-session sandbox
  workspaces under `agents.defaults.sandbox.workspaceRoot`.
