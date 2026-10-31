// SPDX-License-Identifier: MPL-2.0

/**
 * Template Layer ops (CMS_REQUIREMENTS §3.4). Templates carry the document
 * skeleton; pages compose into them via `template_blocks` slots.
 */

import {
  defineOperation,
  OperationAbortError,
  type QueryError,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  ok,
  templateCreateSchema,
  templateUpdateSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { branchVisibilityFilter } from "../../branch.js";
import { loadListEntities, loadListEntityBySlug, persistListEntity } from "../../lists/store.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import { emitSnapshot, loadTemplateState } from "../../snapshots/index.js";
import type { PageTypeState } from "../../snapshots/state.js";
import { buildPatchSet } from "../../sql-helpers.js";
import { readSiteDefaults } from "../site_defaults.js";

const templateRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  /**
   * Epic #1107 — slugs of the page types (in the caller's view) whose
   * pages may use this template. Replaces the old `kind` tag.
   */
  pageTypes: z.array(z.string()),
  html: z.string(),
  css: z.string(),
  /** P6.7.6 — every template binds to one layout. */
  layoutId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  blocks: z.array(z.object({ name: z.string(), displayName: z.string(), position: z.number() })),
});

type RawTemplateRow = {
  id: string;
  slug: string;
  display_name: string;
  html: string;
  css: string;
  layout_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

type RawBlockRow = {
  template_id: string;
  name: string;
  display_name: string;
  position: number;
};

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowsToTemplates(
  templates: RawTemplateRow[],
  blocks: RawBlockRow[],
  pageTypesByTemplate: ReadonlyMap<string, string[]>,
): z.infer<typeof templateRowSchema>[] {
  const blockMap = new Map<string, { name: string; displayName: string; position: number }[]>();
  for (const b of blocks) {
    const arr = blockMap.get(b.template_id) ?? [];
    arr.push({ name: b.name, displayName: b.display_name, position: b.position });
    blockMap.set(b.template_id, arr);
  }
  for (const arr of blockMap.values()) arr.sort((a, b) => a.position - b.position);
  return templates.map((t) => {
    return {
      id: t.id,
      slug: t.slug,
      displayName: t.display_name,
      pageTypes: pageTypesByTemplate.get(t.id) ?? [],
      html: t.html,
      css: t.css,
      layoutId: t.layout_id,
      createdAt: iso(t.created_at),
      updatedAt: iso(t.updated_at),
      deletedAt: t.deleted_at === null ? null : iso(t.deleted_at),
      blocks: blockMap.get(t.id) ?? [],
    };
  });
}

/** Page type slugs per template id, as the caller sees the page types. */
async function pageTypesByTemplate(
  tx: TransactionRunner,
  ctx: ExecutionContext,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const t of await loadListEntities(tx, "pageType", ctx.chatBranchId ?? null)) {
    for (const id of t.state.definition.templates)
      out.set(id, [...(out.get(id) ?? []), t.state.slug]);
  }
  return out;
}

export const listTemplatesOp = defineOperation({
  name: "templates.list",
  readScope: "request",
  // CLAUDE.md §11: AI plans cross-template moves and needs broad read.
  // Plugin actors read too, like pages.list (#396): consent-manager checks
  // a tag scoped to templates against the templates that exist (#1138).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({ includeDeleted: z.boolean().default(false) }),
  output: z.object({ templates: z.array(templateRowSchema) }),
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware: chats see main + their own branched creates.
    const branchFilter = branchVisibilityFilter(ctx);
    const templates = (await tx.execute(
      input.includeDeleted
        ? sql`
            SELECT id::text AS id, slug, display_name, html, css,
                   layout_id::text AS layout_id,
                   created_at, updated_at, deleted_at
            FROM templates WHERE 1=1 ${branchFilter} ORDER BY created_at ASC
          `
        : sql`
            SELECT id::text AS id, slug, display_name, html, css,
                   layout_id::text AS layout_id,
                   created_at, updated_at, deleted_at
            FROM templates WHERE deleted_at IS NULL ${branchFilter} ORDER BY created_at ASC
          `,
    )) as unknown as RawTemplateRow[];
    const blocks = (await tx.execute(sql`
      SELECT template_id::text AS template_id, name, display_name, position
      FROM template_blocks
    `)) as unknown as RawBlockRow[];
    return ok({
      templates: rowsToTemplates(templates, blocks, await pageTypesByTemplate(tx, ctx)),
    });
  },
});

