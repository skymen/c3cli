# Export to other platforms

**Status:** implemented (2026-10-06), `src/export.ts` (`exportProject`, `planExport`, the
`PLATFORM_SETTINGS` table), `c3cli export --platform … --set name=value --accept-warnings`.
See "Implemented" at the end for what was tested. skymen's pick: NW.js, Cordova (Android
and iOS), Windows (WebView2), macOS (WKWebView), Linux (CEF), Playable Ad (single file and
zip). Cordova: **"Cordova project" only** (local zip); no cloud builds (APK/AAB/Android
Studio/Xcode go through Scirra's build service and need nothing a local toolchain can't
do). Full platform survey: [reports/export-platforms.md](../reports/export-platforms.md).

## Seen live with the paid session (r449-5, r495-2, r505)
Flow for all: Project → Export → tile (`exporters.<id>.name`; Cordova:
`exporters.cordova.android.name` / `.ios.name`) → Next → [pre-check] → `#exportStandardOptionsDialog`
→ [exporter options] → `#<x>ExportReportDialog`.

- **Pre-checks** come up as `#okDialog` ("No application ID is set…" for macOS/Linux,
  "Invalid application ID: must look like com.company.name" for Cordova): report as a
  refusal with the text. Cordova also has Confirm warnings (upper-case app ID, version
  code): not seen yet, check their buttons before deciding to accept or refuse them.
- **Options dialogs fill in their defaults after opening** (r449-5 reads all unchecked at
  first; Linux/NW.js load the version list from downloads.scirra.com). Wait until the
  controls stop changing and the version select has options before setting anything.
- **Exporter options** (ids; `from`/`until` = release range):
  - Windows `#wv2OptionsDialog`: `wv2Platformx86` (≤r449), `wv2Platformx64`, `wv2PlatformArm64`;
    `wv2BundleAssets` checkbox (<r479) / `wv2BundleSelect` none|bundle-assets|single-file (r479+);
    `wv2SteamMode` checkbox (r473–r502) / `wv2SteamModeSelect` none|overlay|capture (r503+);
    `wv2EnableDevTools`, `wv2WindowCaption` (r451+), `wv2ResizableWindow`,
    `wv2IgnoreGpuBlacklist`, `wv2RemotePreviewMode`, `wv2CommandLine` (text).
  - macOS `#macosOptionsDialog`: `macosUseAppSandbox`, `macosBundleAssets`, `macosEnableDevTools`,
    `macosWindowCaption`, `macosResizableWindow` (r451+), `macosSigningIdentity` (text),
    `#macosPermissionsButton` → `#macosPermissionsDialog`: `macosAllowCamera` /
    `macosAllowMicrophone` (checkbox + an id-less usage text input in the same row),
    `macosAllowInternetServer`, `macosAllowPicturesFolder` / `Movies` / `Downloads` (select
    ""|read-only|read-write). Its OK button class not checked yet.
  - Linux `#linuxCefOptionsDialog`: `linuxCefVersionSelect` (latest, v147…), `linuxCefPlatformx64`,
    `linuxCefPlatformArm64`, `linuxCefPlatformArm32` (≤r449), `linuxCefStartUpFullscreen`,
    `linuxCefCompressFinalZip`, `linuxCefBundleAssets`, `linuxCefEnableDevTools`,
    `linuxCefWindowCaption` / `linuxCefResizableWindow` (r452+).
  - NW.js `#nwjsOptionsDialog` (r449-x only): `nwjsVersionSelect`, `nwjsPlatformLinux32/Linux64/
    Mac64/Mac64ARM/Win32/Win64` (all on), `nwjsPackageAssets`, `nwjsCompressFinalZip`,
    `nwjsWindowFrame`, `nwjsResizableWindow`, `nwjsKioskMode`, `nwjsIgnoreGpuBlacklist`,
    `nwjsEnableDevTools`, `nwjsSteamMode`, `nwjsCommandLine`.
  - Cordova `#cordovaOptionsDialog` (no ids; by row class): `.androidVersion select`
    (700…1500), `.androidTarget select` (force `cordova`), `.iosVersion select` (1500
    disabled, 1600…1800), `.iosTarget select` (force `cordova`), `.whitelist input`,
    `.versionCode input` (Android), `.hideStatusBar`, `.vibratePermission`,
    `.cameraPermission`, `.microphonePermission` (checkboxes).
  - Playable Ads: no exporter options; Next on Export options exports.
- **Report dialogs**: `cordovaExportReportDialog`, `wv2ExportReportDialog`,
  `macExportReportDialog`, `linuxCefExportReportDialog`, `playableAdSFExportReportDialog`,
  `playableAdZipExportReportDialog` (NW.js not run yet). Output is `a.downloadExportedProject`
  with a blob `href`, **except Cordova**: no href, the zip is made on click. Catch it by
  hooking `URL.createObjectURL` (keep the Blob) and `HTMLAnchorElement.prototype.click`
  (take the name, skip the real download), so it works over CDP too (daemon).
- Outputs seen (r495-2, untitled with an app ID): Windows 1.7 MB zip, macOS 0.6 MB
  (`New project.app` + sign/notarize `.command` scripts), Linux 128 MB `New project_x64.zip`,
  Playable single file 0.35 MB zip, Playable zip 0.32 MB. Not seen: several Linux archs
  or NW.js platforms at once (one zip each? one link each?).
- **Linux/NW.js runtimes** are downloaded per export from versioned URLs
  (`downloads.scirra.com/c3-linux-cef/v147/x64.zip`, 126 MB; `versions.json` isn't
  versioned). Plan: a disk cache (`~/.cache/c3cli/downloads`) behind a context route for
  the versioned zips, so temporary profiles don't re-download.
