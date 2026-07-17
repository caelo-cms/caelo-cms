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
 *     hints); the shared `mintModuleFromHtml` runs `moduleize` (a small focused
 *     AI call off the main turn) to turn it into a proper parametrised module
 *     with semantic {{fields}} before placing it.
 *
 * Placement differs per target, so the handler resolves + mints ONCE and then
 * routes:
 *   - page:     pages.get_with_modules → splice → pages.set_modules.
 *   - layout:   layouts.get → layout_modules.get → splice → layout_modules.set.
 *               (chrome renders from field DEFAULTS only — no content_instance
 *               binding — so mint-mode fields are validated for renderability.)
 *   - template: pages.list (filter by templateId) → fan out the splice to every
 *               bound page. Per-page failures are collected, not fatal.
 */

import { execute } from "@caelo-cms/query-api";
import {
  type AddModuleToolInput,
  addModuleToolInput,
  type ExecutionContext,
  type ModuleField,
} from "@caelo-cms/shared";
import { blockNotFoundError } from "./_block-name-enum.js";
import { checkColdStartGate } from "./_cold-start-gate.js";
import { cssVarWarningSuffix } from "./_css-var-warnings.js";
import { describeError } from "./_describe-error.js";
import { designGuardSuffix } from "./_design-guard.js";
import {
  findUnrenderableLayoutFields,
  unrenderableLayoutFieldsError,
} from "./_layout-module-fields.js";
import { mintModuleFromHtml } from "./_mint-module.js";
import {
  MODULE_FIELDS_JSON_SCHEMA,
  MODULE_META_JSON_SCHEMA_PROPS,
} from "./_module-fields-schema.js";
import { MODULE_JS_CONTRACT } from "./_module-js-contract.js";
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

/** Resolved module + whether it was reused (no fresh CSS to review) or minted. */
interface ResolvedModule {
  moduleId: string;
  slug: string;
  note: string;
  css: string;
  kind: AddModuleToolInput["kind"];
  reused: boolean;
  /** The module's stored fields — echoed in every result so the main
   *  agent knows the content shape without a follow-up modules.get. */
  fields: readonly ModuleField[] | undefined;
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

/** Insert `moduleId` into `existing` at the requested position; returns new list + index. */
function spliceAt(
  existing: string[],
  moduleId: string,
  position: AddModuleToolInput["position"],
): { ids: string[]; idx: number } {
  const idx =
    position === "top"
      ? 0
      : position === "bottom"
        ? existing.length
        : Math.min(position, existing.length);
  return { ids: [...existing.slice(0, idx), moduleId, ...existing.slice(idx)], idx };
}

/** Rebuild the full block array for pages.set_modules, replacing one block's ids. */
function withBlockIds(
  blocks: PageWithModules["blocks"],
  blockName: string,
  ids: string[],
): { blockName: string; moduleIds: string[] }[] {
  return blocks.map((b) =>
    b.blockName === blockName
      ? { blockName: b.blockName, moduleIds: ids }
      : { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) },
  );
}

