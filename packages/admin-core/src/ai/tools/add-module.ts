// SPDX-License-Identifier: MPL-2.0

/**
 * `add_module` — the ONE module-placement tool (audit #2), consolidating the
 * former add_module_to_{page,layout,template} into a single `target`-routed
 * tool. `targetRef` is a slug OR a uuid (resolved server-side — a slug is
 * friendlier for the model to hold than a uuid).
 *
 * Two modes for EVERY target:
 *   - **reuse**: pass `moduleId` to place an existing module. Layout used to
 *     lack this — you couldn't reuse a built footer on a layout; now you can,
 *     closing the one asymmetry the three-tool split carried.
 *   - **mint**: pass raw `html` (+ optional `displayName`/`kind`/`fields`
 *     hints); the shared `prepareModuleMint` runs `moduleize` (a small focused
 *     AI call off the main turn) to turn it into a proper parametrised module
 *     with semantic {{fields}} before placing it.
 *
 * The handler resolves the module WITHOUT writing (reuse: modules.get; mint:
 * the `modules.create` input), checks the target's block, and then runs ONE
 * op, `pages.place_module`: the mint, the splice and the initial `values`
 * commit together or not at all (#1246 — a `values` entry that did not fit
 * used to leave an empty placement and a minted module behind).
 *   - page:     one page.
 *   - layout:   the layout block (chrome renders from field DEFAULTS only —
 *               no content_instance binding — so mint-mode fields are
 *               validated for renderability, and `values` become defaults).
 *   - template: every page bound to the template, in the same transaction.
 */