export const getTemplateOp = defineOperation({
  name: "templates.get",
  readScope: "request",
  // CLAUDE.md §11: AI reads template state when planning page changes.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ templateId: z.string().uuid() }),
  output: z.object({ template: templateRowSchema }),
  handler: async (ctx, input, tx) => {
    // v0.9.0 — branch-aware read.
    const branchFilter = branchVisibilityFilter(ctx);
    const templates = (await tx.execute(sql`
      SELECT id::text AS id, slug, display_name, html, css,
             layout_id::text AS layout_id,
             created_at, updated_at, deleted_at
      FROM templates WHERE id = ${input.templateId}::uuid ${branchFilter} LIMIT 1
    `)) as unknown as RawTemplateRow[];
    if (templates.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.get",
        message: "template not found",
      });
    }
    const blocks = (await tx.execute(sql`
      SELECT template_id::text AS template_id, name, display_name, position
      FROM template_blocks WHERE template_id = ${input.templateId}::uuid
    `)) as unknown as RawBlockRow[];
    const composed = rowsToTemplates(templates, blocks, await pageTypesByTemplate(tx, ctx));
    const template = composed[0];
    if (!template) {
      return err({
        kind: "HandlerError",
        operation: "templates.get",
        message: "template not found",
      });
    }
    return ok({ template });
  },
});

