# @fased/fased-federation (Scaffold)

This package is the externalization scaffold for the federation adapter currently embedded in core gateway runtime.

Current exports proxy to:

- `src/federation/runtime.ts`
- `src/federation/auto-connect.ts`

Target publish flow:

1. Make package public and versioned.
2. Move stable adapter API surface to this package.
3. Keep core gateway using the same API so forks and npm users share identical behavior.
