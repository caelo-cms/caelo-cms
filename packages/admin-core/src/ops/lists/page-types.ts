// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — `page_types.*` ops (docs/lists.md §5, §12). A page type
 * says what a page IS (News, Product, Doc): its properties, the
 * vocabularies whose terms apply and the templates it may use. Page
 * queries filter on it and the AI reads "this module sits on three News
 * pages" from it (CLAUDE.md §1A).
 *
 * Changing a type that pages use re-checks every one of those pages in the
 * caller's view, like list types do for lists: a new property's default is
 * written into them; dropping a template they use is refused (move them
 * first); dropping a property or vocabulary they hold values for is
 * refused unless `dropValues`. Writes need `content.structure`.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { checkPageTypeDef, ok, type PageTypeDef, pageTypeDefSchema } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { fitPageToType, loadVocabularyIndex } from "../../lists/page-fit.js";
import { parseTermRef } from "../../lists/page-terms.js";
import { loadPagesInView } from "../../lists/pages-view.js";
import {
  loadListEntities,
  loadListEntityBySlug,
  loadListEntityForUpsert,
  persistListEntity,
} from "../../lists/store.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../../locks.js";
import { emitSnapshot } from "../../snapshots/index.js";
import type { PageTypeState } from "../../snapshots/state.js";
import { updatePageOp } from "../content/pages.js";
import { structureWriteRefusal } from "./_permission.js";
import { branchOf, failBatch, handlerError, listTypesBySlug, type Tx } from "./_shared.js";

