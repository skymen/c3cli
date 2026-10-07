// The editor's UI text, from the release's own lang files, in whatever language the editor
// runs in. c3cli finds menu items, buttons and dialogs by the text C3 shows, looked up by
// lang key, so nothing depends on English; and it maps dialog text back to lang keys so
// reports don't depend on the wording either.
import type { Page } from "playwright";

export interface Template { key: string; re: RegExp; literal: number }

export interface EditorText {
  // The editor's language, e.g. "fr-FR" (from <html lang>).
  lang: string;
  // The text for a lang key, markup stripped. Throws if the release has no such key.
  t(key: string): string;
  // The text with its markup ([b]…[/b]) and placeholders ({0}), or null.
  raw(key: string): string | null;
  // For matching dialog text back to lang keys.
  templates: Template[];
}

// The editor's current language: the one it picked from the browser's languages, or the
// one chosen in its settings.
export async function editorLang(page: Page): Promise<string> {
  return (await page.evaluate(() => document.documentElement.lang).catch(() => "")) || "en-US";
}

// The UI text of the editor in `page`, in its current language. `assetUrl` is the release's
// (Release.assetUrl); without it, it's found from the lang file the page loaded.
export async function editorText(page: Page, assetUrl?: string): Promise<EditorText> {
  const base = assetUrl ?? (await page.evaluate(() => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/loader/lang/precompiled-"));
    return url ? url.slice(0, url.indexOf("loader/lang/")) : null;
  }).catch(() => null));
  if (!base) throw new Error("can't tell which editor release this page runs (pass its asset URL)");
  return loadText(base, await editorLang(page));
}

const files = new Map<string, Promise<Record<string, unknown> | null>>();
const texts = new Map<string, Promise<EditorText>>();

function fetchLang(assetUrl: string, lang: string): Promise<Record<string, unknown> | null> {
  const url = new URL(`loader/lang/precompiled-${lang}.json`, assetUrl).href;
  if (!files.has(url)) {
    files.set(url, fetch(url).then(async (res) => (res.ok ? ((await res.json()).text ?? null) : null)).catch(() => null));
  }
  return files.get(url)!;
}

// Like the editor: the language's own file, with en-US for keys it doesn't translate.
export function loadText(assetUrl: string, lang = "en-US"): Promise<EditorText> {
  const k = `${assetUrl} ${lang}`;
  if (!texts.has(k)) {
    texts.set(k, (async () => {
      const [en, own] = await Promise.all([fetchLang(assetUrl, "en-US"), lang === "en-US" ? null : fetchLang(assetUrl, lang)]);
      if (!en) throw new Error(`could not load the editor's lang file (${new URL("loader/lang/precompiled-en-US.json", assetUrl).href})`);
      return makeText(own ? [own, en] : [en], lang);
    })());
    texts.get(k)!.catch(() => texts.delete(k));
  }
  return texts.get(k)!;
}

// From lang files' `text` objects, most specific first; exported for tests.
// Like the editor, a string the language doesn't translate shows as the English one in
// brackets, "[Construct 3 LTS]" (links excepted). Checked in main.js on r449-5, r495-2 and
// r505; Japanese on r449-5 has no ui.title-lts, so its window titles read
// "<project> - [Construct 3 LTS]".
export function makeText(sources: Record<string, unknown>[], lang: string): EditorText {
  const flat = new Map<string, string>();
  for (const src of [...sources].reverse()) for (const [k, v] of flatten(src, "")) flat.set(k, v);
  const own = sources.length > 1 ? new Set(flatten(sources[0], "").map(([k]) => k)) : null;
  const untranslated = (key: string, v: string) => !!own && !own.has(key) && !/^https?:/.test(v) && !key.endsWith(".help-url");
  return {
    lang,
    raw: (key) => {
      const v = flat.get(key);
      if (v === undefined) return null;
      return untranslated(key, v) ? `[${v}]` : v;
    },
    t: (key) => {
      const v = flat.get(key);
      if (v === undefined) throw new Error(`the editor has no text for "${key}" (${lang}); its UI changed, c3cli needs updating`);
      const text = squash(stripMarkup(v));
      return untranslated(key, v) ? `[${text}]` : text;
    },
    templates: buildTemplates(Object.fromEntries(flat)),
  };
}

export function matchLangKey(templates: Template[], text: string): string | null {
  const norm = squash(text);
  // A match must account for most of the text, or "{0}: {1}"-style templates match anything.
  let best: Template | null = null;
  for (const t of templates) {
    if (t.literal < norm.length * 0.5) continue;
    if ((!best || t.literal > best.literal) && t.re.test(norm)) best = t;
  }
  return best?.key ?? null;
}

// Build templates from a lang file's `text` object (nested or flat); exported for tests.
export function buildTemplates(text: Record<string, unknown>): Template[] {
  return flatten(text, "")
    .filter(([, v]) => v.length >= 12)
    .map(([key, v]) => ({ key, re: toRegex(v), literal: literalLength(v) }));
}

function flatten(o: Record<string, unknown>, prefix: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([key, v]);
    else if (v && typeof v === "object") out.push(...flatten(v as Record<string, unknown>, key));
  }
  return out;
}

function squash(s: string) { return s.replace(/\s+/g, " ").trim(); }

function stripMarkup(s: string) { return s.replace(/\[\/?[a-z0-9]+(?:=[^\]]*)?\]/gi, ""); }

function literalLength(template: string) { return squash(stripMarkup(template)).replace(/\{\d+\}/g, "").length; }

function toRegex(template: string): RegExp {
  const parts = squash(stripMarkup(template)).split(/\{\d+\}/);
  return new RegExp(parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*?"));
}

// The editor's name as its window title shows it, "<project> - <name>": "Construct 3", or on
// beta and LTS the lang file's ui.title-beta / ui.title-lts around it ("Construct 3 beta";
// in Italian "beta Construct 3").
export function productNames(text: EditorText): string[] {
  const base = "Construct 3";
  const wrapped = ["ui.title-beta", "ui.title-lts"].map((k) => text.raw(k)).filter((t): t is string => !!t).map((t) => t.replace("{0}", base));
  return [base, ...wrapped];
}

// Whether a window title is the editor's with project `name` open.
export function isProjectTitle(title: string, name: string, text: EditorText): boolean {
  return productNames(text).some((p) => title === `${name} - ${p}`) || title.startsWith(`${name} - Construct 3 `);
}

// Match a whole line against a template and return its placeholder values by index
// ({0}, {1}…), or null. "Plugin [b]{0}[/b] ({1}) by [i]{2}[/i]" matches
// "Plugin Foil (dumivid_Foil) by dumivid" → ["Foil", "dumivid_Foil", "dumivid"].
export function fillTemplate(template: string, text: string): string[] | null {
  const plain = squash(stripMarkup(template));
  const order = [...plain.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
  const re = new RegExp(`^${plain.split(/\{\d+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*?)")}$`);
  const m = re.exec(squash(text));
  if (!m) return null;
  const out: string[] = [];
  order.forEach((idx, i) => { out[idx] = m[i + 1]; });
  return out;
}
