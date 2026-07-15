// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: add_module_to_template. Fans one module out to every page
 * using the target template, inserting at the same block + position on
 * each. Used for template-wide content (a per-blog-post sidebar, a
 * product disclaimer, etc.) so the editor doesn't have to add it to each
 * page by hand.
 *
 * Two modes (issue #243), mirroring add_module_to_page:
 *   - **Mint mode** (`displayName` + `html`): create a new module, then
 *     fan it out.
 *   - **Place mode** (`moduleId`): fan out an EXISTING module by id — the
 *     reuse path (CLAUDE.md §1A/§3.2) for sharing one chrome/pattern
 *     module across a page-type template. Before #243 the AI could only
 *     mint here and had to fall back to add_module_to_page to place a
 *     shared module, which silently only worked when the template had
 *     exactly one page.
 *
 * Higher blast radius than add_module_to_page — the "Tool guidance"
 * block in the system prompt steers the AI to prefer the per-page tool
 * unless the user explicitly says "every page" / "site-wide" / "header
 * across the site".
 *
 * Handler chain:
 *   1. Resolve the module — modules.create (mint) OR modules.get (place).
 *   2. pages.list — discover every page bound to the template.
 *   3. For each page (filtered by templateId): pages.get_with_modules
 *      → splice the moduleId into the target block at the requested
 *      position → pages.set_modules.
 *
 * In mint mode, if the template has no pages the module is still created
 * (so a follow-up bind_to_page works) and the tool reports zero
 * placements. In place mode the module already exists, so a template with
 * no pages simply reports zero placements.
 *
 * Per-page failures are collected and surfaced in the tool result; we
 * keep going so a transient failure on one page doesn't strand all the
 * others. Callers can re-run the tool to retry skipped pages.
 */

import { execute } from "@caelo-cms/query-api";
import { addModuleToTemplateToolInput } from "@caelo-cms/shared";
import { checkColdStartGate } from "./_cold-start-gate.js";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import { MODULE_JS_CONTRACT } from "./_module-js-contract.js";
import { mintModuleFromHtml } from "./_mint-module.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageRow {
  id: string;
  slug: string;
  locale: string;
  templateId: string;
}

