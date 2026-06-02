// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — Tailwind 4 `@theme { … }` block importer.
 *
 * Tailwind 4 defines theme tokens in a `@theme` (or `@theme inline`) at-rule:
 *
 *   @theme {
 *     --color-primary: #ff6600;
 *     --spacing-md: 1rem;
 *     --font-sans: Inter, system-ui;
 *   }
 *
 * The importer extracts each `--<namespace>-<rest>: <value>;` line from
 * the brace pair and maps it onto a DTCG path via the inverse of
 * `theme-render.ts`'s namespace table (`color.<rest>`, `spacing.<rest>`,
 * etc.). The result is validated by `validateThemeTokens`.
 *
 * Deliberately forgiving — handles `@theme inline`, single-line / block
 * comments, blank lines. Hard-fails (TailwindImportError) on calc() /
 * nested at-rules so the operator gets a concrete fix-it message
 * instead of silently-truncated output.
 */

import { isUnsafeKey } from "../safe-keys.js";
import { type ThemeDocument, validateThemeTokens } from "../themes.js";
import { NotTailwindShape, TailwindImportError } from "../themes-errors.js";

interface CssVarEntry {
  readonly name: string;
  readonly value: string;
}

export function importTailwind(body: string): ThemeDocument {
  const block = extractAtThemeBlock(body);
  if (block === null) {
    throw new NotTailwindShape();
  }
  const entries = parseCssVarBlock(block);
  if (entries.length === 0) {
    throw new NotTailwindShape("@theme block found but no `--name: value;` pairs inside");
  }
  const doc = mapEntriesToDtcg(entries);
  return validateThemeTokens(doc);
}

/**
 * Locate the body of the first `@theme` (or `@theme inline`) at-rule.
 * Returns the contents inside the matching `{ … }` (no braces, no
 * outer whitespace) or null when no block is present.
 */
function extractAtThemeBlock(body: string): string | null {
  // Tempered-dot comment strip — `(?:(?!\*\/)[\s\S])*` instead of a lazy
  // `[\s\S]*?` — so a comment that is never closed cannot drive O(n²)
  // backtracking (CodeQL js/polynomial-redos). Stops at the first `*/`,
  // identical output to the lazy form on valid CSS.
  const stripped = body.replace(/\/\*(?:(?!\*\/)[\s\S])*\*\//g, "");
  const match = /@theme\s+(?:inline\s+)?\{/i.exec(stripped);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  let i = start;
  while (i < stripped.length && depth > 0) {
    const ch = stripped[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth === 0) break;
    i += 1;
  }
  if (depth !== 0) return null;
  return stripped.slice(start, i);
}

function parseCssVarBlock(block: string): CssVarEntry[] {
  const entries: CssVarEntry[] = [];
  // Split on `;` so each entry is one declaration. Skip empty
  // fragments and any line that doesn't start with `--`.
  for (const raw of block.split(";")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("//")) continue;
    if (!line.startsWith("--")) {
      // Catch nested at-rules; the importer doesn't handle them.
      if (line.startsWith("@")) {
        throw new TailwindImportError("nested @-rule", line);
      }
      // Tolerate plain identifiers (`color-scheme: dark` etc.) — skip silently.
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const name = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (value.length === 0) continue;
    if (/\bcalc\s*\(/i.test(value)) {
      throw new TailwindImportError("calc()", line);
    }
    if (/\bvar\s*\(/i.test(value)) {
      throw new TailwindImportError("var()", line);
    }
    entries.push({ name, value });
  }
  return entries;
}

/**
 * Map each `--<namespace>-<rest>` entry to a DTCG group. The namespace
 * table mirrors theme-render.ts's emit table inverted.
 */
function mapEntriesToDtcg(entries: readonly CssVarEntry[]): ThemeDocument {
  const out: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    // Strip the leading `--` and split on the first hyphen.
    const stripped = entry.name.slice(2);
    const firstHyphen = stripped.indexOf("-");
    if (firstHyphen <= 0) continue; // no category prefix → skip
    const ns = stripped.slice(0, firstHyphen);
    const rest = stripped.slice(firstHyphen + 1);

    let category: string;
    let leafName: string;
    let extraSubField: string | null = null;
    switch (ns) {
      case "color":
        category = "color";
        leafName = rest;
        break;
      case "spacing":
        category = "spacing";
        leafName = rest;
        break;
      case "radius":
        category = "radius";
        leafName = rest;
        break;
      case "shadow":
        category = "shadow";
        leafName = rest;
        break;
      case "breakpoint":
        category = "breakpoint";
        leafName = rest;
        break;
      case "duration":
        category = "duration";
        leafName = rest;
        break;
      case "ease":
        category = "ease";
        leafName = rest;
        break;
      case "font":
        // --font-sans → typography.sans.fontFamily
        category = "typography";
        leafName = rest;
        extraSubField = "fontFamily";
        break;
      case "text":
        // --text-base → typography.base.fontSize
        category = "typography";
        leafName = rest;
        extraSubField = "fontSize";
        break;
      default:
        // Unknown namespace — bucket under its own root so the renderer
        // still emits the var (forward-compat).
        category = ns;
        leafName = rest;
    }

    // `category` and `leafName` are derived from the imported CSS variable
    // name, so a hostile token like `--__proto__-x` could otherwise pollute
    // the prototype chain via `out[category]` / `group[leafName]` (CodeQL
    // js/prototype-polluting-assignment). Skip the entry on any unsafe key.
    if (isUnsafeKey(category) || isUnsafeKey(leafName)) continue;

    if (!out[category]) out[category] = {};
    const group = out[category]!;
    if (extraSubField !== null) {
      // Typography composite: merge into the existing leaf's $value.
      const existing = group[leafName];
      const baseObj =
        existing && typeof existing === "object" && "$value" in existing
          ? ((existing as { $value: unknown }).$value as Record<string, unknown>)
          : {};
      group[leafName] = {
        $value: { ...baseObj, [extraSubField]: entry.value },
        $type: "typography",
      };
    } else {
      // v0.11.1 (issue #76 Copilot review #4): if `leafName` looks like
      // a Tailwind ramp suffix (`primary-50` … `primary-900`,
      // `primary-DEFAULT`), nest it as `<group>.<stop>` so the result
      // matches the OKLCh ramp's DTCG group shape. Without this,
      // `--color-primary-50` would land at the flat key `color['primary-50']`
      // and downstream ramp-aware logic (DEFAULT-alias resolver, the
      // ColorEditor's color.primary swatch, the propose-create explicit-
      // stop override path) wouldn't see the stops as a group.
      const rampMatch = /^(.+)-(50|100|200|300|400|500|600|700|800|900|DEFAULT)$/.exec(leafName);
      const tokenLeaf = {
        $value: entry.value,
        $type: category === "color" ? "color" : category === "duration" ? "duration" : "dimension",
      };
      if (rampMatch && category === "color") {
        const [, baseName, stop] = rampMatch as unknown as [string, string, string];
        // `baseName` is the ramp prefix parsed from the token name; guard it
        // before it becomes a `group[baseName]` assignment target. `stop` is
        // a fixed enum (50…900|DEFAULT), so it needs no guard.
        if (isUnsafeKey(baseName)) continue;
        if (!group[baseName] || typeof group[baseName] !== "object") {
          group[baseName] = {};
        }
        (group[baseName] as Record<string, unknown>)[stop] = tokenLeaf;
      } else {
        group[leafName] = tokenLeaf;
      }
    }
  }
  return out as ThemeDocument;
}
