# Editor internals and demangling

**Status:** not started (2026-09-21)

- The editor is a mangled ES bundle (`main.js` ~1.4 MB). Property names are mangled
  per build (`Vz.Knr`, `zz.n6s.kn`), but literal strings (URL params, storage keys, lang
  keys, JSON property names) are not. Search by strings, then read outward.
- Tool: `~/Documents/C3 Versions/C3-r500 copy/demangle/demangle.mjs` (babel + prettier;
  collects scope-aware bindings with snippets). Extend it to emit a *name map* for a fixed
  set of anchors, e.g.:
  - `openFromUrl`: the function called with `` `exampleProjects/debug/${t}.capx` ``
  - `searchParams`: the object constructed from `location.search`
  - `projectOpened` signal: whatever `sV()` awaits before reading `?layout`
  - the App/main object (`Vz`), the current project (`Vz.rsr[0]`), `j2(name)` layout by
    name, `B2(name)` event sheet by name, `WW`/`mL` open views.
- Store `maps/<release>.json`; `c3cli doctor --release rX` re-derives the map from the
  live bundle (fetch `main.js`) and diffs it. A missing anchor = fail loudly.
- Rule: internals are an accelerator, never the only route (see DESIGN.md).
