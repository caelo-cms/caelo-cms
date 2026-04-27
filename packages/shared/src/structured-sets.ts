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

/** One CSS variable. Renderer emits `<style>:root{--<token>: <value>;…}</style>`. */
export const themeToken = z
  .object({
    token: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9-]*$/, "lowercase kebab-case"),
    value: z.string().min(1).max(500),
    scope: z.enum(["color", "font", "space", "radius", "shadow"]).optional(),
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

/** Discriminated kind → items array. The Query API op picks the
 *  validator at runtime by reading `kind` first. */
export const structuredSetKind = z.enum(["nav-menu", "taxonomy", "theme", "tags", "link-list"]);
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
    case "theme":
      return items.map((it) => themeToken.parse(it));
    case "tags":
      return items.map((it) => tagItem.parse(it));
    case "link-list":
      return items.map((it) => linkListItem.parse(it));
  }
}

export type NavMenuItem = z.infer<typeof navMenuItem>;
export type TaxonomyItem = z.infer<typeof taxonomyItem>;
export type ThemeToken = z.infer<typeof themeToken>;
export type TagItem = z.infer<typeof tagItem>;
export type LinkListItem = z.infer<typeof linkListItem>;
