// SPDX-License-Identifier: MPL-2.0

/**
 * #1752 — `page_types.set_seo_many`: the SEO a page inherits when it has
 * none of its own, per page type and site-wide, in one call (CLAUDE.md §11
 * bulk first).
 *
 *  - A page type's `seo` (`PageTypeDef.seo`, seo-head.ts): the title
 *    template of its pages without their own SEO title, and their
 *    `og:type`. Draft state like the rest of the page type: in a chat the
 *    write is a pending page type change on the chat's branch, merged by
 *    the Stage, undone with the chat, reverted like any page type write.
 *  - The site's title template (`site_defaults.seo_title_template`): the
 *    `<title>` of pages whose page type has none. A site setting that
 *    renders into page HTML, like the site name and language: written
 *    here, live with the next Stage and the operator's Publish live.
 *
 * Routine (CLAUDE.md §11.A test: one call sets the old template back), and
 * a structure write like every page type write (`content.structure`).
 */

import { defineOperation, OperationAbortError } from "@caelo-cms/query-api";
import {
  OG_TYPES,
  ok,
  type PageTypeDef,
  titleTemplateSchema,
  titleTemplateVariables,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { loadListEntityForUpsert, persistListEntity } from "../lists/store.js";
import { checkAndAcquireEntityLock, entityWriteBlockedError } from "../locks.js";
import { loadSiteSeoHeadSettings } from "../seo/page-seo-head.js";
import { emitSnapshot } from "../snapshots/index.js";
import type { PageTypeState } from "../snapshots/state.js";
import { structureWriteRefusal } from "./lists/_permission.js";
import { branchOf, conflictError, failBatch, handlerError } from "./lists/_shared.js";

const itemSchema = z
  .object({
    /** The page type's slug. */
    pageType: z.string().min(1).max(64),
    /** `<title>` of its pages without their own SEO title; null = the site's template. */
    titleTemplate: titleTemplateSchema.nullable().optional(),
    /** Its pages' og:type; null = `website`, the site's. */
    ogType: z.enum(OG_TYPES).nullable().optional(),
    /** The version `list_page_types` showed; a different one refuses (it changed since). */
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.titleTemplate !== undefined || v.ogType !== undefined, {
    message: "pass `titleTemplate` and/or `ogType` for each page type",
  });

/** The `seo` a page type has after `item`; undefined = none (it adds nothing). */
function nextSeo(
  current: PageTypeDef["seo"],
  item: z.infer<typeof itemSchema>,
): PageTypeDef["seo"] {
  const out: { titleTemplate?: string; ogType?: (typeof OG_TYPES)[number] } = { ...current };
  if (item.titleTemplate === null) delete out.titleTemplate;
  else if (item.titleTemplate !== undefined) out.titleTemplate = item.titleTemplate;
  if (item.ogType === null) delete out.ogType;
  else if (item.ogType !== undefined) out.ogType = item.ogType;
  return Object.keys(out).length === 0 ? undefined : out;
}

const pageTypeResultSchema = z.object({
  slug: z.string(),
  id: z.string(),
  version: z.number().int().positive(),
  changed: z.boolean(),
  titleTemplate: z.string().nullable(),
  ogType: z.enum(OG_TYPES).nullable(),
});

const sameSeo = (a: PageTypeDef["seo"], b: PageTypeDef["seo"]): boolean =>
  (a?.titleTemplate ?? null) === (b?.titleTemplate ?? null) &&
  (a?.ogType ?? null) === (b?.ogType ?? null);

/**
 * Set the title template and og:type of 1..50 page types and/or the site's
 * title template, one transaction (see the file header).
 */
export const setPageTypeSeoManyOp = defineOperation({
  name: "page_types.set_seo_many",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The site's title template: pages whose page type has none. */
      siteTitleTemplate: titleTemplateSchema.optional(),
      pageTypes: z.array(itemSchema).min(1).max(50).optional(),
    })
    .strict()
    .refine((v) => v.siteTitleTemplate !== undefined || v.pageTypes !== undefined, {
      message: "pass `siteTitleTemplate` and/or `pageTypes`",
    }),
  output: z.object({
    siteTitleTemplate: z.object({ value: z.string(), changed: z.boolean() }),
    pageTypes: z.array(pageTypeResultSchema),
  }),
  handler: async (ctx, input, tx) => {
    const op = "page_types.set_seo_many";
    const refusal = await structureWriteRefusal(tx, ctx, op);
    if (refusal) return { ok: false, error: handlerError(op, refusal, true) };
    const branchId = branchOf(ctx);
    const site = await loadSiteSeoHeadSettings(tx);

    // {site_name} renders only once the site has a name.
    const templates = [
      ...(input.siteTitleTemplate !== undefined ? [input.siteTitleTemplate] : []),
      ...(input.pageTypes ?? []).flatMap((t) => (t.titleTemplate ? [t.titleTemplate] : [])),
    ];
    if (
      site.siteName === null &&
      templates.some((t) => titleTemplateVariables(t).includes("site_name"))
    ) {
      return {
        ok: false,
        error: handlerError(
          op,
          "{site_name} needs the site's name, and the site has none yet — set it first with set_site_identity({siteName}), or write the name into the template. Nothing was written.",
          true,
        ),
      };
    }
    const slugs = (input.pageTypes ?? []).map((t) => t.pageType);
    const twice = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    if (twice.length > 0) {
      return {
        ok: false,
        error: handlerError(op, `page type ${twice[0]} is named twice — send each once.`, true),
      };
    }

    let wrote = false;
    const out: z.infer<typeof pageTypeResultSchema>[] = [];
    for (const [i, item] of (input.pageTypes ?? []).entries()) {
      const at = `pageTypes[${i}] ("${item.pageType}")`;
      const found = await loadListEntityForUpsert(tx, "pageType", branchId, item.pageType);
      if (!found || found.state.deletedAt !== null) {
        return failBatch(
          wrote,
          handlerError(
            op,
            `${at}: no page type with this slug — list_page_types shows the site's page types. Nothing was written.`,
            true,
          ),
        );
      }
      if (item.expectedVersion !== undefined && found.state.version !== item.expectedVersion) {
        return failBatch(
          wrote,
          conflictError(
            op,
            `Conflict: ${at} is at version ${found.state.version}, not ${item.expectedVersion} — it changed since you read it. Read it again (list_page_types) and redo your change on top of it.`,
          ),
        );
      }
      let current = found.state.definition;
      let seo = nextSeo(current.seo, item);
      let changed = !sameSeo(current.seo, seo);
      let version = found.state.version;
      if (changed) {
        const lock = await checkAndAcquireEntityLock(tx, {
          kind: "pageType",
          entityId: found.id,
          chatBranchId: branchId,
          holderKey: ctx.chatTaskId,
        });
        if (!lock.permitted) {
          return failBatch(
            wrote,
            await entityWriteBlockedError(tx, op, "pageType", found.id, lock),
          );
        }
        // The lock may have taken another chat's pending edit of this type
        // over: the patch builds on the type as the caller sees it now, so
        // that edit survives. A refusal from here on throws, which rolls the
        // takeover back with it.
        const locked = await loadListEntityForUpsert(tx, "pageType", branchId, item.pageType);
        if (!locked || locked.state.deletedAt !== null) {
          throw new OperationAbortError(
            handlerError(
              op,
              `${at}: the page type was deleted by the change this write just took over. Nothing was written.`,
              true,
            ),
          );
        }
        if (item.expectedVersion !== undefined && locked.state.version !== item.expectedVersion) {
          throw new OperationAbortError(
            conflictError(
              op,
              `Conflict: ${at} is at version ${locked.state.version}, not ${item.expectedVersion} — another chat's change of it was just taken over. Read it again (list_page_types) and redo your change on top of it.`,
            ),
          );
        }
        current = locked.state.definition;
        seo = nextSeo(current.seo, item);
        changed = !sameSeo(current.seo, seo);
        version = locked.state.version;
      }
      if (changed) {
        const { seo: _old, ...rest } = current;
        const definition: PageTypeDef = seo === undefined ? rest : { ...rest, seo };
        version += 1;
        const state: PageTypeState = {
          schemaVersion: 1,
          slug: found.state.slug,
          definition,
          version,
          deletedAt: null,
        };
        const entity = await persistListEntity(
          tx,
          ctx.actorId,
          branchId,
          { kind: "pageType", entityId: found.id, state },
          false,
        );
        await emitSnapshot(tx, {
          actorId: ctx.actorId,
          opKind: "page_types.upsert_many",
          description: `${op} ${found.state.slug}`,
          chatTaskId: ctx.chatTaskId ?? null,
          chatBranchId: branchId,
          entities: [entity],
        });
        wrote = true;
      }
      out.push({
        slug: found.state.slug,
        id: found.id,
        version,
        changed,
        titleTemplate: seo?.titleTemplate ?? null,
        ogType: seo?.ogType ?? null,
      });
    }

    let siteChanged = false;
    if (input.siteTitleTemplate !== undefined && input.siteTitleTemplate !== site.titleTemplate) {
      await tx.execute(sql`
        UPDATE site_defaults
           SET seo_title_template = ${input.siteTitleTemplate},
               updated_at = now(), updated_by = ${ctx.actorId}::uuid
         WHERE id = 1
      `);
      siteChanged = true;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      resultSummary: `site=${siteChanged} types=${out.filter((t) => t.changed).length}/${out.length}${branchId ? " (branch)" : ""}`,
    });
    return ok({
      siteTitleTemplate: {
        value: input.siteTitleTemplate ?? site.titleTemplate,
        changed: siteChanged,
      },
      pageTypes: out,
    });
  },
});
