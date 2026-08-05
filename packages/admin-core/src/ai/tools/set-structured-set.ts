// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: set_structured_set. The ONLY tool that writes structured-data
 * sets — handles every kind (nav-menu, tags, taxonomy, theme, link-list,
 * link-list). Upsert: creates the set if `(kind, slug)` doesn't
 * exist yet, replaces the items list if it does. No separate `create`
 * step.
 *
 * Per-kind item validation runs inside `structured_sets.set`'s handler
 * (via `validateStructuredSetItems(kind, items)` from @caelo-cms/shared)
 * and again at the tool boundary via the Zod schema referenced in the
 * `schema:` field below. v0.10.22 originally tried to mirror that Zod
 * into a discriminator-by-kind JSON Schema (`allOf: [{ if, then }, …]`)
 * inline here too, but Anthropic's Messages API rejects `allOf` /
 * `oneOf` / `anyOf` at the top level of a tool's input_schema — caught
 * by the issue #47 real-AI e2e suite, which surfaced
 * `tools.N.custom.input_schema: input_schema does not support oneOf,
 * allOf, or anyOf at the top level`. Reverted to keeping the JSON
 * Schema flat (`items: { type: "array" }`) and letting Zod handle the
 * per-kind shape.
 *
 * Pre-v0.10.22 there were also kind-specific wrappers (`set_nav_menu`,
 * `update_theme`) that lived next to this tool. They were removed in
 * favor of the single unified surface — the AI uses `kind` as a
 * discriminator argument and Zod enforces the right item shape.
 */

import { execute } from "@caelo-cms/query-api";
import { setStructuredSetToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setStructuredSetTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetStructuredSetToolInput
> = {
  name: "set_structured_set",
  description:
    "Upsert a structured-data set. Creates the set if `(kind, slug)` doesn't exist yet; REPLACES the items array if it does (NOT append — pass the full desired list). " +
    "Kinds: nav-menu, tags, taxonomy, link-list. The per-item shape is enforced by Zod at the tool boundary; a mismatch is rejected with a structured error naming the offending field. " +
    "Read before you write: sets are NOT inlined in the system prompt — call `get_structured_set({kind, slug})` first and modify its items. " +
    "Visibility: writing a set does NOT by itself change the site. The only built-in binding renders a set through a module whose slug is exactly `nav-menu-<set-slug>` placed directly in a layout/page block — that module's own HTML is replaced by the built-in renderer (`children` render as nested submenus). No AI tool can mint such a slug today (admin UI only — issue #414); if no bound module exists, render nav in the chrome module via a `link-list` field instead. Other kinds render only where module HTML/JS consumes them. " +
    "Common slugs: nav-menu/header-main, nav-menu/footer-main, tags/blog. " +
    "Theme tokens are NOT structured sets anymore (v0.11.0) — use `set_theme_tokens` for theme edits and `propose_create_theme` to mint a new theme.",
  schema: setStructuredSetToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "slug", "displayName", "items"],
    properties: {
      kind: {
        enum: ["nav-menu", "tags", "taxonomy", "link-list"],
      },
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      items: { type: "array" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.set", input);
    if (!r.ok)
      return { ok: false, content: `structured_sets.set failed: ${describeError(r.error)}` };
    // issue #414 — state HOW (and whether) the write becomes visible.
    // Writing a set alone changes no page, and the slug-binding
    // convention is not otherwise discoverable mid-task, so an
    // unqualified "updated" reads as "the site changed" when it may not
    // have.
    const bindingSlug = `${input.kind}-${input.slug}`;
    const visibility =
      input.kind === "nav-menu"
        ? ` Rendering: this set shows on the site ONLY through a module whose slug is exactly \`${bindingSlug}\`, placed directly in a layout/page block (the built-in renderer replaces that module's stored HTML; \`children\` render as nested submenus). No AI tool can mint that slug today (admin UI only — issue #414). Check list_modules: if no \`${bindingSlug}\` module exists, the data is saved but NOT visible — render the nav in the chrome module via a \`link-list\` field instead.`
        : " Rendering: saved, but nothing renders it automatically — this kind shows only where a module's HTML/JS consumes it.";
    return {
      ok: true,
      content: `${input.kind}/${input.slug} updated with ${input.items.length} item${input.items.length === 1 ? "" : "s"}.${visibility}`,
    };
  },
};
