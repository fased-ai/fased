---
summary: "How Fased vendors Apple device model identifiers for friendly names in the macOS app and Nodes diagnostics."
read_when:
  - Updating device model identifier mappings or NOTICE/license files
  - Changing how Advanced > Nodes displays device names
title: "Device Model Database"
---

# Device model database (friendly names)

The macOS companion app and **Advanced > Nodes** diagnostics show friendly Apple device model names by mapping Apple model identifiers (e.g. `iPad16,6`, `Mac16,6`) to human-readable names.

The mapping is vendored as JSON under:

- `apps/macos/Sources/FasedAgent/Resources/DeviceModels/`

## Data source

We currently vendor the mapping from the MIT-licensed repository:

- `kyle-seongwoo-jun/apple-device-identifiers`

To keep builds deterministic, the JSON files are pinned to specific upstream commits (recorded in `apps/macos/Sources/FasedAgent/Resources/DeviceModels/NOTICE.md`).

## Updating the database

1. Pick the upstream commits you want to pin to (one for iOS, one for macOS).
2. Update the commit hashes in `apps/macos/Sources/FasedAgent/Resources/DeviceModels/NOTICE.md`.
3. Re-download the JSON files, pinned to those commits:

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/FasedAgent/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/FasedAgent/Resources/DeviceModels/mac-device-identifiers.json
```

4. Ensure `apps/macos/Sources/FasedAgent/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` still matches upstream (replace it if the upstream license changes).
5. Verify the macOS app builds cleanly (no warnings):

```bash
swift build --package-path apps/macos
```
