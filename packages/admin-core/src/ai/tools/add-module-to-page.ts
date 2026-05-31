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
import { MODULE_FIELDS_JSON_SCHEMA } from "./_module-fields-schema.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  templateId: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as { kind?: string; message?: string; issues?: unknown[]; detail?: string };
  if (e.kind === "ValidationFailed" && Array.isArray(e.issues)) {
    return `validation: ${e.issues
      .slice(0, 3)
      .map((i) => {
        const z = i as { path?: unknown[]; message?: string };
        return `${(z.path ?? []).join(".")}: ${z.message ?? "?"}`;
      })
      .join("; ")}`;
  }
  if (typeof e.message === "string") return e.message;
  if (typeof e.detail === "string") return e.detail;
  return e.kind ?? "unknown";
}

/**
 * Static JSON Schema for the provider. `describeSchema` (below) clones
 * this per-turn and pins `blockName` to an enum of the focused page's
 * real blocks when one is in context.
 */
const ADD_MODULE_TO_PAGE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["pageId", "blockName", "position", "displayName", "html"],
  properties: {
    pageId: { type: "string", format: "uuid" },
    blockName: { type: "string", minLength: 1, maxLength: 80 },
    position: {
      oneOf: [
        { type: "string", enum: ["top", "bottom"] },
        { type: "integer", minimum: 0, maximum: 1000 },
      ],
    },
    displayName: { type: "string", minLength: 1, maxLength: 128 },
    description: { type: "string", maxLength: 1000 },
    kind: {
      type: "string",
      enum: ["chrome", "hero", "content", "cta", "utility"],
    },
    // v0.12.3 (issue #106) — stable type (reusable class, e.g. `button`).
    // Derived from displayName when omitted; pass it to mint an instance
    // of an existing class so it satisfies a parent's allowedModuleTypes.
    type: { type: "string", minLength: 1, maxLength: 64 },
    html: { type: "string", minLength: 1, maxLength: 50_000 },
    css: { type: "string", maxLength: 50_000 },
    js: { type: "string", maxLength: 50_000 },
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
    "Mint a NEW module and place it on ONE page's block. **Always check `## Modules` first** — if a module with the right `kind` + `description` already exists, do not re-create it; place the existing one via `pages.set_modules` or use this tool but check the catalog first to avoid duplicates. " +
    "**Required v0.12.0 inputs for new modules:** `description` (what this module is for + when to use it — surfaced in `## Modules` so YOUR future self can pick the right module without asking the operator), `kind` (one of `chrome`|`hero`|`content`|`cta`|`utility`), `html` with `{{fieldName}}` placeholders, and explicit `fields[]` with semantic snake_case names. " +
    "**Author HTML + fields together.** Field names must describe the value (`hero_title`, `primary_cta_href`, `nav_items`), never the tag (`spanText`, `cta2label`). Lists are list-shaped fields (`text-list` for tag chips, `link-list` for nav menus, `module-list` for cards) — never numbered scalars. " +
    "**Server-side extractor fallback** still exists when you pass HTML without fields, but the names it mints are heuristic — relying on it pollutes `## Modules` with garbage. Author explicitly. " +
    "Use when the operator describes adding new content (a button, a banner, a menu, a section). For site-wide chrome use add_module_to_layout; for template-wide use add_module_to_template. " +
    'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). ' +
    'Quoted-string numbers like "0" fail validation — pass `0` not `"0"`.',
  // v0.6.0 W1 — state-aware: this tool takes a pageId (not pageSlug), and
  // the per-page block set depends on the template the page is bound to.
  // v0.12.3 (issue #106) — `blockName` is constrained at GENERATION time
  // by `describeSchema` (enum of the focused page's real blocks), so we no
  // longer tell the AI to "guess"; we tell it to read the authoritative
  // block list in the `# Current page` block.
  describe: (state) => {
    const lines: string[] = [
      "Add a NEW module to ONE page's block. Use for one-off content; for site-wide chrome use add_module_to_layout, for template-wide use add_module_to_template.",
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
      'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer. Quoted-string numbers like "0" fail validation.',
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

    const slug = slugifyModuleName(input.displayName);
    const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
      slug,
      displayName: input.displayName,
      // v0.12.0 — plumb the AI-supplied description + kind so the
      // `## Modules` catalog can render decision-support context.
      // Defaults to "" + "content" if the AI omits — see CLAUDE.md §1A
      // for why the AI SHOULD pass them.
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      // v0.12.3 (issue #106) — forward an AI-authored stable type; the op
      // derives it from displayName when omitted.
      ...(input.type !== undefined ? { type: input.type } : {}),
      html: input.html,
      css: input.css ?? "",
      js: input.js ?? "",
      ...(input.fields ? { fields: input.fields } : {}),
    });
    if (!created.ok) {
      return {
        ok: false,
        content: `modules.create failed: ${describeError(created.error)}`,
      };
    }
    const newModuleId = (created.value as { moduleId: string }).moduleId;

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
    // v0.12.0 — surface the extractor's inferred fields when the AI
    // didn't supply `fields[]` so the AI sees the heuristic names
    // it'll need to live with (or rename via edit_module).
    const createdValue = created.value as { extractedFields?: { name: string; kind: string }[] };
    const extracted = createdValue.extractedFields ?? [];
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
      content: `module ${newModuleId} (slug=${slug}) added to block "${input.blockName}" at position ${insertIdx}.${extractedHint}${missingMetaHint}`,
    };
  },
};
