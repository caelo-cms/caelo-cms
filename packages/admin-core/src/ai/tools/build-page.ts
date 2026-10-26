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
import { describeError, forwardNextAction, forwardRefusal } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import {
  MODULE_CSS_DESCRIPTION,
  MODULE_HTML_DESCRIPTION,
  MODULE_JS_CONTRACT,
} from "./_module-js-contract.js";
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
        "EITHER { pageId, metaDescription? } to build onto an existing page (modules are appended), OR { slug, title, metaDescription, shortTitle?, pageType?, properties?, terms?, templateId?, status?, parentPageId? } to create the page in the same call. Never both.",
      properties: {
        pageId: { type: "string", format: "uuid" },
        slug: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description:
            "Lowercase letters, digits and hyphens only — never a path or a slash. The HOMEPAGE (served at `/`) uses slug 'home'.",
        },
        title: { type: "string", minLength: 1, maxLength: 256 },
        shortTitle: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "The page's short label in breadcrumbs and navigation ('Pricing' for 'Pricing for teams of every size'). Omit when the title is already short — it is stored as the short title.",
        },
        templateId: {
          type: "string",
          format: "uuid",
          description:
            "Omit to take the page type's default template (or, without pageType, the site default).",
        },
        pageType: {
          type: "string",
          pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
          description:
            "What the page IS — a page type slug from list_page_types (e.g. 'news' for an article, 'page' for a plain page). Set it whenever the site has more than one type: page queries ('latest news', 'articles in this category') find pages by it. Omitted: the type that lists templateId, else the site's default type.",
        },
        properties: {
          type: "object",
          additionalProperties: true,
          description:
            "Values of the page type's properties (list_page_types shows them, `*` = required), e.g. {author:'Ada Lovelace', event_date:'2026-11-03'}.",
        },
        terms: {
          type: "array",
          maxItems: 100,
          items: { type: "string", pattern: "^caelo:term/[0-9a-f-]{36}/[0-9a-f-]{36}$" },
          description:
            "The page's categories / tags: caelo:term/<listId>/<itemId> from the page type's vocabularies (get_list on the vocabulary shows the entry ids).",
        },
        status: {
          type: "string",
          enum: ["draft", "published"],
          description:
            "Only 'published' pages are built on staging. Omitted: published on a site with no published page yet, else draft. Pass 'published' for a page that belongs on the site now.",
        },
        metaDescription: {
          type: "string",
          minLength: 1,
          maxLength: 320,
          description:
            "The page's meta description (150–160 characters, written from the page's content; in a migration, the source page's). A Stage refuses a published page without one — pass it here so the page is Stage-ready from this call. Fill-once, same as autofill_page_seo: with pageId it is written only when the page has no description yet; an existing one is kept and the result says so.",
        },
        parentPageId: {
          type: "string",
          format: "uuid",
          description:
            "Create the page UNDER this page: its URL becomes the parent's URL + '/' + slug (e.g. parent /seo-monitoring + slug 'alerts' → /seo-monitoring/alerts). Omit for a top-level page. Take the id from list_pages. To move an EXISTING page, use move_pages.",
        },
        importPageId: {
          type: "string",
          format: "uuid",
          description:
            "When rebuilding a crawled page during a site migration, pass the source import_pages id. This links the built page to the crawl (so fidelity / inventory / media-migration checks resolve regardless of slug) AND makes the build idempotent — building the same importPageId twice rebuilds the SAME page, never a duplicate.",
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
              "Page-TEMPLATE block to place into (usually 'content'; see `# Current page`). Never 'header' / 'footer': site chrome lives on the layout (add_module target='layout'). " +
              'OMIT for a DETACHED nested-only module (requires `ref`; another entry embeds it via {"$ref": …}).',
          },
          position: {
            description:
              'Where in its block this entry lands: "top", "bottom" (default — entries append in array order, so a new page needs none) or a 0-based index. Same grammar as add_module. Not for detached entries.',
            oneOf: [
              { type: "string", enum: ["top", "bottom"] },
              { type: "integer", minimum: 0, maximum: 1000 },
            ],
          },
          ref: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,31}$",
            description:
              'Local handle: another entry\'s module/module-list field value (or moduleId) {"$ref": "<ref>"} resolves to this entry\'s {moduleId, contentInstanceId}. Array order does not matter — referenced entries are created first automatically.',
          },
          moduleId: {
            description:
              'EXISTING module UUID from list_modules — or {"$ref": "<handle>"} to RE-PLACE a module minted by another entry of THIS call (e.g. one card module, three placements; each entry still gets its own content).',
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
            description:
              "Rewrite CSS literals that equal a theme token value into var(--…). DEFAULT true — omit it. Pass false only to keep a deliberate off-palette literal.",
          },
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

/** #820 — the field values a build_page call writes (inline + shared content). */
export function buildPageValues(input: BuildPageInput): Record<string, unknown>[] {
  return input.modules.flatMap((m) =>
    m.content !== undefined && "values" in m.content ? [m.content.values] : [],
  );
}