/** Resolve the reuse module id, or mint a new one from the authoring fields. */
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
          "The moduleId must come from `## Modules` or `list_modules` — to mint a new module instead, omit moduleId and pass displayName + html.",
      };
    }
    const mod = (
      got.value as { module: { id: string; slug: string; fields?: readonly ModuleField[] } }
    ).module;
    return {
      ok: true,
      module: {
        moduleId: mod.id,
        slug: mod.slug,
        note: "",
        css: input.css ?? "",
        kind: input.kind,
        reused: true,
        fields: mod.fields,
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
  const minted = await mintModuleFromHtml(ctx, toolCtx, {
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
  if (!minted.ok) return { ok: false, content: minted.content };
  return {
    ok: true,
    module: {
      moduleId: minted.moduleId,
      slug: minted.slug,
      note: minted.note,
      css: minted.css,
      kind: minted.kind,
      reused: false,
      fields: minted.fields,
    },
  };
}

export const addModuleTool: ToolDefinitionWithHandler<AddModuleToolInput> = {
  name: "add_module",
  description:
    "Add ONE module to a page, a layout (site-wide chrome on every page), or a template (fans out to every page of that page-type). " +
    "**Prefer `build_page` when a PAGE needs more than one module** — it places the whole ordered list WITH content in one transaction. " +
    "`target` = 'page' | 'layout' | 'template'. `targetRef` is the slug OR uuid of that page/layout/template (both resolve). " +
    "Two modes, on ALL three targets. **Reuse (check the catalog first):** pass `moduleId` of an existing module from `## Modules` to place/fan-out a SHARED module without minting a duplicate — a later edit_module then updates it everywhere at once. **Mint:** pass `html` (+ `displayName`, `kind`, and semantic snake_case `fields`) to author a new module and place it; raw HTML is fine, it is parametrised into {{fields}} automatically. `moduleId` and the authoring fields are mutually exclusive. " +
    "**The initial content comes IN THIS CALL, always via `values`** ({fieldName: value, …}): on 'page' it fills the placement's content_instance, on 'template' every fanned-out placement gets it, on 'layout' it is stored as the minted module's field defaults (chrome has no content_instance — so layout `values` require explicit `fields`, and are rejected with `moduleId` reuse: a shared module renders its stored defaults; edit_module changes them). A mint with fields but neither `values` nor field defaults is REJECTED — it would render empty placeholders until a second call. " +
    "`blockName` must be a real block on the target; the handler returns the available block set if it isn't. " +
    'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). Prefer a bare integer (`0`, not `"0"`).',
  // 2026-07 — STATIC on purpose (prompt-cache): the per-turn describe
  // embedded active-page blocks + layout/template slugs into the tool
  // definition, busting Anthropic's tools-prefix cache on every page
  // switch or structural write. The same facts live in the volatile
  // `# Current page` / `## Layouts` / `## Templates` context blocks and
  // list_layouts / list_templates; a blockName mismatch returns a
  // structured error naming the valid set.
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
        maxLength: 200,
        description: "Slug or uuid of the page / layout / template. Both forms resolve.",
      },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      position: {
        oneOf: [
          { type: "string", enum: ["top", "bottom"] },
          { type: "integer", minimum: 0, maximum: 1000 },
        ],
      },
      moduleId: { type: "string", format: "uuid" },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      ...MODULE_META_JSON_SCHEMA_PROPS,
      html: { type: "string", minLength: 1, maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      js: { type: "string", maxLength: 50_000, description: MODULE_JS_CONTRACT },
      bindThemeLiterals: { type: "boolean" },
      fields: MODULE_FIELDS_JSON_SCHEMA,
      values: {
        type: "object",
        additionalProperties: true,
        description:
          "Initial content, applied in the SAME call ({fieldName: value, …}) — the ONE place content goes on every target. page/template: fills the placement(s). layout: stored as the minted module's field defaults (requires explicit `fields`; not valid with moduleId reuse). A mint with fields but neither values nor defaults is rejected.",
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
    if (gate.blocked) return gate.gateResult!;

    const resolved = await resolveModule(ctx, toolCtx, input);
    if (!resolved.ok) return { ok: false, content: resolved.content };
    const mod = resolved.module;
    // CSS/design-guard suffixes only apply to freshly authored CSS.
    const suffix = mod.reused
      ? ""
      : `${await cssVarWarningSuffix(ctx, toolCtx, mod.css)}${await designGuardSuffix(ctx, toolCtx, { css: mod.css, displayName: input.displayName, kind: mod.kind, type: input.type })}`;
    const label = mod.reused ? "existing module" : "module";

    if (input.target === "page") return placeOnPage(ctx, toolCtx, input, mod, suffix, label);
    if (input.target === "layout") return placeOnLayout(ctx, toolCtx, input, mod, suffix, label);
    return placeOnTemplate(ctx, toolCtx, input, mod, suffix, label);
  },
};

async function placeOnPage(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  suffix: string,
  label: string,
): Promise<ToolResult> {
  const pageId = await resolvePageId(ctx, toolCtx, input.targetRef);
  if (pageId === null) return refNotFound("page", input.targetRef);
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
    pageId,
  });
  if (!got.ok)
    return { ok: false, content: `pages.get_with_modules failed: ${describeError(got.error)}` };
  const page = (got.value as { page: PageWithModules }).page;
  const targetBlock = page.blocks.find((b) => b.blockName === input.blockName);
  if (!targetBlock)
    return blockNotFoundError({
      blockName: input.blockName,
      blockNames: page.blocks.map((b) => b.blockName),
      pageId,
      argName: "blockName",
    });
  const { ids, idx } = spliceAt(
    targetBlock.modules.map((m) => m.moduleId),
    mod.moduleId,
    input.position,
  );
  const set = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
    pageId,
    blocks: withBlockIds(page.blocks, input.blockName, ids),
  });
  if (!set.ok)
    return { ok: false, content: `pages.set_modules failed: ${describeError(set.error)}` };
  // 2026-07 — apply the placement's initial content IN THIS CALL (a
  // fresh module must never render empty waiting for a second
  // set_page_module_content round-trip).
  let valuesNote = "";
  if (input.values !== undefined) {
    const fill = await fillPlacementValues(
      ctx,
      toolCtx,
      pageId,
      input.blockName,
      idx,
      input.values,
    );
    if (!fill.ok) return fill;
    valuesNote = " Initial content applied.";
  }
  return {
    ok: true,
    content: `${label} ${mod.moduleId} (slug=${mod.slug}) added to page block "${input.blockName}" at position ${idx}.${valuesNote}${fieldsSummary(mod.fields)}${mod.note}${suffix}`,
  };
}

