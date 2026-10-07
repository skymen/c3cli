# Export platforms in the Construct 3 editor, r449-5 (LTS) to r505 (beta)

Research for picking which platforms c3cli should export to besides Web (HTML5). Done on
2026-10-06 with a guest (free edition) session, logged out.

Sources:
- `exporters/defaultExporterList.json` for every release from r449 to r505, patches -1 to -6
  (76 releases exist; no `-1` patches).
- The `exporters/<id>/exporter.html` and `exporter.js` files of every release (size and hash),
  `main.html` (the markup of the export dialogs), `main.js` and `projectResources.js` (the
  export pipeline and the Cordova options), and the `precompiled-en-US.json` lang files. All
  fetched over HTTP.
- In the editor (headless, guest), on r449-5, r495-2 and r505: fixture `untitled` (saved with
  r432-2, no addons, opened from a scratch copy). On each release I opened Project → Export,
  recorded the tiles, then for each tile clicked it and pressed Next once. Nothing was
  exported.

Scratch scripts, JSON dumps and screenshots are in the session scratchpad
(`…/scratchpad/exports/`: `walk-<release>.json`, `<release>/*.png`, `probe*.json`), not in the
repo.

## Summary

| Tile (group) | Exporter id | Releases | Guest / free edition | Dialogs after "Choose platform" | Output | Network / account |
|---|---|---|---|---|---|---|
| Web (HTML5) (Web) | `html5` | all | **allowed** (minify ≠ None is refused) | Export options | zip, or a chosen folder (r488+) | none |
| Construct Arcade (Web) | `scirra-arcade` | all | **allowed** (minify ≠ None is refused) | Export options | zip with `arcade.json`; you upload it to construct.net yourself | none (the upload is manual) |
| Android (Cordova) (Mobile) | `cordova`, tag `android` | all | refused at Next | Export options → Cordova options | "Cordova project": local zip. Every other build: **Scirra cloud build** | `wss://build.construct.net/` for everything except "Cordova project" |
| iOS (Cordova) (Mobile) | `cordova`, tag `ios` | all | refused at Next | Export options → Cordova options | "Cordova project": local zip. "Xcode project": **cloud build** | as above |
| Windows (WebView2) (Desktop) | `windows-webview2` | all | refused at Next | Export options → Windows wrapper options | zip with an x64/ARM64 app folder (wrapper exe from the release's `files/builds.zip`) | none (wrapper files come from editor.construct.net) |
| macOS (WKWebView) (Desktop) | `macos-wkwebview` | all | refused at Next | Export options (no folder option) → macOS wrapper options (→ Permissions sub-dialog) | zip with `<name>.app` (from the release's `files/app.zip`) | none |
| Linux (CEF) (Desktop) | `linux-cef` | all | refused at Next | Export options (no folder option) → Linux options | zip, one per platform or combined | downloads CEF from `downloads.scirra.com` (~115-125 MB per arch), cached in the browser profile |
| Xbox UWP (WebView2) (Console) | `xbox-uwp-webview2` | all | refused at Next | Export options only | zip with a Visual Studio UWP solution (from `files/solution.zip`) | none |
| Facebook Instant Games (Other) | `instant-games` | all | refused at Next | Export options only | zip with `fbapp-config.json`; you publish it on Facebook yourself | none |
| Playable Ad (single file) (Other) | `playable-ad-single-file` | all | refused at Next | Export options only (Minify None becomes Bundle) | one self-contained `index.html` with every file inlined as base64 | none |
| Playable Ad (zip) (Other) | `playable-ad-zip` | all | refused at Next | Export options (no folder option) only | zip | none |
| NW.js (**Deprecated**) | `nwjs` | **r449 to r449-5 only** | refused at Next | Export options → NW.js options | zip(s) for Windows, macOS and Linux | downloads NW.js from `downloads.scirra.com` (~140-170 MB per platform) |

Not shown for game projects (productType `animation`, Construct Animate): `video`, `gif`,
`image-sequence`. Their code is built into the editor and they have no `exporters/` folder.
They are in the list for every release. `preview` (productType `all`) is internal and has no
tile.

The tiles, their order and their groups are the same on r449-5, r495-2 and r505. The only
difference is r449-5's extra **Deprecated → NW.js** group at the end.

## How the export pipeline works (all three releases)

From `projectResources.js` (r505; r449-5 and r495-2 do the same):

1. **Choose platform to export to** (`#exportSelectPlatformDialog`): tiles are
   `ui-iconviewitem`s grouped under `.iconview-groupname` headings (Web, Mobile, Desktop,
   Console, Other, plus Deprecated on r449). Tiles have no id or data attribute; only the
   label identifies them. The dialog preselects the last tile used.
2. **Free edition gate**, right after Next: on the free edition, any exporter other than
   `html5`, `scirra-arcade`, `video` and `gif` opens `#freeEditionLimitDialog` "This exporter
   is not available in the Free Edition" (Purchase / Learn more... / Cancel, plus a "log in"
   tip). A project over the free limits gets "This project exceeds the Free Edition limits"
   instead. In the editor, every tile except Web (HTML5) and Construct Arcade hit this on
   all three releases. `image-sequence` is not on this list, while `video` and `gif` are.
   But the lang file also has a free-edition "image sequence longer than 5 seconds" limit,
   so whether image sequences are free is unclear (not checked).
3. **Exporter pre-checks** (OK dialogs that stop the export):
   - Cordova: needs a valid project version (`1.2.3.4`), an app ID like `com.company.name`
     (no `class`), a project name other than `CordovaActivity`, a non-empty description,
     and Fullscreen mode not "Off". It also warns (Confirm dialogs) about version-code
     problems, upper-case app IDs, and missing Mobile Advert properties.
   - Construct Arcade: Fullscreen mode must not be "Off".
   - Instant Games: the project must contain the Instant Games plugin.
   - Linux (CEF) and macOS: an app ID must be set. NW.js: a valid project ID must be set.
4. **Export options** (`#exportStandardOptionsDialog`): the same dialog for every exporter,
   with some rows hidden per exporter (see the next section).
5. **Exporter options** (`exporter.WJi()`): `#cordovaOptionsDialog`, `#wv2OptionsDialog`,
   `#macosOptionsDialog`, `#linuxCefOptionsDialog`, `#nwjsOptionsDialog`. Other exporters
   have none. Its Next starts the export.
6. The export runs (`#progressDialog`), then the exporter's report dialog opens (e.g.
   `#wv2ExportReportDialog`, `#cordovaExportReportDialog`, `#cordovaBuildReportDialog`
   after a cloud build) with an `a.downloadExportedProject` blob link, like
   `#webExportReportDialog`.