export const createTemplateOp = defineOperation({
  name: "templates.create",
  readScope: "request",
  // P18 AI-completeness — widened to default scope per CLAUDE.md §11.
  // Creating a NEW template doesn't affect existing pages (they bind by
  // id, not slug); the user just gets a new page-type to compose against.
  // Owner gating still applies to `templates.update` (HTML/CSS rewrites
  // ARE hard-to-revert and cascade across bound pages — that op stays
  // human-only until a §11.A propose/execute gate ships for templates).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: templateCreateSchema,
  output: z.object({ templateId: z.string() }),
  handler: async (ctx, input, tx) => {
    // v0.9.0 — same-branch uniqueness only (each branch + main own their
    // own slug namespace per migration 0089).
    const dupNamespace = ctx.chatBranchId ?? "00000000-0000-0000-0000-000000000000";
    const dup = (await tx.execute(sql`
      SELECT 1 FROM templates
      WHERE slug = ${input.slug}
        AND deleted_at IS NULL
        AND COALESCE(chat_branch_id, '00000000-0000-0000-0000-000000000000'::uuid) = ${dupNamespace}::uuid
      LIMIT 1
    `)) as unknown as { exists: number }[];
    if (dup.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "templates.create",
        input,
        succeeded: false,
        resultSummary: "slug-already-exists",
      });
      return err({
        kind: "HandlerError",
        operation: "templates.create",
        message: "slug already in use",
      });
    }
    // P6.7.6 — every template binds to one layout. Caller may pass an
    // explicit layoutId; otherwise resolve to site_defaults at create
    // time. Fail loudly if neither is available — no silent fallback.
    let layoutId = input.layoutId;
    if (layoutId === undefined) {
      const defaults = await readSiteDefaults(tx);
      if (!defaults) {
        // v0.6.0 W3 — autoExecute the read-only recovery so the chat-
        // runner can self-correct without an extra AI round-trip. The
        // runner calls list_layouts, picks the first id, and retries
        // templates.create with that explicit layoutId. If no layouts
        // exist at all, list_layouts returns empty and the second
        // attempt surfaces a clean "no layouts on this site" message
        // — the AI then knows to call create_layout first.
        return err({
          kind: "HandlerError",
          operation: "templates.create",
          message:
            "no layoutId provided and site_defaults is empty — seed site_defaults via /settings/site-defaults or pass an explicit layoutId",
          nextAction: {
            tool: "list_layouts",
            reason:
              "fetch the available layouts so a UUID can be passed explicitly as layoutId on the retry",
            autoExecute: true,
            // v0.6.0 alpha.2 — declarative retry: chat-runner extracts
            // the first layout's id from list_layouts.value and
            // re-dispatches templates.create with layoutId set. AI
            // never sees the original failure.
            retryWithArgs: { argName: "layoutId", fromValuePath: "layouts.0.id" },
          },
        });
      }
      layoutId = defaults.defaultLayoutId;
    } else {
      const layoutOk = (await tx.execute(sql`
        SELECT 1 FROM layouts WHERE id = ${layoutId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { exists: number }[];
      if (layoutOk.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "templates.create",
          message: "layout not found or deleted",
          nextAction: {
            tool: "list_layouts",
            reason: "fetch valid layoutId values; the one you passed does not match a live layout",
            autoExecute: true,
          },
        });
      }
    }
    // v0.9.0 — branched-create: branched until chat.merge_to_main
    // clears the chat_branch_id tag.
    const rows = (await tx.execute(sql`
      INSERT INTO templates (slug, display_name, html, css, layout_id, chat_branch_id)
      VALUES (
        ${input.slug},
        ${input.displayName},
        ${input.html},
        ${input.css},
        ${layoutId}::uuid,
        ${ctx.chatBranchId ?? null}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const templateId = rows[0]?.id;
    if (!templateId) {
      return err({
        kind: "HandlerError",
        operation: "templates.create",
        message: "no id returned",
      });
    }
    // v0.5.21 — auto-derive template_blocks from <caelo-slot name="X">
    // tags in the HTML. Pre-v0.5.21 templates.create created the
    // template row but no block rows; the AI's follow-up
    // add_module_to_page("content") rejected because the block
    // didn't exist. Block names are deduped + ordered by first
    // appearance in HTML; positions are 0-based ascending.
    const slotNames: string[] = [];
    const seenSlots = new Set<string>();
    const slotPattern = /<caelo-slot\s+name=["']([^"']+)["']/gi;
    for (const match of input.html.matchAll(slotPattern)) {
      const name = match[1];
      if (name && !seenSlots.has(name)) {
        seenSlots.add(name);
        slotNames.push(name);
      }
    }
    // Optional `blocks` metadata SYMMETRIC with create_layout: each entry
    // enriches the derived block's display_name + position. Its `name` MUST
    // match a <caelo-slot> — a declared block with no slot renders nothing,
    // so we reject the mismatch loudly rather than silently drop it
    // (CLAUDE.md §2 no-fallbacks). When `blocks` is omitted, every slot
    // derives display_name = name, position = order of appearance (unchanged).
    const blockMeta = new Map((input.blocks ?? []).map((b) => [b.name, b]));
    const orphan = (input.blocks ?? []).find((b) => !seenSlots.has(b.name));
    if (orphan) {
      return err({
        kind: "HandlerError",
        operation: "templates.create",
        message: `blocks[] entry "${orphan.name}" has no matching <caelo-slot name="${orphan.name}"> in html — a block with no slot renders nothing. Add the slot tag or drop the block.`,
      });
    }
    for (let i = 0; i < slotNames.length; i++) {
      const blockName = slotNames[i];
      if (!blockName) continue;
      const meta = blockMeta.get(blockName);
      const displayName = meta?.displayName ?? blockName;
      const position = meta?.position ?? i;
      await tx.execute(sql`
        INSERT INTO template_blocks (template_id, name, display_name, position)
        VALUES (${templateId}::uuid, ${blockName}, ${displayName}, ${position})
        ON CONFLICT DO NOTHING
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.create",
      input,
      succeeded: true,
      entityId: templateId,
      resultSummary: `slug=${input.slug} blocks=${slotNames.length}`,
    });
    const state = await loadTemplateState(tx, templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.create",
        description: `templates.create slug=${input.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "template", entityId: templateId, state }],
      });
    }
    // Epic #1107 — the template serves a page type: the named one, else
    // the site's default page type (stored data).
    const added = await addTemplateToPageType(
      ctx,
      tx,
      templateId,
      input.pageType,
      "templates.create",
    );
    if (!added.ok) throw new OperationAbortError(added.error);
    return ok({ templateId });
  },
});

