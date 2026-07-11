// SPDX-License-Identifier: MPL-2.0

/**
 * issue #156 — CSS custom-property reference scanner.
 *
 * The silent-fallback trap: module/template/layout CSS referencing a
 * `var(--…)` the active theme never emits renders the hardcoded
 * fallback (or nothing), so the page quietly diverges from the theme —
 * the monochrome regression class documented in theme-render.ts. The
 * prompt-level var inventory guards the happy path; this scanner is the
 * mechanical write-time guard (CLAUDE.md §2: misses must be loud).
 *
 * Pure string analysis — callers (authoring tools, preview op) supply
 * the known-var set from `listThemeCssVarNames(activeTheme.tokens)`.
 * Custom properties DEFINED anywhere in the scanned bundle are treated
 * as known: a layout may define `--site-gutter` for its modules, and
 * that is legitimate authoring, not drift.
 */

/** One `var(--x)` reference found in CSS. */
export interface CssVarReference {
  readonly name: string;
  /** True when the reference carries a literal fallback (`var(--x, #fff)`). */
  readonly hasFallback: boolean;
}

const VAR_REFERENCE_RE = /var\(\s*(--[a-zA-Z0-9_-]+)\s*(,)?/g;
const VAR_DEFINITION_RE = /(?:^|[{;\s])(--[a-zA-Z0-9_-]+)\s*:/g;

/** Extract every `var(--x[, fallback])` reference (deduped by name+fallback). */
export function extractCssVarReferences(css: string): CssVarReference[] {
  const seen = new Map<string, CssVarReference>();
  for (const m of css.matchAll(VAR_REFERENCE_RE)) {
    const name = m[1] ?? "";
    const hasFallback = m[2] === ",";
    const key = `${name}|${hasFallback}`;
    if (!seen.has(key)) seen.set(key, { name, hasFallback });
  }
  return [...seen.values()];
}

/** Custom properties DEFINED in the CSS (`--x: value;`). */
export function extractCssVarDefinitions(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(VAR_DEFINITION_RE)) {
    out.add(m[1] ?? "");
  }
  return out;
}

/** Levenshtein distance, small-string use only (var names). */
function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min(
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length] as number;
}

/** An unknown reference + the closest known name worth suggesting. */
export interface UnknownCssVar {
  readonly name: string;
  readonly hasFallback: boolean;
  /** Closest known var within edit-distance 40% of length, or null. */
  readonly suggestion: string | null;
}

export interface CssVarScanInput {
  /** The CSS bundle to scan (concatenate layout+template+module parts). */
  readonly css: string;
  /** Vars the active theme emits (`listThemeCssVarNames`). */
  readonly knownVars: readonly string[];
}

/**
 * Report `var()` references that neither the theme emits nor the
 * bundle itself defines, with a nearest-match suggestion so the fix is
 * one edit, not a research task (CLAUDE.md §11: AI-actionable).
 */
export function scanCssVars(input: CssVarScanInput): UnknownCssVar[] {
  const known = new Set(input.knownVars);
  for (const def of extractCssVarDefinitions(input.css)) known.add(def);

  const unknown: UnknownCssVar[] = [];
  const reported = new Set<string>();
  for (const ref of extractCssVarReferences(input.css)) {
    if (known.has(ref.name) || reported.has(ref.name)) continue;
    reported.add(ref.name);
    let best: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const candidate of known) {
      const d = editDistance(ref.name, candidate);
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
    const threshold = Math.max(2, Math.floor(ref.name.length * 0.4));
    unknown.push({
      name: ref.name,
      hasFallback: ref.hasFallback,
      suggestion: best !== null && bestDist <= threshold ? best : null,
    });
  }
  return unknown;
}

/**
 * Marker for the preview op's missing-content surface — same
 * convention as `theme-asset-unbound:<slot>` / `theme-font-unresolvable`.
 */
export function unknownCssVarMarker(name: string): string {
  return `unknown-css-var:${name}`;
}

/**
 * One-line, AI-actionable warning for authoring-tool results. Returns
 * null when nothing is unknown (no noise on clean writes).
 */
export function formatUnknownCssVarWarning(unknown: readonly UnknownCssVar[]): string | null {
  if (unknown.length === 0) return null;
  const parts = unknown.map((u) => {
    const hint = u.suggestion !== null ? ` (did you mean \`${u.suggestion}\`?)` : "";
    const fallback = u.hasFallback
      ? " — its hardcoded fallback is what visitors will see, detached from the theme"
      : " — the declaration is invalid and the property won't apply";
    return `\`${u.name}\`${hint}${fallback}`;
  });
  return (
    `⚠️ Unknown CSS vars (the active theme does not emit them): ${parts.join("; ")}. ` +
    "Use the exact names from the `## Theme` inventory, or define the custom property in this CSS if it's intentional."
  );
}
