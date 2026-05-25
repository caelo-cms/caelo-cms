// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — DTCG (W3C Design Tokens Format) import / export for the
 * `themes` primitive (#45 Phase 7 slice 1).
 *
 * The full format-auto-detect (Style Dictionary / Tailwind 4 @theme /
 * shadcn `:root` / loose key-value) is v0.11.2 — see the follow-up
 * comment §4 on #45. This slice ships the DTCG side only so design
 * tooling (Figma, Tokens Studio, Style Dictionary) round-trips cleanly
 * from day one.
 *
 * The shape we accept IS the same shape `themes.tokens` jsonb carries,
 * because `themes.ts`'s Zod schema mirrors DTCG. So `importDtcg` is
 * essentially `JSON.parse + validateThemeTokens`; `exportDtcg` returns
 * the stored tokens jsonb after stable-stringification. The wrappers
 * exist so we have explicit entry points to grow Style-Dictionary /
 * Tailwind / shadcn / loose parsers next to in v0.11.2 without
 * widening `themes.ts`.
 */

import { type Theme, type ThemeDocument, validateThemeTokens } from "../themes.js";

/**
 * Parse a DTCG JSON document into a validated tokens tree. Throws on
 * malformed JSON OR on tokens that don't match `themes.ts`'s Zod
 * schema (e.g. missing `$value`, unrecognised composite shape).
 */
export function importDtcg(body: string): ThemeDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`DTCG parse failed: ${msg}`);
  }
  return validateThemeTokens(parsed);
}

/**
 * Emit a stable DTCG JSON document for the given theme. Keys are
 * sorted alphabetically at every nesting level so the output is
 * byte-for-byte deterministic — Style Dictionary / Tokens Studio diff
 * cleanly under git.
 *
 * Only `tokens` is exported; asset URLs and the `is_active` flag are
 * Caelo-specific and have no DTCG representation. Operators bind
 * assets through `set_theme_asset`, not through an exported JSON file.
 */
export function exportDtcg(theme: Pick<Theme, "tokens">): string {
  return JSON.stringify(sortDeep(theme.tokens), null, 2) + "\n";
}

function sortDeep(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort((a, b) => {
    // DTCG convention: $-prefixed metadata keys ($value, $type,
    // $description, $extensions) sort BEFORE plain group keys so a
    // leaf renders with its metadata up top, then its sub-references
    // (if any) below. Within each tier keys sort alphabetically.
    const aDollar = a.startsWith("$");
    const bDollar = b.startsWith("$");
    if (aDollar && !bDollar) return -1;
    if (!aDollar && bDollar) return 1;
    return a.localeCompare(b);
  });
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    out[k] = sortDeep(obj[k]);
  }
  return out;
}