/**
 * Fill a just-created placement's content_instance with the initial
 * values. Reads the placement back (branch-aware) to learn the instance
 * id pages.set_modules minted, then writes through the standard
 * set_values op so field-shape validation applies.
 */
async function fillPlacementValues(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  pageId: string,
  blockName: string,
  position: number,
  values: Record<string, unknown>,
): Promise<{ ok: true } | ToolResult> {
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
    pageId,
  });
  if (!got.ok)
    return { ok: false, content: `pages.get_with_modules failed: ${describeError(got.error)}` };
  const page = (got.value as { page: PageWithModules }).page;
  const block = page.blocks.find((b) => b.blockName === blockName);
  const placement = block?.modules[position] as { contentInstanceId?: string | null } | undefined;
  const instanceId = placement?.contentInstanceId;
  if (!instanceId) {
    return {
      ok: false,
      content: `placed the module, but could not resolve the new placement's content_instance to apply \`values\` — fill it via set_page_module_content({pageId: "${pageId}", blockName: "${blockName}", position: ${position}, values: …}).`,
    };
  }
  const write = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "content_instances.set_values",
    {
      id: instanceId,
      values,
    },
  );
  if (!write.ok) {
    return {
      ok: false,
      content: `placed the module, but applying \`values\` failed: ${describeError(write.error)}`,
    };
  }
  return { ok: true };
}

async function placeOnLayout(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  suffix: string,
  label: string,
): Promise<ToolResult> {
  const slug = await resolveLayoutSlug(ctx, toolCtx, input.targetRef);
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", { slug });
  if (!got.ok) return { ok: false, content: `layouts.get failed: ${describeError(got.error)}` };
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
  const existing = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.get", {
    layoutId: layout.id,
    blockName: input.blockName,
  });
  if (!existing.ok)
    return { ok: false, content: `layout_modules.get failed: ${describeError(existing.error)}` };
  const { ids, idx } = spliceAt(
    (existing.value as { moduleIds: string[] }).moduleIds,
    mod.moduleId,
    input.position,
  );
  const set = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.set", {
    layoutId: layout.id,
    blockName: input.blockName,
    moduleIds: ids,
  });
  if (!set.ok)
    return { ok: false, content: `layout_modules.set failed: ${describeError(set.error)}` };
  return {
    ok: true,
    content: `${label} ${mod.moduleId} (slug=${mod.slug}) added to layout "${layout.slug}" block "${input.blockName}" at position ${idx}; chrome now reaches every page on every template bound to this layout.${fieldsSummary(mod.fields)}${mod.note}${suffix}`,
  };
}

