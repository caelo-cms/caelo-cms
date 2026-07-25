// SPDX-License-Identifier: MPL-2.0

/**
 * Pure text operations behind the `read_content` / `edit_content` /
 * `grep_content` tools — the DB-content analogue of Claude Code's
 * Read / Edit / Grep file tools.
 *
 * The load-bearing design choice (see the content-edit plan): edits are
 * anchored on TEXT, never on line numbers. Line numbers exist only to help
 * the model locate a hunk in `read_content`; an edit that no longer matches
 * is rejected loudly (CLAUDE.md §2 — no silent fallbacks) rather than
 * misapplied against a stale line index. This is exactly why Claude Code's
 * string-replace edit survives a stale read.
 */

/** One surgical string replacement, mirroring Claude Code's Edit tool. */
export interface ContentEdit {
  /** Exact text to find. Must be UNIQUE in the body unless `replaceAll`. */
  readonly oldString: string;
  /** Replacement text. Must differ from `oldString`. */
  readonly newString: string;
  /** Replace every occurrence instead of requiring uniqueness. */
  readonly replaceAll?: boolean;
}

export type ApplyEditsResult =
  | { readonly ok: true; readonly content: string; readonly replacements: number }
  | { readonly ok: false; readonly error: string };

/** Count non-overlapping literal occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Apply a sequence of string edits to `source`, left-to-right, atomically.
 *
 * MultiEdit semantics: each edit runs against the result of the previous
 * one; the whole batch either fully succeeds (returns the new body) or
 * fails with a single AI-actionable error and NO partial write (the caller
 * only persists on `ok`). Enforces Claude Code's Edit invariants:
 *  - `oldString !== newString`,
 *  - `oldString` occurs at least once (else "not found — re-read"),
 *  - `oldString` is unique unless `replaceAll` (else "N matches — add
 *    surrounding context or pass replaceAll").
 */
export function applyStringEdits(source: string, edits: readonly ContentEdit[]): ApplyEditsResult {
  if (edits.length === 0) {
    return { ok: false, error: "No edits supplied. Pass at least one {oldString, newString}." };
  }
  let current = source;
  let replacements = 0;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit) continue;
    const where = edits.length > 1 ? ` (edit #${i + 1})` : "";
    if (edit.oldString === edit.newString) {
      return {
        ok: false,
        error: `oldString equals newString${where} — nothing to change. Make the two differ, or drop this edit.`,
      };
    }
    const count = countOccurrences(current, edit.oldString);
    if (count === 0) {
      return {
        ok: false,
        error:
          `oldString not found${where}. It may be stale — re-read the current body with ` +
          `read_content and copy the exact text (including whitespace) to anchor the edit.`,
      };
    }
    if (count > 1 && edit.replaceAll !== true) {
      return {
        ok: false,
        error:
          `oldString is not unique${where}: ${count} matches. Add surrounding context to the ` +
          `oldString so it matches exactly once, or pass replaceAll:true to change all ${count}.`,
      };
    }
    current =
      edit.replaceAll === true
        ? current.split(edit.oldString).join(edit.newString)
        : current.replace(edit.oldString, edit.newString);
    replacements += edit.replaceAll === true ? count : 1;
  }
  return { ok: true, content: current, replacements };
}

/**
 * djb2 hash (base36) of a content body. Used as the optional `expectedSha`
 * freshness token: `read_content` stamps it, `edit_content` may pass it back
 * so a body changed by another writer since the read is rejected instead of
 * clobbered. Not cryptographic — a cheap change-detector, same family as the
 * chat-context `noteSignature`.
 */
