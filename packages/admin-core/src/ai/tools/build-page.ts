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
import { cssVarWarnings } from "./_css-var-warnings.js";
import { describeError, forwardNextAction, toolError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import { toolNamesIn } from "./_list-tool-kit.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import {
  MODULE_BIND_THEME_LITERALS_DESCRIPTION,
  MODULE_CSS_DESCRIPTION,
  MODULE_HTML_DESCRIPTION,
  MODULE_JS_CONTRACT,
} from "./_module-js-contract.js";
import { moduleJsGuardSuffix } from "./_module-js-guard.js";
import { pluginWriteHintsSuffix, storedModuleWrites } from "./_plugin-write-hints.js";
import { stageReadinessSuffix } from "./_stage-readiness.js";
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
        "Existing: `{pageId, metaDescription?}` (modules append). New: `{slug, title, metaDescription, …}`. Never both.",
      properties: {
        pageId: { type: "string", format: "uuid" },
        slug: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description:
            "Lowercase letters, digits, hyphens — no path or slash. HOMEPAGE (`/`) = `home`.",
        },
        title: { type: "string", minLength: 1, maxLength: 256 },
        shortTitle: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Short label in breadcrumbs and navigation ('Pricing' for 'Pricing for teams of every size'). Omit when the title is short: the title is stored as it.",
        },
        templateId: {
          type: "string",
          format: "uuid",
          description:
            "Omit -> the page type's default template (without `pageType`: site default).",
        },
        pageType: {
          type: "string",
          pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
          description:
            "What the page IS: a slug `list_page_types` shows for this site (e.g. `news` for an article); page queries ('latest news') find pages by it. Omit it for an ordinary page (gets the type listing `templateId`, else the site default). Never guess a slug.",
        },
        properties: {
          type: "object",
          additionalProperties: true,
          description:
            "Page type property values (`list_page_types`, `*` = required), e.g. `{author:'Ada Lovelace', event_date:'2026-11-03'}`.",
        },
        terms: {
          type: "array",
          maxItems: 100,
          items: { type: "string", pattern: "^caelo:term/[0-9a-f-]{36}/[0-9a-f-]{36}$" },
          description:
            "Categories/tags from the page type's vocabularies (`get_list` on the vocabulary shows entry ids).",
        },
        status: {
          type: "string",
          enum: ["draft", "published"],
          description:
            "New pages only (with `pageId`: publish via `set_pages_status_many`). Only `published` pages build on staging. Omitted: published on a site with no published page yet, else draft.",
        },
        metaDescription: {
          type: "string",
          minLength: 1,
          maxLength: 320,
          description:
            "150–160 chars, written from the page's content (migration: the source page's). Fill-once like `autofill_page_seo_many`: with `pageId` written only when the page has none; an existing one is kept (result says so).",
        },
        parentPageId: {
          type: "string",
          format: "uuid",
          description:
            "Create UNDER this page (`list_pages`): URL = parent URL + `/` + slug (e.g. `/seo-monitoring/alerts`). Omit for top level. Move existing pages via `move_pages`.",
        },
        importPageId: {
          type: "string",
          format: "uuid",
          description:
            "Site migration: the source `import_pages` id. Links the page to the crawl (fidelity/inventory/media checks resolve regardless of slug) and makes the build idempotent (same id rebuilds the SAME page, never a duplicate).",
        },
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
              "Page-TEMPLATE block — a slot, NOT a module `kind` (usually `content`; valid set: `# Current page` for the open page, `list_templates` `pageBlocks` otherwise; a mismatch error names it). Never `header`/`footer`. OMIT for a detached nested-only entry (requires `ref`).",
          },
          position: {
            description:
              "Default bottom: entries append in array order (a new page needs none). `top` or 0-based index inserts. Not for detached entries.",
            oneOf: [
              { type: "string", enum: ["top", "bottom"] },
              { type: "integer", minimum: 0, maximum: 1000 },
            ],
          },
          ref: {
            type: "string",
            pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$",
            description:
              'Local handle: `{"$ref":"<ref>"}` in another entry\'s `module`/`module-list` field value or `moduleId` resolves to this entry\'s `{moduleId, contentInstanceId}`. Referenced entries are created first.',
          },
          moduleId: {
            description:
              'EXISTING module (`list_modules`), or `{"$ref":"<handle>"}` to RE-PLACE a module minted by another entry of this call (e.g. one card module, three placements; each entry gets its own content).',
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
          html: {
            type: "string",
            minLength: 1,
            maxLength: 50_000,
            description: MODULE_HTML_DESCRIPTION,
          },
          css: { type: "string", maxLength: 50_000, description: MODULE_CSS_DESCRIPTION },
          js: { type: "string", maxLength: 50_000, description: MODULE_JS_CONTRACT },
          // issue #106 — shared field schema (single source of truth).
          fields: MODULE_FIELDS_JSON_SCHEMA,
          bindThemeLiterals: {
            type: "boolean",
            description: MODULE_BIND_THEME_LITERALS_DESCRIPTION,
          },
          content: {
            description:
              "Omit for an empty private instance to fill later. `inline` -> page-local values (routine); `shared` -> mint a REUSABLE instance other pages can bind (synced by default); `existing` -> bind an instance from `list_content_instances`. " +
              "`values` keyed by field name: local `list` -> entries (`[{node:'text', values:{text:'Fast'}}]`); shared `list` -> `caelo:list/<id>`; source field -> its editable knobs; nested `module`/`module-list` -> `{\"$ref\":\"<ref>\"}` | `{moduleId, contentInstanceId}`.",
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

/** #820 — the field values a build_page call writes (inline + shared content). */
export function buildPageValues(input: BuildPageInput): Record<string, unknown>[] {
  return input.modules.flatMap((m) =>
    m.content !== undefined && "values" in m.content ? [m.content.values] : [],
  );
}

export const buildPageTool: ToolDefinitionWithHandler<BuildPageInput> = {
  name: "build_page",
  // STATIC on purpose (prompt-cache): no per-turn block names here — the
  // `# Current page` note carries them and a blockName mismatch returns a
  // structured error naming the valid set.
  description: [
    "Build a WHOLE page in ONE transaction: create (`page:{slug, title}`) or target existing (`page:{pageId}`) + the full ordered module list (each entry places one module into a template block, top to bottom; on an existing page entries append). Any invalid entry aborts everything (error names `modules[i]` + failing field); nothing is written.",
    "USE FOR: every page creation (THE page-creation tool); any page needing >1 module — never `add_module` / `create_content_instances` chains. `modules: []` = intentionally empty page shell.",
    "DO NOT USE FOR: one incremental module on an existing page -> `add_module` (target `page`); site chrome header/footer -> `add_module` (target `layout`; chrome never rides in a page body).",
    "CORE RULES:",
    '- Creating: typed page -> `page.pageType` (+ `properties`/`terms`; an ordinary page omits pageType); always `page.metaDescription`, and `status:"published"` for a page that belongs on the site — a Stage refuses published pages without a description and builds only published ones; the result says what still blocks a Stage.',
    "- Per module, two modes: `moduleId` places an EXISTING module (`list_modules`; reuse first — shared modules keep pages consistent), or mint with `displayName` + `html` + `description` + `kind` + explicit `fields[]` (all required).",
    "- Pair `{{field_name}}` placeholders in `html` with `fields[]` in semantic snake_case (`hero_title`, `primary_cta_href`); never heuristic names (`cta2label2`) or numbered scalars (`label1`..`label10` -> ONE `list` field or a `module-list`).",
    '- An overview of pages (guides hub, category page) is ONE `list` field bound to a page query (`bind:"source"`, `source:{kind:"query", defaults:{page_type:…}}`; `term_pages` / `children`), never a hand-kept card per page.',
    "- Nested modules in the SAME call: inner entry gets `ref` and NO `blockName` (detached: minted + content-bound, not placed); the outer module's `module`/`module-list` field value references it as `{\"$ref\":\"<ref>\"}`, any array order. Never an `add_module` -> `remove_module_from` -> `create_content_instances` chain. E.g. `modules:[{ref:'btn', displayName:'Button', html:'<button>{{label}}</button>', fields:[…], content:{source:'inline', values:{label:'Go'}}}, {blockName:'content', displayName:'CTA', html:'<section>{{>cta}}</section>', fields:[{name:'cta', kind:'module', label:'CTA', allowedModuleTypes:['button']}], content:{source:'inline', values:{cta:{'$ref':'btn'}}}}]`",
    INTERNAL_LINK_CONTRACT,
    "Typical call: `{page:{slug:'pricing', title:'Pricing', status:'published', metaDescription:'…'}, modules:[{blockName:'content', displayName:'Pricing Hero', kind:'hero', description:'…', html:'<section><h1>{{hero_title}}</h1></section>', fields:[{name:'hero_title', kind:'text', label:'Hero title'}], content:{source:'inline', values:{hero_title:'Fair pricing'}}}, …]}`",
  ].join("\n"),
  schema: buildPageInputSchema,
  inputSchema: BUILD_PAGE_INPUT_SCHEMA,
  handler: async (ctx, input, toolCtx) => {
    // Same cold-start gate as add_module_to_page — no
    // module authoring against the seed-grayscale theme.
    const gate = await checkColdStartGate(ctx, toolCtx, "build_page");
    // biome-ignore lint/style/noNonNullAssertion: gateResult is always set when gate.blocked is true
    if (gate.blocked) return gate.gateResult!;

    // issue #164 slice 2 — mechanical token binding, applied at the tool
    // layer (same as add_module_to_page) so the op receives the bound CSS.
    // issue #430 — on by default; pass `false` per module to keep a literal.
    // Per-module notes, keyed by the entry's index in `input.modules` —
    // every note names the module it is about, so the AI never has to
    // guess which entry a warning belongs to.
    const notesByIndex = new Map<number, string[]>();
    const note = (i: number, text: string) => {
      const t = text.trim();
      if (t.length === 0) return;
      notesByIndex.set(i, [...(notesByIndex.get(i) ?? []), t]);
    };
    const modules = [...input.modules];
    for (const [i, m] of modules.entries()) {
      if (m.bindThemeLiterals !== false && m.css !== undefined && m.css.length > 0) {
        const bound = await bindCssToTheme(ctx, toolCtx, m.css);
        modules[i] = { ...m, css: bound.css };
        note(i, bound.report);
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
        ...toolError(
          r.error,
          `pages.build_page failed (nothing was written — the whole call rolled back): ${toolNamesIn(describeError(r.error))}`,
        ),
        ...(next ? { nextAction: next } : {}),
      };
    }
    const value = r.value as {
      pageId: string;
      createdPage: boolean;
      placements: {
        index: number;
        blockName: string;
        position: number;
        moduleId: string;
        contentInstanceId: string;
        syncMode: "synced" | "unsynced";
        minted: boolean;
      }[];
      detached: { index: number; ref: string; moduleId: string; contentInstanceId: string }[];
      extractedFieldsByIndex: Record<string, { name: string; kind: string }[]>;
      ignoredAuthoringByIndex: Record<string, string[]>;
      reusedMintByIndex: Record<string, number>;
      metaDescription: "written" | "unchanged" | "kept-existing" | null;
    };

    const mintedCount = value.placements.filter((p) => p.minted).length;
    const reusedCount = value.placements.length - mintedCount;
    // One line per input entry, in input order, labelled with the entry's
    // own index — a detached (nested-only) entry has no placement, so the
    // placements array alone would shift every later index.
    // Named by what the call authored. A placement-only entry (`moduleId`,
    // possibly a `{"$ref"}`) gets no name: the op ignores its authoring
    // fields, so a name it carried may not be the module's — its line shows
    // the resolved module id instead.
    const label = (i: number) => {
      const m = input.modules[i];
      const name =
        m === undefined || m.moduleId !== undefined
          ? undefined
          : [m.displayName, m.type].find((v): v is string => typeof v === "string" && v.length > 0);
      return name ? `modules[${i}] (${name})` : `modules[${i}]`;
    };
    const resultLines = [
      ...value.placements.map((p) => ({
        index: p.index,
        text: `${label(p.index)} → ${p.blockName}#${p.position} module=${p.moduleId} content=${p.contentInstanceId} (${p.syncMode}${p.minted ? ", minted" : ", reused"})`,
      })),
      ...value.detached.map((d) => ({
        index: d.index,
        text: `${label(d.index)} ref='${d.ref}' → DETACHED (nested-only) module=${d.moduleId} content=${d.contentInstanceId}`,
      })),
    ].sort((a, b) => a.index - b.index);
    const lines = resultLines.map((l) => l.text);

    // Extractor-fallback hint — same steering as add_module_to_page.
    const extractedEntries = Object.entries(value.extractedFieldsByIndex);
    const extractedHint =
      extractedEntries.length > 0
        ? ` ⚠️ Extractor fallback minted heuristic field names for ${extractedEntries
            .map(([idx, fields]) => `modules[${idx}] (${fields.map((f) => f.name).join(", ")})`)
            .join(
              "; ",
            )} — author HTML + \`fields[]\` together next time so \`list_modules\` stays useful.`
        : "";
    const missingMeta = input.modules
      .map((m, i) =>
        m.moduleId === undefined &&
        value.reusedMintByIndex[String(i)] === undefined &&
        (m.description === undefined || m.kind === undefined)
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    const missingMetaHint =
      missingMeta.length > 0
        ? ` ⚠️ modules[${missingMeta.join(", ")}] minted without \`description\`/\`kind\` — \`list_modules\` shows "(no description)"; patch via update_modules_many.`
        : "";
    // §2 — a moduleId entry is placement-only; any authoring field it also
    // carried that DIFFERS from the module's stored value was NOT applied. Say
    // so loudly so an intended change never vanishes silently.
    const ignoredEntries = Object.entries(value.ignoredAuthoringByIndex);
    const ignoredHint =
      ignoredEntries.length > 0
        ? ` ℹ️ ${ignoredEntries
            .map(
              ([idx, fields]) =>
                `modules[${idx}] placed by moduleId (placement-only) — NOT applied: ${fields.join(", ")}`,
            )
            .join(
              "; ",
            )}. To change that shared module (rename / structure / fields), use update_modules_many.`
        : "";

    const reusedEntries = Object.entries(value.reusedMintByIndex);
    const reusedHint =
      reusedEntries.length > 0
        ? ` ℹ️ ${reusedEntries
            .map(([idx, first]) => `modules[${idx}] repeats modules[${first}]'s html`)
            .join(
              "; ",
            )} — placed that one module again with its own content instead of minting copies. To say so directly, pass moduleId: {"$ref": "<the first entry's ref>"}.`
        : "";

    // css-var scan per freshly-authored module (one theme read) and
    // design-guard per minted module (pattern-reuse compares its html).
    // Reuses the exact helpers add_module_to_page applies — no forks.
    const cssWarnings = await cssVarWarnings(
      ctx,
      toolCtx,
      modules.map((m) => (m.moduleId === undefined ? m.css : undefined)),
    );
    for (const [i, w] of cssWarnings.entries()) note(i, w);
    // Every module this call minted is in the catalog now; none may
    // match itself (or a sibling minted from the same markup — `$ref`
    // re-placement is the same-call reuse path, the check catches the rest).
    const mintedIds = [
      ...value.placements.filter((p) => p.minted).map((p) => p.moduleId),
      ...value.detached.map((d) => d.moduleId),
    ];
    for (const [i, m] of modules.entries()) {
      if (m.moduleId !== undefined) continue;
      const suffix = await designGuardSuffix(ctx, toolCtx, {
        css: m.css,
        html: m.html,
        excludeModuleIds: mintedIds,
      });
      note(i, suffix);
    }
    const pluginHints =
      (await pluginWriteHintsSuffix(ctx, await storedModuleWrites(ctx, toolCtx, mintedIds))) +
      (await moduleJsGuardSuffix(ctx, toolCtx, mintedIds));
    const moduleNotes = [...notesByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([i, texts]) => texts.map((t) => `\n${label(i)}: ${t}`))
      .join("");
    const metaNote =
      value.metaDescription === "kept-existing"
        ? " ℹ️ page.metaDescription NOT applied: this page already has a meta description (fill-once — change it via bulk_optimize_seo only when the operator asks)."
        : value.metaDescription === "written"
          ? " Meta description written."
          : "";
    // What a Stage would refuse now, in this chat's view of the site — so
    // the AI fixes it before stage_changes, not after a failed build.
    const readiness = await stageReadinessSuffix(ctx, toolCtx);
    return {
      ok: true,
      content:
        `page ${value.pageId}${value.createdPage ? " created" : ""} — ${value.placements.length} module(s) placed (${mintedCount} minted, ${reusedCount} reused) in one transaction.\n` +
        `${lines.join("\n")}${moduleNotes}${pluginHints}${extractedHint}${missingMetaHint}${ignoredHint}${reusedHint}${metaNote}${readiness}`,
      value,
    };
  },
};
