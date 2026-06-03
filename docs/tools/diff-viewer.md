---
title: "Diff Viewer"
summary: "Fased diff viewer tool for code, docs, and review changes."
read_when:
  - Reviewing patches or before/after text
  - Showing changes in a canvas-style artifact
  - Comparing Fased's diff viewer with plugin-provided diff extensions
---

# Diff Viewer

Fased ships a built-in `diff_view` tool. It creates a compact HTML diff artifact
under the Canvas host root and returns:

- added/removed line counts;
- the local artifact path;
- a Canvas URL such as `/__fased__/canvas/diffs/...html`.

This is a built-in Fased review tool, not a patch-application or
approval-bypass surface.

## Inputs

The tool accepts either:

- `before` and `after` text; or
- `unifiedDiff`.

Example prompt:

```text
Use diff_view to compare this old text and new text, then give me the canvas URL.
```

## Where It Belongs

`diff_view` is a core Agent tool:

- enable/disable it in **Agent > Tools**;
- use it from chat, tasks, or channels when the Agent needs to present a change;
- use normal file tools or git commands to create the diff input.

The viewer is for review and presentation. It does not apply patches and it does
not bypass approval policy.

## Related

- [Apply Patch](/tools/apply-patch)
- [Browser and Canvas](/tools/browser)
- [Tools](/tools/index)
