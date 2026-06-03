# Plugin License Policy

This repository contains the MIT-licensed Fased core plus plugin and extension
surfaces that may evolve under different licensing and notice requirements.

## Core rule

The Fased core repository remains governed by its own top-level license and required
third-party notices.

That does not automatically force every standalone plugin to use the same license.

## Standalone plugins

A plugin may use its own license when all of the following are true:

- the plugin is original work by its author
- it is meaningfully separable from Fased core
- it does not copy core files in a way that would require preserving notices in
  those copied files
- it includes its own required third-party notices

## Fork-derived or copied code

If a plugin copies code from:

- Fased core
- copied Fased core files with their own notice obligations
- any other vendored or third-party source

then the plugin author must preserve the notices and license obligations that apply
to the copied material.

You cannot relabel copied code as purely original work.

## Finance, crypto, trading, and news plugins

Plugins that touch:

- wallets
- custody
- mining
- federation
- operator network features
- trading
- market/news signals

should include their own clear risk disclosure where appropriate.

At minimum, those plugins should not imply:

- financial advice
- certain execution
- financial outcome or return
- regulatory clearance

## Branding

Using the Fased plugin surface does not grant rights to Fased trademarks, branding, or
endorsement claims beyond normal compatibility description.

Good:

- "Plugin for Fased"
- "Works with Fased"

Bad:

- "Official Fased plugin" unless explicitly approved
- branding that implies core-team sponsorship without permission

## Recommendation

For public ecosystem simplicity:

- keep core notices and legal files in sync
- keep plugin licenses explicit
- keep plugin risk boundaries explicit
- preserve third-party attribution whenever code or assets are copied
