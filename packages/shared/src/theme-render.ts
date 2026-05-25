// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — DTCG-aligned theme renderer (#45 Phase 3).
 *
 * Walks a `ThemeDocument` (DTCG tokens jsonb) and emits CSS custom
 * properties under the Tailwind 4 namespace convention so module CSS
 * can `var(--color-primary)` / `var(--spacing-lg)` etc. without
 * mental-translation from DTCG paths.
 *
 * Namespace mapping (matches Tailwind 4's `@theme { … }` directive):
 *
 *   color.X             → --color-X
 *   typography.X        → --font-X (fontFamily) + --text-X (fontSize)
 *                         + --font-weight-X + --leading-X + --tracking-X
 *   spacing.X           → --spacing-X
 *   radius.X            → --radius-X
 *   shadow.X            → --shadow-X (expanded to `<x> <y> <blur> [spread] <color> [inset]`)
 *   breakpoint.X        → --breakpoint-X
 *   duration.X          → --duration-X
 *   ease.X              → --ease-X (cubic-bezier expansion)
 *
 * Color tokens carrying `{ light, dark }` emit the light value inside
 * `:root { … }` AND the dark value inside `:root.dark { … }` so a
 * single declaration drives both surfaces.
 *
 * DTCG aliases (`"{group.token}"`) are resolved before emission.
 * Cyclic aliases produce a structured error rather than infinite-
 * looping. Pure function — no IO, dependency-free, testable in unit
 * isolation.
 */

import { type AnyThemeToken, flattenTokens, type ThemeDocument } from "./themes.js";

/** Renderer-level error for cyclic / unresolved aliases. */
export class ThemeRenderError extends Error {
  readonly kind: "cyclic-alias" | "missing-alias";
  readonly path: string;
  constructor(kind: "cyclic-alias" | "missing-alias", path: string, message: string) {
    super(message);
    this.name = "ThemeRenderError";
    this.kind = kind;
    this.path = path;
  }
}

/**
 * Emit the `:root { … }` (+ optional `:root.dark { … }`) CSS for the
 * supplied tokens document. Returns the bare CSS body — caller wraps
 * it in `<style data-source="theme">…</style>` and injects it ahead of
 * module CSS in the document head.
 */
export function renderThemeCss(tokens: ThemeDocument): string {
  const flat = flattenTokens(tokens);
  const resolveCache = new Map<string, unknown>();
  const lightLines: string[] = [];
  const darkLines: string[] = [];

  for (const { path, token } of flat) {
    const category = path.split(".")[0] ?? "";
    const value = resolveTokenValue(token, tokens, resolveCache, new Set([path]));
    emitTokenLines(category, path, value, lightLines, darkLines);
  }

  const lightBlock = `:root{${lightLines.join("")}}`;
  if (darkLines.length === 0) return lightBlock;
  return `${lightBlock}:root.dark{${darkLines.join("")}}`;
}

// ────────────────────────────────────────────────────────────────────
// Alias resolution
// ────────────────────────────────────────────────────────────────────

const ALIAS_REGEX = /^\{([a-zA-Z0-9_.-]+)\}$/;

function resolveTokenValue(
  token: AnyThemeToken,
  doc: ThemeDocument,
  cache: Map<string, unknown>,
  seen: Set<string>,
): unknown {
  return resolveValue(token.$value, doc, cache, seen);
}

function resolveValue(
  raw: unknown,
  doc: ThemeDocument,
  cache: Map<string, unknown>,
  seen: Set<string>,
): unknown {
  if (typeof raw === "string") {
    const m = ALIAS_REGEX.exec(raw);
    if (!m) return raw;
    const targetPath = m[1];
    if (!targetPath) return raw;
    if (seen.has(targetPath)) {
      throw new ThemeRenderError(
        "cyclic-alias",
        targetPath,
        `cyclic DTCG alias detected at '${targetPath}' (chain: ${[...seen].join(" → ")} → ${targetPath})`,
      );
    }
    if (cache.has(targetPath)) return cache.get(targetPath);
    const target = lookupPath(doc, targetPath);
    if (!target) {
      throw new ThemeRenderError(
        "missing-alias",
        targetPath,
        `DTCG alias '{${targetPath}}' points at a path that doesn't exist in this theme`,
      );
    }
    const resolved = resolveValue(target.$value, doc, cache, new Set([...seen, targetPath]));
    cache.set(targetPath, resolved);
    return resolved;
  }
  // Composite ({ light, dark } color, typography sub-fields, shadow sub-fields).
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveValue(v, doc, cache, seen);
    }
    return out;
  }
  return raw;
}