**Remembered options (r488+).** Export options and exporter options are saved in the
browser profile's localforage, per exporter id and per `projectUniqueId-exporterId`, and
prefilled next time. On r449-5 the standard options are not remembered, and the
macOS/Linux/NW.js options are saved per profile (`macos-export-options` etc.). With a
temporary profile every run starts from the defaults. With `--profile`, c3cli would get the
last choices, so it should set every option explicitly.

## Export options dialog (`#exportStandardOptionsDialog`)

Seen in the editor for Web (HTML5) and Construct Arcade on all three releases. For the other
exporters, which rows show comes from the r505 code.

| Control | id | Type / choices | Default | Notes |
|---|---|---|---|---|
| Export to | `exportTo` | select: `zip` "Zip file", `folder` "Folder" | zip | **r488+ only** (absent on r449-5). Shown only when the exporter allows it and the browser supports it (an `LK.RK` flag, presumably the File System Access API; it shows in headless Chromium). Hidden for Linux, macOS and Playable Ad (zip). |
| Folder / Choose folder | `chooseFolder` (button), `.chosenFolderName` | `window.showDirectoryPicker()` | (none) | Only for Folder. **Native directory picker.** |
| Delete existing files | `deleteExistingFiles` | checkbox | checked | Only for Folder. |
| Deduplicate images | `exportDeduplicateImages` | checkbox | off | |
| Lossless format | `exportLosslessImageFormat` | `png`, `webp` | webp | |
| Lossy format | `exportLossyImageFormat` | `jpeg`, `webp`, `avif` | **webp on r449-5, avif on r495-2 / r505** (observed, same project) | |
| Optimize images | `exportOptimizeImages` | checkbox | off | |
| Minify mode | `exportMinifyMode` | `none`, `bundle`, `simple`, `advanced`, `debug-advanced` | none | Anything other than None opens the free-edition limit dialog on Next (already handled by `exportWeb`). Playable Ad (single file) turns None into Bundle. |
| Offline support | `exportOfflineSupport` | checkbox | checked | Shown only for Web (HTML5) and Construct Arcade. |

