// SPDX-License-Identifier: MPL-2.0

/**
 * #1759 — `lists.merge_terms`: one topic spelt as two terms ("SEO-Tool" /
 * "SEO Tools") becomes one, in ONE call (CLAUDE.md §11: a multi-step
 * change is one op):
 *
 * 1. every page carrying a merged term carries the kept term instead,
 * 2. a merged term's overview page (`landing_page`) becomes the kept
 *    term's when it has none, else it is deleted with a 301 to the kept
 *    term's overview page, so its inbound links keep working,
 * 3. the merged terms leave the vocabulary.
 *
 * Each step runs through the op that owns it (`pages.update`,
 * `pages.delete_many`, `lists.patch_items_many`), so the change is a draft
 * of the caller's branch with its locks and snapshots, and undone like any
 * other. The pages read are the ones carrying the merged terms (indexed by
 * `page_terms_term_idx`) plus the branch's own pending pages: request-sized.
 */

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadListEntityBySlug } from "../../lists/store.js";
import { deletePagesManyOp, listPagesOp, updatePageOp } from "../content/pages.js";
import { branchOf, failBatch, handlerError, listTypesBySlug } from "./_shared.js";
import { patchListItemsManyOp } from "./lists.js";

const OP = "lists.merge_terms";

/** Most pages one merge re-tags: a bigger vocabulary change is several calls. */
export const MERGE_TERMS_MAX_PAGES = 2000;

interface TermItem {
  readonly id: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly children?: readonly TermItem[];
}

function flatten(
  items: readonly TermItem[],
  out = new Map<string, TermItem>(),
): Map<string, TermItem> {
  for (const item of items) {
    out.set(item.id, item);
    flatten(item.children ?? [], out);
  }
  return out;
}

/** The page a term's `landing_page` names, or null. */
function landingPageOf(item: TermItem): string | null {
  const href = (item.values.landing_page as { href?: unknown } | undefined)?.href;
  const m = typeof href === "string" ? /^caelo:page\/([0-9a-f-]{36})/i.exec(href) : null;
  return m ? (m[1] as string).toLowerCase() : null;
}

const message = (e: { kind: string } & Partial<{ message: string }>) => e.message ?? e.kind;

