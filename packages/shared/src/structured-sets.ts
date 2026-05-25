// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.5 — typed schemas for the `structured_sets` table.
 *
 * One database table holds N kinds of named lists (nav-menus, taxonomies,
 * theme tokens, tag lists, footer link blocks, ...). The `kind`
 * discriminator drives both the Zod validator at the Query API layer
 * and the renderer that turns the items into HTML at preview / deploy.
 *
 * Adding a new kind: add a Zod schema below, add it to the
 * `structuredSetItem` discriminated union, add a renderer in
 * `packages/shared/src/structured-set-renderer.ts`. No DB migration
 * required — the table already accepts arbitrary `kind` text.
 *
 * Item shapes are deliberately **structured data**, not HTML strings.
 * That's what makes `change_page_slug` able to retarget every menu
 * link automatically: walk the JSON, swap `href` matches.
 */

import { z } from "zod";

/** Recursive nav menu — supports arbitrary submenu nesting. */
export const navMenuItem: z.ZodType<{
  label: string;
  href: string;
  target?: "_self" | "_blank";
  children?: { label: string; href: string }[];
  /** When set, the renderer delegates this slot to the named ad plugin. */
  adSlotId?: string;
}> = z.lazy(() =>
  z
    .object({
      label: z.string().min(1).max(120),
      href: z.string().min(1).max(500),
      target: z.enum(["_self", "_blank"]).optional(),
      children: z.array(navMenuItem).optional(),
      adSlotId: z.string().min(1).max(100).optional(),
    })
    .strict(),
);

/** Tree-shaped category list. Used by typed-content / tag pages (P12A). */
export const taxonomyItem = z
  .object({
    slug: z.string().min(1).max(120),
    displayName: z.string().min(1).max(200),
    parentSlug: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();

/** Flat tag — used by post taxonomies, content filtering. */
export const tagItem = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9-]+$/, "lowercase letters/digits/hyphens"),
    displayName: z.string().min(1).max(200),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{3,8}$/, "hex color")
      .optional(),
  })
  .strict();

/** Footer "legal" / related-resources block. */
export const linkListItem = z
  .object({
    label: z.string().min(1).max(200),
    href: z.string().min(1).max(500),
    description: z.string().max(500).optional(),
  })
  .strict();

/**
 * P9 review-pass — `language-selector` kind. Items are user-supplied
 * overrides (e.g. force a specific display label per locale); empty
 * array means "auto-populate from the locale registry at render time."
 * The renderer (apps/static-generator + preview op) reads the locale
 * registry + the current page's slug + resolveLocaleUrl to emit
 * `<a hreflang lang href>` rows. Closes CMS_REQUIREMENTS §7.8.
 */
export const languageSelectorOverride = z
  .object({
    /** BCP-47 locale code; must match a row in the locales registry. */
    locale: z.string().min(2).max(10),
    /** Override the locale's display_name when rendering this entry. */
    label: z.string().min(1).max(120).optional(),
    /** Hide this locale from the rendered selector even if it has a published page. */
    hidden: z.boolean().optional(),
  })
  .strict();

/** Discriminated kind → items array. The Query API op picks the
 *  validator at runtime by reading `kind` first.
 *
 *  v0.11.0 (#45) — `theme` is no longer a structured-set kind. The
 *  theme primitive moved to its own `themes` table with DTCG-shaped
 *  jsonb tokens; see `themes.ts` + `theme-render.ts`. */
export const structuredSetKind = z.enum([
  "nav-menu",
  "taxonomy",
  "tags",
  "link-list",
  "language-selector",
]);
export type StructuredSetKind = z.infer<typeof structuredSetKind>;

/** Validate `items` against the right schema for `kind`. Throws a
 *  ZodError on mismatch — callers wrap and return `Err(ValidationFailed)`. */
export function validateStructuredSetItems(kind: StructuredSetKind, items: unknown): unknown[] {
  if (!Array.isArray(items)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["items"],
        message: "items must be an array",
      },
    ]);
  }
  switch (kind) {
    case "nav-menu":
      return items.map((it) => navMenuItem.parse(it));
    case "taxonomy":
      return items.map((it) => taxonomyItem.parse(it));
    case "tags":
      return items.map((it) => tagItem.parse(it));
    case "link-list":
      return items.map((it) => linkListItem.parse(it));
    case "language-selector":
      return items.map((it) => languageSelectorOverride.parse(it));
  }
}

export type NavMenuItem = z.infer<typeof navMenuItem>;
export type TaxonomyItem = z.infer<typeof taxonomyItem>;
export type TagItem = z.infer<typeof tagItem>;
export type LinkListItem = z.infer<typeof linkListItem>;
export type LanguageSelectorOverride = z.infer<typeof languageSelectorOverride>;

/**
 * Render a `<nav class="caelo-language-selector">` with one `<a>`
 * per locale that has a published variant of the current page. Pure
 * function — caller threads the page's published-locale list and a
 * URL resolver. Used by `composePagePreview` (admin) and the static
 * generator (deploy) so byte-for-byte output parity holds.
 *
 * Per CMS_REQUIREMENTS §7.8: locales with no published variant for the
 * current page are excluded.
 */
export function renderLanguageSelector(args: {
  /** Each locale that has a published variant of the current page. */
  readonly availableLocales: ReadonlyArray<{
    code: string;
    displayName: string;
    href: string;
    isCurrent: boolean;
  }>;
  /** Owner-supplied overrides (relabel a locale, hide one). */
  readonly overrides?: ReadonlyArray<LanguageSelectorOverride>;
}): string {
  const overrideByLocale = new Map<string, LanguageSelectorOverride>(
    (args.overrides ?? []).map((o) => [o.locale, o]),
  );
  const enc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = args.availableLocales
    .filter((l) => !overrideByLocale.get(l.code)?.hidden)
    .map((l) => {
      const override = overrideByLocale.get(l.code);
      const label = override?.label ?? l.displayName;
      const aria = l.isCurrent ? ' aria-current="true"' : "";
      return `<a hreflang="${enc(l.code)}" lang="${enc(l.code)}" href="${enc(l.href)}"${aria}>${enc(label)}</a>`;
    });
  if (items.length === 0) return "";
  return `<nav class="caelo-language-selector" aria-label="Language">${items.join("")}</nav>`;
}
