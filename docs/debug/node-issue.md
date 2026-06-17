---
summary: Node + tsx "__name is not a function" crash notes and developer workarounds.
read_when:
  - Debugging Node-only dev scripts or watch mode failures
  - Investigating tsx/esbuild loader crashes in Fased
title: "Node + tsx Crash"
---

# Node + tsx "\_\_name is not a function" crash

## Summary

Running Fased via Node with `tsx` fails at startup with:

```
[fased] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

This was observed on direct `node --import tsx ...` developer paths. The same
runtime path works when Fased is built first and launched through the compiled
entrypoint.

This is a developer-runner issue for direct `node --import tsx ...` paths. It is
not the normal installed Fased runtime path; the supported runner builds with
`tsdown` when needed and launches `fased.mjs`. For normal install requirements,
see
[Node.js](/install/node).

## Environment

- Node: v25.x (observed on v25.3.0)
- tsx: 4.21.0
- OS: macOS (repro also likely on other platforms that run Node 25)

## Repro (Node-only)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro in repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node version check

- Node 25.3.0: fails
- Node 22.22.0 (Homebrew `node@22`): fails
- Node 24: needs verification on the local machine where the crash appears

## Notes / hypothesis

- `tsx` uses esbuild to transform TS/ESM. esbuild's `keepNames` emits a
  `__name` helper and wraps function definitions with `__name(...)`.
- The crash indicates `__name` exists but is not a function at runtime. That
  usually means the helper is missing or overwritten for this module in the
  Node 25 loader path.
- Similar `__name` helper issues have been reported in other esbuild consumers
  when the helper is missing or rewritten.

## Workarounds

- Use the normal runner scripts instead of direct `node --import tsx`:

  ```bash
  pnpm fased status
  pnpm gateway:watch
  ```

- Or build first, then run compiled output:

  ```bash
  pnpm build:fast
  node --watch fased.mjs status
  ```

- Confirmed locally: compiled output plus `node fased.mjs status` works on
  Node 25.
- Disable esbuild keepNames in the TS loader if possible. That prevents
  `__name` helper insertion; `tsx` does not currently expose this.
- Test Node LTS with `tsx` to confirm whether the issue is local to a specific
  Node/loader combination.

## References

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Next steps

- Repro on the supported Node LTS line and the newest local Node version.
- Test `tsx` nightly or pin to earlier version if a known regression exists.
- If reproduces on Node LTS, file a minimal repro upstream with the `__name`
  stack trace.