function lookupPath(doc: ThemeDocument, path: string): AnyThemeToken | null {
  const parts = path.split(".");
  let cur: unknown = doc;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return null;
  }
  if (cur && typeof cur === "object" && "$value" in cur) return cur as AnyThemeToken;
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Per-category CSS emission
// ────────────────────────────────────────────────────────────────────

function emitTokenLines(
  category: string,
  path: string,
  value: unknown,
  lightLines: string[],
  darkLines: string[],
): void {
  // Strip the category prefix to get the rest of the path. e.g.
  // `color.brand.primary` → `brand-primary` becomes `--color-brand-primary`.
  const rest = path.slice(category.length + 1).replace(/\./g, "-");
  const baseName = `--${category === "ease" ? "ease" : category}-${rest}`;

  switch (category) {
    case "color":
      emitColor(baseName, value, lightLines, darkLines);
      break;
    case "typography":
      emitTypography(rest, value, lightLines);
      break;
    case "spacing":
    case "radius":
    case "breakpoint":
      emitSimple(baseName, value, lightLines);
      break;
    case "shadow":
      emitShadow(baseName, value, lightLines);
      break;
    case "duration":
      emitSimple(baseName, value, lightLines);
      break;
    case "ease":
      emitEase(baseName, value, lightLines);
      break;
    default:
      // Unknown category — emit as `--<category>-<rest>: <value>` so
      // forward-compat tokens (e.g. future `gradient.X`) still appear
      // in CSS rather than silently disappearing.
      emitSimple(baseName, value, lightLines);
  }
}

function emitColor(
  baseName: string,
  value: unknown,
  lightLines: string[],
  darkLines: string[],
): void {
  if (value && typeof value === "object" && "light" in value && "dark" in value) {
    const both = value as { light: unknown; dark: unknown };
    lightLines.push(`${baseName}:${asString(both.light)};`);
    darkLines.push(`${baseName}:${asString(both.dark)};`);
    return;
  }
  lightLines.push(`${baseName}:${asString(value)};`);
}

function emitTypography(rest: string, value: unknown, out: string[]): void {
  if (typeof value !== "object" || value === null) {
    // Alias resolved to a scalar; emit on --font-<rest>.
    out.push(`--font-${rest}:${asString(value)};`);
    return;
  }
  const v = value as Record<string, unknown>;
  if (v.fontFamily !== undefined) out.push(`--font-${rest}:${asString(v.fontFamily)};`);
  if (v.fontSize !== undefined) out.push(`--text-${rest}:${asString(v.fontSize)};`);
  if (v.fontWeight !== undefined) out.push(`--font-weight-${rest}:${asString(v.fontWeight)};`);
  if (v.lineHeight !== undefined) out.push(`--leading-${rest}:${asString(v.lineHeight)};`);
  if (v.letterSpacing !== undefined) out.push(`--tracking-${rest}:${asString(v.letterSpacing)};`);
}

function emitShadow(baseName: string, value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    // Layered shadow — join with comma so CSS receives multi-layer.
    const layers = value
      .map((layer) => shadowLayerToCss(layer))
      .filter((s): s is string => s !== null);
    if (layers.length > 0) out.push(`${baseName}:${layers.join(",")};`);
    return;
  }
  const single = shadowLayerToCss(value);
  if (single !== null) out.push(`${baseName}:${single};`);
}

function shadowLayerToCss(layer: unknown): string | null {
  if (!layer || typeof layer !== "object") return null;
  const v = layer as Record<string, unknown>;
  const x = asString(v.offsetX ?? "0");
  const y = asString(v.offsetY ?? "0");
  const blur = asString(v.blur ?? "0");
  const spread = v.spread !== undefined ? ` ${asString(v.spread)}` : "";
  const color = asString(v.color ?? "currentColor");
  const inset = v.inset === true ? " inset" : "";
  return `${x} ${y} ${blur}${spread} ${color}${inset}`;
}

function emitEase(baseName: string, value: unknown, out: string[]): void {
  if (Array.isArray(value) && value.length === 4) {
    out.push(`${baseName}:cubic-bezier(${value.map((n) => asString(n)).join(", ")});`);
    return;
  }
  out.push(`${baseName}:${asString(value)};`);
}

function emitSimple(baseName: string, value: unknown, out: string[]): void {
  out.push(`${baseName}:${asString(value)};`);
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