interface PageWithModules {
  id: string;
  templateId: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

export const addModuleToTemplateTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").AddModuleToTemplateToolInput
> = {
  name: "add_module_to_template",
  description:
    "Add a module to EVERY page that uses the target template, in the same block at the same position — two modes. " +
    "**Place mode (reuse first):** pass `moduleId` of an existing module from `## Modules` (or `list_modules`) to fan " +
    "out a SHARED module across the template's pages without minting a duplicate — the right call to reuse one " +
    "chrome/pattern module across a page-type template (a shared post footer, a product disclaimer). The module renders " +
    "live-referenced, so a later edit_module updates it on every page at once. ALWAYS check the catalog before minting. " +
    "**Mint mode:** pass `displayName` + `html` (+ `fields`, `description`, `kind`) to create a NEW module when none fits, " +
    "then fan it out. Exactly one mode per call — `moduleId` and authoring fields are mutually exclusive. " +
    'Use for template-wide changes ("add a sidebar to every blog post"). ' +
    "For a single-page change, use add_module_to_page. " +
    "For site-wide chrome (header / footer / nav across every page on every template), use add_module_to_layout. " +
    "**MINT-MODE CONTENT: give each field a `default` holding the shared content** — the fan-out mints a fresh (empty) " +
    "content_instance per page, so a field with no default renders a raw `{{field}}` on every page until filled. " +
    "Defaults render everywhere; to vary the content on one page, override that page's placement later with " +
    "set_placement_content. " +
    'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). ' +
    'Prefer a bare integer (`0`, not `"0"`) — quoted/over-quoted forms are normalized at the boundary, not rejected.',
  // v0.6.0 W1 — state-aware: list the available template UUIDs +
  // their slugs so the AI can pick a `templateId` without a separate
  // templates.list round-trip. Block names live on the template's
  // <caelo-slot> tags + the template_blocks rows; the per-page
  // get_with_modules call inside the handler validates them, so we
  // don't need to list block names here (they vary per template, and
  // we don't want to fan out to template_blocks.get for every template
  // every turn).
  describe: (state) => {
    const lines: string[] = [
      "Add a module to EVERY page using the target template (template-wide change): pass `moduleId` to fan out an EXISTING module from `## Modules` (reuse a shared/chrome/pattern module — keeps pages consistent), or `displayName` + `html` to mint a new one.",
      'Use for "add a sidebar to every blog post". For a single page use add_module_to_page; for site-wide chrome use add_module_to_layout.',
    ];
    if (state.templates.length === 0) {
      lines.push(
        "NO templates exist on this site yet — this tool will fail. Bootstrap layouts + templates first.",
      );
    } else {
      lines.push("Available templateId values (use the UUID, NOT the slug):");
      for (const t of state.templates) {
        lines.push(`- ${t.slug} → templateId=${t.id}`);
      }
      lines.push(
        "Block names depend on the template's <caelo-slot> tags; if you guess the wrong blockName the handler returns the available set.",
      );
    }
    lines.push(
      'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer. Prefer a bare integer; quoted forms are normalized at the boundary, not rejected.',
    );
    return lines.join(" ");
  },
  schema: addModuleToTemplateToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    // issue #243 — displayName/html moved out of `required`: place mode
    // passes `moduleId` instead. The Zod superRefine enforces the
    // either-or; JSON Schema stays permissive so the provider doesn't
    // reject the place-mode shape before our boundary sees it (same
    // pattern as add_module_to_page).
    required: ["templateId", "blockName", "position"],
    properties: {
      templateId: { type: "string", format: "uuid" },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      position: {
        oneOf: [
          { type: "string", enum: ["top", "bottom"] },
          { type: "integer", minimum: 0, maximum: 1000 },
        ],
      },
      // issue #243 — place-existing mode: fan out an existing module by id
      // instead of minting. Mutually exclusive with the authoring fields.
      moduleId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      // issue #106 (step-13 round-4) — same description/kind/type metadata as
      // add_module_to_page so the AI's one authoring pattern (CLAUDE.md §1A)
      // is accepted on every module-authoring tool. See `_module-fields-schema.ts`.
      ...MODULE_META_JSON_SCHEMA_PROPS,
      html: { type: "string", minLength: 1, maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      js: { type: "string", maxLength: 50_000, description: MODULE_JS_CONTRACT },
      // issue #106 — shared field schema (full kind enum incl. list +
      // nested-module kinds), so a template-wide nav/list module is
      // representable. See `_module-fields-schema.ts`.
      fields: MODULE_FIELDS_JSON_SCHEMA,
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // v0.11.4 (issue #76 follow-up) — cold-start gate.
    const gate = await checkColdStartGate(ctx, toolCtx, "add_module_to_template");
    if (gate.blocked) return gate.gateResult!;

    // issue #243 — resolve the module: place-existing mode reads an
    // existing module by id (branch-aware read, so a just-minted branched
    // module fans out immediately); mint mode creates one. The Zod
    // superRefine keeps the two modes mutually exclusive at the dispatch
    // boundary; the re-narrowing below covers direct handler calls (tests).
    let newModuleId: string;
    let slug: string;
    const placedExisting = input.moduleId !== undefined;
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
    } else {
      const { displayName, html } = input;
      if (displayName === undefined || html === undefined) {
        return {
          ok: false,
          content:
            "Pass either `moduleId` (fan out an existing module) or `displayName` + `html` (mint a new one).",
        };
      }
      // Mint via the shared moduleize path (raw html → parametrised module +
      // semantic fields, off the main turn). See _mint-module.
      const minted = await mintModuleFromHtml(ctx, toolCtx, {
        html,
        displayNameHint: displayName,
        fieldsHint: input.fields,
        description: input.description,
        kind: input.kind,
        type: input.type,
        css: input.css,
        js: input.js,
      });
      if (!minted.ok) return { ok: false, content: minted.content };
      newModuleId = minted.moduleId;
      slug = minted.slug;
    }

    const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
    if (!listed.ok) {
      return {
        ok: false,
        content: `pages.list failed: ${describeError(listed.error)}`,
      };
    }
    const allPages = (listed.value as { pages: PageRow[] }).pages;
    const targetPages = allPages.filter((p) => p.templateId === input.templateId);

    if (targetPages.length === 0) {
      // v0.6.0 W3 — when no pages use this template, nudge AI toward
      // list_templates so it can confirm the templateId is right (or
      // pick a different one). Not auto-execute since the result here is
      // technically ok=true (module resolved, just unplaced). In place
      // mode nothing was created, so we don't claim it was.
      const created = placedExisting ? "" : " created";
      const suffix = placedExisting
        ? ""
        : `${await cssVarWarningSuffix(ctx, toolCtx, input.css)}${await designGuardSuffix(ctx, toolCtx, { css: input.css, displayName: input.displayName, kind: input.kind, type: input.type })}`;
      return {
        ok: true,
        content: `module ${newModuleId} (slug=${slug})${created}; no pages currently use this template, so nothing was placed${suffix}`,
        nextAction: {
          tool: "list_templates",
          reason:
            "verify templateId points at the intended template; if wrong, add_module_to_page can attach the module to a specific page",
        },
      };
    }

    const placements: { pageId: string; slug: string; position: number }[] = [];
    const failures: { pageId: string; slug: string; reason: string }[] = [];

    for (const page of targetPages) {
      const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
        pageId: page.id,
      });
      if (!got.ok) {
        failures.push({ pageId: page.id, slug: page.slug, reason: describeError(got.error) });
        continue;
      }
      const detail = (got.value as { page: PageWithModules }).page;
      const targetBlock = detail.blocks.find((b) => b.blockName === input.blockName);
      if (!targetBlock) {
        const allowed = detail.blocks.map((b) => b.blockName).join(", ");
        failures.push({
          pageId: page.id,
          slug: page.slug,
          reason: `block "${input.blockName}" not on this page's template — available: ${allowed}`,
        });
        continue;
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
      const blocks = detail.blocks.map((b) =>
        b.blockName === input.blockName
          ? { blockName: b.blockName, moduleIds: newBlockIds }
          : { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) },
      );
      const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
        pageId: page.id,
        blocks,
      });
      if (!setRes.ok) {
        failures.push({
          pageId: page.id,
          slug: page.slug,
          reason: describeError(setRes.error),
        });
        continue;
      }
      placements.push({ pageId: page.id, slug: page.slug, position: insertIdx });
    }

    // issue #243 — CSS/design-guard suffixes only apply to freshly
    // authored CSS; place mode fans out an already-reviewed module, so we
    // skip them (matching add_module_to_page's place path).
    const summarySuffix = placedExisting
      ? ""
      : `${await cssVarWarningSuffix(ctx, toolCtx, input.css)}${await designGuardSuffix(ctx, toolCtx, { css: input.css, displayName: input.displayName, kind: input.kind, type: input.type })}`;
    const summary = [
      `${placedExisting ? "existing module" : "module"} ${newModuleId} (slug=${slug}) added to block "${input.blockName}" on ${placements.length} of ${targetPages.length} pages using this template${summarySuffix}`,
      placements.length > 0
        ? `placed: ${placements.map((p) => `${p.slug}@${p.position}`).join(", ")}`
        : null,
      failures.length > 0
        ? `failed: ${failures.map((f) => `${f.slug} (${f.reason})`).join("; ")}`
        : null,
    ]
      .filter((s): s is string => s !== null)
      .join("\n");

    // v0.6.2 Fix B — chrome-block redirect. When ALL per-page failures
    // are "block X not on this page's template" AND the requested
    // blockName is a well-known layout-level chrome block (header,
    // footer, nav, navigation, sidebar, banner), the operator almost
    // certainly intended `add_module_to_layout` instead. Surface a
    // nextAction with the EXACT corrected call so the AI re-dispatches
    // on the next turn rather than surfacing a "failed" caveat to the
    // user.
    //
    // Not autoExecute — add_module_to_layout is a write op so the AI
    // should see the hint, confirm, and dispatch on its own turn. The
    // hint's `args` carry the same module payload + position the AI
    // intended so it doesn't have to re-compose.
    // issue #243 — mint mode only: the redirect hand-composes an
    // add_module_to_layout mint call from the authoring payload, and that
    // tool has no place-existing mode. In place mode we return the honest
    // failure summary instead of a malformed hint.
    const CHROME_BLOCKS = new Set(["header", "footer", "nav", "navigation", "sidebar", "banner"]);
    if (
      !placedExisting &&
      placements.length === 0 &&
      CHROME_BLOCKS.has(input.blockName.toLowerCase()) &&
      failures.every((f) =>
        f.reason.includes(`block "${input.blockName}" not on this page's template`),
      )
    ) {
      return {
        ok: false,
        content: `${summary}\n[hint] "${input.blockName}" is layout-level chrome, not template-level. Use add_module_to_layout instead — see nextAction.`,
        nextAction: {
          tool: "add_module_to_layout",
          args: {
            layoutSlug: "site-default",
            blockName: input.blockName,
            position: input.position,
            displayName: input.displayName,
            html: input.html,
            ...(input.css !== undefined ? { css: input.css } : {}),
            ...(input.js !== undefined ? { js: input.js } : {}),
            ...(input.fields !== undefined ? { fields: input.fields } : {}),
          },
          reason: `"${input.blockName}" is a layout-level chrome block (header/footer/nav). Re-dispatch the same payload via add_module_to_layout against layoutSlug="site-default" (or your actual layout slug — confirm via list_layouts if uncertain).`,
        },
      };
    }

    return {
      ok: failures.length === 0,
      content: summary,
    };
  },
};
