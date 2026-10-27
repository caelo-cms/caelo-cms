// SPDX-License-Identifier: MPL-2.0

/**
 * The list types every install starts with (epic #1107,
 * `docs/lists.md` §3). They are seeded as STORED data by migration 0352
 * and edited like any other type afterwards — these objects are the
 * source the seed and the tests share, not a render-time fallback
 * (CLAUDE.md §2).
 */

import type { ListTypeDef } from "./list-type.js";

export const DEFAULT_LIST_TYPES: readonly ListTypeDef[] = [
  {
    slug: "texts",
    name: "Texts",
    purpose: "A flat list of short texts inside one module: feature bullets, chips, steps.",
    role: "content",
    root: { allow: ["text"] },
    nodes: {
      text: {
        label: "Text",
        fields: [{ name: "text", label: "Text", type: "text", required: true }],
      },
    },
  },
  {
    slug: "links",
    name: "Links",
    purpose: "A flat group of links: legal links, social links, a footer column.",
    role: "content",
    root: { allow: ["link"] },
    nodes: {
      link: {
        label: "Link",
        fields: [
          { name: "label", label: "Label", type: "text", required: true },
          { name: "link", label: "Link", type: "link", required: true },
        ],
        current_from: "link",
      },
    },
  },
  {
    slug: "menu",
    name: "Menu",
    purpose:
      "Site navigation with up to three levels: header menu, footer menu, mobile menu. Use a custom type for mega menus with columns or teasers.",
    role: "navigation",
    root: { allow: ["entry"] },
    nodes: {
      entry: {
        label: "Menu entry",
        fields: [
          { name: "label", label: "Label", type: "text", required: true },
          { name: "link", label: "Link", type: "link" },
        ],
        children: { name: "children", allow: ["entry"] },
        current_from: "link",
      },
    },
    max_depth: 3,
  },
  {
    slug: "categories",
    name: "Categories",
    purpose: "A category tree pages are assigned to: blog sections, product groups, doc areas.",
    role: "vocabulary",
    root: { allow: ["category"] },
    nodes: {
      category: {
        label: "Category",
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          { name: "slug", label: "Slug", type: "text", required: true },
          { name: "description", label: "Description", type: "richtext" },
          { name: "landing_page", label: "Landing page", type: "link" },
        ],
        children: { name: "children", allow: ["category"] },
        current_from: "landing_page",
      },
    },
    max_depth: 6,
  },
  {
    slug: "tags",
    name: "Tags",
    purpose: "Flat keywords pages are tagged with, for filters, tag clouds and related content.",
    role: "vocabulary",
    root: { allow: ["tag"] },
    nodes: {
      tag: {
        label: "Tag",
        fields: [
          { name: "name", label: "Name", type: "text", required: true },
          { name: "slug", label: "Slug", type: "text", required: true },
          { name: "color", label: "Color", type: "text", maxLength: 9 },
        ],
      },
    },
  },
];

/** Slug of the list type whose entries are the site texts (`{{site_text.<key>}}`, #1142). */
export const SITE_TEXTS_LIST_TYPE = "site-texts";

/**
 * The site texts type: fixed interface strings of the website that are no
 * page content ("Start" in a trail, the breadcrumb `aria-label`, "Read
 * more"). Module HTML reads one by key with `{{site_text.<key>}}`, so the
 * string is translatable (shared-list overlays) instead of frozen into
 * the module. Seeded by migration 0358 together with the "Site texts"
 * list; installs that ran 0352 never had it, so it is not part of
 * {@link DEFAULT_LIST_TYPES} (whose seed is pinned to 0352).
 */
export const SITE_TEXTS_TYPE: ListTypeDef = {
  slug: SITE_TEXTS_LIST_TYPE,
  name: "Site texts",
  purpose:
    "Fixed interface texts of the website, read by key in module HTML with {{site_text.<key>}}: the breadcrumb aria-label, button and link texts that repeat across modules. Not page content.",
  role: "content",
  root: { allow: ["text"] },
  nodes: {
    text: {
      label: "Site text",
      fields: [
        // The lookup key is code, not copy: a translated key would stop
        // `{{site_text.<key>}}` from finding the entry in that language.
        {
          name: "key",
          label: "Key",
          type: "text",
          required: true,
          maxLength: 64,
          ext: { "international-site": { translate: false } },
        },
        { name: "text", label: "Text", type: "text", required: true },
      ],
    },
  },
};
