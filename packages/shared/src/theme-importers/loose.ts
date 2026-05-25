// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76) — loose key-value JSON object importer.
 *
 * Accepts a flat JSON object of `{looseName: value}` pairs and runs
 * each entry through `normalizeTokens` + `applyDtcgWrites` so the
 * result lands at canonical DTCG paths. This is the same path
 * `themes.update_tokens` uses for AI-supplied input — extracted here
 * so `import_theme` can offer a "paste a flat object, server figures
 * out where each one goes" surface.
 *
 * The importer starts from an empty document so it produces a complete
 * tokens tree (no existing tokens merged in). Callers wanting a patch
 * use `themes.update_tokens` directly.
 */

import { applyDtcgWrites, type ThemeDocument, validateThemeTokens } from "../themes.js";
import { normalizeTokens } from "../theme-normalize.js";
import { NotLooseShape } from "../themes-errors.js";

export function importLoose(body: string): ThemeDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new NotLooseShape(`loose-format parse failed: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NotLooseShape("loose-format input must be a JSON object");
  }
  // Reject inputs that are clearly other formats so auto-detect doesn't
  // accidentally swallow them at the last hop.
  if (hasNestedDollarValue(parsed) || hasNestedPlainValue(parsed)) {
    throw new NotLooseShape(
      "input has nested `$value` / `value` leaves — looks like DTCG or Style Dictionary, not loose",
    );
  }

  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length === 0) {
    throw new NotLooseShape("loose-format input is an empty object");
  }
  // Normalize loose names → canonical paths (throws UnknownTokenName on
  // ambiguity, per the v0.11.0 normalizer's failure surface).
  const normalized = normalizeTokens(obj);
  // Apply to an empty document so the result is a complete tokens tree.
  const written = applyDtcgWrites({}, normalized.set, normalized.types);
  return validateThemeTokens(written);
}

function hasNestedDollarValue(node: unknown): boolean {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "$value") return true;
    if (typeof v === "object" && v !== null && hasNestedDollarValue(v)) return true;
  }
  return false;
}

function hasNestedPlainValue(node: unknown): boolean {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const obj = node as Record<string, unknown>;
  // A "Style Dictionary leaf" looks like `{value: <primitive>, ...}` —
  // not a top-level flat key whose value is a primitive.
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      if ("value" in inner && typeof inner.value !== "object") return true;
      if (hasNestedPlainValue(v)) return true;
    }
  }
  return false;
}
