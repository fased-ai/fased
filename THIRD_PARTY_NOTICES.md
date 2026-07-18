# Third-Party Notices

This repository is primarily distributed under the MIT license in [LICENSE](./LICENSE).

In addition, the repository includes some bundled third-party code, data, and assets
that carry their own notices or licenses. Those notices should be preserved when the
repository is published or redistributed.

## Bundled items in this repository

1. `vendor/a2ui/`
   - Origin: vendored A2A UI code
   - License: Apache License 2.0
   - License file: [vendor/a2ui/LICENSE](./vendor/a2ui/LICENSE)

2. Android bundled Manrope fonts
   - Files:
     - `apps/android/app/src/main/res/font/manrope_400_regular.ttf`
     - `apps/android/app/src/main/res/font/manrope_500_medium.ttf`
     - `apps/android/app/src/main/res/font/manrope_600_semibold.ttf`
     - `apps/android/app/src/main/res/font/manrope_700_bold.ttf`
   - License: SIL Open Font License 1.1
   - Notice file: [apps/android/THIRD_PARTY_LICENSES/MANROPE_OFL.txt](./apps/android/THIRD_PARTY_LICENSES/MANROPE_OFL.txt)

3. Apple device identifier mappings
   - Files: `apps/macos/Sources/FasedAgent/Resources/DeviceModels/*`
   - Origin noted in:
     - [apps/macos/Sources/FasedAgent/Resources/DeviceModels/NOTICE.md](./apps/macos/Sources/FasedAgent/Resources/DeviceModels/NOTICE.md)
   - License:
     - [apps/macos/Sources/FasedAgent/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt](./apps/macos/Sources/FasedAgent/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt)

4. HTML export bundled libraries
   - Files:
     - `src/auto-reply/reply/export-html/vendor/highlight.min.js`
     - `src/auto-reply/reply/export-html/vendor/marked.min.js`
   - Embedded notices in file headers:
     - `highlight.min.js`: BSD-3-Clause
     - `marked.min.js`: MIT

5. `Swabble/`
   - Included subproject with its own license file:
     - [Swabble/LICENSE](./Swabble/LICENSE)

6. `github.com/go-webauthn/webauthn`
   - Compiled into `fased-signerd` for WebAuthn relying-party verification
   - License: BSD 3-Clause
   - License file:
     [tools/fased-signerd/THIRD_PARTY_LICENSES/go-webauthn-BSD-3-Clause.txt](./tools/fased-signerd/THIRD_PARTY_LICENSES/go-webauthn-BSD-3-Clause.txt)

## Notes

- This file covers bundled third-party material checked into the repository itself.
- Package manager dependencies under `node_modules/` are not enumerated here; those
  should be handled separately by dependency-license tooling if you distribute built
  artifacts that bundle them.
- If vendored third-party source is modified locally, preserve the original
  license text and add modification notices where the license requires that.
