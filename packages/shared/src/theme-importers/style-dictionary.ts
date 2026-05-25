// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — Style Dictionary v3/v4 importer.
 *
 * Style Dictionary stores tokens as `{ value: "…", attributes?: {…} }`
 * leaves instead of DTCG's `$value` / `$type`. This importer walks the
 * tree, rewrites `value` → `$value` (and `type` → `$type` where set),
 * preserves `attributes` blocks under `$extensions.styleDictionary`,
 * and feeds the result through `validateThemeTokens` for round-trip
 * compatibility with the DTCG storage shape.
 *
 * Recognition heuristic: input must be valid JSON with at least one
 * nested `{ value: … }` leaf and NO `$value` keys (the latter would
 * indicate DTCG — the auto-detect chain handles priority).
 */

import { type ThemeDocument, validateThemeTokens } from "../themes.js";
import { NotStyleDictionaryShape } from "../themes-errors.js";

export function importStyleDictionary(body: string): ThemeDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new NotStyleDictionaryShape(`Style Dictionary parse failed: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NotStyleDictionaryShape("Style Dictionary input must be a JSON object");
  }
  if (hasDollarValue(parsed)) {
    throw new NotStyleDictionaryShape(
      "input has `$value` leaves — looks like DTCG, not Style Dictionary",
    );
  }
  if (!hasPlainValue(parsed)) {
    throw new NotStyleDictionaryShape(
      "input has no `{ value: … }` leaves typical of Style Dictionary",
    );
  }
  const dtcg = rewriteSdToDtcg(parsed);
  // Top-level Style Dictionary categories may not exactly match DTCG
  // (e.g. `size` instead of `spacing`); rename common cases so the
  // resulting document validates and renders correctly.
  const renamed = renameTopLevelCategories(dtcg);
  return validateThemeTokens(renamed);
}

function hasDollarValue(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasDollarValue);
  const obj = node as Record<string, unknown>;
  if ("$value" in obj) return true;
  for (const v of Object.values(obj)) {
    if (hasDollarValue(v)) return true;
  }
  return false;
}

function hasPlainValue(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasPlainValue);
  const obj = node as Record<string, unknown>;
  // A leaf in Style Dictionary has `value` AND no nested object siblings
  // carrying their own value. Detecting "has value somewhere" is enough
  // for the auto-detect sniff; full validation happens in rewriteSdToDtcg.
  if ("value" in obj && typeof obj.value !== "object") return true;
  for (const v of Object.values(obj)) {
    if (hasPlainValue(v)) return true;
  }
  return false;
}

function rewriteSdToDtcg(node: unknown): unknown {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
  const obj = node as Record<string, unknown>;
  // Leaf detection: has `value` but no nested children that themselves
  // have `value` (deepest-first rewrite).
  if ("value" in obj && typeof obj.value !== "object") {
    const leaf: Record<string, unknown> = { $value: obj.value };
    if ("type" in obj && typeof obj.type === "string") {
      leaf.$type = obj.type;
    }
    if ("description" in obj && typeof obj.description === "string") {
      leaf.$description = obj.description;
    }
    if ("attributes" in obj && obj.attributes && typeof obj.attributes === "object") {
      leaf.$extensions = { styleDictionary: { attributes: obj.attributes } };
    }
    return leaf;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = rewriteSdToDtcg(v);
  }
  return out;
}

/**
 * Common Style Dictionary category name → DTCG category map. Only
 * applied at the root; nested groups keep their original names.
 */
const SD_TO_DTCG_CATEGORY: Record<string, string> = {
  size: "spacing",
  sizes: "spacing",
  spaces: "spacing",
  colors: "color",
  fonts: "typography",
  font: "typography",
  shadows: "shadow",
  radii: "radius",
  borderRadius: "radius",
};

function renameTopLevelCategories(doc: unknown): unknown {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const obj = doc as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const renamed = SD_TO_DTCG_CATEGORY[k];
    out[renamed ?? k] = v;
  }
  return out;
}
