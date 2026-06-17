---
summary: "Bun workflow (experimental): installs, caveats, and pnpm differences"
read_when:
  - You want the fastest local dev loop (bun + watch)
  - You hit Bun install/patch/lifecycle script issues
title: "Bun (Experimental)"
---

# Bun (experimental)

Goal: run this repo with **Bun** for local development without diverging from
pnpm workflows.

<Warning>
Bun is not recommended for the Gateway runtime. Use Node for the Gateway,
especially when testing WhatsApp, Telegram, and other channel integrations.
</Warning>

## Status

- Bun is an optional local runtime for running TypeScript directly.
- `pnpm` is the default for builds and remains fully supported. Some docs tools
  still expect pnpm.
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