export const updateTemplateOp = defineOperation({
  name: "templates.update",
  readScope: "request",
  // Why human-only: §11.A — a template edit cascades to every page on it; the AI edits through
  // propose_update_template (Owner-approved) and re-points layouts via templates.set_layout.
  // Human-only writes. AI re-points layouts via the narrow
  // `templates.set_layout` op below — never via this surface.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: templateUpdateSchema,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // v0.5.0 — per-entity lock.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "template",
      entityId: input.templateId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(tx, "templates.update", "template", input.templateId, lock),
      );
    }
    const existing = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (existing.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.update",
        message: "template not found",
      });
    }
    if (input.layoutId !== undefined) {
      const layoutOk = (await tx.execute(sql`
        SELECT 1 FROM layouts WHERE id = ${input.layoutId}::uuid AND deleted_at IS NULL LIMIT 1
      `)) as unknown as { exists: number }[];
      if (layoutOk.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "templates.update",
          message: "layout not found or deleted",
        });
      }
    }
    const sets = buildPatchSet({
      display_name: input.displayName,
      html: input.html,
      css: input.css,
      layout_id: input.layoutId !== undefined ? sql`${input.layoutId}::uuid` : undefined,
    });
    // buildPatchSet returns an empty fragment when nothing changed —
    // running an UPDATE with no SETs is invalid SQL. Skip the UPDATE
    // when only `blocks` was provided.
    const hasScalarPatch =
      input.displayName !== undefined ||
      input.html !== undefined ||
      input.css !== undefined ||
      input.layoutId !== undefined;
    if (hasScalarPatch) {
      await tx.execute(sql`
        UPDATE templates SET ${sets} WHERE id = ${input.templateId}::uuid
      `);
    }
    // v0.2.65 — Atomic block-set replace when the payload includes
    // blocks. Same DELETE-then-INSERT shape as `template_blocks.set`;
    // running it inside the same transaction means a partial failure
    // leaves zero changes (the propose/execute pattern guarantees
    // atomicity per CLAUDE.md §11.A).
    if (input.blocks !== undefined) {
      const seen = new Set<string>();
      for (const b of input.blocks) {
        if (seen.has(b.name)) {
          return err({
            kind: "HandlerError",
            operation: "templates.update",
            message: `duplicate block name in blocks payload: ${b.name}`,
          });
        }
        seen.add(b.name);
      }
      await tx.execute(
        sql`DELETE FROM template_blocks WHERE template_id = ${input.templateId}::uuid`,
      );
      for (const b of input.blocks) {
        await tx.execute(sql`
          INSERT INTO template_blocks (template_id, name, display_name, position)
          VALUES (${input.templateId}::uuid, ${b.name}, ${b.displayName}, ${b.position})
        `);
      }
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.update",
      input,
      succeeded: true,
      entityId: input.templateId,
    });
    const state = await loadTemplateState(tx, input.templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.update",
        description: `templates.update slug=${state.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "template", entityId: input.templateId, state }],
      });
    }
    if (input.pageType !== undefined) {
      const added = await addTemplateToPageType(
        ctx,
        tx,
        input.templateId,
        input.pageType,
        "templates.update",
      );
      if (!added.ok) throw new OperationAbortError(added.error);
    }
    return ok({});
  },
});

/**
 * Epic #1107 — append a template to a page type's `templates` (a page
 * type write: lock, snapshot, in the caller's view). `pageTypeSlug`
 * undefined = the site's default page type. A no-op when already listed.
 */
async function addTemplateToPageType(
  ctx: Parameters<typeof createTemplateOp.handler>[0],
  tx: Parameters<typeof createTemplateOp.handler>[2],
  templateId: string,
  pageTypeSlug: string | undefined,
  operation: string,
): Promise<{ ok: true } | { ok: false; error: QueryError }> {
  const branchId = ctx.chatBranchId ?? null;
  let type: Awaited<ReturnType<typeof loadListEntityBySlug<"pageType">>>;
  if (pageTypeSlug === undefined) {
    const defaults = await readSiteDefaults(tx);
    const all = await loadListEntities(tx, "pageType", branchId);
    type = all.find((t) => t.id === defaults?.defaultPageTypeId) ?? null;
    if (!type) {
      return {
        ok: false,
        error: {
          kind: "HandlerError",
          operation,
          message:
            "the site has no default page type to put the template in — pass pageType (page_types.list shows the page types)",
        },
      };
    }
  } else {
    type = await loadListEntityBySlug(tx, "pageType", branchId, pageTypeSlug);
    if (!type) {
      const known = (await loadListEntities(tx, "pageType", branchId)).map((t) => t.state.slug);
      return {
        ok: false,
        error: {
          kind: "HandlerError",
          operation,
          // #1177 — a page type lists at least one template, so it cannot
          // be created before its first template: name the order that works.
          message: `no page type "${pageTypeSlug}" — the site has ${known.join(", ") || "none"}. Use one of those, or leave pageType out (the template joins the default page type) and then create "${pageTypeSlug}" with page_types.upsert_many, listing this template's id in its templates.`,
        },
      };
    }
  }
  if (type.state.definition.templates.includes(templateId)) return { ok: true };
  const lock = await checkAndAcquireEntityLock(tx, {
    kind: "pageType",
    entityId: type.id,
    chatBranchId: ctx.chatBranchId,
    holderKey: ctx.chatTaskId,
  });
  if (!lock.permitted) {
    return {
      ok: false,
      error: await entityWriteBlockedError(tx, operation, "pageType", type.id, lock),
    };
  }
  const state: PageTypeState = {
    ...type.state,
    definition: {
      ...type.state.definition,
      templates: [...type.state.definition.templates, templateId],
    },
    version: type.state.version + 1,
  };
  const entity = await persistListEntity(
    tx,
    ctx.actorId,
    branchId,
    { kind: "pageType", entityId: type.id, state },
    false,
  );
  await emitSnapshot(tx, {
    actorId: ctx.actorId,
    opKind: operation === "templates.create" ? "templates.create" : "templates.update",
    description: `${operation} → page type ${type.state.slug}`,
    chatTaskId: ctx.chatTaskId ?? null,
    chatBranchId: branchId,
    entities: [entity],
  });
  return { ok: true };
}

