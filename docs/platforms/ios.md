---
summary: "iOS node app: connect to the Gateway, pairing, canvas, and troubleshooting"
read_when:
  - Pairing or reconnecting the iOS node
  - Running the iOS app from source
  - Debugging gateway discovery or canvas commands
title: "iOS App"
---

# iOS App (Node)

Availability: internal preview. The iOS app is not publicly distributed yet.

## What it does

- Connects to a Gateway over WebSocket (LAN or tailnet).
- Exposes node capabilities: Canvas, Screen snapshot, Camera capture, Location,
  Talk mode, and Voice wake.
- Receives `node.invoke` commands and reports node status events.

## Requirements

- Gateway running on a supported Linux x86_64/systemd host, including Ubuntu
  WSL2.
- Network path:
  - Same LAN via Bonjour, **or**
  - Tailnet via unicast DNS-SD (example domain: `fased.internal.`), **or**
  - Manual host/port (fallback).

## Quick start (pair + connect)

1. Start the Gateway:

```bash
fased gateway --port 18789
```

2. In the iOS app, open Settings and pick a discovered gateway (or enable Manual Host and enter host/port).

3. Approve the pairing request on the gateway host:

```bash
fased devices list
fased devices approve <requestId>
```

4. Verify connection:

```bash
fased nodes status
fased gateway call node.list --params "{}"
```

You can also verify the paired device in the browser Control UI under
**Advanced → Nodes**.

## Discovery paths

### Bonjour (LAN)

The Gateway advertises `_fased-gw._tcp` on `local.`. The iOS app lists these
automatically.

### Tailnet (cross-network)

If mDNS is blocked, use a unicast DNS-SD zone, for example `fased.internal.`,
and Tailscale split DNS.
See [Bonjour](/gateway/bonjour) for the CoreDNS example.

### Manual host/port

In Settings, enable **Manual Host** and enter the gateway host + port. Default:
`18789`.

## Canvas + A2UI

The iOS node renders a WKWebView canvas. Use `node.invoke` to drive it:

```bash
fased nodes invoke \
  --node "iOS Node" \
  --command canvas.navigate \
  --params '{"url":"http://<gateway-host>:18789/__fased__/canvas/"}'
```

Notes:

- The Gateway canvas host serves `/__fased__/canvas/` and `/__fased__/a2ui/`.
- It is served from the Gateway HTTP server. Same port as `gateway.port`;
  default `18789`.
- The iOS node auto-navigates to A2UI on connect when a canvas host URL is
  advertised.
- Return to the built-in scaffold with `canvas.navigate` and `{"url":""}`.

### Canvas eval / snapshot

```bash
fased nodes invoke \
  --node "iOS Node" \
  --command canvas.eval \
  --params '{"javaScript":"document.body.innerHTML = \"<h1>Fased Canvas</h1>\"; \"ok\";"}'
```

```bash
fased nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + talk mode

- Voice wake and talk mode are available in Settings.
- iOS may suspend background audio; treat voice features as best-effort when the app is not active.

## Common errors

- `NODE_BACKGROUND_UNAVAILABLE`: bring the iOS app to the foreground. Canvas,
  camera, and screen commands require it.
- `A2UI_HOST_NOT_CONFIGURED`: the Gateway did not advertise a canvas host URL.
  Check `canvasHost` in [Gateway configuration](/gateway/configuration).
- Pairing prompt never appears: run `fased devices list` and approve the request manually.
- Reconnect fails after reinstall: the Keychain pairing token was cleared; re-pair the node.

## Related docs

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
