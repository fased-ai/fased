# Google Gemini CLI Auth (FasedAgent plugin)

OAuth provider plugin for **Gemini CLI** (Google Code Assist).

## Account safety caution

- This plugin is an unofficial integration and is not endorsed by Google.
- Some users have reported account restrictions or suspensions after using third-party Gemini CLI OAuth clients.
- Use caution, review the applicable Google terms, and avoid using a mission-critical account.

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
fased plugins enable google-gemini-cli-auth
```

Restart the Gateway after enabling.

## Authenticate

```bash
fased models auth login --provider google-gemini-cli --set-default
```

## Requirements

Requires the Gemini CLI to be installed (credentials are extracted automatically):

```bash
brew install gemini-cli
# or: npm install -g @google/gemini-cli
```

## Env vars (optional)

Override auto-detected credentials with:

- `FASED_GEMINI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_ID`
- `FASED_GEMINI_OAUTH_CLIENT_SECRET` / `GEMINI_CLI_OAUTH_CLIENT_SECRET`
