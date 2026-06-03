---
title: "TOOLS.md Template"
summary: "Workspace template for TOOLS.md"
read_when:
  - Bootstrapping a workspace manually
---

# TOOLS.md - Local Tool Notes

This file is for local details that help the agent use tools correctly. It does not define tool availability and it does not grant access.

Use Agent > Tools to allow or block tools. Use Agent > Services for service credentials. Use Agent > Skills for skill instructions and dependency setup.

## Local Notes

Add setup-specific details such as:

- Device names and locations.
- SSH hosts and aliases.
- Preferred browsers, folders, or working directories.
- Voice or media device names.
- Project conventions.
- Commands that are safe and common in this workspace.

## Example

```markdown
### Project paths

- main repo: ~/projects/example
- logs: ~/.fased/logs

### Devices

- office-camera: desk camera
- kitchen-speaker: default voice output

### Shell

- Prefer rg for text search.
- Ask before destructive commands.
```