import { execute } from "@caelo-cms/query-api";
import {
  type AddModuleToolInput,
  addModuleToolInput,
  type ExecutionContext,
  type ModuleField,
} from "@caelo-cms/shared";
import { PLACE_MODULE_MAX_PAGES } from "../../ops/content/place-module.js";
import { blockNotFoundError } from "./_block-name-enum.js";
import { checkColdStartGate } from "./_cold-start-gate.js";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError, toolError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import {
  findUnrenderableLayoutFields,
  unrenderableLayoutFieldsError,
} from "./_layout-module-fields.js";
import { type PreparedMint, prepareModuleMint } from "./_mint-module.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import {
  MODULE_BIND_THEME_LITERALS_DESCRIPTION,
  MODULE_CSS_DESCRIPTION,
  MODULE_HTML_DESCRIPTION_KIT_REF,
  MODULE_JS_CONTRACT_KIT_REF,
} from "./_module-js-contract.js";
import { moduleJsGuardSuffix } from "./_module-js-guard.js";
import { resolvePageRef } from "./_page-ref.js";
import { pluginWriteHintsSuffix, storedModuleWrites } from "./_plugin-write-hints.js";
import type { ToolContext, ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageWithModules {
  id: string;
  templateId: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}
interface PageRow {
  id: string;
  slug: string;
  templateId: string;
}
interface LayoutDetail {
  id: string;
  slug: string;
  blocks: { name: string }[];
}

/**
 * The module a call places: an existing one (reuse — no fresh CSS to review)
 * or the `modules.create` input of a mint. Nothing is written while
 * resolving: `pages.place_module` creates a minted module in the same
 * transaction as its placement and content (#1246).
 */
interface ResolvedModule {
  source: { moduleId: string } | { create: PreparedMint["createInput"] };
  slug: string;
  note: string;
  css: string;
  kind: AddModuleToolInput["kind"];
  reused: boolean;
  /** The module's stored fields — echoed in every result so the main
   *  agent knows the content shape without a follow-up modules.get. */
  fields: readonly ModuleField[] | undefined;
  /**
   * §2 — reuse (`moduleId`) is placement-only, but the schema TOLERATES a
   * call that also carried authoring fields (§1A/§11 — a placement that can
   * succeed must not fail over an extra field). Any such field whose value
   * DIFFERS from the module's stored one is NOT applied here; naming it in the
   * result keeps the dropped change from being silent. Empty on mint.
   */
  ignoredAuthoring: string[];
}

/**
 * Which authoring fields on a `moduleId` reuse call differ from the module's
 * stored values (so were not applied). Structural fields (html/css/js/fields)
 * are always listed when present — build_page/add_module place, they don't
 * re-author a shared module.
 */
function ignoredAuthoringFields(
  input: AddModuleToolInput,
  stored: {
    displayName: string;
    description: string | null;
    kind: string | null;
    type: string | null;
  },
): string[] {
  const ignored: string[] = [];
  if (input.displayName !== undefined && input.displayName !== stored.displayName)
    ignored.push(`displayName='${input.displayName}' (module keeps '${stored.displayName}')`);
  if (input.description !== undefined && input.description !== (stored.description ?? undefined))
    ignored.push("description");
  if (input.kind !== undefined && input.kind !== (stored.kind ?? undefined))
    ignored.push(`kind='${input.kind}' (module keeps '${stored.kind ?? "(none)"}')`);
  if (input.type !== undefined && input.type !== (stored.type ?? undefined))
    ignored.push(`type='${input.type}' (module keeps '${stored.type ?? "(none)"}')`);
  if (input.html !== undefined) ignored.push("html (structural)");
  if (input.css !== undefined) ignored.push("css (structural)");
  if (input.js !== undefined) ignored.push("js (structural)");
  if (input.fields !== undefined) ignored.push("fields (structural)");
  if (input.bindThemeLiterals !== undefined) ignored.push("bindThemeLiterals");
  return ignored;
}

/** ` Fields: title(text), cta_href(link).` — appended to every ok result. */
function fieldsSummary(fields: readonly ModuleField[] | undefined): string {
  if (!fields || fields.length === 0) return "";
  return ` Fields: ${fields.map((f) => `${f.name}(${f.kind})`).join(", ")}.`;
}

/**
 * One rule, every target: initial content arrives via `values`. Chrome
 * has no content_instance, so for target='layout' the values become the
 * minted module's field defaults (the schema already guaranteed explicit
 * fields + matching keys).
 */
function mergeValuesIntoDefaults(
  fields: readonly ModuleField[],
  values: Record<string, unknown>,
): ModuleField[] {
  return fields.map((f) =>
    values[f.name] !== undefined ? ({ ...f, default: values[f.name] } as ModuleField) : f,
  );
}

/** Resolve the reuse module, or prepare the mint of a new one (no write). */
async function resolveModule(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
): Promise<{ ok: true; module: ResolvedModule } | { ok: false; content: string }> {
  if (input.moduleId !== undefined) {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.get", {
      moduleId: input.moduleId,
    });
    if (!got.ok) {
      return {
        ok: false,
        content:
          `modules.get failed: ${describeError(got.error)}. ` +
          "The moduleId must come from `list_modules` — to mint a new module instead, omit moduleId and pass displayName + html.",
      };
    }
    const mod = (
      got.value as {
        module: {
          id: string;
          slug: string;
          displayName: string;
          description: string | null;
          kind: string | null;
          type: string | null;
          fields?: readonly ModuleField[];
        };
      }
    ).module;
    return {
      ok: true,
      module: {
        source: { moduleId: mod.id },
        slug: mod.slug,
        note: "",
        css: input.css ?? "",
        kind: input.kind,
        reused: true,
        fields: mod.fields,
        ignoredAuthoring: ignoredAuthoringFields(input, {
          displayName: mod.displayName,
          description: mod.description,
          kind: mod.kind,
          type: mod.type,
        }),
      },
    };
  }
  // mint via moduleize (html + displayName guaranteed present by the schema
  // superRefine). One-rule content: for layout, `values` become the minted
  // fields' defaults (chrome renders from defaults — no content_instance).
  const fieldsHint =
    input.target === "layout" && input.values !== undefined && input.fields !== undefined
      ? mergeValuesIntoDefaults(input.fields, input.values)
      : input.fields;
  const prepared = await prepareModuleMint(ctx, toolCtx, {
    html: input.html as string,
    displayNameHint: input.displayName as string,
    fieldsHint,
    description: input.description,
    kind: input.kind,
    type: input.type,
    css: input.css,
    js: input.js,
    bindThemeLiterals: input.bindThemeLiterals,
  });
  if (!prepared.ok) return { ok: false, content: prepared.content };
  return {
    ok: true,
    module: {
      source: { create: prepared.createInput },
      slug: prepared.createInput.slug,
      note: prepared.note,
      css: prepared.css,
      kind: prepared.kind,
      reused: false,
      fields: prepared.fields,
      ignoredAuthoring: [],
    },
  };
}

