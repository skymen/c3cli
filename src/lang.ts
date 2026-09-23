// Map dialog text back to the editor's lang keys, using the release's own lang file, so
// reports don't depend on English wording that changes between releases.
export interface Template { key: string; re: RegExp; literal: number }

const cache = new Map<string, Template[]>();

export async function loadLang(assetUrl: string): Promise<Template[]> {
  if (cache.has(assetUrl)) return cache.get(assetUrl)!;
  let templates: Template[] = [];
  try {
    const res = await fetch(new URL("loader/lang/precompiled-en-US.json", assetUrl));
    if (res.ok) {
      const json = await res.json();
      templates = buildTemplates(json.text ?? {});
    }
  } catch { /* no lang keys then; reports still carry the text */ }
  cache.set(assetUrl, templates);
  return templates;
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

// Build templates from a lang file's `text` object; exported for tests.
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