const pageTypeRowSchema = pageTypeDefSchema.extend({
  id: z.string(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
  /** Pages of this type the caller sees. */
  pageCount: z.number().int().nonnegative(),
  /** Vocabulary list slugs, in `vocabularies` order. */
  vocabularySlugs: z.array(z.string()),
});

async function rows(
  tx: Tx,
  branchId: string | null,
  filter: (def: PageTypeDef) => boolean,
): Promise<z.infer<typeof pageTypeRowSchema>[]> {
  const types = (await loadListEntities(tx, "pageType", branchId)).filter((t) =>
    filter(t.state.definition),
  );
  const pages = await loadPagesInView(tx, branchId);
  const counts = new Map<string, number>();
  for (const p of pages) counts.set(p.pageTypeId, (counts.get(p.pageTypeId) ?? 0) + 1);
  const listSlugs = new Map(
    (await loadListEntities(tx, "list", branchId)).map((l) => [l.id, l.state.slug]),
  );
  return types.map((t) => ({
    ...t.state.definition,
    id: t.id,
    version: t.state.version,
    updatedAt: t.updatedAt,
    pageCount: counts.get(t.id) ?? 0,
    vocabularySlugs: t.state.definition.vocabularies.map((v) => listSlugs.get(v.list) ?? v.list),
  }));
}

// ─── page_types.list ─────────────────────────────────────────────────

export const listPageTypesOp = defineOperation({
  name: "page_types.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ query: z.string().min(1).max(128).optional() }).strict(),
  output: z.object({ pageTypes: z.array(pageTypeRowSchema) }),
  handler: async (ctx, input, tx) => {
    const q = input.query?.toLowerCase();
    return ok({
      pageTypes: await rows(
        tx,
        branchOf(ctx),
        (def) =>
          q === undefined || `${def.slug} ${def.name} ${def.purpose}`.toLowerCase().includes(q),
      ),
    });
  },
});

// ─── page_types.get ──────────────────────────────────────────────────

export const getPageTypeOp = defineOperation({
  name: "page_types.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(64) }).strict(),
  output: z.object({
    pageType: pageTypeRowSchema,
    samplePages: z.array(z.object({ pageId: z.string(), path: z.string(), title: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    const branchId = branchOf(ctx);
    const [row] = await rows(tx, branchId, (def) => def.slug === input.slug);
    if (!row) {
      const known = (await loadListEntities(tx, "pageType", branchId)).map((t) => t.state.slug);
      return {
        ok: false,
        error: handlerError(
          "page_types.get",
          `no page type "${input.slug}" — the site has ${known.join(", ") || "none"}. Use one of those, or create it with page_types.upsert_many.`,
        ),
      };
    }
    const pages = (await loadPagesInView(tx, branchId, { pageTypeIds: [row.id] })).slice(0, 5);
    return ok({
      pageType: row,
      samplePages: pages.map((p) => ({ pageId: p.id, path: p.currentPath, title: p.title })),
    });
  },
});

// ─── page_types.upsert_many ──────────────────────────────────────────

const upsertItemSchema = pageTypeDefSchema.extend({
  expectedVersion: z.number().int().positive().optional(),
});

/**
 * Create or replace page types, one transaction. A replaced definition is
 * checked against every page of the type (see the file header).
 */
export const upsertPageTypesManyOp = defineOperation({
  name: "page_types.upsert_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageTypes: z.array(upsertItemSchema).min(1).max(50),
      /** Allow deleting property values / terms the new definition has no place for. */
      dropValues: z.boolean().default(false),
    })
    .strict(),
  output: z.object({
    pageTypes: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        version: z.number().int().positive(),
        created: z.boolean(),
        pagesRewritten: z.number().int().nonnegative(),
      }),
    ),
  }),
  handler: async (ctx, input, tx) => {
    const op = "page_types.upsert_many";
    const refusal = await structureWriteRefusal(tx, ctx, op);
    if (refusal) return { ok: false, error: handlerError(op, refusal, true) };
    const branchId = branchOf(ctx);
    const out: {
      id: string;
      slug: string;
      version: number;
      created: boolean;
      pagesRewritten: number;
    }[] = [];
    let wrote = false;
    const seen = new Set<string>();
    for (const [i, item] of input.pageTypes.entries()) {
      const { expectedVersion, ...def } = item;
      const at = `pageTypes[${i}] ("${def.slug}")`;
      if (seen.has(def.slug)) {
        return failBatch(
          wrote,
          handlerError(op, `${at}: slug appears twice in this call — send each page type once.`),
        );
      }
      seen.add(def.slug);
      const issues = [
        ...checkPageTypeDef(def).map((x) => `${x.path}: ${x.message}`),
        ...(await checkReferences(tx, branchId, def)),
      ];
      if (issues.length > 0) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `${at}: ${issues.slice(0, 8).join("; ")}. Fix the definition and resend the whole batch.`,
          ),
        );
      }
      const found = await loadListEntityForUpsert(tx, "pageType", branchId, def.slug);
      const existing = found && found.state.deletedAt === null ? found : null;
      if (expectedVersion !== undefined && (existing?.state.version ?? 0) !== expectedVersion) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `Conflict: ${at} is at version ${existing?.state.version ?? "none (it does not exist)"}, not ${expectedVersion} — it changed since you read it. Read it again (page_types.get) and redo your change on top of it.`,
          ),
        );
      }
      const id = found?.id ?? crypto.randomUUID();
      if (found) {
        const lock = await checkAndAcquireEntityLock(tx, {
          kind: "pageType",
          entityId: id,
          chatBranchId: branchId,
          holderKey: ctx.chatTaskId,
        });
        if (!lock.permitted) {
          return failBatch(wrote, await entityWriteBlockedError(tx, op, "pageType", id, lock));
        }
      }

      // Re-check the type's pages against the new definition.
      const pages = existing ? await loadPagesInView(tx, branchId, { pageTypeIds: [id] }) : [];
      const vocabularies = await loadVocabularyIndex(tx, branchId, [def]);
      const blocked: string[] = [];
      const rewrites: { pageId: string; properties: Record<string, unknown>; terms: string[] }[] =
        [];
      for (const p of pages) {
        const label = `page ${p.currentPath} (${p.id})`;
        const removed: string[] = [];
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p.properties)) {
          if (def.properties.some((f) => f.name === k)) properties[k] = v;
          else removed.push(`property "${k}"`);
        }
        const keptLists = new Set(def.vocabularies.map((v) => v.list));
        const terms = p.terms.filter((t) => keptLists.has(parseTermRef(t)?.listId ?? ""));
        if (terms.length !== p.terms.length)
          removed.push(`${p.terms.length - terms.length} term(s)`);
        if (removed.length > 0 && !input.dropValues) {
          blocked.push(`${label} holds ${removed.join(", ")} the new definition drops`);
          continue;
        }
        const fit = fitPageToType(
          def,
          {
            templateId: p.templateId,
            properties: input.dropValues ? properties : p.properties,
            terms: input.dropValues ? terms : [...p.terms],
          },
          vocabularies,
        );
        if (fit.issues.length > 0) {
          blocked.push(`${label}: ${fit.issues.slice(0, 2).join(" ")}`);
          continue;
        }
        if (
          JSON.stringify(fit.properties) !== JSON.stringify(p.properties) ||
          JSON.stringify(fit.terms) !== JSON.stringify(p.terms)
        ) {
          rewrites.push({ pageId: p.id, properties: fit.properties, terms: fit.terms });
        }
      }
      if (blocked.length > 0) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `${at}: ${blocked.length} page(s) of this type would not fit the new definition — ${blocked.slice(0, 6).join("; ")}${blocked.length > 6 ? `; and ${blocked.length - 6} more` : ""}. ` +
              "Move them to an allowed template or another page type first (pages.update_many), give new required properties a default, or resend with dropValues: true to delete the dropped values.",
            true,
          ),
        );
      }

      const state: PageTypeState = {
        schemaVersion: 1,
        slug: def.slug,
        definition: def,
        version: (found?.state.version ?? 0) + 1,
        deletedAt: null,
      };
      const entity = await persistListEntity(
        tx,
        ctx.actorId,
        branchId,
        { kind: "pageType", entityId: id, state },
        found === null,
      );
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "page_types.upsert_many",
        description: `page_types.upsert_many ${def.slug}${existing ? "" : " (new)"}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: [entity],
      });
      wrote = true;
      // Pages written AFTER the type: pages.update checks them against it.
      for (const rw of rewrites) {
        const page = pages.find((p) => p.id === rw.pageId);
        const patch: Record<string, unknown> = { ...rw.properties };
        for (const k of Object.keys(page?.properties ?? {})) if (!(k in patch)) patch[k] = null;
        const r = await updatePageOp.handler(
          ctx,
          { pageId: rw.pageId, properties: patch, terms: rw.terms },
          tx,
        );
        if (!r.ok) {
          return failBatch(
            wrote,
            handlerError(
              op,
              `${at}: updating page ${rw.pageId} failed: ${"message" in r.error ? r.error.message : r.error.kind}`,
            ),
          );
        }
      }
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: item,
        succeeded: true,
        entityId: id,
        resultSummary: `${def.slug} v${state.version} pages=${rewrites.length}${branchId ? " (branch)" : ""}`,
      });
      out.push({
        id,
        slug: def.slug,
        version: state.version,
        created: existing === null,
        pagesRewritten: rewrites.length,
      });
    }
    return ok({ pageTypes: out });
  },
});

/** Templates and vocabulary lists a definition names must exist in the caller's view. */
async function checkReferences(
  tx: Tx,
  branchId: string | null,
  def: PageTypeDef,
): Promise<string[]> {
  const issues: string[] = [];
  const visible = branchId
    ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)`
    : sql`chat_branch_id IS NULL`;
  const tpl = (await tx.execute(sql`
    SELECT id::text AS id FROM templates
    WHERE deleted_at IS NULL AND ${visible} AND id IN (${sql.join(
      def.templates.map((t) => sql`${t}::uuid`),
      sql`, `,
    )})
  `)) as unknown as { id: string }[];
  const have = new Set(tpl.map((t) => t.id));
  for (const t of def.templates) {
    if (!have.has(t)) {
      issues.push(
        `templates: ${t} is not a template of this site (or was deleted) — list_templates shows the templates.`,
      );
    }
  }
  if (def.vocabularies.length > 0) {
    const types = await listTypesBySlug(tx, branchId);
    const roleOf = new Map([...types.values()].map((t) => [t.id, t.def.role]));
    const lists = await loadListEntities(tx, "list", branchId, {
      ids: def.vocabularies.map((v) => v.list),
    });
    for (const v of def.vocabularies) {
      const l = lists.find((x) => x.id === v.list);
      if (!l) {
        issues.push(
          `vocabularies: list ${v.list} does not exist — create the vocabulary (lists.upsert_many with type categories or tags) and use its id.`,
        );
      } else if (roleOf.get(l.state.listTypeId) !== "vocabulary") {
        issues.push(
          `vocabularies: list "${l.state.slug}" is not a vocabulary (its type's role is not "vocabulary") — use a categories / tags list.`,
        );
      }
    }
  }
  return issues;
}