/** What `pages.place_module` returns. */
interface PlaceModuleResult {
  moduleId: string;
  placements: { pageId: string; position: number }[];
  layoutPosition: number | null;
}

/**
 * Run `pages.place_module` — the mint (if any), the placement(s) and the
 * initial values in ONE transaction (#1246). On failure nothing was written,
 * so the AI fixes the call and sends the same add_module again.
 */
async function place(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  target: { kind: "pages"; pageIds: string[] } | { kind: "layout"; layoutId: string },
): Promise<{ ok: true; value: PlaceModuleResult } | { ok: false; result: ToolResult }> {
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.place_module", {
    target,
    blockName: input.blockName,
    position: input.position,
    module: mod.source,
    ...(target.kind === "pages" && input.values !== undefined ? { values: input.values } : {}),
  });
  if (r.ok) return { ok: true, value: r.value as PlaceModuleResult };
  const what = mod.reused ? "the module was not placed" : "no module was created or placed";
  return {
    ok: false,
    result: toolError(
      r.error,
      `add_module wrote nothing (${what} — the target is as before): ${describeError(r.error)}`,
    ),
  };
}

/** The css-var / design / plugin-write / module-JS hints for a freshly minted module. */
async function mintedModuleSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  moduleId: string,
): Promise<string> {
  if (mod.reused) return "";
  return `${await cssVarWarningSuffix(ctx, toolCtx, mod.css)}${await designGuardSuffix(ctx, toolCtx, { css: mod.css, html: input.html, excludeModuleIds: [moduleId] })}${await pluginWriteHintsSuffix(ctx, await storedModuleWrites(ctx, toolCtx, [moduleId]))}${await moduleJsGuardSuffix(ctx, toolCtx, [moduleId])}`;
}

/** Every ok result's tail: the hints on the new module + the §2 ignored-authoring note. */
async function resultSuffix(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  moduleId: string,
): Promise<string> {
  // §2 — reuse ignored some authoring fields the call also carried; say so
  // loudly so an intended change never vanishes silently.
  const ignoredNote =
    mod.ignoredAuthoring.length > 0
      ? ` ℹ️ placed by moduleId (placement-only) — NOT applied: ${mod.ignoredAuthoring.join(", ")}. To change that shared module, use update_modules_many.`
      : "";
  return `${await mintedModuleSuffix(ctx, toolCtx, input, mod, moduleId)}${ignoredNote}`;
}