- **Zip contents keep Unix modes**: the Linux binary, `.so` files and the macOS wrapper are
  `rwx`. `src/unzip.ts` drops modes (and symlinks), so unzipping desktop exports into a
  folder `--to` would break them: keep the zip, or restore modes when unzipping.

## Plan
- `c3cli export <project> --platform web|android|ios|windows|macos|linux|nwjs|playable-ad|playable-ad-zip --to …`,
  plus `--set name=value` (repeatable) for each platform's options, from a table of
  settings per platform with release ranges (error on unknown names/values or a release
  without the option). Only what's given is changed. Library: `project.export(to, { platform, settings })`.
- Outcomes: `exported`, `refused-by-edition`, `refused` (pre-check), `export-failed`.
- Several outputs → `--to` must be a folder.
- Test project: `fixtures/folder/untitled` with `appId` and `description` set (scratch).

## Implemented (2026-10-06)
- One loop handles the dialogs in whatever order they come: `freeEditionLimitDialog` →
  `refused-by-edition`; `okDialog` before the options → `refused` (pre-check), after them →
  `export-failed` with the text ("Failed to export project…"); `confirmDialog` → `refused`
  unless `acceptWarnings`, then its non-Cancel button (picked by label: in the Cordova
  upper-case warning, Cancel is the bold `.confirmButton` and Continue is
  `.cancelConfirmButton`); Export options; the platform's dialog (after `settle()`); the
  report (`/ExportReportDialog$/`), every visible `a.downloadExportedProject`.
- The platform tiles fill in a moment after the export dialog opens: wait for the tile.
- Options are checked against the platform and the release before anything opens
  (`planExport`, exit 4 from the CLI), with the release ranges above.
- Unzipping keeps Unix modes and symlinks (`src/unzip.ts`); checked: `libcef.so` and the
  Linux binary stay executable.
- **No download cache.** Serving the 126 MB CEF runtime from a Playwright route crashed the
  page (`route.fulfill` with `body`, and with `path`), so Linux and NW.js download their
  runtime at every export, as the editor does in a fresh profile. A follow-up could seed the
  editor's own runtime cache in the profile's localforage.

Tested with skymen_auto (paid), the untitled fixture with an app ID and a description:
- r495-2: web; android (min-version 8.0 → minSdk 26, version-code 42, CAMERA permission in
  config.xml); ios (min-version 17 → deployment-target 17.0); windows (arch=x64 → only x64,
  bundle=single-file, devtools off in package.json); macos (app-sandbox off: no sandbox
  entitlement; camera usage text in Info.plist; downloads-folder=read → read-only
  entitlement); linux (arch=x64, window-caption off → `caption: false`, into a folder, 34
  files, executables kept, 20-27 s); playable-ad (into a folder: index.html); playable-ad-zip.
- r505: windows steam=overlay (`allow-host-input-processing: true`, what r505's exporter
  writes for overlay). r449-5: windows arch=x86,x64 + bundle=assets (old checkbox); nwjs
  arch=win64 kiosk=on (76 s).
- Through the daemon (CDP): android twice (the click-made zip) and windows into a folder.
- Refusals: no app ID → `refused` with the editor's text; upper-case app ID → `refused`,
  and with `--accept-warnings` exported with the warning (exit 1); `--guest` →
  `refused-by-edition`; unknown option or a value the release lacks → exit 4 in 1 s.
- Several architectures or platforms give **one** zip with a folder each: Linux x64,arm64
  (36-46 s, `arm64/` and `x64/`), NW.js win64,linux64 (113 s, `linux64/`, `win64/`, plus
  `WindowsIconUpdater.exe`). NW.js kiosk=on lands in `win64/package.nw` → `package.json`.
- **Warnings** (Confirm dialogs; from the r495-2 lang file and code): every exporter, at
  Export, before the platform list: an image over 4096 px (`ui.export.max-texture-size-warning`)
  and a framerate mode other than vsync (`ui.export.unlimited-framerate-mode-warning`).
  Cordova: `exporters.cordova.errors.uppercase-id`, `.version-number-issues` (1-2 component
  version, a component over 99, a code over 2147483647) and `.missing-mobile-ad-properties`.
  The framerate one broke every export (web included, also before today) since it comes
  before the platform list: the platform list is now one more dialog in the loop. Checked:
  refused, and exported with `--accept-warnings` (exit 1).
- skymen (2026-10-06): keep "only given options change" (no reset to C3's defaults), keep
  warnings stopping exports by default, no runtime download cache for now.
- r449-5 and r505, each: web, android, ios, macos (app-sandbox off), playable-ad,
  playable-ad-zip all exported (12 runs), and again lts macos / beta android / beta
  playable-ad 4 times each.
- In one batch, 3 of 12 CLI runs failed **before** exporting: the editor didn't take the
  dropped project, with no dialog in the way (seen once on r505 earlier too). Not seen in
  36 runs since (24 library opens, 12 CLI exports). `Bridge.open` now drops up to 3 times
  (safe: the editor reads the handle inside its drop handler, so an untaken drop was never
  handled), and the open report notes it when a drop was retried.
- Twice, a Linux export sat at "Adding files..." (the runtime downloads) until the timeout
  (300 s, then 600 s with two archs); the same commands then worked in 27 s and 46 s, and
  traced runs show both downloads finishing in ~10 s. Looks like a download that never
  finishes; the editor's fetch has no timeout. A timeout now reports the progress text.