export const buildPageTool: ToolDefinitionWithHandler<BuildPageInput> = {
  name: "build_page",
  description:
    "Build a WHOLE page in ONE call: the page (create new via `page: {slug, title}` or target existing via `page: {pageId}`) plus the FULL ordered module list — each entry places one module into a template block, top to bottom (on an existing page entries append; an entry's optional `position` — 'top' or an index, as in add_module — inserts it instead). ONE transaction: any invalid entry aborts the whole call (the error names `modules[i]` and the failing field) and nothing is written. " +
    "This is THE page-creation tool: when creating, set `page.pageType` (list_page_types — an article is `news`, not a plain page) with its `properties` / `terms`, and pass `page.metaDescription` (and `status:'published'` for a page that belongs on the site) — a Stage refuses published pages without a description, and builds only published ones; the result says when something still blocks a Stage. `modules: []` (empty) creates an intentionally empty page shell; a populated `modules` array builds the whole page in one transaction. **Prefer it over add_module / create_content_instance chains whenever a page needs more than one module** — one build_page call replaces that whole round-trip chain (§11 bulk-first). Use add_module (target='page') only for a single incremental module on an existing page. " +
    "**Per module, two modes** (same contract as add_module): pass `moduleId` to place an EXISTING module from `list_modules` (reuse first — shared modules keep pages consistent), or `displayName` + `html` (+ required `description`, `kind`, explicit `fields[]`) to mint a new one. Field names are semantic snake_case (`hero_title`, `primary_cta_href`); repeating content is ONE `list` field (entries of a list type, iterated with `{{#field}}…{{/field}}`) or a `module-list`, never numbered scalars. A `list` field is local (entries in `content.values`, e.g. `{features:[{node:'text', values:{text:'Fast'}}]}`), shared (bind 'shared', value or field `list` = caelo:list/<id> — menus, footer links) or a source (bind 'source': a page query such as the latest news, breadcrumbs; `content.values` may override the knobs the source marks editable). " +
    "**Per module, `content` fills the placement**: `{source:'inline', values:{hero_title:'…'}}` for page-local content (the routine case); `{source:'shared', purpose:'…', values:{…}}` to mint a REUSABLE instance other pages can bind (synced by default); `{source:'existing', contentInstanceId}` to bind a row from `## Content Library`. Omit `content` for an empty private instance you fill later. " +
    "Typical call: `{page:{slug:'pricing', title:'Pricing', status:'published', metaDescription:'…'}, modules:[{blockName:'content', displayName:'Pricing Hero', kind:'hero', description:'…', html:'<section><h1>{{hero_title}}</h1></section>', fields:[{name:'hero_title', kind:'text', label:'Hero title'}], content:{source:'inline', values:{hero_title:'Fair pricing'}}}, …]}`. " +
    "**Nested modules in the SAME call**: give the inner module `ref` and NO blockName (detached — minted + content-bound but not placed), then reference it from the outer module's `module`/`module-list` field value as `{\"$ref\": \"<ref>\"}` — the server resolves it to the real {moduleId, contentInstanceId}, in any array order. Example: `modules:[{ref:'btn', displayName:'Button', html:'<button>{{label}}</button>', fields:[…], content:{source:'inline', values:{label:'Go'}}}, {blockName:'content', displayName:'CTA', html:'<section>{{>cta}}</section>', fields:[{name:'cta', kind:'module', label:'CTA', allowedModuleTypes:['button']}], content:{source:'inline', values:{cta:{'$ref':'btn'}}}}]` — the whole nested composition is ONE call, never an add_module → remove_module_from → create_content_instance chain. " +
    "For site-wide chrome (header/footer) use add_module (target='layout') — chrome is layout-owned and never rides in a page body. " +
    // 2026-07 — STATIC on purpose (prompt-cache): the per-turn describe/
    // describeSchema hooks embedded the focused page's block names into
    // the tool definition, busting Anthropic's tools-prefix cache on
    // every page switch. The same facts live in the volatile `# Current
    // page` block, and a blockName mismatch returns a structured error
    // naming the valid set (recover-don't-punt).
    "Each entry's `blockName` must be a block on the page's template — see `# Current page` (exhaustive list for the focused page); a mismatch error names the valid set. A block name is a template slot, NOT a module `kind`. With zero templates on the site, bootstrap first (create_layout → create_template)." +
    INTERNAL_LINK_CONTRACT,
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
        ok: false,
        content: `pages.build_page failed (nothing was written — the whole call rolled back): ${describeError(r.error)}`,
        ...(next ? { nextAction: next } : {}),
        ...forwardRefusal(r.error),
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
        ? ` ⚠️ modules[${missingMeta.join(", ")}] minted without \`description\`/\`kind\` — \`list_modules\` shows "(no description)"; patch via edit_module.`
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
            )}. To change that shared module (rename / structure / fields), use edit_module.`
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
    const moduleNotes = [...notesByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([i, texts]) => texts.map((t) => `\n${label(i)}: ${t}`))
      .join("");
    const metaNote =
      value.metaDescription === "kept-existing"
        ? " ℹ️ page.metaDescription NOT applied: this page already has a meta description (fill-once — change it via optimize_page_seo only when the operator asks)."
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
        `${lines.join("\n")}${moduleNotes}${extractedHint}${missingMetaHint}${ignoredHint}${reusedHint}${metaNote}${readiness}`,
      value,
    };
  },
};