/**
 * P6.7.6 review pass — narrow AI-allowed surface for re-pointing a
 * template's layout. Distinct from `templates.update` so the AI cannot
 * smuggle html/css/displayName patches through a layout-targeting tool.
 */
export const setTemplateLayoutOp = defineOperation({
  name: "templates.set_layout",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      templateId: z.string().uuid(),
      layoutId: z.string().uuid(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const tplOk = (await tx.execute(sql`
      SELECT 1 FROM templates WHERE id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (tplOk.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.set_layout",
        message: "template not found",
      });
    }
    const layoutOk = (await tx.execute(sql`
      SELECT 1 FROM layouts WHERE id = ${input.layoutId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (layoutOk.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "templates.set_layout",
        message: "layout not found or deleted",
      });
    }
    await tx.execute(sql`
      UPDATE templates
      SET layout_id = ${input.layoutId}::uuid, updated_at = now()
      WHERE id = ${input.templateId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.set_layout",
      input,
      succeeded: true,
      entityId: input.templateId,
      resultSummary: `layout=${input.layoutId}`,
    });
    const state = await loadTemplateState(tx, input.templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.update",
        description: `templates.set_layout slug=${state.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "template", entityId: input.templateId, state }],
      });
    }
    return ok({});
  },
});

export const deleteTemplateOp = defineOperation({
  name: "templates.delete",
  readScope: "request",
  // Why human-only: Owner-only — large blast radius (every page on the template fails).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ templateId: z.string().uuid() }),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // v0.5.0 — per-entity lock.
    const lock = await checkAndAcquireEntityLock(tx, {
      kind: "template",
      entityId: input.templateId,
      chatBranchId: ctx.chatBranchId,
      holderKey: ctx.chatTaskId,
    });
    if (!lock.permitted) {
      return err(
        await entityWriteBlockedError(tx, "templates.delete", "template", input.templateId, lock),
      );
    }
    const inUse = (await tx.execute(sql`
      SELECT 1 FROM pages WHERE template_id = ${input.templateId}::uuid AND deleted_at IS NULL LIMIT 1
    `)) as unknown as { exists: number }[];
    if (inUse.length > 0) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "templates.delete",
        input,
        succeeded: false,
        entityId: input.templateId,
        resultSummary: "template-in-use",
      });
      return err({
        kind: "HandlerError",
        operation: "templates.delete",
        message: "template is referenced by one or more active pages",
      });
    }
    const rows = (await tx.execute(sql`
      SELECT deleted_at FROM templates WHERE id = ${input.templateId}::uuid
    `)) as unknown as { deleted_at: Date | null }[];
    const target = rows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "templates.delete",
        message: "template not found",
      });
    }
    if (target.deleted_at !== null) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "templates.delete",
        input,
        succeeded: true,
        entityId: input.templateId,
        resultSummary: "already-deleted",
      });
      return ok({});
    }
    // Epic #1107 — page types stop listing the template. A type for which
    // it is the default (or the only) template cannot lose it silently.
    const listing = (await loadListEntities(tx, "pageType", ctx.chatBranchId ?? null)).filter((t) =>
      t.state.definition.templates.includes(input.templateId),
    );
    for (const t of listing) {
      if (t.state.definition.defaultTemplate === input.templateId) {
        return err({
          kind: "HandlerError",
          operation: "templates.delete",
          refusal: true,
          message: `page type "${t.state.slug}" uses this template as its defaultTemplate — make another of its templates the default first (page_types.upsert_many), then retry.`,
        });
      }
    }
    for (const t of listing) {
      const state: PageTypeState = {
        ...t.state,
        definition: {
          ...t.state.definition,
          templates: t.state.definition.templates.filter((id) => id !== input.templateId),
        },
        version: t.state.version + 1,
      };
      const entity = await persistListEntity(
        tx,
        ctx.actorId,
        ctx.chatBranchId ?? null,
        { kind: "pageType", entityId: t.id, state },
        false,
      );
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.delete",
        description: `templates.delete → page type ${t.state.slug} drops the template`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [entity],
      });
    }
    await tx.execute(sql`
      UPDATE templates SET deleted_at = now() WHERE id = ${input.templateId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "templates.delete",
      input,
      succeeded: true,
      entityId: input.templateId,
      resultSummary: "soft-deleted",
    });
    const state = await loadTemplateState(tx, input.templateId);
    if (state) {
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "templates.delete",
        description: `templates.delete slug=${state.slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: ctx.chatBranchId ?? null,
        entities: [{ kind: "template", entityId: input.templateId, state }],
      });
    }
    return ok({});
  },
});