export const addModuleTool: ToolDefinitionWithHandler<AddModuleToolInput> = {
  name: "add_module",
  usesInstallAi: true,
  description: [
    "Add ONE module to a page, a layout (site-wide chrome on every page) or a template (fans out to every page of that page type).",
    'USE FOR: one incremental module on an existing page; chrome (`target:"layout"`); a module on every page of a template.',
    "DO NOT USE FOR: a new page or a page needing >1 module -> `build_page` (whole ordered list WITH content, one transaction).",
    "CORE RULES:",
    "- Two modes, all targets. Reuse (check `list_modules` first): `moduleId` places a SHARED module without a duplicate; a later `update_modules_many` changes it everywhere. Placement-only: authoring fields passed alongside are NOT applied (result says so) — to change the module, place by `moduleId`, then `update_modules_many`. Mint: `html` + `displayName` + `kind` + `fields[]` (`[]` = no fields of its own, used verbatim).",
    "- AUTHOR EXPLICITLY: `fields[]` names in semantic snake_case (`hero_title`, `primary_cta_href`, `nav_items`); never heuristic names (`cta2label2`, `spanText`).",
    '- LISTS ARE LISTS: 10-item menu = ONE `list` field, never `label1`..`label10`; tag cloud = ONE `list` (`listType:"texts"`); multi-part items (image + heading + text) -> custom list type (`upsert_list_types_many`) or a `module-list` of a card module.',
    "- Initial content: `values` in this call (or field `default`s).",
    INTERNAL_LINK_CONTRACT,
  ].join("\n"),
  // 2026-07 — STATIC on purpose (prompt-cache): the per-turn describe
  // embedded active-page blocks + layout/template slugs into the tool
  // definition, busting Anthropic's tools-prefix cache on every page
  // switch or structural write. The same facts live in the `# Current page`
  // note on the user message and in list_layouts / list_templates; a
  // blockName mismatch returns a structured error naming the valid set.
  schema: addModuleToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target", "targetRef", "blockName", "position"],
    properties: {
      target: { type: "string", enum: ["page", "layout", "template"] },
      targetRef: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "Page: id or URL path (e.g. `/docs/setup`); a bare slug only while unique (nested pages can share slugs). Layout/template: slug or id.",
      },
      blockName: {
        type: "string",
        minLength: 1,
        maxLength: 80,
        description: "Real block on the target; a mismatch error returns the valid set.",
      },
      position: {
        description: 'Integer as a bare number (`0`, not `"0"`).',
        oneOf: [
          { type: "string", enum: ["top", "bottom"] },
          { type: "integer", minimum: 0, maximum: 1000 },
        ],
      },
      moduleId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      ...MODULE_META_JSON_SCHEMA_PROPS,
      html: {
        type: "string",
        minLength: 1,
        maxLength: 50_000,
        description: MODULE_HTML_DESCRIPTION_KIT_REF,
      },
      css: { type: "string", maxLength: 50_000, description: MODULE_CSS_DESCRIPTION },
      js: { type: "string", maxLength: 50_000, description: MODULE_JS_CONTRACT_KIT_REF },
      bindThemeLiterals: {
        type: "boolean",
        description: MODULE_BIND_THEME_LITERALS_DESCRIPTION,
      },
      fields: MODULE_FIELDS_JSON_SCHEMA,
      values: {
        type: "object",
        additionalProperties: true,
        description:
          "Initial content `{field_name: value}` — the ONE place content goes. page/template: fills the placement(s). layout: stored as the minted module's field defaults (chrome has no content_instance) -> requires explicit `fields`; rejected with `moduleId` reuse (a shared module renders its stored defaults; change them via `update_modules_many`).",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Layout chrome renders from field defaults only — validate BEFORE any DB
    // round-trip (and before minting) so the AI re-authors with defaults
    // instead of shipping raw `{{…}}` site-wide. Mint mode only; reuse places
    // an already-reviewed module.
    if (input.target === "layout" && input.moduleId === undefined) {
      // Check renderability AFTER folding `values` into the defaults —
      // one-rule content means the copy usually arrives via `values`.
      const effectiveFields =
        input.values !== undefined && input.fields !== undefined
          ? mergeValuesIntoDefaults(input.fields, input.values)
          : input.fields;
      const unrenderable = findUnrenderableLayoutFields(effectiveFields);
      if (unrenderable.length > 0) {
        return {
          ok: false,
          content: unrenderableLayoutFieldsError("add_module", "layout", unrenderable),
        };
      }
    }

    const gate = await checkColdStartGate(ctx, toolCtx, "add_module");
    // biome-ignore lint/style/noNonNullAssertion: gateResult is always set when gate.blocked is true
    if (gate.blocked) return gate.gateResult!;

    const resolved = await resolveModule(ctx, toolCtx, input);
    if (!resolved.ok) return { ok: false, content: resolved.content };
    const mod = resolved.module;
    const label = mod.reused ? "existing module" : "module";

    if (input.target === "page") return placeOnPage(ctx, toolCtx, input, mod, label);
    if (input.target === "layout") return placeOnLayout(ctx, toolCtx, input, mod, label);
    return placeOnTemplate(ctx, toolCtx, input, mod, label);
  },
};