async function placeOnTemplate(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: AddModuleToolInput,
  mod: ResolvedModule,
  suffix: string,
  label: string,
): Promise<ToolResult> {
  const templateId = await resolveTemplateId(ctx, toolCtx, input.targetRef);
  if (templateId === null) return refNotFound("template", input.targetRef);
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
  if (!listed.ok)
    return { ok: false, content: `pages.list failed: ${describeError(listed.error)}` };
  const targetPages = (listed.value as { pages: PageRow[] }).pages.filter(
    (p) => p.templateId === templateId,
  );
  if (targetPages.length === 0) {
    return {
      ok: true,
      content: `${label} ${mod.moduleId} (slug=${mod.slug})${mod.reused ? "" : " created"}; no pages currently use this template, so nothing was placed.${mod.note}${suffix}`,
      nextAction: {
        tool: "list_templates",
        reason:
          "verify templateId points at the intended template; add_module target='page' can attach the module to a specific page instead",
      },
    };
  }
  const placements: string[] = [];
  const failures: string[] = [];
  for (const p of targetPages) {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: p.id,
    });
    if (!got.ok) {
      failures.push(`${p.slug} (${describeError(got.error)})`);
      continue;
    }
    const detail = (got.value as { page: PageWithModules }).page;
    const targetBlock = detail.blocks.find((b) => b.blockName === input.blockName);
    if (!targetBlock) {
      const allowed = detail.blocks.map((b) => b.blockName).join(", ");
      failures.push(
        `${p.slug} (block "${input.blockName}" not on this page's template — available: ${allowed})`,
      );
      continue;
    }
    const { ids, idx } = spliceAt(
      targetBlock.modules.map((m) => m.moduleId),
      mod.moduleId,
      input.position,
    );
    const set = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: p.id,
      blocks: withBlockIds(detail.blocks, input.blockName, ids),
    });
    if (set.ok) {
      // 2026-07 — the fan-out carries the initial copy too: every
      // created placement starts with the same values (unsynced, so
      // pages can diverge later).
      if (input.values !== undefined) {
        const fill = await fillPlacementValues(
          ctx,
          toolCtx,
          p.id,
          input.blockName,
          idx,
          input.values,
        );
        if (!fill.ok) {
          failures.push(`${p.slug} (placed, but values failed: ${fill.content})`);
          continue;
        }
      }
      placements.push(`${p.slug}@${idx}`);
    } else failures.push(`${p.slug} (${describeError(set.error)})`);
  }
  const summary = [
    `${label} ${mod.moduleId} (slug=${mod.slug}) added to block "${input.blockName}" on ${placements.length} of ${targetPages.length} pages using this template.${fieldsSummary(mod.fields)}${mod.note}${suffix}`,
    placements.length > 0 ? `placed: ${placements.join(", ")}` : null,
    failures.length > 0 ? `failed: ${failures.join("; ")}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join("\n");

  // When EVERY failure is "block not on this page's template" AND the block is
  // well-known layout-level chrome, the operator meant target='layout'. Surface
  // the corrected call so the AI re-dispatches instead of caveating a failure.
  const CHROME_BLOCKS = new Set(["header", "footer", "nav", "navigation", "sidebar", "banner"]);
  if (
    placements.length === 0 &&
    CHROME_BLOCKS.has(input.blockName.toLowerCase()) &&
    failures.every((f) => f.includes(`block "${input.blockName}" not on this page's template`))
  ) {
    return {
      ok: false,
      content: `${summary}\n[hint] "${input.blockName}" is layout-level chrome, not template-level. Re-dispatch with target='layout' — see nextAction.`,
      nextAction: {
        tool: "add_module",
        args: {
          target: "layout",
          targetRef: "site-default",
          blockName: input.blockName,
          position: input.position,
          ...(mod.reused
            ? { moduleId: mod.moduleId }
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
  return { ok: failures.length === 0, content: summary };
}

function refNotFound(target: string, ref: string): ToolResult {
  return {
    ok: false,
    content: `no ${target} found for targetRef "${ref}" — pass a valid slug or uuid (list_pages / list_layouts / list_templates).`,
  };
}

async function resolvePageId(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  ref: string,
): Promise<string | null> {
  if (UUID_RE.test(ref)) return ref;
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
  if (!listed.ok) return null;
  return (listed.value as { pages: PageRow[] }).pages.find((p) => p.slug === ref)?.id ?? null;
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