Release changes: the markup is unchanged from r449 to r487-3, and **r488** adds the Export to /
Folder rows. From r488 the report dialogs hide their "Open export manager" link
(`.exportManagerWrap`) for folder exports.

## Platforms

### Web (HTML5): `html5`
- Releases: all. Free edition: yes. This is what c3cli does today (`src/export.ts`).
- Output: zip, or on r488+ files written into a chosen folder (native picker).

### Construct Arcade: `scirra-arcade`
- Releases: all. Free edition: **yes**. In the editor it goes Choose platform → Export options
  as a guest on r449-5, r495-2 and r505. The final export button was not clicked.
- Options: the same Export options dialog as Web (Export to, image options, minify, offline
  support). No exporter options.
- Pre-check: Fullscreen mode must not be "Off".
- Output: the web export plus `arcade.json` (name, version, description, id, unique-id…).
  The report (`#scirraArcadeExportReportDialog`) says: "To submit your game to the Construct
  Arcade, download the exported zip, and submit it by uploading the zip file at:"
  construct.net. The editor uploads nothing.
- Automation: the same flow as `exportWeb`, with another tile label
  (`exporters.scirra-arcade.name`) and report dialog id. Easy.

### Android (Cordova) and iOS (Cordova): `cordova` (tags `android`, `ios`)
- Releases: all. Free edition: **no** (refused at Next on all three releases). productTypes
  `games`.
- Flow: Export options → **Cordova options** (`#cordovaOptionsDialog`, markup in `main.html`).
  The markup is the same on r449-5, r495-2 and r505. Only r470-r472 lacked the "Hide status
  bar" row.
  - **General** (`.generalSection`):
    - Android only: Min. version (`.androidVersion select`): 700 "7.0+ (Nougat)", 710, 800
      "8.0+ (Oreo)", 810, 900 "9.0+ (Pie)", 1000…1500 "15.0+". Default 7.0, floor 7.0.
    - Android only: Target version, an info text "Android 16 (API level 36)" on all three
      releases.
    - Android only: **Android build** (`.androidTarget select`): `cordova` "Cordova
      project", `project` "Android Studio project", `debug` "Debug APK", `release`
      "Unsigned release APK", `bundle` "Unsigned Android App Bundle", `signed-debug`,
      `signed-release`, `signed-bundle`. Default `cordova`. r449-5 always resets it to
      `cordova`; r495-2+ remember the last one.
    - iOS only: Min. version (`.iosVersion select`): 1500 "15.0+", 1600, 1700, 1800.
      Default 15.0, and 15.0 is disabled in some cases.
    - iOS only: **iOS build** (`.iosTarget select`): `cordova` "Cordova project", `project`
      "Xcode project".
  - **Properties** (`.propertiesSection`): URL whitelist (text, default `http://*/* https://*/*`).
    Android version code (number 0-2147483647, from the project version; Android only).
    Hide status bar, Require Vibrate / Camera / Microphone permission (checkboxes, off). "App
    license key" and "Use expansion archive" exist in the markup but are always hidden.
  - **Signing** (`.signingSection`, shown only for `signed-*` builds): Keystore
    (`<input type="file">`, plus **Create**, which opens `#createKeystoreDialog`, and
    Clear), Key alias, Show password, Keystore password, Key password (optional).
