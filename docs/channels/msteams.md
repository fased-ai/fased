---
summary: "Microsoft Teams bot setup, Azure credentials, webhook exposure, and Fased routing."
read_when:
  - Setting up Microsoft Teams
  - Debugging Teams credentials, app package, or routing
title: "Microsoft Teams"
---

# Microsoft Teams

Microsoft Teams is an enterprise channel integration that uses Azure Bot
credentials, a Teams app package, and optional Microsoft Graph permissions.

Status: text DMs are supported. Group/channel file features need SharePoint site
configuration and Graph permissions.

## Setup from Agent > Channels

Teams ships as a bundled channel extension. Open **Agents**, select the Agent,
then use **Agent > Channels > Microsoft Teams**.

You need:

- Azure Bot app id
- client secret
- tenant id
- public HTTPS messaging endpoint for `/api/messages`
- Teams app package installed in the tenant/team

Minimal config:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    },
  },
}
```

Restart the gateway if the UI reports that the channel runtime still needs to
load.

## Access model

| Area            | Recommended start                                        |
| --------------- | -------------------------------------------------------- |
| DMs             | `dmPolicy: "pairing"`                                    |
| Groups/channels | `groupPolicy: "allowlist"`                               |
| Sender ids      | AAD object ids preferred                                 |
| Name matching   | keep disabled unless you intentionally need it           |
| Mentions        | required in shared channels unless policy says otherwise |

Use stable IDs when possible. Display names and UPNs can change.

## Public endpoint

Teams requires a reachable HTTPS endpoint. Common local-development options:

- Tailscale Funnel
- trusted reverse proxy
- Cloudflare Tunnel
- ngrok or equivalent temporary tunnel

Set the Azure Bot messaging endpoint to:

```text
https://your-domain.example/api/messages
```

## Graph and files

Basic text operation does not require broad Graph application permissions.
Channel/group file sending and some lookup flows may need Graph permissions and
SharePoint configuration.

Keep Graph permissions narrow and document why each permission is enabled.

## Runtime behavior

- Teams conversations route into Agent sessions.
- Replies return to the originating Teams conversation by default.
- Task commands create Agent-owned Tasks; Teams is the transport.
- Polls and richer UI use Adaptive Cards where supported.

## Troubleshooting

| Symptom                    | Check                                                |
| -------------------------- | ---------------------------------------------------- |
| Azure Bot receives nothing | Messaging endpoint URL, public HTTPS, tenant/app id. |
| Auth failures              | App id, secret, tenant id, secret expiry.            |
| Group replies blocked      | Group policy, allowlist, mention requirement.        |
| Files fail                 | Graph permissions, SharePoint site id, channel type. |
| App package upload fails   | Manifest ids, bot endpoint, valid icon/assets.       |

## Related

- [Groups](/channels/groups)
- [Channel routing](/channels/channel-routing)
- [Troubleshooting](/channels/troubleshooting)
