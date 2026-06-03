---
summary: "Generate or install shell completions for the Fased CLI."
read_when:
  - You want shell completions for zsh/bash/fish/PowerShell
  - You need to cache completion scripts under Fased state
title: "completion"
---

# `fased completion`

Generate shell completion scripts. The command can print a script, write cached
scripts under Fased state, or add a shell-profile source line for cached
completion.

## Usage

```bash
fased completion
fased completion --shell zsh
fased completion --write-state
fased completion --install
fased completion --shell fish --install
fased completion --write-state
fased completion --shell bash --write-state
```

## Options

- `-s, --shell <shell>`: shell target (`zsh`, `bash`, `powershell`, `fish`; default: `zsh`)
- `-i, --install`: install completion by adding a source line to your shell profile
- `--write-state`: write completion script(s) to `$FASED_STATE_DIR/completions` without printing to stdout
- `-y, --yes`: skip install confirmation prompts

## Notes

- `--install` expects the cached completion file to exist. Run
  `fased completion --write-state` first, or let onboarding create the cache.
- Automated profile install is supported for zsh, bash, and fish. PowerShell
  script generation is supported; profile installation is manual.
- `--install` writes a small "Fased Completion" block into your shell profile and
  points it at the cached script.
- Without `--install` or `--write-state`, the command prints the script to stdout.
- Completion generation eagerly loads command trees so nested subcommands are included.
