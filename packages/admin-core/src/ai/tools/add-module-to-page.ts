// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: add_module_to_page. Creates a new module and inserts it into
 * a target page's block at a chosen position ("top" | "bottom" | index).
 * The handler chains three Query API ops:
 *
 *   1. modules.create — make the module (the Zod validator and snapshot
 *      emission run here exactly as they do for human module creation).
 *   2. pages.get_with_modules — read the existing layout.
 *   3. pages.set_modules — splice the new moduleId into the requested
 *      block at the requested position.
 *
 * Each op fires its own audit + snapshot row; the tool result reports
 * the new moduleId so the AI can refer to it in follow-up turns.
 */

import { execute } from "@caelo-cms/query-api";
import { addModuleToPageToolInput, slugifyModuleName } from "@caelo-cms/shared";
import { blockNotFoundError, withBlockNameEnum } from "./_block-name-enum.js";
import { checkColdStartGate } from "./_cold-start-gate.js";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import { MODULE_JS_CONTRACT } from "./_module-js-contract.js";
import { bindCssToTheme } from "./_theme-binding.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  templateId: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

/**
 * Static JSON Schema for the provider. `describeSchema` (below) clones
 * this per-turn and pins `blockName` to an enum of the focused page's
 * real blocks when one is in context.
 */
const ADD_MODULE_TO_PAGE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  // issue #159 — displayName/html moved out of `required`: place-existing
  // mode passes `moduleId` instead. The Zod superRefine enforces the
  // either-or; JSON Schema stays permissive so the provider doesn't
  // reject the place-mode shape before our boundary sees it.
  required: ["pageId", "blockName", "position"],
  properties: {
    pageId: { type: "string", format: "uuid" },
    blockName: { type: "string", minLength: 1, maxLength: 80 },
    position: {
      oneOf: [
        { type: "string", enum: ["top", "bottom"] },
        { type: "integer", minimum: 0, maximum: 1000 },
      ],
    },
    moduleId: { type: "string", format: "uuid" },
    displayName: { type: "string", minLength: 1, maxLength: 128 },
    // issue #106 — shared decision-support metadata (description/kind/type).
    // Spread from the single source of truth so the three module-authoring
    // tools can never drift apart again. See `_module-fields-schema.ts`.
    ...MODULE_META_JSON_SCHEMA_PROPS,
    html: { type: "string", minLength: 1, maxLength: 50_000 },
    css: { type: "string", maxLength: 50_000 },
    js: { type: "string", maxLength: 50_000, description: MODULE_JS_CONTRACT },
    bindThemeLiterals: { type: "boolean" },
    // issue #106 — shared field schema (single source of truth across all
    // module-authoring tools). See `_module-fields-schema.ts`.
    fields: MODULE_FIELDS_JSON_SCHEMA,
  },
};

