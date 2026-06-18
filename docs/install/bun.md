---
summary: "Bun workflow (experimental): installs, caveats, and pnpm differences"
read_when:
  - You want the fastest local dev loop (bun + watch)
  - You hit Bun install/patch/lifecycle script issues
title: "Bun (Experimental)"
---

# Bun (experimental)

Goal: use **Bun** only for experimental local development. This is not the
normal install path for Fased.

<Warning>
Normal installs use `./install.sh`, and the Gateway runtime should use Node.
Bun is not recommended for the Gateway runtime, especially when testing
WhatsApp, Telegram, and other channel integrations.
</Warning>

## Status

- Bun is an optional local runtime for running TypeScript directly during
  development.
- `pnpm` remains the source-build package manager for this repo.
- Bun cannot use `pnpm-lock.yaml` and will ignore it.

## Install

Default:

```sh
bun install
```

Note: `bun.lock`/`bun.lockb` are gitignored, so there is no repo churn either
way. If you want _no lockfile writes_:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun lifecycle scripts (blocked by default)

Bun may block dependency lifecycle scripts unless explicitly trusted with
`bun pm untrusted` / `bun pm trust`.
For this repo, the commonly blocked scripts are not required:

- `@whiskeysockets/baileys` `preinstall`: checks Node major >= 20
  (Fased itself recommends Node 24, or Node 22.14+ with `node:sqlite`).
- `protobufjs` `postinstall`: emits warnings about incompatible version schemes
  and does not create required build artifacts for Fased.

If you hit a real runtime issue that requires these scripts, trust them explicitly:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- Some scripts still expect pnpm, especially docs, UI, and protocol checks. Run
  those via pnpm for now.