// ─── page_types.delete_many ──────────────────────────────────────────

export const deletePageTypesManyOp = defineOperation({
  name: "page_types.delete_many",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slugs: z.array(z.string().min(1).max(64)).min(1).max(50) }).strict(),
  output: z.object({ deleted: z.array(z.string()) }),
  handler: async (ctx, input, tx) => {
    const op = "page_types.delete_many";
    const refusal = await structureWriteRefusal(tx, ctx, op);
    if (refusal) return { ok: false, error: handlerError(op, refusal, true) };
    const branchId = branchOf(ctx);
    const defaults = (await tx.execute(sql`
      SELECT default_page_type_id::text AS id FROM site_defaults WHERE id = 1
    `)) as unknown as { id: string }[];
    const deleted: string[] = [];
    let wrote = false;
    for (const slug of [...new Set(input.slugs)]) {
      const t = await loadListEntityBySlug(tx, "pageType", branchId, slug);
      if (!t) {
        return failBatch(
          wrote,
          handlerError(op, `no page type "${slug}" — page_types.list shows the ones that exist.`),
        );
      }
      if (defaults[0]?.id === t.id) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `page type "${slug}" is the site's default for new pages — make another page type the default first (set_site_defaults), then retry.`,
            true,
          ),
        );
      }
      const pages = await loadPagesInView(tx, branchId, { pageTypeIds: [t.id] });
      if (pages.length > 0) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `page type "${slug}" is used by ${pages.length} page(s): ${pages
              .slice(0, 8)
              .map((p) => p.currentPath)
              .join(
                ", ",
              )}${pages.length > 8 ? ", …" : ""}. Move them to another page type (pages.update_many with pageType) or delete them, then retry.`,
            true,
          ),
        );
      }
      const lock = await checkAndAcquireEntityLock(tx, {
        kind: "pageType",
        entityId: t.id,
        chatBranchId: branchId,
        holderKey: ctx.chatTaskId,
      });
      if (!lock.permitted) {
        return failBatch(wrote, await entityWriteBlockedError(tx, op, "pageType", t.id, lock));
      }
      const state: PageTypeState = {
        ...t.state,
        version: t.state.version + 1,
        deletedAt: new Date().toISOString(),
      };
      const entity = await persistListEntity(
        tx,
        ctx.actorId,
        branchId,
        { kind: "pageType", entityId: t.id, state },
        false,
      );
      await emitSnapshot(tx, {
        actorId: ctx.actorId,
        opKind: "page_types.delete_many",
        description: `page_types.delete_many ${slug}`,
        chatTaskId: ctx.chatTaskId ?? null,
        chatBranchId: branchId,
        entities: [entity],
      });
      wrote = true;
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: { slug },
        succeeded: true,
        entityId: t.id,
        resultSummary: `deleted ${slug}${branchId ? " (branch)" : ""}`,
      });
      deleted.push(slug);
    }
    return ok({ deleted });
  },
});
