// Library entry point: `import { C3Editor } from "@skymen75/c3cli"`. See src/api.ts for usage.
export { C3Editor, OpenedProject, REPORT_VERSION, resolveRelease } from "./api.ts";
export type { AddonResult, CreateOptions, ExportReport, LaunchOptions, OpenOptions, OpenOutcome, OpenReport, SaveOptions, SaveReport } from "./api.ts";
export { LivePreview } from "./preview.ts";
export type { PreviewResult } from "./preview.ts";
export { PLATFORM_NAMES as EXPORT_PLATFORMS, exportSettingsHelp } from "./export.ts";
export type { ExportOptions, Platform as ExportPlatform, SettingValue as ExportSettingValue } from "./export.ts";
export { daemonStatus, isRunning as isDaemonRunning, DEFAULT_SOCKET } from "./daemon.ts";
export type { Branch, Release } from "./release.ts";
