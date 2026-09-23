// Editor releases: names ("r495-2"), numbers (49502, as in project.c3proj's savedWithRelease)
// and the hosted URL that serves each.
export const EDITOR_ORIGIN = "https://editor.construct.net";

export type Branch = "stable" | "beta" | "lts";

export interface Release {
  name: string; // "r495-2"
  num: number; // 49502
  url: string; // page to load: "https://editor.construct.net/r495-2/" (stable: the root URL)
  assetUrl: string; // where the release's files live, always "…/r495-2/"
}

export function releaseNum(name: string): number {
  const m = /^r(\d+)(?:[-.](\d+))?$/.exec(name.trim());
  if (!m) throw new Error(`not a release name: ${name} (expected e.g. r497 or r495-2)`);
  return Number(m[1]) * 100 + Number(m[2] ?? 0);
}

export function releaseName(num: number): string {
  const major = Math.floor(num / 100), patch = num % 100;
  return patch ? `r${major}-${patch}` : `r${major}`;
}

export function exactRelease(name: string): Release {
  const num = releaseNum(name);
  const canonical = releaseName(num);
  const url = `${EDITOR_ORIGIN}/${canonical}/`;
  return { name: canonical, num, url, assetUrl: url };
}

// beta/lts redirect to their release; stable is served at / and names it in asset paths.
export async function resolveBranch(branch: Branch): Promise<Release> {
  if (branch === "stable") {
    const html = await (await fetch(`${EDITOR_ORIGIN}/`)).text();
    const counts = new Map<string, number>();
    for (const m of html.matchAll(/\b(r\d{3}(?:-\d+)?)\//g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    const name = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!name) throw new Error("could not find the stable release number in the editor's index page");
    return { ...exactRelease(name), url: `${EDITOR_ORIGIN}/` };
  }
  const res = await fetch(`${EDITOR_ORIGIN}/${branch}/`, { redirect: "manual" });
  const m = /\/(r\d{3}(?:-\d+)?)\/?$/.exec(res.headers.get("location") ?? "");
  if (!m) throw new Error(`could not resolve the ${branch} branch (HTTP ${res.status})`);
  return exactRelease(m[1]);
}
