// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — shadcn CSS-variable importer.
 *
 * shadcn-style themes ship as a `:root { … }` (+ optional `.dark { … }`)
 * block of unprefixed CSS variables:
 *
 *   :root {
 *     --background: 0 0% 100%;
 *     --primary: 222.2 47.4% 11.2%;
 *     --primary-foreground: 210 40% 98%;
 *   }
 *   .dark {
 *     --background: 222.2 84% 4.9%;
 *     --primary: 210 40% 98%;
 *   }
 *
 * Each unprefixed name maps to `color.<name>` (shadcn variables are
 * exclusively colors today — typography/spacing live in Tailwind config).
 * When both blocks exist, paired names land as `{light, dark}` composite
 * color values; lone names emit flat values.
 */

import { type ThemeDocument, validateThemeTokens } from "../themes.js";
import { NotShadcnShape } from "../themes-errors.js";

interface CssVarMap {
  readonly [name: string]: string;
}

export function importShadcn(body: string): ThemeDocument {
  // Quick rejections so the auto-detect chain can fall through fast.
  if (/"value"\s*:/i.test(body)) {
    throw new NotShadcnShape('input contains `"value":` — looks like Style Dictionary JSON');
  }
  const lightBlock = extractBlock(body, ":root");
  if (lightBlock === null) {
    throw new NotShadcnShape();
  }
  const lightVars = parseCssVars(lightBlock);
  if (Object.keys(lightVars).length === 0) {
    throw new NotShadcnShape(":root block found but no `--name: value;` pairs inside");
  }
  const darkBlock = extractBlock(body, ".dark");
  const darkVars = darkBlock === null ? null : parseCssVars(darkBlock);

  const color: Record<string, unknown> = {};
  for (const [name, lightVal] of Object.entries(lightVars)) {
    const wrapped = wrapColorValue(lightVal);
    if (darkVars && darkVars[name] !== undefined) {
      color[name] = {
        $value: { light: wrapped, dark: wrapColorValue(darkVars[name]) },
        $type: "color",
      };
    } else {
      color[name] = { $value: wrapped, $type: "color" };
    }
  }
  // Surface dark-only names too (no light counterpart). Rare but real
  // when an operator splits brand variants across blocks.
  if (darkVars) {
    for (const [name, darkVal] of Object.entries(darkVars)) {
      if (name in color) continue;
      color[name] = { $value: wrapColorValue(darkVal), $type: "color" };
    }
  }

  const doc: ThemeDocument = { color };
  return validateThemeTokens(doc);
}

/**
 * Find a selector block (e.g. `:root` or `.dark`) and return the body
 * inside the matching braces. Strips block comments before matching.
 */
function extractBlock(body: string, selector: string): string | null {
  // Tempered-dot comment strip (see tailwind.ts) — non-backtracking
  // replacement for the lazy `/\/\*[\s\S]*?\*\//g` (CodeQL js/polynomial-redos).
  const stripped = body.replace(/\/\*(?:(?!\*\/)[\s\S])*\*\//g, "");
  // Escape regex specials in the selector (`.` for `.dark`).
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`).exec(stripped);
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

function parseCssVars(block: string): CssVarMap {
  const out: Record<string, string> = {};
  for (const raw of block.split(";")) {
    const line = raw.trim();
    if (line.length === 0 || !line.startsWith("--")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const name = line.slice(2, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (name.length === 0 || value.length === 0) continue;
    out[name] = value;
  }
  return out;
}

/**
 * shadcn often stores HSL channels without the `hsl(...)` wrapper
 * (`--primary: 222.2 47.4% 11.2%`). Detect that shape and wrap so the
 * resulting value is a valid CSS color string the renderer / browser
 * can use directly. Hex / oklch / rgb / hsl(...) values pass through
 * unchanged.
 */
function wrapColorValue(raw: string): string {
  const trimmed = raw.trim();
  // Already a recognised CSS color → pass through.
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  if (/^(oklch|rgb|rgba|hsl|hsla|lab|lch|color|hwb)\s*\(/i.test(trimmed)) return trimmed;
  if (/^(transparent|currentColor)$/i.test(trimmed)) return trimmed;
  // Three space-separated tokens with a `%` somewhere → shadcn HSL triple.
  if (/^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/.test(trimmed)) {
    return `hsl(${trimmed})`;
  }
  // Bare named color or anything else — pass through; the Zod schema
  // will catch genuinely-broken inputs at validateThemeTokens.
  return trimmed;
}