async function placeOnPage(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  label: string,
): Promise<ToolResult> {
  const pageRef = await resolvePageRef(ctx, toolCtx, input.targetRef);
  if (!pageRef.ok) return { ok: false, content: pageRef.message };
  const pageId = pageRef.pageId;
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
    pageId,
  });
  if (!got.ok)
    return toolError(got.error, `pages.get_with_modules failed: ${describeError(got.error)}`);
  const page = (got.value as { page: PageWithModules }).page;
  if (!page.blocks.some((b) => b.blockName === input.blockName))
    return blockNotFoundError({
      blockName: input.blockName,
      blockNames: page.blocks.map((b) => b.blockName),
      pageId,
      argName: "blockName",
    });
  const placed = await place(ctx, toolCtx, input, mod, { kind: "pages", pageIds: [pageId] });
  if (!placed.ok) return placed.result;
  const { moduleId } = placed.value;
  const idx = placed.value.placements[0]?.position ?? 0;
  const valuesNote = input.values !== undefined ? " Initial content applied." : "";
  return {
    ok: true,
    content: `${label} ${moduleId} (slug=${mod.slug}) added to page block "${input.blockName}" at position ${idx}.${valuesNote}${fieldsSummary(mod.fields)}${mod.note}${await resultSuffix(ctx, toolCtx, input, mod, moduleId)}`,
  };
}

async function placeOnLayout(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  label: string,
): Promise<ToolResult> {
  const slug = await resolveLayoutSlug(ctx, toolCtx, input.targetRef);
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", { slug });
  if (!got.ok) return toolError(got.error, `layouts.get failed: ${describeError(got.error)}`);
  const layout = (got.value as { layout: LayoutDetail | null }).layout;
  if (!layout) return refNotFound("layout", input.targetRef);
  if (!layout.blocks.some((b) => b.name === input.blockName)) {
    const allowed = layout.blocks.map((b) => b.name).join(", ");
    return {
      ok: false,
      content: `block "${input.blockName}" not on layout "${layout.slug}". Available: ${allowed}`,
      nextAction: {
        tool: "list_layouts",
        reason: `pick blockName from [${allowed}] and retry — the layout has no block named "${input.blockName}"`,
      },
    };
  }
  const placed = await place(ctx, toolCtx, input, mod, { kind: "layout", layoutId: layout.id });
  if (!placed.ok) return placed.result;
  const { moduleId, layoutPosition } = placed.value;
  return {
    ok: true,
    content: `${label} ${moduleId} (slug=${mod.slug}) added to layout "${layout.slug}" block "${input.blockName}" at position ${layoutPosition ?? 0}; chrome now reaches every page on every template bound to this layout.${fieldsSummary(mod.fields)}${mod.note}${await resultSuffix(ctx, toolCtx, input, mod, moduleId)}`,
  };
}

/** Well-known layout-level chrome blocks (a template miss there meant target='layout'). */
const CHROME_BLOCKS = new Set(["header", "footer", "nav", "navigation", "sidebar", "banner"]);

