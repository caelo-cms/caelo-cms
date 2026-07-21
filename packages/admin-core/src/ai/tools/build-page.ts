// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — AI tool: build_page. ONE call assembles a whole page:
 * the page itself (create new, or target existing) + an ordered module
 * list, each module carrying its HTML/CSS/fields AND its content
 * (inline values, a shared instance, or a bind to an existing one).
 *
 * Wraps the `pages.build_page` op — one transaction, all-or-nothing —
 * and applies the same tool-layer guards `add_module_to_page` applies:
 * the cold-start gate before any authoring, per-module theme-literal
 * binding when requested, and the css-var / design-guard warning
 * suffixes on success.
 */

import { execute } from "@caelo-cms/query-api";
import { type BuildPageInput, buildPageInputSchema } from "@caelo-cms/shared";
import { checkColdStartGate } from "./_cold-start-gate.js";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError, forwardNextAction } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import { MODULE_JS_CONTRACT } from "./_module-js-contract.js";
import { bindCssToTheme } from "./_theme-binding.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

/** Static JSON Schema for the provider (static by design — prompt-cache). */
const BUILD_PAGE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["page", "modules"],
  properties: {
    page: {
      type: "object",
      additionalProperties: false,
      description:
        "EITHER { pageId } to build onto an existing page (modules are appended), OR { slug, title, name?, locale?, templateId?, status? } to create the page in the same call. Never both.",
      properties: {
        pageId: { type: "string", format: "uuid" },
        slug: { type: "string", minLength: 1, maxLength: 120 },
        title: { type: "string", minLength: 1, maxLength: 256 },
        name: { type: "string", minLength: 1, maxLength: 256 },
        locale: { type: "string", minLength: 2, maxLength: 10 },
        templateId: { type: "string", format: "uuid" },
        status: { type: "string", enum: ["draft", "published"] },
      },
    },
    modules: {
      type: "array",
      minItems: 0,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockName: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description:
              'Template block to place into. OMIT for a DETACHED nested-only module (requires `ref`; a later entry embeds it via {"$ref": …}).',
          },
          ref: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,31}$",
            description:
              'Local handle: a LATER entry\'s module/module-list field value {"$ref": "<ref>"} resolves to this entry\'s {moduleId, contentInstanceId}. Referenced entries must come FIRST in the array.',
          },
          moduleId: {
            description:
              'EXISTING module UUID from ## Modules — or {"$ref": "<handle>"} to RE-PLACE a module minted earlier in THIS call (e.g. one card module, three placements; each entry still gets its own content).',
            oneOf: [
              { type: "string", format: "uuid" },
              {
                type: "object",
                additionalProperties: false,
                required: ["$ref"],
                properties: { $ref: { type: "string" } },
              },
            ],
          },
          displayName: { type: "string", minLength: 1, maxLength: 128 },
          // issue #106 — shared decision-support metadata (description/
          // kind/type), spread from the single source of truth.
          ...MODULE_META_JSON_SCHEMA_PROPS,
          html: { type: "string", minLength: 1, maxLength: 50_000 },
          css: { type: "string", maxLength: 50_000 },
          js: { type: "string", maxLength: 50_000, description: MODULE_JS_CONTRACT },
          // issue #106 — shared field schema (single source of truth).
          fields: MODULE_FIELDS_JSON_SCHEMA,
          bindThemeLiterals: { type: "boolean" },
          content: {
            description:
              "The placement's content. Omit for an empty private instance. " +
              "source='inline' → page-local values; source='shared' → mint a REUSABLE instance (purpose required) bound synced; " +
              "source='existing' → bind an instance from ## Content Library.",
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["source", "values"],
                properties: {
                  source: { type: "string", enum: ["inline"] },
                  values: { type: "object", additionalProperties: true },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["source", "purpose"],
                properties: {
                  source: { type: "string", enum: ["shared"] },
                  values: { type: "object", additionalProperties: true },
                  purpose: { type: "string", minLength: 1, maxLength: 1000 },
                  slug: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
                  displayName: { type: "string", minLength: 1, maxLength: 128 },
                  syncMode: { type: "string", enum: ["synced", "unsynced"] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["source", "contentInstanceId"],
                properties: {
                  source: { type: "string", enum: ["existing"] },
                  contentInstanceId: { type: "string", format: "uuid" },
                  syncMode: { type: "string", enum: ["synced", "unsynced"] },
                },
              },
            ],
          },
        },
      },
    },
  },
};

