// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 — design-compiler stage 1: the deterministic INVENTORY.
 *
 * Compiler contract (epic #149): the AI decides, code executes and
 * verifies. This module is the "code" half of the first stage — it
 * parses a Genesis draft (complete single-file HTML) into a fact base
 * of design values (colors with usage contexts, font families, size /
 * spacing / radius histograms, gradients, shadows) plus a section
 * outline. The AI reads the inventory and makes the DECISIONS (which
 * literal becomes which token, what things are called); it never has
 * to re-derive facts by eyeballing raw CSS, and the facts can't be
 * hallucinated.
 *
 * Pure string analysis, linear scans, unambiguous regex classes
 * (ReDoS-aware per issue #113 — drafts are AI-authored but the parser
 * budget must hold on adversarial input too).
 */

/** One distinct color literal with where/how often the draft uses it. */
export interface ColorUsage {
  readonly value: string;
  readonly count: number;
  /** Distinct declaration properties using it (background, color, …). */
  readonly properties: readonly string[];
}

export interface GenesisDraftInventory {
  readonly colors: readonly ColorUsage[];
  readonly gradients: readonly string[];
  readonly fontFamilies: readonly string[];
  readonly fontSizes: readonly string[];
  readonly spacingValues: readonly string[];
  readonly radiusValues: readonly string[];
  readonly shadows: readonly string[];
  /** Ordered structural outline of the body (tag + text snippet). */
  readonly outline: readonly { tag: string; text: string }[];
}

/** Linear extraction of every <style> block's contents. */
export function extractDraftCss(html: string): string {
  const parts: string[] = [];
  const lower = html.toLowerCase();
  let from = 0;
  while (true) {
    const open = lower.indexOf("<style", from);
    if (open === -1) break;
    const openEnd = lower.indexOf(">", open);
    if (openEnd === -1) break;
    const close = lower.indexOf("</style", openEnd);
    if (close === -1) break;
    parts.push(html.slice(openEnd + 1, close));
    from = close + 8;
  }
  return parts.join("\n");
}

const DECLARATION_RE = /([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|(?:oklch|rgba?|hsla?|lab|lch|hwb)\([^()]*\)/g;
const GRADIENT_RE = /(?:repeating-)?(?:linear|radial|conic)-gradient\([^;{}]*\)/gi;
const LENGTH_RE = /-?\d+(?:\.\d+)?(?:rem|em|px|vh|vw|ch|%)\b/g;

const SPACING_PROPS = new Set([
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-block",
  "margin-inline",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-block",
  "padding-inline",
  "gap",
  "row-gap",
  "column-gap",
]);

const GENERIC_FONT_KEYWORDS: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
]);

function pushCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedByCount(map: Map<string, number>): string[] {
  return [...map.entries()].sort((a, z) => z[1] - a[1]).map(([k]) => k);
}

const OUTLINE_TAG_RE = /<(section|header|footer|main|nav|h1|h2|h3)\b[^>]*>/gi;
const TAG_STRIP_RE = /<[^>]*>/g;

/**
 * Build the inventory. Caps guard pathological drafts: the boundary
 * already limits draft size (GENESIS_DRAFT_MAX_HTML_BYTES), and each
 * result list is truncated to what a decision-maker can actually use.
 */
export function inventoryGenesisDraft(html: string): GenesisDraftInventory {
  const css = extractDraftCss(html);

  const colorMeta = new Map<string, { count: number; properties: Set<string> }>();
  const gradients = new Map<string, number>();
  const fontFamilies = new Map<string, number>();
  const fontSizes = new Map<string, number>();
  const spacing = new Map<string, number>();
  const radii = new Map<string, number>();
  const shadows = new Map<string, number>();

  for (const decl of css.matchAll(DECLARATION_RE)) {
    const prop = (decl[1] ?? "").toLowerCase();
    const value = (decl[2] ?? "").trim();

    for (const g of value.matchAll(GRADIENT_RE)) {
      pushCount(gradients, g[0]);
    }
    // Colors inside gradients still count — a gradient stop color is a
    // palette member the token map must name.
    for (const c of value.matchAll(COLOR_LITERAL_RE)) {
      const key = c[0].toLowerCase();
      const meta = colorMeta.get(key) ?? { count: 0, properties: new Set<string>() };
      meta.count += 1;
      meta.properties.add(prop);
      colorMeta.set(key, meta);
    }
    if (prop === "font-family") {
      for (const fam of value.split(",")) {
        const clean = fam.trim().replace(/^["']|["']$/g, "");
        // Generic keywords are fallback-chain noise, not palette
        // members — the token map names real typefaces.
        if (
          clean.length > 0 &&
          clean.length < 80 &&
          !GENERIC_FONT_KEYWORDS.has(clean.toLowerCase())
        ) {
          pushCount(fontFamilies, clean);
        }
      }
    } else if (prop === "font-size") {
      pushCount(fontSizes, value);
    } else if (SPACING_PROPS.has(prop)) {
      for (const len of value.matchAll(LENGTH_RE)) pushCount(spacing, len[0]);
    } else if (prop === "border-radius") {
      pushCount(radii, value);
    } else if (prop === "box-shadow" || prop === "text-shadow") {
      pushCount(shadows, value);
    }
  }

  const outline: { tag: string; text: string }[] = [];
  for (const m of html.matchAll(OUTLINE_TAG_RE)) {
    if (outline.length >= 60) break;
    const tag = (m[1] ?? "").toLowerCase();
    const start = (m.index ?? 0) + m[0].length;
    const text = html
      .slice(start, start + 400)
      .replace(TAG_STRIP_RE, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    outline.push({ tag, text });
  }

  return {
    colors: [...colorMeta.entries()]
      .sort((a, z) => z[1].count - a[1].count)
      .slice(0, 40)
      .map(([value, meta]) => ({
        value,
        count: meta.count,
        properties: [...meta.properties].sort(),
      })),
    gradients: sortedByCount(gradients).slice(0, 12),
    fontFamilies: sortedByCount(fontFamilies).slice(0, 12),
    fontSizes: sortedByCount(fontSizes).slice(0, 24),
    spacingValues: sortedByCount(spacing).slice(0, 24),
    radiusValues: sortedByCount(radii).slice(0, 12),
    shadows: sortedByCount(shadows).slice(0, 12),
    outline,
  };
}

/** Compact, prompt-friendly rendering of the inventory. */
export function formatGenesisInventory(inv: GenesisDraftInventory): string {
  const lines: string[] = [];
  lines.push(
    `Colors (${inv.colors.length}): ${inv.colors
      .map((c) => `${c.value}×${c.count}[${c.properties.join("/")}]`)
      .join(", ")}`,
  );
  if (inv.gradients.length > 0) lines.push(`Gradients: ${inv.gradients.join(" | ")}`);
  lines.push(`Font families: ${inv.fontFamilies.join(", ") || "(none declared)"}`);
  lines.push(`Font sizes: ${inv.fontSizes.join(", ")}`);
  lines.push(`Spacing values: ${inv.spacingValues.join(", ")}`);
  if (inv.radiusValues.length > 0) lines.push(`Radii: ${inv.radiusValues.join(", ")}`);
  if (inv.shadows.length > 0) lines.push(`Shadows: ${inv.shadows.join(" | ")}`);
  lines.push(
    `Outline: ${inv.outline.map((o) => `<${o.tag}>${o.text ? ` ${o.text}` : ""}`).join(" → ")}`,
  );
  return lines.join("\n");
}
