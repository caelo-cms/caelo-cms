// SPDX-License-Identifier: MPL-2.0

/**
 * Module JS must parse before it is stored.
 *
 * The composer concatenates every module's `js` on a page into ONE classic
 * `<script defer data-source="modules">` (shared `preview-compose.ts`), so a
 * single syntax error stops the script of every module on the page, the
 * interaction kit included — and the browser reports it only as an
 * uncaught `SyntaxError` with no source location. e2e-livedit run
 * 40532297620: a footer module whose js arrived with escaped line breaks
 * (`(function () {\n  document…` with a literal backslash-n) was stored
 * as-is, and every preview of every page threw `SyntaxError: Invalid or
 * unexpected token` until the AI noticed the broken render. Refusing at
 * the write with the parser's own message and position turns that into
 * one corrected call (CLAUDE.md §2 fail loudly, §11 AI-actionable errors).
 *
 * Parsed as a classic script, not a module: that is how the page runs it,
 * so `import` / top-level `await` / top-level `return` are errors here too.
 */

import { parseSync } from "oxc-parser";

/** 1-based line and column of a 0-based offset in `source`. */
function lineColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/**
 * The AI-actionable refusal for module `js` that does not parse as a classic
 * script, or `null` when it parses (an empty value always does).
 *
 * @param js - the module's js as it would be stored.
 */
export function moduleJsSyntaxError(js: string): string | null {
  if (js.trim().length === 0) return null;
  const { errors } = parseSync("module.js", js, { sourceType: "script" });
  const first = errors.find((e) => e.severity === "Error");
  if (!first) return null;
  const label = first.labels[0];
  const pos = label ? lineColumn(js, label.start) : null;
  const where = pos ? ` at line ${pos.line}, column ${pos.column}` : "";
  const escapedLineBreaks =
    !/[\r\n]/.test(js) && /(?<!\\)\\n/.test(js)
      ? " It has no real line break but literal \\n sequences — send the js with real line breaks, not escaped ones."
      : "";
  return (
    `js is not valid JavaScript (${first.message}${where}).${escapedLineBreaks} ` +
    "All module js on a page runs as one shared <script>, so this error would stop every module's script on the page. Fix the syntax in `js`."
  );
}