export const buildPageTool: ToolDefinitionWithHandler<BuildPageInput> = {
  name: "build_page",
  description:
    "Build a WHOLE page in ONE call: the page (create new via `page: {slug, title}` or target existing via `page: {pageId}`) plus the FULL ordered module list — each entry places one module into a template block, top to bottom. ONE transaction: any invalid entry aborts the whole call (the error names `modules[i]` and the failing field) and nothing is written. " +
    "This is THE page-creation tool: `modules: []` (empty) creates an intentionally empty page shell; a populated `modules` array builds the whole page in one transaction. **Prefer it over add_module / create_content_instance chains whenever a page needs more than one module** — one build_page call replaces that whole round-trip chain (§11 bulk-first). Use add_module (target='page') only for a single incremental module on an existing page. " +
    "**Per module, two modes** (same contract as add_module): pass `moduleId` to place an EXISTING module from `## Modules` (reuse first — shared modules keep pages consistent), or `displayName` + `html` (+ required `description`, `kind`, explicit `fields[]`) to mint a new one. Field names are semantic snake_case (`hero_title`, `primary_cta_href`); repeats are LIST fields (`text-list`, `link-list`, `module-list`), never numbered scalars. " +
    "**Per module, `content` fills the placement**: `{source:'inline', values:{hero_title:'…'}}` for page-local content (the routine case); `{source:'shared', purpose:'…', values:{…}}` to mint a REUSABLE instance other pages can bind (synced by default); `{source:'existing', contentInstanceId}` to bind a row from `## Content Library`. Omit `content` for an empty private instance you fill later. " +
    "Typical call: `{page:{slug:'pricing', title:'Pricing'}, modules:[{blockName:'content', displayName:'Pricing Hero', kind:'hero', description:'…', html:'<section><h1>{{hero_title}}</h1></section>', fields:[{name:'hero_title', kind:'text', label:'Hero title'}], content:{source:'inline', values:{hero_title:'Fair pricing'}}}, …]}`. " +
    "**Nested modules in the SAME call**: give the inner module `ref` and NO blockName (detached — minted + content-bound but not placed), then reference it from the outer module's `module`/`module-list` field value as `{\"$ref\": \"<ref>\"}` — the server resolves it to the real {moduleId, contentInstanceId}. Referenced entries come FIRST. Example: `modules:[{ref:'btn', displayName:'Button', html:'<button>{{label}}</button>', fields:[…], content:{source:'inline', values:{label:'Go'}}}, {blockName:'content', displayName:'CTA', html:'<section>{{>cta}}</section>', fields:[{name:'cta', kind:'module', label:'CTA', allowedModuleTypes:['button']}], content:{source:'inline', values:{cta:{'$ref':'btn'}}}}]` — the whole nested composition is ONE call, never an add_module → remove_module_from → create_content_instance chain. " +
    "For site-wide chrome (header/footer) use add_module (target='layout') — chrome is layout-owned and never rides in a page body. " +
    // 2026-07 — STATIC on purpose (prompt-cache): the per-turn describe/
    // describeSchema hooks embedded the focused page's block names into
    // the tool definition, busting Anthropic's tools-prefix cache on
    // every page switch. The same facts live in the volatile `# Current
    // page` block, and a blockName mismatch returns a structured error
    // naming the valid set (recover-don't-punt).
    "Each entry's `blockName` must be a block on the page's template — see `# Current page` (exhaustive list for the focused page); a mismatch error names the valid set. A block name is a template slot, NOT a module `kind`. With zero templates on the site, bootstrap first (create_layout → create_template).",
  schema: buildPageInputSchema,
  inputSchema: BUILD_PAGE_INPUT_SCHEMA,
  handler: async (ctx, input, toolCtx) => {
    // Same cold-start gate as add_module_to_page — no
    // module authoring against the seed-grayscale theme.
    const gate = await checkColdStartGate(ctx, toolCtx, "build_page");
    // biome-ignore lint/style/noNonNullAssertion: gateResult is always set when gate.blocked is true
    if (gate.blocked) return gate.gateResult!;

    // issue #164 slice 2 — opt-in mechanical token binding, applied at
    // the tool layer (same as add_module_to_page) so the op receives
    // the bound CSS.
    const bindingReports: string[] = [];
    const modules = [...input.modules];
    for (const [i, m] of modules.entries()) {
      if (m.bindThemeLiterals === true && m.css !== undefined && m.css.length > 0) {
        const bound = await bindCssToTheme(ctx, toolCtx, m.css);
        modules[i] = { ...m, css: bound.css };
        if (bound.report.length > 0) bindingReports.push(`modules[${i}]:${bound.report}`);
      }
    }

    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.build_page", {
      page: input.page,
      // The op schema doesn't know bindThemeLiterals — strip it here.
      modules: modules.map(({ bindThemeLiterals: _bind, ...rest }) => rest),
    });
    if (!r.ok) {
      const next = forwardNextAction(r.error);
      return {
        ok: false,
        content: `pages.build_page failed (nothing was written — the whole call rolled back): ${describeError(r.error)}`,
        ...(next ? { nextAction: next } : {}),
      };
    }
    const value = r.value as {
      pageId: string;
      createdPage: boolean;
      placements: {
        blockName: string;
        position: number;
        moduleId: string;
        contentInstanceId: string;
        syncMode: "synced" | "unsynced";
        minted: boolean;
      }[];
      detached: { ref: string; moduleId: string; contentInstanceId: string }[];
      extractedFieldsByIndex: Record<string, { name: string; kind: string }[]>;
    };

    const mintedCount = value.placements.filter((p) => p.minted).length;
    const reusedCount = value.placements.length - mintedCount;
    const lines = value.placements.map(
      (p, i) =>
        `modules[${i}] → ${p.blockName}#${p.position} module=${p.moduleId} content=${p.contentInstanceId} (${p.syncMode}${p.minted ? ", minted" : ", reused"})`,
    );
    for (const d of value.detached) {
      lines.push(
        `ref='${d.ref}' → DETACHED (nested-only) module=${d.moduleId} content=${d.contentInstanceId}`,
      );
    }

    // Extractor-fallback hint — same steering as add_module_to_page.
    const extractedEntries = Object.entries(value.extractedFieldsByIndex);
    const extractedHint =
      extractedEntries.length > 0
        ? ` ⚠️ Extractor fallback minted heuristic field names for ${extractedEntries
            .map(([idx, fields]) => `modules[${idx}] (${fields.map((f) => f.name).join(", ")})`)
            .join(
              "; ",
            )} — author HTML + \`fields[]\` together next time so \`## Modules\` stays useful.`
        : "";
    const missingMeta = input.modules
      .map((m, i) =>
        m.moduleId === undefined && (m.description === undefined || m.kind === undefined) ? i : -1,
      )
      .filter((i) => i >= 0);
    const missingMetaHint =
      missingMeta.length > 0
        ? ` ⚠️ modules[${missingMeta.join(", ")}] minted without \`description\`/\`kind\` — \`## Modules\` shows "(no description)"; patch via edit_module.`
        : "";

    // css-var scan once over ALL freshly-authored CSS; design-guard per
    // minted module (pattern-reuse needs the displayName). Reuses the
    // exact helpers add_module_to_page applies — no forks.
    const allCss = modules
      .filter((m) => m.moduleId === undefined)
      .map((m) => m.css ?? "")
      .filter((c) => c.length > 0)
      .join("\n");
    const cssWarning = await cssVarWarningSuffix(ctx, toolCtx, allCss);
    const guardFindings: string[] = [];
    for (const [i, m] of modules.entries()) {
      if (m.moduleId !== undefined) continue;
      const suffix = await designGuardSuffix(ctx, toolCtx, {
        css: m.css,
        displayName: m.displayName,
        kind: m.kind,
        type: m.type,
      });
      if (suffix.length > 0) guardFindings.push(`modules[${i}]:${suffix}`);
    }

    const binding = bindingReports.length > 0 ? ` ${bindingReports.join(" ")}` : "";
    return {
      ok: true,
      content:
        `page ${value.pageId}${value.createdPage ? " created" : ""} — ${value.placements.length} module(s) placed (${mintedCount} minted, ${reusedCount} reused) in one transaction.\n` +
        `${lines.join("\n")}${binding}${extractedHint}${missingMetaHint}${cssWarning}${guardFindings.join("")}`,
      value,
    };
  },
};
