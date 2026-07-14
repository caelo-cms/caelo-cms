// SPDX-License-Identifier: MPL-2.0

/**
 * issue #301 — skill-allowlist naming translation.
 *
 * Skill rows seeded by migration 0033 (the P10.5 subagent reviewer
 * skills) declared `allowlisted_tools` in Query-API op notation
 * (`pages.list`, `structured_sets.get`, …) while the chat-runner
 * matches AI tool names (`list_pages`, `get_structured_set`, …). The
 * intersection was always empty and the old zero-match branch silently
 * widened back to the full catalogue — run #15 hit this 5× in one
 * session ("skill-allowlist-zero-match"), shipping the whole catalogue
 * on turns the skill meant to narrow (CLAUDE.md §2: exactly the hidden
 * fallback pre-1.0 forbids).
 *
 * This module is the single, explicit translation layer:
 *   - `OP_NAME_TO_TOOL_NAMES` maps every op name that appears in a
 *     seeded skill allowlist to the AI tool name(s) covering the same
 *     read/write surface. Unknown names never pass silently.
 *   - `resolveAllowlistEntries` is the runtime evaluator used by
 *     `buildToolCatalogue` (exact tool-name match first, then the
 *     table, then loud per-entry failure with a nearest-name hint).
 *   - `validateAllowlistEntries` is the save-time gate used by the
 *     skills ops (`skills.set` / `skills.propose` /
 *     `skills.review_proposal`): entries that resolve to neither a
 *     live tool nor a translation entry reject the write with a
 *     structured, AI-actionable error (CLAUDE.md §11).
 *
 * Migration 0157 normalizes the seeded rows themselves to tool names,
 * so in a healthy install this table is a belt-and-braces layer for
 * operator-edited rows and pre-0157 databases.
 */

/**
 * Op-name → AI tool name(s). Keys are every Query-API op name that
 * appears in a seeded skill allowlist today (migration 0033: qa-check,
 * legal-check, menu-auditor, page-categorizer).
 *
 * An EMPTY mapping means the op is a known read surface with no AI
 * tool counterpart — the data is delivered via system-prompt context
 * blocks (site memory, glossary, style guide), so the entry narrows
 * nothing and is dropped at normalization. That is NOT a silent pass:
 * the entry is explicitly enumerated here with the reason, and
 * validation still rejects anything outside this table.
 */
export const OP_NAME_TO_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  // Page reads. There is no standalone `get_page` tool; `list_pages`
  // returns the same row data, and `inspect_page_render` is the
  // per-page deep read (it wraps `pages.get_with_modules` internally).
  "pages.list": ["list_pages"],
  "pages.get": ["list_pages"],
  "pages.get_with_modules": ["inspect_page_render"],
  // Structured sets have direct tool counterparts.
  "structured_sets.list": ["list_structured_sets"],
  "structured_sets.get": ["get_structured_set"],
  // Both redirect read ops are served by the one search tool.
  "redirects.list": ["find_redirects"],
  "redirects.lookup": ["find_redirects"],
  // Context-served reads — injected into the system prompt by the
  // chat-runner's context blocks, never exposed as tools:
  //   glossary.list   → the translation glossary block
  //   style_guide.get → the style-guide / brand-voice block
  //   ai_memory.list  → the site-memory block (persistence.ts)
  "glossary.list": [],
  "style_guide.get": [],
  "ai_memory.list": [],
};

/** How a single allowlist entry resolved against the live tool set. */
export type AllowlistEntryResolution =
  /** The entry IS a live tool name — passes through unchanged. */
  | { readonly kind: "tool"; readonly toolNames: readonly string[] }
  /** Op-notation entry translated to ≥1 live tool via the table. */
  | { readonly kind: "translated"; readonly toolNames: readonly string[] }
  /** Known op with no AI-tool counterpart (context-served) — narrows nothing. */
  | { readonly kind: "context-served" }
  /** Neither a live tool nor a translation entry — a defect in the skill row. */
  | { readonly kind: "unresolved"; readonly suggestion: string | null };

/** Aggregate resolution of a whole allowlist. */
export interface AllowlistResolution {
  /** Live tool names the allowlist narrows to (exact + translated, deduped). */
  readonly resolvedToolNames: ReadonlySet<string>;
  /** Op-notation entries that translated, with their tool names (for logging). */
  readonly translated: ReadonlyArray<{ entry: string; toolNames: readonly string[] }>;
  /** Known context-served ops that narrow nothing. */
  readonly contextServed: readonly string[];
  /** Entries that resolved to nothing — each with a nearest-name hint. */
  readonly unresolved: ReadonlyArray<{ entry: string; suggestion: string | null }>;
}

/**
 * Resolves one allowlist entry: exact live-tool match first, then the
 * translation table, else unresolved with a nearest-name suggestion.
 */
