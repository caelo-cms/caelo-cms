// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_structured_set. The ONLY tool that writes structured-data
 * sets — handles every kind (nav-menu, tags, taxonomy, theme, link-list,
 * language-selector). Upsert: creates the set if `(kind, slug)` doesn't
 * exist yet, replaces the items list if it does. No separate `create`
 * step.
 *
 * Per-kind Zod validation runs inside `structured_sets.set`'s handler
 * (via `validateStructuredSetItems(kind, items)` from @caelo-cms/shared).
 * v0.10.22 adds the matching JSON Schema HERE so the AI's tool-call
 * validator catches per-kind shape mismatches at generation time, not
 * post-hoc Zod. The schema branches by `kind` via JSON-Schema `allOf`
 * + `if/then` — modern Claude tool-use validators handle this pattern.
 *
 * Pre-v0.10.22 there were also kind-specific wrappers (`set_nav_menu`,
 * `update_theme`) that lived next to this tool. They were removed in
 * favor of the single unified surface — the AI uses `kind` as a
 * discriminator argument and the JSON Schema enforces the right shape.
 */

import { execute } from "@caelo-cms/query-api";
import { setStructuredSetToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

// JSON-Schema fragments per kind. These mirror the Zod schemas in
// @caelo-cms/shared/structured-sets.ts. Kept inline rather than
// imported because zod-to-json-schema would re-emit them on every
// process boot and lose the readability of an explicit table.
const navMenuItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "href"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 120 },
    href: { type: "string", minLength: 1, maxLength: 500 },
    target: { enum: ["_self", "_blank"] },
    // children is recursive in Zod (z.lazy); we flatten to one level in
    // the JSON Schema for readability. Three-level menus would fail
    // here but the Zod validator catches them at runtime — the cost is
    // a slightly less helpful error in the rare 3-level case.
    children: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "href"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 120 },
          href: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    adSlotId: { type: "string", minLength: 1, maxLength: 100 },
  },
} as const;

const taxonomyItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "displayName"],
  properties: {
    slug: { type: "string", minLength: 1, maxLength: 120 },
    displayName: { type: "string", minLength: 1, maxLength: 200 },
    parentSlug: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const themeTokenJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["token", "value"],
  properties: {
    // Matches the Zod regex /^[a-z][a-z0-9-]*$/ — lowercase kebab-case.
    token: { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z][a-z0-9-]*$" },
    value: { type: "string", minLength: 1, maxLength: 500 },
    scope: { enum: ["color", "font", "space", "radius", "shadow"] },
  },
} as const;

const tagItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["slug", "displayName"],
  properties: {
    slug: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z0-9-]+$" },
    displayName: { type: "string", minLength: 1, maxLength: 200 },
    color: { type: "string", pattern: "^#[0-9a-fA-F]{3,8}$" },
  },
} as const;

const linkListItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label", "href"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 200 },
    href: { type: "string", minLength: 1, maxLength: 500 },
    description: { type: "string", maxLength: 500 },
  },
} as const;

const languageSelectorItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["locale"],
  properties: {
    locale: { type: "string", minLength: 2, maxLength: 10 },
    label: { type: "string", minLength: 1, maxLength: 120 },
    hidden: { type: "boolean" },
  },
} as const;

export const setStructuredSetTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetStructuredSetToolInput
> = {
  name: "set_structured_set",
  description:
    "Upsert a structured-data set. Creates the set if `(kind, slug)` doesn't exist yet; REPLACES the items array if it does (NOT append — pass the full desired list). " +
    "Kinds: nav-menu, tags, taxonomy, theme, link-list, language-selector. The per-item shape is enforced by the JSON Schema below — a mismatch is rejected at the tool boundary with a structured error. " +
    "Current sets + their items (for nav-menus, up to 30 items) are inlined in the '# Structured-data sets you can edit' system-prompt block above; copy them and modify, don't re-invent. If a set isn't inlined (cap exceeded or different kind), call `get_structured_set({kind, slug})` first. " +
    "Common slugs: nav-menu/header-main, nav-menu/footer-main, theme/site, tags/blog.",
  schema: setStructuredSetToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "slug", "displayName", "items"],
    properties: {
      kind: {
        enum: ["nav-menu", "tags", "taxonomy", "theme", "link-list", "language-selector"],
      },
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      items: { type: "array" },
    },
    // biome-ignore-start lint/suspicious/noThenProperty: JSON-Schema `if/then`
    //   is the standard discriminator pattern — this is data, not a thenable.
    allOf: [
      {
        if: { properties: { kind: { const: "nav-menu" } }, required: ["kind"] },
        then: { properties: { items: { type: "array", items: navMenuItemJsonSchema } } },
      },
      {
        if: { properties: { kind: { const: "taxonomy" } }, required: ["kind"] },
        then: { properties: { items: { type: "array", items: taxonomyItemJsonSchema } } },
      },
      {
        if: { properties: { kind: { const: "theme" } }, required: ["kind"] },
        then: { properties: { items: { type: "array", items: themeTokenJsonSchema } } },
      },
      {
        if: { properties: { kind: { const: "tags" } }, required: ["kind"] },
        then: { properties: { items: { type: "array", items: tagItemJsonSchema } } },
      },
      {
        if: { properties: { kind: { const: "link-list" } }, required: ["kind"] },
        then: { properties: { items: { type: "array", items: linkListItemJsonSchema } } },
      },
      {
        if: { properties: { kind: { const: "language-selector" } }, required: ["kind"] },
        then: { properties: { items: { type: "array", items: languageSelectorItemJsonSchema } } },
      },
    ],
    // biome-ignore-end lint/suspicious/noThenProperty: see above.
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.set", input);
    if (!r.ok)
      return { ok: false, content: `structured_sets.set failed: ${describeError(r.error)}` };
    return {
      ok: true,
      content: `${input.kind}/${input.slug} updated with ${input.items.length} item${input.items.length === 1 ? "" : "s"}`,
    };
  },
};
