---
name: skill-workshop
description: Draft a reviewed Fased skill proposal from a repeated workflow without writing files automatically.
summary: Turn repeated operator workflows into pending-review skill drafts for Agent > Skills.
metadata:
  fased:
    skillKey: skill-workshop
---

# Skill Workshop

Use this skill when the operator wants to turn a repeated workflow into a Fased
skill.

## Safety Boundary

This workshop is **pending-review only**.

- Do not create, edit, install, or overwrite skill files automatically.
- Do not run dependency installers.
- Do not grant Agent tools, wallet access, mining access, task autonomy, or
  channel permissions.
- Produce a draft the operator can review in **Agent > Skills > + Skill** or the
  Skill editor.

## Workflow

1. Ask for the repeated workflow, trigger phrase, expected inputs, expected
   output, and any required external tools.
2. Identify whether the workflow is safe instruction-only or needs dependencies,
   service credentials, tools, wallet grants, or mining access.
3. Draft a `SKILL.md` proposal with:
   - `name`
   - `description`
   - `summary`
   - When To Use
   - Inputs
   - Workflow
   - Output
   - Safety / Access Needed
4. Explicitly list review items before install:
   - dependencies
   - requested tool access
   - service credentials
   - wallet/mining grants
   - task/channel automation

## Output

Return:

- the proposed skill name;
- a short risk summary;
- the complete draft `SKILL.md` in a fenced `markdown` block;
- a final line telling the operator to review it in Agent > Skills before saving.
