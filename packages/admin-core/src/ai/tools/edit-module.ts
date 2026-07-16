// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: edit_module. Writes one module's HTML/CSS/JS, displayName, or
 * field schema. Modules are the *structural* layer (CMS_REQUIREMENTS §3.1)
 * — edits land on main immediately and propagate to every page using the
 * module.
 *
 * v0.4.0 — module HTML is a TEMPLATE referencing fields as `{{name}}`.
 * The per-page content that fills those placeholders lives on each page
 * placement (see `set_page_module_content`). Use `edit_module` for code /
 * styling / field-schema changes that should affect every page using the
 * module. Use `set_page_module_content` to change what a specific page
 * shows in those fields.
 */

import { execute } from "@caelo-cms/query-api";
import { editModuleToolInput } from "@caelo-cms/shared";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { designGuardSuffix } from "./_design-guard.js";
import { MODULE_FIELDS_JSON_SCHEMA } from "./_module-fields-schema.js";
import { MODULE_JS_CONTRACT } from "./_module-js-contract.js";
import { bindCssToTheme } from "./_theme-binding.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const editModuleTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").EditModuleToolInput
> = {
  name: "edit_module",
  description:
    "Edit ONE module's structure: HTML template, fields, CSS, JS, displayName, description, or kind. " +
    "**AUTHOR EXPLICITLY (v0.12.0+):** pass `html` with `{{fieldName}}` placeholders + an explicit `fields[]` array with semantic snake_case names (`hero_title`, `primary_cta_href`, `nav_items`), NOT a literal-content fallback. The operator says 'fix the homepage hero copy'; YOU translate that to the right field names. Field names like `cta2label2` or `spanText` are wrong — they leak the extractor heuristic. " +
    "**Field kinds (v0.12.0):** `text`, `richtext`, `url`, `image`, `number`, `boolean`, `link` (primitives); `text-list` (array of strings, slot `{{#field}}…{{.}}…{{/field}}`); `link-list` (array of `{label, href}`, slot `{{#field}}…{{label}}…{{href}}…{{/field}}` — use for menus, footer columns); `module` (single nested module, slot `{{>field}}`); `module-list` (array of nested modules, slot `{{#field}}…{{/field}}`). " +
    '**Nested fields may declare `allowedModuleTypes`** — a whitelist of stable module `type`s (e.g. `["button"]`), NOT slugs. It matches the referenced module\'s `type`; set it to constrain what can nest in a `module`/`module-list` slot, and widen it here if a valid module is being wrongly rejected. ' +
    "**Lists are lists, not numbered scalars.** A menu with 10 items is ONE `link-list` field with 10 elements — never `label1`, `label2`, …, `label10`. A tag cloud is ONE `text-list`. Cards with rich per-item structure use `module-list` pointing at a sub-module. " +
    "**Update description + kind when the module's purpose drifts.** The `## Modules` block exposes them to your future self; stale descriptions hurt your own decision-making. " +
    "**Legacy fallback only:** if you pass HTML with literal content and NO `fields[]`, a server-side extractor mints heuristic field names — useful for one-shot drafts but the result hurts the `## Modules` block. Treat it as a fallback, not the default path. " +
    "**Scope module CSS under the module's own root class** - bare global selectors (`body`, `h1`, `.card`) bleed into every other module on the page (issue #158). " +
    "**Module JS shares ONE page-level script** - no implicit `root`/`el` binding exists; wrap in an IIFE and query via document.querySelectorAll scoped to your module's root class (see the `js` input description). " +
    "Edits are CHAT-BRANCHED until publish. " +
    "Use this for structure, styling, fields list, or `description`/`kind` updates. " +
    "DO NOT use this to change what one page shows — use `set_page_module_content` (per-page content) or `set_content_instance_values` (shared content) for that. " +
    "Prefer `update_modules_many` when targeting > 1 module. " +
    "DO NOT use for page metadata (`update_pages_many`) or template-level edits (`propose_update_template`).",
  schema: editModuleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["moduleId"],
    properties: {
      moduleId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      description: { type: "string", maxLength: 1000 },
      kind: {
        type: "string",
        enum: ["chrome", "hero", "content", "cta", "utility"],
      },
      // v0.12.3 (issue #106) — stable type (reusable class). Set to make
      // this module satisfy a parent's allowedModuleTypes whitelist.
      // Pattern mirrors the Zod `slugSchema` the Validator enforces so the
      // provider can't emit a `type` the Validator then rejects.
      // slugSchema = ^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$.
      type: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
      },
      html: { type: "string" },
      css: { type: "string" },
      js: { type: "string", description: MODULE_JS_CONTRACT },
      // issue #106 — shared field schema (single source of truth across all
      // module-authoring tools). See `_module-fields-schema.ts`.
      fields: MODULE_FIELDS_JSON_SCHEMA,
      bindThemeLiterals: { type: "boolean" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // issue #164 slice 2 — opt-in mechanical token binding before write.
    let bindingReport = "";
    let opInput: Record<string, unknown> = { ...input };
    delete opInput.bindThemeLiterals;
    if (input.bindThemeLiterals === true && typeof input.css === "string") {
      const bound = await bindCssToTheme(ctx, toolCtx, input.css);
      opInput = { ...opInput, css: bound.css };
      bindingReport = bound.report;
    }
    const result = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.update", opInput);
    if (result.ok) {
      // issue #156 — scan freshly-written CSS against the active theme's
      // emitted vars; unknown names ride the result so the AI fixes
      // drift in the same turn.
      const effectiveCss = (opInput.css as string | undefined) ?? input.css;
      const cssWarn = await cssVarWarningSuffix(ctx, toolCtx, effectiveCss);
      // issue #166 — static consistency findings against the Design Manifest
      // (checked on the css as written, i.e. post-binding).
      const guard = await designGuardSuffix(ctx, toolCtx, { css: effectiveCss });
      // v0.12.2 — surface the extractor's inferred fields when present
      // so the AI's next turn sees the auto-minted names verbatim.
      const value = result.value as {
        extractedFields?: { name: string; kind: string }[];
      };
      const extracted = value.extractedFields ?? [];
      if (extracted.length > 0) {
        const list = extracted.map((f) => `${f.name} (${f.kind})`).join(", ");
        return {
          ok: true,
          // v0.12.0 — AI-visible deprecation hint per CLAUDE.md §1A.
          // The extractor fired because the caller didn't supply
          // `fields[]`. Heuristic names like `spanText` or `cta2label2`
          // pollute the `## Modules` block — the AI's future self
          // will struggle to pick the right module if the catalog is
          // full of garbage. Tell the AI to author next time.
          content: `⚠️ Extractor fallback used — module ${input.moduleId} updated with heuristic field names: ${list}. **Next time, author HTML + fields together** with semantic snake_case names (e.g. \`hero_title\`, \`primary_cta_href\`) so the \`## Modules\` block stays useful. Rename via a follow-up edit_module with explicit \`fields\` if these names are confusing.${cssWarn}`,
        };
      }
      return {
        ok: true,
        content: `module ${input.moduleId} updated${bindingReport}${cssWarn}${guard}`,
      };
    }
    const message = (result.error as { message?: string }).message ?? "unknown error";
    return { ok: false, content: message };
  },
};