export const addModuleToPageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").AddModuleToPageToolInput
> = {
  name: "add_module_to_page",
  description:
    "Add a module to ONE page's block — two modes. **Place mode (reuse first):** pass `moduleId` of an existing module from `## Modules` (or `list_modules`) to place it without minting a duplicate; shared modules keep pages consistent, so ALWAYS check the catalog before minting. **Mint mode:** pass `displayName` + `html` (+ `fields`) to create a new module and place it in one call. Exactly one mode per call — `moduleId` and authoring fields are mutually exclusive. " +
    "**Required v0.12.0 inputs for new modules:** `description` (what this module is for + when to use it — surfaced in `## Modules` so YOUR future self can pick the right module without asking the operator), `kind` (one of `chrome`|`hero`|`content`|`cta`|`utility`), `html` with `{{fieldName}}` placeholders, and explicit `fields[]` with semantic snake_case names. " +
    "**Author HTML + fields together.** Field names must describe the value (`hero_title`, `primary_cta_href`, `nav_items`), never the tag (`spanText`, `cta2label`). Lists are list-shaped fields (`text-list` for tag chips, `link-list` for nav menus, `module-list` for cards) — never numbered scalars. " +
    "**Server-side extractor fallback** still exists when you pass HTML without fields, but the names it mints are heuristic — relying on it pollutes `## Modules` with garbage. Author explicitly. " +
    "Use when the operator describes adding new content (a button, a banner, a menu, a section). For site-wide chrome use add_module_to_layout; for template-wide use add_module_to_template. " +
    'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). ' +
    'Prefer a bare integer (`0`, not `"0"`) — quoted/over-quoted forms are normalized at the boundary, not rejected.',
  // v0.6.0 W1 — state-aware: this tool takes a pageId (not pageSlug), and
  // the per-page block set depends on the template the page is bound to.
  // v0.12.3 (issue #106) — `blockName` is constrained at GENERATION time
  // by `describeSchema` (enum of the focused page's real blocks), so we no
  // longer tell the AI to "guess"; we tell it to read the authoritative
  // block list in the `# Current page` block.
  describe: (state) => {
    const lines: string[] = [
      "Add a module to ONE page's block: pass `moduleId` to place an EXISTING module from `## Modules` (reuse first — keeps pages consistent), or `displayName` + `html` to mint a new one. For site-wide chrome use add_module_to_layout, for template-wide use add_module_to_template.",
    ];
    if (state.templates.length === 0) {
      lines.push(
        "NO templates exist on this site yet — every page would also be missing. Bootstrap first via create_layout + create_template + create_page.",
      );
    } else if (state.activePage && state.activePage.blockNames.length > 0) {
      lines.push(
        `Pass \`pageId\` (UUID, see \`## Pages\`). \`blockName\` MUST be one of this page's template blocks: ${state.activePage.blockNames
          .map((b) => `\`${b}\``)
          .join(
            ", ",
          )}. A block name is a slot on the template — NOT a module \`kind\` (chrome/hero/content/cta/utility). A "hero" module usually goes into the \`content\` block.`,
      );
    } else {
      lines.push(
        "Pass `pageId` (UUID, see `## Pages` for the list). `blockName` must be one of the page's template block names listed in the `# Current page` block — not a module `kind`.",
      );
    }
    lines.push(
      'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer. Prefer a bare integer; quoted forms are normalized at the boundary, not rejected.',
    );
    return lines.join(" ");
  },
  schema: addModuleToPageToolInput,
  inputSchema: ADD_MODULE_TO_PAGE_INPUT_SCHEMA,
  describeSchema: (state) => withBlockNameEnum(ADD_MODULE_TO_PAGE_INPUT_SCHEMA, state, "blockName"),
  handler: async (ctx, input, toolCtx) => {
    // v0.11.4 (issue #76 follow-up) — cold-start gate.
    const gate = await checkColdStartGate(ctx, toolCtx, "add_module_to_page");
    if (gate.blocked) return gate.gateResult!;

    // issue #159 — place-existing mode: resolve the module (branch-aware
    // read, so a just-minted branched module is placeable immediately)
    // instead of creating one. The Zod superRefine keeps the two modes
    // mutually exclusive at the dispatch boundary.
    let newModuleId: string;
    let slug: string;
    let placedExisting = false;
    let extractedFields: { name: string; kind: string }[] | undefined;
    let bindingReport = "";
    let boundCss = "";
    if (input.moduleId !== undefined) {
      const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.get", {
        moduleId: input.moduleId,
      });
      if (!got.ok) {
        return {
          ok: false,
          content:
            `modules.get failed: ${describeError(got.error)}. ` +
            "The moduleId must come from `## Modules` or `list_modules` — to mint a new module instead, omit moduleId and pass displayName + html.",
        };
      }
      const mod = (got.value as { module: { id: string; slug: string } }).module;
      newModuleId = mod.id;
      slug = mod.slug;
      placedExisting = true;
    } else {
      const { displayName, html } = input;
      // The Zod superRefine enforces this at the dispatch boundary; the
      // check re-narrows for direct handler calls (tests, future reuse).
      if (displayName === undefined || html === undefined) {
        return {
          ok: false,
          content:
            "Pass either `moduleId` (place an existing module) or `displayName` + `html` (mint a new one).",
        };
      }
      slug = slugifyModuleName(displayName);
      // issue #164 slice 2 — opt-in mechanical token binding.
      boundCss = input.css ?? "";
      if (input.bindThemeLiterals === true && boundCss.length > 0) {
        const bound = await bindCssToTheme(ctx, toolCtx, boundCss);
        boundCss = bound.css;
        bindingReport = bound.report;
      }
      const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
        slug,
        displayName,
        // v0.12.0 — plumb the AI-supplied description + kind so the
        // `## Modules` catalog can render decision-support context.
        // Defaults to "" + "content" if the AI omits — see CLAUDE.md §1A
        // for why the AI SHOULD pass them.
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        // v0.12.3 (issue #106) — forward an AI-authored stable type; the op
        // derives it from displayName when omitted.
        ...(input.type !== undefined ? { type: input.type } : {}),
        html,
        css: boundCss,
        js: input.js ?? "",
        ...(input.fields ? { fields: input.fields } : {}),
      });
      if (!created.ok) {
        return {
          ok: false,
          content: `modules.create failed: ${describeError(created.error)}`,
        };
      }
      newModuleId = (created.value as { moduleId: string }).moduleId;
      extractedFields = (created.value as { extractedFields?: { name: string; kind: string }[] })
        .extractedFields;
    }

    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!got.ok) {
      return {
        ok: false,
        content: `pages.get_with_modules failed: ${describeError(got.error)}`,
      };
    }
    const page = (got.value as { page: PageWithModules }).page;
    const targetBlock = page.blocks.find((b) => b.blockName === input.blockName);
    if (!targetBlock) {
      // v0.12.3 (issue #106) — shared AI-actionable error (identical body
      // to move_module) so the two block-name failure paths can't drift.
      // Not autoExecute: the AI must pick a different blockName.
      return blockNotFoundError({
        blockName: input.blockName,
        blockNames: page.blocks.map((b) => b.blockName),
        pageId: input.pageId,
        argName: "blockName",
      });
    }

    const existingIds = targetBlock.modules.map((m) => m.moduleId);
    const insertIdx =
      input.position === "top"
        ? 0
        : input.position === "bottom"
          ? existingIds.length
          : Math.min(input.position, existingIds.length);
    const newBlockIds = [
      ...existingIds.slice(0, insertIdx),
      newModuleId,
      ...existingIds.slice(insertIdx),
    ];

    const blocks = page.blocks.map((b) =>
      b.blockName === input.blockName
        ? { blockName: b.blockName, moduleIds: newBlockIds }
        : { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) },
    );
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!setRes.ok) {
      return {
        ok: false,
        content: `pages.set_modules failed: ${describeError(setRes.error)}`,
      };
    }
    if (placedExisting) {
      return {
        ok: true,
        content: `existing module ${newModuleId} (slug=${slug}) placed in block "${input.blockName}" at position ${insertIdx}. It renders live-referenced — fill per-page values via set_page_module_content; structural edits via edit_module affect every page using it.`,
      };
    }
    // v0.12.0 — surface the extractor's inferred fields when the AI
    // didn't supply `fields[]` so the AI sees the heuristic names
    // it'll need to live with (or rename via edit_module).
    const extracted = extractedFields ?? [];
    const extractedHint =
      extracted.length > 0
        ? ` ⚠️ Extractor fallback used — minted heuristic field names: ${extracted.map((f) => `${f.name} (${f.kind})`).join(", ")}. **Next time, author HTML + fields together** with semantic snake_case names so \`## Modules\` stays useful.`
        : "";
    const missingMetaHint =
      input.description === undefined || input.kind === undefined
        ? ` ⚠️ Missing \`description\` / \`kind\` — \`## Modules\` shows this module as "(no description)" which hurts your future self's picks. Patch via edit_module.`
        : "";
    return {
      ok: true,
      content: `module ${newModuleId} (slug=${slug}) added to block "${input.blockName}" at position ${insertIdx}.${bindingReport}${extractedHint}${missingMetaHint}${await cssVarWarningSuffix(ctx, toolCtx, boundCss)}${await designGuardSuffix(ctx, toolCtx, { css: boundCss, displayName: input.displayName, kind: input.kind, type: input.type })}`,
    };
  },
};
