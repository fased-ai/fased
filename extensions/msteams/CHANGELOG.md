# Changelog

## 0.1.62

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.61

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.60

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.59

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.58

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.57

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.56

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.55

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.54

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.53

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.52

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.51

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.50

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.49

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.48

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.47

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.46

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.44

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.43

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.41

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.40

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.38

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.37

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.36

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.35

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.34

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.33

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.32

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.31

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.30

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.29

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.28

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.27

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.26

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.25

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.24

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.23

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.22

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.21

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.20

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.19

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.18

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.17

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.16

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.15

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.14

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.13

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.12

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.11

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.8

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.7

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.6

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.5

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.1

### Changes

- Version alignment with core FasedAgent release numbers.

## 2026.2.27

### Changes

- Version alignment with core FasedAgent release numbers.

## 2026.2.26

### Changes

- Version alignment with core FasedAgent release numbers.

## 2026.2.25

### Changes

- Version alignment with core FasedAgent release numbers.

## 2026.2.24

### Changes

- Version alignment with core FasedAgent release numbers.

## 2026.2.22

### Changes

- Version alignment with core FasedAgent release numbers.

## 2026.1.15

### Features

- Bot Framework gateway monitor (Express + JWT auth) with configurable webhook path/port and `/api/messages` fallback.
- Onboarding flow for Azure Bot credentials (config + env var detection) and DM policy setup.
- Channel capabilities: DMs, group chats, channels, threads, media, polls, and `teams` alias.
- DM pairing/allowlist enforcement plus group policies with per-team/channel overrides and mention gating.
- Inbound debounce + history context for room/group chats; mention tag stripping and timestamp parsing.
- Proactive messaging via stored conversation references (file store with TTL/size pruning).
- Outbound text/media send with markdown chunking, 4k limit, split/inline media handling.
- Adaptive Card polls: build cards, parse votes, and persist poll state with vote tracking.
- Attachment processing: placeholders + HTML summaries, inline image extraction (including data: URLs).
- Media downloads with host allowlist, auth scope fallback, and Graph hostedContents/attachments fallback.
- Retry/backoff on transient/throttled sends with classified errors + helpful hints.