async function placeOnTemplate(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  label: string,
): Promise<ToolResult> {
  const templateId = await resolveTemplateId(ctx, toolCtx, input.targetRef);
  if (templateId === null) return refNotFound("template", input.targetRef);
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
  if (!listed.ok)
    return toolError(listed.error, `pages.list failed: ${describeError(listed.error)}`);
  const targetPages = (listed.value as { pages: PageRow[] }).pages.filter(
    (p) => p.templateId === templateId,
  );
  if (targetPages.length === 0) {
    return {
      ok: true,
      content: `no pages currently use this template, so nothing was placed${mod.reused ? "" : " and no module was created"}.`,
      nextAction: {
        tool: "list_templates",
        reason:
          "verify templateId points at the intended template; add_module target='page' can attach the module to a specific page instead",
      },
    };
  }
  if (targetPages.length > PLACE_MODULE_MAX_PAGES) {
    return {
      ok: false,
      refusal: true,
      content: `this template has ${targetPages.length} pages; add_module places on at most ${PLACE_MODULE_MAX_PAGES} in one transaction, so nothing was written. Chrome that belongs on every page goes on the layout (target='layout', one placement every page renders); otherwise place it per page (target='page').`,
    };
  }
  // Every page of the template has the template's blocks: one read tells
  // whether the block exists before anything is written.
  const first = targetPages[0] as PageRow;
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
    pageId: first.id,
  });
  if (!got.ok)
    return toolError(got.error, `pages.get_with_modules failed: ${describeError(got.error)}`);
  const blockNames = (got.value as { page: PageWithModules }).page.blocks.map((b) => b.blockName);
  if (!blockNames.includes(input.blockName)) {
    const content = `block "${input.blockName}" is not on this template — available: ${blockNames.join(", ")}. Nothing was written.`;
    // A chrome block missing from the template: the operator meant
    // target='layout'. Surface the corrected call so the AI re-dispatches.
    if (CHROME_BLOCKS.has(input.blockName.toLowerCase())) {
      return {
        ok: false,
        content: `${content}\n[hint] "${input.blockName}" is layout-level chrome, not template-level. Re-dispatch with target='layout' — see nextAction.`,
        nextAction: {
          tool: "add_module",
          args: {
            target: "layout",
            targetRef: "site-default",
            blockName: input.blockName,
            position: input.position,
            ...(mod.reused
              ? { moduleId: (mod.source as { moduleId: string }).moduleId }
              : {
                  displayName: input.displayName,
                  html: input.html,
                  ...(input.css !== undefined ? { css: input.css } : {}),
                  ...(input.js !== undefined ? { js: input.js } : {}),
                  ...(input.fields !== undefined ? { fields: input.fields } : {}),
                }),
          },
          reason: `"${input.blockName}" is a layout-level chrome block. Re-dispatch via add_module target='layout' against targetRef="site-default" (confirm your actual layout slug via list_layouts if uncertain).`,
        },
      };
    }
    return { ok: false, content, nextAction: { tool: "list_templates", reason: content } };
  }
  // One transaction for the whole fan-out: every page gets the module (and
  // its own copy of `values`, unsynced so pages can diverge later), or none.
  const placed = await place(ctx, toolCtx, input, mod, {
    kind: "pages",
    pageIds: targetPages.map((p) => p.id),
  });
  if (!placed.ok) return placed.result;
  const { moduleId, placements } = placed.value;
  const slugById = new Map(targetPages.map((p) => [p.id, p.slug]));
  const valuesNote = input.values !== undefined ? " Initial content applied." : "";
  return {
    ok: true,
    content: [
      `${label} ${moduleId} (slug=${mod.slug}) added to block "${input.blockName}" on ${placements.length} of ${targetPages.length} pages using this template.${valuesNote}${fieldsSummary(mod.fields)}${mod.note}${await resultSuffix(ctx, toolCtx, input, mod, moduleId)}`,
      `placed: ${placements.map((p) => `${slugById.get(p.pageId) ?? p.pageId}@${p.position}`).join(", ")}`,
    ].join("\n"),
  };
}

function refNotFound(target: string, ref: string): ToolResult {
  return {
    ok: false,
    content: `no ${target} found for targetRef "${ref}" — pass a valid slug or uuid (list_pages / list_layouts / list_templates).`,
  };
}

async function resolveLayoutSlug(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  ref: string,
): Promise<string> {
  if (!UUID_RE.test(ref)) return ref; // already a slug
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {});
  if (!listed.ok) return ref;
  return (
    (listed.value as { layouts: { id: string; slug: string }[] }).layouts.find((l) => l.id === ref)
      ?.slug ?? ref
  );
}

async function resolveTemplateId(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  ref: string,
): Promise<string | null> {
  if (UUID_RE.test(ref)) return ref;
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.list", {});
  if (!listed.ok) return null;
  return (
    (listed.value as { templates: { id: string; slug: string }[] }).templates.find(
      (t) => t.slug === ref,
    )?.id ?? null
  );
}
