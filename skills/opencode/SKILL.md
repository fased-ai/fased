---
name: opencode
description: "Use the OpenCode CLI (`opencode`) for coding tasks in a target repo. Use when you need implementation, refactors, test fixes, or codebase analysis in a specific working directory. NOT for: trivial one-line edits, simple file reads, or non-coding chat."
metadata:
  {
    "fased":
      {
        "emoji": "🤖",
        "requires": { "bins": ["opencode"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "opencode-ai",
              "bins": ["opencode"],
              "label": "Install OpenCode CLI",
            },
          ],
      },
  }
---

# OpenCode Skill

Use OpenCode CLI to delegate substantial coding work in a scoped directory.

## When to use

- Implementing features across multiple files.
- Refactoring with tests and follow-up fixes.
- Running repo-aware coding tasks from natural language prompts.
- Generating patches that require project context.

## When not to use

- Tiny manual edits (do them directly).
- Pure read/search tasks (use read/grep/glob tools directly).
- Non-coding requests.

## Recommended workflow

1. Pick the target repository directory.
2. Run OpenCode with that directory as `workdir`.
3. Give a clear task prompt including constraints.
4. Review changes, run tests, and iterate.

## Commands

```bash
# One-shot task in current directory
opencode run "Add input validation to the config loader and update tests"

# One-shot task in a specific repository
opencode run "Refactor retry logic in src/network and keep behavior unchanged"

# Ask for analysis only (no edits)
opencode run "Analyze this codebase and list top 5 reliability risks without changing files"
```

## Prompting tips

- Include success criteria: tests to run, files to avoid, expected behavior.
- Specify change scope: "minimal diff", "no dependency changes", or "docs included".
- For risky changes, request a plan first, then implementation.

## Safety

- Keep work scoped to the intended repository.
- Prefer explicit test commands in prompts.
- Review diffs before committing or pushing.
