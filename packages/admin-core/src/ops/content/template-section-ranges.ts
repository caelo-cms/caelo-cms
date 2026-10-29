// SPDX-License-Identifier: MPL-2.0

/**
 * Byte ranges of the template sections already present in module HTML,
 * for the content extractor (`extract-module-structure.ts`,
 * `extract-module-lists.ts`).
 *
 * A section body — `{{#breadcrumbs}}<li><span>Sep</span></li>{{/breadcrumbs}}`,
 * an inverted `{{^x}}…{{/x}}`, or a helper-style block such as
 * `{{#if x}}…{{/if}}` — is authored template, not hardcoded copy: its
 * text renders once per entry of a list (often a plugin's list source) or
 * depends on a value. Lifting that text into an invented module field
 * breaks the loop, and the validator, which reads only top-level
 * references, then refuses the very field the extractor minted (#1236).
 * So the extractor treats every section as opaque and touches nothing
 * inside it.
 */

/** A half-open `[start, end)` range of the HTML. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

// Opening tag: `{{#name}}`, `{{^name}}`, or a helper form `{{#if x}}` (the
// name is the first word; the rest of the tag is ignored). `[^{}]*` cannot
// overlap the name's character class across the mandatory boundary, so the
// match stays linear.
const TAG_RE = /\{\{\s*([#^/])\s*([a-zA-Z][\w.]*)([^{}]*)\}\}/g;

/**
 * Returns the outermost section ranges of `html`, each from the start of
 * its opening tag to the end of its matching closing tag. An opening tag
 * that is never closed extends to the end of the HTML: the extractor
 * leaving the rest untouched is safe, guessing where the section ends is
 * not.
 */
export function templateSectionRanges(html: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  const stack: { name: string; start: number }[] = [];
  for (const m of html.matchAll(TAG_RE)) {
    const sigil = m[1];
    const name = m[2] ?? "";
    const start = m.index ?? 0;
    if (sigil === "#" || sigil === "^") {
      stack.push({ name, start });
      continue;
    }
    // Closing tag: pop back to the matching opener; a stray closer is
    // ignored (it is the validator's job to report it).
    const at = stack.map((s) => s.name).lastIndexOf(name);
    if (at < 0) continue;
    const opener = stack[at];
    stack.length = at;
    if (opener && stack.length === 0) {
      ranges.push({ start: opener.start, end: start + m[0].length });
    }
  }
  const unclosed = stack[0];
  if (unclosed) ranges.push({ start: unclosed.start, end: html.length });
  return ranges;
}

/** True when `[start, end)` overlaps any of `ranges`. */
export function overlapsAny(ranges: readonly SourceRange[], start: number, end: number): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}
