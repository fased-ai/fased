# Changelog

## 0.1.76-rc.2

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.76-rc.1

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.75

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.73

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.72

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.71

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.70

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.69

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.68

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.67

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.66

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.65

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.64

### Changes

- Version alignment with core FasedAgent release numbers.

## 0.1.63

### Changes

- Version alignment with core FasedAgent release numbers.

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

## 2026.1.26

### Changes

- Breaking: voice-call TTS now uses core `messages.tts` (plugin TTS config deep‑merges with core).
- Telephony TTS supports OpenAI + ElevenLabs; Edge TTS is ignored for calls.
- Removed legacy `tts.model`/`tts.voice`/`tts.instructions` plugin fields.
- Ngrok free-tier bypass renamed to `tunnel.allowNgrokFreeTierLoopbackBypass` and gated to loopback + `tunnel.provider="ngrok"`.

## 0.1.0

### Highlights

- First public release of the @fased/voice-call plugin.

### Features

- Providers: Twilio (Programmable Voice + Media Streams), Telnyx (Call Control v2), and mock provider for local dev.
- Call flows: outbound notify vs. conversation modes, configurable auto‑hangup, and multi‑turn continuation.
- Inbound handling: policy controls (disabled/allowlist/open), allowlist matching, and inbound greeting.
- Webhooks: built‑in server with configurable bind/port/path plus `publicUrl` override.
- Exposure helpers: ngrok + Tailscale serve/funnel; dev‑only signature bypass for ngrok free tier.
- Streaming: OpenAI Realtime STT over media WebSocket with partial + final transcripts.
- Speech: OpenAI TTS (model/voice/instructions) with Twilio `<Say>` fallback.
- Tooling: `voice_call` tool actions for initiate/continue/speak/end/status.
- Gateway RPC: `voicecall.initiate|continue|speak|end|status` (+ legacy `voicecall.start`).
- CLI: `fased voicecall` commands (call/start/continue/speak/end/status/tail/expose).
- Observability: JSONL call logs and `voicecall tail` for live inspection.
- Response controls: `responseModel`, `responseSystemPrompt`, and `responseTimeoutMs` for auto‑responses.