export function resolveAllowlistEntry(
  entry: string,
  liveToolNames: ReadonlySet<string>,
): AllowlistEntryResolution {
  if (liveToolNames.has(entry)) return { kind: "tool", toolNames: [entry] };
  const mapped = OP_NAME_TO_TOOL_NAMES[entry];
  if (mapped !== undefined) {
    if (mapped.length === 0) return { kind: "context-served" };
    const live = mapped.filter((n) => liveToolNames.has(n));
    if (live.length > 0) return { kind: "translated", toolNames: live };
    // The table knows the op but none of its tools are registered in
    // THIS process (e.g. a narrowed test registry). Surface the mapped
    // name as the suggestion instead of guessing.
    return { kind: "unresolved", suggestion: mapped[0] ?? null };
  }
  return { kind: "unresolved", suggestion: suggestNearestToolName(entry, liveToolNames) };
}

/** Resolves a whole allowlist; see {@link AllowlistResolution}. */
export function resolveAllowlistEntries(
  entries: Iterable<string>,
  liveToolNames: ReadonlySet<string>,
): AllowlistResolution {
  const resolvedToolNames = new Set<string>();
  const translated: Array<{ entry: string; toolNames: readonly string[] }> = [];
  const contextServed: string[] = [];
  const unresolved: Array<{ entry: string; suggestion: string | null }> = [];
  for (const entry of entries) {
    const r = resolveAllowlistEntry(entry, liveToolNames);
    switch (r.kind) {
      case "tool":
        for (const n of r.toolNames) resolvedToolNames.add(n);
        break;
      case "translated":
        for (const n of r.toolNames) resolvedToolNames.add(n);
        translated.push({ entry, toolNames: r.toolNames });
        break;
      case "context-served":
        contextServed.push(entry);
        break;
      case "unresolved":
        unresolved.push({ entry, suggestion: r.suggestion });
        break;
    }
  }
  return { resolvedToolNames, translated, contextServed, unresolved };
}

/** One rejected allowlist entry + the nearest live tool name, if any. */
export interface AllowlistProblem {
  readonly entry: string;
  readonly suggestion: string | null;
}

/**
 * Save-time validation + normalization for `allowlistedTools`
 * (issue #301, CLAUDE.md §2 loud path). Success returns the canonical
 * tool-name list: exact names kept, op-notation entries replaced by
 * their tool names, context-served entries dropped, order-preserving
 * dedupe. Failure names every bad entry with a suggestion so the
 * caller (Owner form or AI tool result) can fix it without guessing.
 */
export function validateAllowlistEntries(
  entries: readonly string[],
  liveToolNames: ReadonlySet<string>,
): { ok: true; normalized: string[] } | { ok: false; problems: AllowlistProblem[] } {
  const normalized: string[] = [];
  const seen = new Set<string>();
  const problems: AllowlistProblem[] = [];
  for (const entry of entries) {
    const r = resolveAllowlistEntry(entry, liveToolNames);
    if (r.kind === "unresolved") {
      problems.push({ entry, suggestion: r.suggestion });
      continue;
    }
    if (r.kind === "context-served") continue;
    for (const n of r.toolNames) {
      if (!seen.has(n)) {
        seen.add(n);
        normalized.push(n);
      }
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, normalized };
}

/**
 * Renders validation problems into the one-line, AI-actionable error
 * message the skills ops return (CLAUDE.md §11: failure surfaces carry
 * the next step, not just "validation failed").
 */
export function describeAllowlistProblems(problems: readonly AllowlistProblem[]): string {
  const list = problems
    .map((p) => `"${p.entry}"${p.suggestion ? ` (did you mean "${p.suggestion}"?)` : ""}`)
    .join(", ");
  return (
    `allowlistedTools entries must be live AI tool names (e.g. "edit_module", "list_pages"), ` +
    `not Query-API op names. Unresolvable: ${list}. ` +
    `Fix the named entries and retry; call with allowlistedTools=[] to leave the catalogue unrestricted.`
  );
}

/**
 * Nearest live tool name for an unresolvable entry. Tries the two
 * shapes a mis-remembered name usually takes — dots-for-underscores
 * (`pages_list`) and op-notation flipped to verb_domain (`list_pages`)
 * — then picks the closest live name by edit distance, suppressing
 * suggestions too far away to be plausibly related.
 */
export function suggestNearestToolName(
  entry: string,
  liveToolNames: ReadonlySet<string>,
): string | null {
  const candidates = new Set<string>([entry.replaceAll(".", "_")]);
  const dot = entry.indexOf(".");
  if (dot > 0 && dot < entry.length - 1) {
    const domain = entry.slice(0, dot);
    const op = entry.slice(dot + 1).replaceAll(".", "_");
    candidates.add(`${op}_${domain}`);
  }
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const toolName of liveToolNames) {
    for (const candidate of candidates) {
      const d = levenshtein(candidate, toolName);
      if (d < bestDistance) {
        bestDistance = d;
        best = toolName;
      }
    }
  }
  if (best === null) return null;
  // Cap: more than ~a-third-of-the-name in edits is noise, not a typo.
  const cap = Math.max(3, Math.floor(best.length / 3));
  return bestDistance <= cap ? best : null;
}

/** Classic two-row Levenshtein — inputs are short tool names, so O(n·m) is fine. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