export function contentSha(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) {
    h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export interface LineWindow {
  /** 1-based line to start from (default 1). */
  readonly offset?: number;
  /** Max lines to return (default: all). */
  readonly limit?: number;
}

export interface RenderedLines {
  /** `cat -n`-style body: right-aligned line number + tab + line text. */
  readonly text: string;
  readonly totalLines: number;
  readonly shownLines: number;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Render a body with `cat -n`-style line numbers, optionally windowed —
 * the exact display convention Claude Code's Read tool uses. Line numbers
 * are display-only; `edit_content` never keys on them.
 */
export function renderWithLineNumbers(body: string, window: LineWindow = {}): RenderedLines {
  const lines = body.split("\n");
  const totalLines = lines.length;
  const start = Math.max(1, window.offset ?? 1);
  const end =
    window.limit !== undefined ? Math.min(totalLines, start + window.limit - 1) : totalLines;
  const slice = start <= totalLines ? lines.slice(start - 1, end) : [];
  const text = slice.map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join("\n");
  return {
    text,
    totalLines,
    shownLines: slice.length,
    startLine: start,
    endLine: start + slice.length - 1,
  };
}

/** Count of `\n` in `body` before `end` (exclusive) → 0-based line index. */
function newlinesBefore(body: string, end: number): number {
  let n = 0;
  const stop = Math.min(end, body.length);
  for (let i = 0; i < stop; i++) if (body.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Render a `cat -n` snippet of the regions an edit batch changed in the
 * FINAL body — the same efficiency trick Claude Code's Edit result uses:
 * the model sees the change landed AND gets fresh line-numbered context for
 * a follow-up edit nearby, so it can chain edits without a re-read.
 *
 * Each edit's `newString` is located in the final body (all occurrences for
 * `replaceAll`, else the first — best-effort when `newString` also appears
 * elsewhere), a ±`context`-line window is taken around it, overlapping
 * windows are merged, and non-contiguous windows are separated by a `⋮`
 * marker. Returns "" when nothing is locatable (e.g. pure deletions).
 */
export function renderEditSnippet(
  finalBody: string,
  edits: readonly ContentEdit[],
  opts: { readonly context?: number; readonly maxWindows?: number } = {},
): string {
  const context = opts.context ?? 3;
  const maxWindows = opts.maxWindows ?? 5;
  const totalLines = finalBody.split("\n").length;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const edit of edits) {
    if (!edit || edit.newString.length === 0) continue;
    const starts: number[] = [];
    if (edit.replaceAll === true) {
      let from = 0;
      let idx = finalBody.indexOf(edit.newString, from);
      while (idx !== -1 && starts.length < 50) {
        starts.push(idx);
        from = idx + edit.newString.length;
        idx = finalBody.indexOf(edit.newString, from);
      }
    } else {
      const idx = finalBody.indexOf(edit.newString);
      if (idx !== -1) starts.push(idx);
    }
    for (const start of starts) {
      const startLine = newlinesBefore(finalBody, start) + 1;
      const endLine = newlinesBefore(finalBody, start + edit.newString.length) + 1;
      ranges.push({
        start: Math.max(1, startLine - context),
        end: Math.min(totalLines, endLine + context),
      });
    }
  }
  if (ranges.length === 0) return "";

  ranges.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    // Merge overlapping OR immediately-adjacent windows into one block.
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }

  const shown = merged.slice(0, maxWindows);
  const blocks = shown.map(
    (w) => renderWithLineNumbers(finalBody, { offset: w.start, limit: w.end - w.start + 1 }).text,
  );
  let out = blocks.join("\n     ⋮\n");
  if (merged.length > maxWindows) {
    out += `\n     … ${merged.length - maxWindows} more changed region(s)`;
  }
  return out;
}

export interface GrepHit {
  readonly lineNumber: number;
  readonly line: string;
}

/**
 * Find lines in `body` matching `pattern`. `pattern` is a literal substring
 * unless `isRegex`, in which case it's compiled as a JS RegExp (invalid
 * patterns return an error). Matching is line-oriented like ripgrep.
 */
export function grepBody(
  body: string,
  pattern: string,
  opts: { readonly isRegex?: boolean; readonly ignoreCase?: boolean } = {},
):
  | { readonly ok: true; readonly hits: GrepHit[] }
  | { readonly ok: false; readonly error: string } {
  let test: (line: string) => boolean;
  if (opts.isRegex === true) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, opts.ignoreCase === true ? "i" : "");
    } catch (e) {
      return { ok: false, error: `invalid regex: ${(e as Error).message}` };
    }
    test = (line) => re.test(line);
  } else {
    const needle = opts.ignoreCase === true ? pattern.toLowerCase() : pattern;
    test = (line) => (opts.ignoreCase === true ? line.toLowerCase() : line).includes(needle);
  }
  const hits: GrepHit[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (test(line)) hits.push({ lineNumber: i + 1, line });
  }
  return { ok: true, hits };
}