export const mergeTermsOp = defineOperation({
  name: "lists.merge_terms",
  pluginAccess: "write",
  readScope: "request",
  // Why human-only: the AI reaches it through the seo plugin's
  // merge_terms tool, which resolves term names and proposes the merges the
  // plugin found (#1759); a human or the system may call it as is.
  actorScope: ["human", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The vocabulary list's slug. */
      list: z.string().min(1).max(64),
      merges: z
        .array(
          z
            .object({
              from: z.array(z.string().uuid()).min(1).max(20),
              into: z.string().uuid(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
  output: z.object({
    retaggedPages: z.number().int(),
    removedTerms: z.number().int(),
    /** Overview pages of merged terms the kept term now uses. */
    adoptedOverviewPages: z.array(z.string()),
    /** Overview pages of merged terms deleted with a 301 to the kept term's. */
    redirectedOverviewPages: z.array(z.object({ pageId: z.string(), to: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    const branchId = branchOf(ctx);
    const list = await loadListEntityBySlug(tx, "list", branchId, input.list);
    if (!list) {
      return failBatch(
        false,
        handlerError(OP, `no list "${input.list}" — lists.list names the vocabularies`),
      );
    }
    const types = await listTypesBySlug(tx, branchId);
    const type = [...types.values()].find((t) => t.id === list.state.listTypeId);
    if (type?.def.role !== "vocabulary") {
      return failBatch(
        false,
        handlerError(OP, `list "${input.list}" is not a vocabulary: only terms merge`),
      );
    }
    const items = flatten(list.state.items as readonly TermItem[]);
    const fromAll = new Set<string>();
    for (const [i, m] of input.merges.entries()) {
      for (const id of [...m.from, m.into]) {
        if (!items.has(id)) {
          return failBatch(
            false,
            handlerError(OP, `merges[${i}]: "${input.list}" has no term ${id}`),
          );
        }
      }
      if (m.from.includes(m.into)) {
        return failBatch(false, handlerError(OP, `merges[${i}]: a term cannot merge into itself`));
      }
      for (const id of m.from) {
        if (fromAll.has(id))
          return failBatch(false, handlerError(OP, `merges[${i}]: term ${id} is merged twice`));
        fromAll.add(id);
      }
    }
    if (input.merges.some((m) => fromAll.has(m.into))) {
      return failBatch(
        false,
        handlerError(OP, "a kept term is also merged away: merge in one direction"),
      );
    }

    // 1. Re-tag: the pages carrying a merged term, as the caller sees them.
    const listId = list.id;
    const candidates = (await tx.execute(sql`
      SELECT DISTINCT page_id::text AS id FROM page_terms
       WHERE list_id = ${listId}::uuid AND item_id = ANY(${uuidArray([...fromAll])})
      ${branchId ? sql`UNION SELECT entity_id::text FROM draft_pending_entities WHERE chat_branch_id = ${branchId}::uuid AND entity_kind = 'page'` : sql``}
    `)) as unknown as { id: string }[];
    if (candidates.length > MERGE_TERMS_MAX_PAGES) {
      return failBatch(
        false,
        handlerError(
          OP,
          `the merge touches ${candidates.length} pages, more than ${MERGE_TERMS_MAX_PAGES}: merge fewer terms per call`,
        ),
      );
    }
    const intoOf = new Map(input.merges.flatMap((m) => m.from.map((f) => [f, m.into] as const)));
    const termRef = (itemId: string) => `caelo:term/${listId}/${itemId}`;
    const fromRefs = new Map([...intoOf].map(([f, into]) => [termRef(f), termRef(into)]));
    let retaggedPages = 0;
    for (let at = 0; at < candidates.length; at += 1000) {
      const listed = await listPagesOp.handler(
        ctx,
        { includeDeleted: false, pageIds: candidates.slice(at, at + 1000).map((c) => c.id) },
        tx,
      );
      if (!listed.ok) return failBatch(retaggedPages > 0, listed.error);
      for (const page of listed.value.pages as { id: string; terms: string[] }[]) {
        if (!page.terms.some((t) => fromRefs.has(t))) continue;
        const next: string[] = [];
        for (const t of page.terms) {
          const kept = fromRefs.get(t) ?? t;
          if (!next.includes(kept)) next.push(kept);
        }
        const r = await updatePageOp.handler(ctx, { pageId: page.id, terms: next }, tx);
        if (!r.ok) {
          return failBatch(
            true,
            handlerError(OP, `re-tagging page ${page.id} failed: ${message(r.error)}`),
          );
        }
        retaggedPages += 1;
      }
    }

    // 2. Overview pages of merged terms.
    const adopted: string[] = [];
    const redirected: { pageId: string; to: string }[] = [];
    const patches: { op: "update"; itemId: string; values: Record<string, unknown> }[] = [];
    const deletions: { pageId: string; disposition: "redirect"; redirectTo: string }[] = [];
    for (const m of input.merges) {
      let kept = landingPageOf(items.get(m.into) as TermItem);
      for (const f of m.from) {
        const landing = landingPageOf(items.get(f) as TermItem);
        if (landing === null || landing === kept) continue;
        if (kept === null) {
          kept = landing;
          adopted.push(landing);
          patches.push({
            op: "update",
            itemId: m.into,
            values: { landing_page: { href: `caelo:page/${landing}` } },
          });
          continue;
        }
        const target = await listPagesOp.handler(
          ctx,
          { includeDeleted: false, pageIds: [kept] },
          tx,
        );
        const path = target.ok
          ? (target.value.pages[0] as { currentPath: string } | undefined)?.currentPath
          : undefined;
        if (path === undefined) {
          return failBatch(
            true,
            handlerError(
              OP,
              `the kept term's overview page ${kept} is gone: set its landing_page first`,
            ),
          );
        }
        deletions.push({ pageId: landing, disposition: "redirect", redirectTo: path });
        redirected.push({ pageId: landing, to: path });
      }
    }
    if (deletions.length > 0) {
      const r = await deletePagesManyOp.handler(ctx, { deletions }, tx);
      if (!r.ok)
        return failBatch(
          true,
          handlerError(OP, `deleting merged overview pages failed: ${message(r.error)}`),
        );
      if (r.value.refused.length > 0) {
        return failBatch(
          true,
          handlerError(
            OP,
            `a merged overview page could not be deleted: ${r.value.refused.map((x) => x.reason).join("; ")}`,
          ),
        );
      }
    }

    // 3. The merged terms leave the vocabulary.
    const removed = [...fromAll].map((itemId) => ({ op: "remove" as const, itemId }));
    const r = await patchListItemsManyOp.handler(
      ctx,
      { lists: [{ slug: input.list, patches: [...patches, ...removed] }] },
      tx,
    );
    if (!r.ok) return failBatch(true, r.error);
    return ok({
      retaggedPages,
      removedTerms: removed.length,
      adoptedOverviewPages: adopted,
      redirectedOverviewPages: redirected,
    });
  },
});
