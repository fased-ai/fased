# Qwen OAuth legacy compatibility plugin

Compatibility plugin for existing **Qwen portal OAuth** credentials.

New setup should not use this plugin. Qwen Code's OAuth free tier was
discontinued on 2026-04-15, so normal Fased setup now uses:

- Qwen Coding Plan API key
- Qwen DashScope API key

## Existing Configs

This plugin is kept only so older local configs can continue to read cached
credentials while they still work. Do not enable it for new users.