- Output, from `aEr()` in main.js on all three releases:
  - Build **Cordova project**: a local zip `<name>.<android|ios>.cordova.zip`, also stored
    in the Export Manager, and `#cordovaExportReportDialog` with a download link and a
    "Build apps" button.
  - **Every other build, including "Android Studio project" and "Xcode project"**: the
    editor uploads the Cordova project over a WebSocket to **`wss://build.construct.net/`**
    (Scirra's build service), shows its statuses ("Waiting to build", "Building Android", …),
    downloads the result and opens `#cordovaBuildReportDialog` "Build report for '…'". The
    upload carries the account/licence details. Signed builds also upload the keystore.
    **Create keystore** generates the keystore on the build service too.
- Automation: "Cordova project" is a plain local export (paid). Everything else depends on a
  cloud service: uploads, waiting on a queue, needing the account. The keystore is an
  `input[type=file]` (Playwright `setInputFiles` works), not a File System Access picker.
  Several confirm and OK dialogs can come up before Export options (pre-checks).

### Windows (WebView2): `windows-webview2`
- Releases: all. Free edition: **no**. productTypes `all`.
- Flow: Export options (Export to available) → **Windows wrapper options** (`#wv2OptionsDialog`).

| Control | id | r449-5 | r495-2 | r505 | Default (r505) |
|---|---|---|---|---|---|
| Platforms | `wv2Platformx86` | yes | (gone, r450) | (gone) | |
| | `wv2Platformx64`, `wv2PlatformArm64` | yes | yes | yes | both checked |
| Bundle assets | `wv2BundleAssets` checkbox | yes | (replaced, r479) | | |
| Bundle | `wv2BundleSelect`: `none`, `bundle-assets`, `single-file` | | yes | yes | none |
| Steam mode | `wv2SteamMode` checkbox "Export for Steam" | | yes (r473-r502) | | |
| | `wv2SteamModeSelect`: `none`, `overlay`, `capture` | | | yes (r503+) | none |
| Enable DevTools | `wv2EnableDevTools` | yes | yes | yes | checked |
| Window caption | `wv2WindowCaption` | (added r451) | yes | yes | checked |
| Resizable window | `wv2ResizableWindow` | yes | yes | yes | checked |
| Ignore GPU blacklist | `wv2IgnoreGpuBlacklist` | yes | yes | yes | checked |
| Export for Remote Preview | `wv2RemotePreviewMode` | yes | yes | yes | off |
| Command line | `wv2CommandLine` text | yes | yes | yes | "" |

- Output: a zip with one folder per architecture, holding `WebView2Wrapper.exe`,
  `WV2ExtManager.dll`, `package.json`, `www/`… The wrapper binaries come from the release's
  own `exporters/windows-webview2/files/builds.zip`. Steam mode adds the
  `scirra-gameinput-*.ext.dll` files. Report notes: run `WindowsIconUpdater.exe` on Windows
  to apply icons, and `PackToSingleExecutable.exe` on Windows for "Single file".
- Automation: paid. Local, no cloud. An easy dialog.

### macOS (WKWebView): `macos-wkwebview`
- Releases: all. Free edition: **no**. productTypes `all`.
- Flow: Export options (no Export to) → **macOS wrapper options** (`#macosOptionsDialog`):
  - Use App Sandbox (`macosUseAppSandbox`, on), Bundle assets (`macosBundleAssets`, on),
    Enable DevTools (`macosEnableDevTools`, on).
  - Window caption and Resizable window (`macosWindowCaption`, `macosResizableWindow`, on,
    **r451+**).
  - Permissions: an Edit button `#macosPermissionsButton` opens `#macosPermissionsDialog`.
    It has, for Camera, Microphone, Internet server, Pictures / Movies / Downloads folder,
    an allow checkbox (camera/mic, with a usage description text that becomes required) or
    a Not allowed / Read-only / Read & write choice (folders).
  - Signing identity (optional), text, placeholder `Developer ID Application: Name (ABC123)`.
- Pre-check: an app ID is required.
- Output: a zip with `<name>.app`, built in the browser from the release's `files/app.zip`
  (~130 KB). The report says to extract it on a Mac, and Gatekeeper may block it.
- Automation: paid. Local. A sub-dialog for permissions.

### Linux (CEF): `linux-cef`
- Releases: all. Free edition: **no**. productTypes `games`.
- Flow: Export options (no Export to) → **Linux options** (`#linuxCefOptionsDialog`):
  - Linux CEF version (`linuxCefVersionSelect`: "Latest (Chromium N)" or a specific one,
    loaded from `https://downloads.scirra.com/c3-linux-cef/versions.json`; today v147…v129f),
    plus a "Manage versions..." link (version / platform manager dialogs).
  - Platforms: x64 (on) and ARM64 (off). **r449-x also had ARM (32-bit)**, removed in r450.
  - Start up fullscreen (off), Compress final zip (on), Bundle assets (off), Enable DevTools
    (on). Window caption and Resizable window (on, **r452+**).
- Pre-check: an app ID is required.
- Output: a zip (`<name>_<arch>.zip` for one platform). The CEF runtime for each chosen
  platform is downloaded at export time (~115-125 MB each) and cached in the browser
  profile's localforage. The report says to extract it on the target system.
- Automation: paid. A large download on every run with a temporary profile. Needs network to
  downloads.scirra.com. The version list loads asynchronously.

### Xbox UWP (WebView2): `xbox-uwp-webview2`
- Releases: all. Free edition: **no**. productTypes `games`.
- Flow: Export options (Export to available). No exporter options.
- Output: a zip with a Visual Studio UWP solution, filled from the release's
  `files/solution.zip` (~100 KB) with GUIDs and the project name. You build it in Visual
  Studio.
- Automation: paid. The simplest of the paid exporters.

### Facebook Instant Games: `instant-games`
- Releases: all. Free edition: **no**. productTypes `games`.
- Flow: Export options (Export to available). No exporter options.
- Pre-check: the project must use the Instant Games plugin.
- Output: a web export plus `fbapp-config.json`. You upload it to Facebook yourself (the
  report links developers.facebook.com).

### Playable Ad (single file): `playable-ad-single-file`
- Releases: all. Free edition: **no**. productTypes `all`.
- Flow: Export options (Export to available, no offline support). No exporter options.
  Minify None is turned into Bundle.
- Output: one `index.html` with all scripts, CSS and files inlined (`self.c3_base64files`).
  The report warns that this mode is inefficient and may be removed. I did not check whether
  the download is the bare HTML or a zip around it.

### Playable Ad (zip): `playable-ad-zip`
- Releases: all. Free edition: **no**. productTypes `all`.
- Flow: Export options (no Export to, no offline support). No exporter options.
- Output: a zip.

### NW.js: `nwjs` (deprecated, LTS only)
- Releases: **r449, r449-2 … r449-5**. Removed from `defaultExporterList.json` and from
  `exporters/` in r450. On r449-5 it is under a "Deprecated" heading. Free edition: **no**.
- Flow: Export options → **NW.js options** (`#nwjsOptionsDialog`):
  - NW.js version (`nwjsVersionSelect`, from `https://downloads.scirra.com/c3-nwjs/versions.json`,
    "Latest (v0.100.1, Chromium 137)"…) with Manage versions.
  - Platforms: Linux 32 / Linux 64 / macOS 64 / macOS ARM64 / Windows 32 / Windows 64, all
    checked by default.
  - Package assets (on), Compress final zip (on), Window frame (on), Resizable window (on),
    Kiosk mode (off), Ignore GPU blacklist (on), Enable DevTools (on), Export for Steam
    (off), Command line (text).
- Pre-check: a valid project ID.
- Output: zip(s) per platform. Each NW.js platform is downloaded (~140-170 MB) and cached in
  the profile.
- Automation: only matters for LTS projects. It is the heaviest download of all.

### Animation-only exporters: `video`, `gif`, `image-sequence`
- In `defaultExporterList.json` for all releases with productTypes `animation`, so they only
  appear for Construct Animate projects. The free list in the code includes `video` and
  `gif` but not `image-sequence`. The lang file has free-edition 5-second limits for
  video/GIF and for image sequences.
- **Not seen in the editor**: every fixture is a game project.

## Release timeline (r449 → r505)

| Release | Change |
|---|---|
| r449 to r449-5 (LTS) | 15 exporter ids including `nwjs`. Windows has x86/x64/ARM64 and a "Bundle assets" checkbox. Linux has x64/ARM32/ARM64. |
| r450 | `nwjs` removed (list and folder). Windows drops x86. Linux drops ARM (32-bit). |
| r451 | Windows adds "Window caption". macOS adds "Window caption" and "Resizable window". |
| r452 | Linux adds "Window caption" and "Resizable window". |
| r470 to r472 | The Cordova options lack "Hide status bar" (back in r473). |
| r473 | Windows adds an "Export for Steam" checkbox. |
| r479 | Windows "Bundle assets" checkbox becomes the **Bundle** select (None / Assets / Single file). |
| r488 | Export options gain **Export to: Zip / Folder**. Export choices are remembered per project and exporter. Report dialogs hide the export-manager link for folder exports. |
| r503 | Windows Steam checkbox becomes the **Steam mode** select (None / Overlay / Capture). |
| r450 to r505 | `defaultExporterList.json` is identical (14 ids). |

`exporter.js` is minified again in every release, so its hash changes every time. The rows
above come from `exporter.html` / `main.html` hash changes, plus diffs of string literals
wherever an `exporter.js` grew or shrank by more than 100 bytes. A logic change that adds no
new strings would not show up.

## What would make each one hard to automate

- **Free edition**: only Web and Construct Arcade can be exported logged out. Everything else
  needs a logged-in paid profile (c3cli's `login` / `--profile`).
- **Cloud service**: Cordova builds other than "Cordova project" (APK, AAB, Android Studio
  project, Xcode project, signed builds, Create keystore) go through
  `wss://build.construct.net/`. They upload the project (and keystore), wait in a queue, and
  depend on the account.
- **Native pickers**: "Export to: Folder" (r488+, every exporter except Linux, macOS and
  Playable zip) uses `showDirectoryPicker`. Zip avoids it. The Cordova keystore is a plain
  file input.
- **Large downloads**: Linux CEF and NW.js download runtimes of over 100 MB per platform into
  the browser profile, again on every run with a temporary profile.
- **Post-processing outside C3**: Windows icons and single-file packing (tools that run on
  Windows), the macOS .app (must be extracted and run on a Mac, optional signing), and
  Xbox (a Visual Studio build).
- **Pre-check dialogs**: Cordova, Arcade, Instant Games, Linux, macOS and NW.js stop on
  project properties (app ID, version, description, fullscreen mode, plugin). The OK and
  Confirm dialogs come before Export options.
- **Tiles have no ids**: c3cli has to pick them by label (`exporters.<id>.name`, and
  `exporters.cordova.android.name` / `.ios.name` for the Cordova pair).

## Not checked

- The options dialogs of the paid exporters were **not seen live**: a guest is refused at
  "Choose platform → Next". Their controls and defaults above come from the static markup
  (`exporter.html`, `main.html`) and the minified code. The dialog order (Export options,
  then exporter options) comes from `projectResources.js` on r449-5, r495-2 and r505.
  Confirming them needs a logged-in paid profile, which I did not use.
- Nothing was exported, Web and Arcade included. Output contents come from code and lang
  strings, not from real exports.
- The animation exporters were not seen in the editor.
- Which Export options rows show per exporter comes from the r505 code. Live, I only saw
  the Web and Arcade versions of the dialog on all three releases.
