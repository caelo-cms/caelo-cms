// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1269 — `pages.search`: the pages whose words start with what the
 * caller typed, as the caller's branch sees them, read through the word
 * tables of migration 0603 instead of loading every page of the site.
 *
 * The rule. The query is split into words exactly as the pages are
 * (`caelo_search_words`). The LAST word must start a word of the page's
 * own title, short title or slug: it is the word being typed, and it names
 * the page itself. Every other word must start a word of the page's title,
 * short title or composed path. So "products shoes" finds `/products/shoes`,
 * "contact us" finds the page titled "Contact us", and "blog" finds the
 * blog page, not every post below it.
 *
 * The read. Candidates come in word order from two index ranges of the
 * last word: the page rows' words (`page_search_words`) and the words of
 * the caller's branch's pending page states (`draft_pending_page_words`) —
 * a page a chat renamed or created there is found by its pending title.
 * Each chunk of candidates is confirmed through `pages.list({ pageIds })`,
 * which applies the caller's view (pending renames, moves and deletes, the
 * composed path), and then against the rule. A call examines at most
 * {@link MAX_CANDIDATES} candidates and returns `nextCursor` when it
 * stopped before the candidates ran out, so a common prefix costs a bounded
 * read per call, never the site.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { listPagesOp, pageListRowSchema } from "./pages.js";

/** The most pages one `pages.search` call returns. */
export const PAGE_SEARCH_MAX_LIMIT = 200;
/** Candidates confirmed per statement. */
const CHUNK = 100;
/** Candidates one call examines at most before it answers with `nextCursor`. */
const MAX_CANDIDATES = 500;

type Listed = z.infer<typeof pageListRowSchema>;

/** Where a search continues: the last examined (word, page) of the last word's ranges. */
interface SearchCursor {
  readonly word: string;
  readonly pageId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeSearchCursor(c: SearchCursor): string {
  return Buffer.from(JSON.stringify(["pages.search", c.word, c.pageId])).toString("base64url");
}

/** The cursor, or null when `text` is not one `pages.search` issued. */
function decodeSearchCursor(text: string): SearchCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== "pages.search") return null;
  const [, word, pageId] = parsed as unknown[];
  if (typeof word !== "string" || word.length === 0 || word.length > 64) return null;
  if (typeof pageId !== "string" || !UUID.test(pageId)) return null;
  return { word, pageId };
}

/** The query's words, split as the pages' words are (0603). */
async function queryWords(tx: TransactionRunner, query: string): Promise<string[]> {
  // Ordered by first appearance: the last word typed drives the read.
  const rows = (await tx.execute(sql`
    SELECT w FROM regexp_split_to_table(lower(${query}), '[^[:alnum:]]+') WITH ORDINALITY AS t(w, i)
     WHERE w <> '' ORDER BY i`)) as unknown as { w: string }[];
  const out: string[] = [];
  for (const r of rows) {
    const w = r.w.slice(0, 64);
    const at = out.indexOf(w);
    if (at >= 0) out.splice(at, 1);
    out.push(w);
  }
  return out;
}

/** The next candidates after `after`, in (word, page) order, from both ranges. */
async function candidates(
  tx: TransactionRunner,
  branchId: string | null,
  driver: string,
  after: SearchCursor | null,
  n: number,
): Promise<{ word: string; page_id: string }[]> {
  const past = after
    ? sql`AND (word, page_id) > (${after.word}::text COLLATE "C", ${after.pageId}::uuid)`
    : sql``;
  const live = sql`(SELECT word, page_id FROM page_search_words
                     WHERE word ^@ (${driver}::text COLLATE "C") ${past}
                     ORDER BY word, page_id LIMIT ${n})`;
  const pending = branchId
    ? sql`UNION ALL
          (SELECT word, page_id FROM draft_pending_page_words
            WHERE chat_branch_id = ${branchId}::uuid AND word ^@ (${driver}::text COLLATE "C") ${past}
            ORDER BY word, page_id LIMIT ${n})`
    : sql``;
  return (await tx.execute(sql`
    SELECT word, page_id::text AS page_id FROM (${live} ${pending}) c
     ORDER BY word COLLATE "C", page_id LIMIT ${n}`)) as unknown as {
    word: string;
    page_id: string;
  }[];
}

/** The ids of `pages` the rule matches (the words of each side split in SQL, as 0603 does). */
async function matching(
  tx: TransactionRunner,
  pages: readonly Listed[],
  words: readonly string[],
): Promise<Set<string>> {
  const driver = words[words.length - 1] as string;
  const others = words.slice(0, -1);
  const rows = (await tx.execute(sql`
    SELECT p.id FROM jsonb_to_recordset((${JSON.stringify(
      pages.map((p) => ({
        id: p.id,
        title: p.title,
        short: p.shortTitle,
        slug: p.slug,
        path: p.currentPath,
      })),
    )}::text)::jsonb) AS p(id text, title text, short text, slug text, path text)
     WHERE EXISTS (SELECT 1 FROM caelo_search_words(p.title, p.short, p.slug) w
                    WHERE w ^@ ${driver})
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text((${JSON.stringify(others)}::text)::jsonb) q
          WHERE NOT EXISTS (SELECT 1 FROM caelo_search_words(p.title, p.short, p.path) w
                             WHERE w ^@ q))`)) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export const searchPagesOp = defineOperation({
  name: "pages.search",
  readScope: "request",
  // §11: list and search ops are open reads; plugins search like the AI.
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({
    /** What was typed: words; the last one may be unfinished. */
    query: z.string().min(1).max(200),
    /** At most this many pages (default 50). */
    limit: z.number().int().min(1).max(PAGE_SEARCH_MAX_LIMIT).default(50),
    /** `nextCursor` of the previous call with the same query. */
    cursor: z.string().min(1).max(400).optional(),
  }),
  output: z.object({
    pages: z.array(pageListRowSchema),
    /**
     * More pages may match: call again with `cursor: nextCursor`. A page
     * whose words match the last query word twice ("shop", "shopping") may
     * come once more on a later call; key results by id.
     */
    nextCursor: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const after = input.cursor === undefined ? null : decodeSearchCursor(input.cursor);
    if (input.cursor !== undefined && after === null) {
      return err({
        kind: "HandlerError",
        operation: "pages.search",
        message:
          "cursor is not a pages.search cursor: pass nextCursor exactly as the previous call with the same query returned it, or omit it.",
      });
    }
    const words = await queryWords(tx, input.query);
    const driver = words[words.length - 1];
    if (driver === undefined) return ok({ pages: [], nextCursor: null });
    const branchId = ctx.chatBranchId ?? null;

    const found: Listed[] = [];
    const seen = new Set<string>();
    let cursor = after;
    let examined = 0;
    for (;;) {
      const chunk = await candidates(tx, branchId, driver, cursor, CHUNK);
      const last = chunk[chunk.length - 1];
      if (!last) return ok({ pages: found, nextCursor: null });
      cursor = { word: last.word, pageId: last.page_id };
      examined += chunk.length;
      const ids = [...new Set(chunk.map((c) => c.page_id))].filter((id) => !seen.has(id));
      for (const id of ids) seen.add(id);
      if (ids.length > 0) {
        const listed = await listPagesOp.handler(ctx, { includeDeleted: false, pageIds: ids }, tx);
        if (!listed.ok) return listed;
        const hit = await matching(tx, listed.value.pages, words);
        const byId = new Map(listed.value.pages.map((p) => [p.id, p]));
        // In candidate order, each page at its first candidate here: when
        // the limit is reached, the next call continues right after the
        // candidate just taken, so a page matched later in the chunk under
        // another word is examined again and never skipped.
        const taken = new Set<string>();
        for (const c of chunk) {
          if (!ids.includes(c.page_id) || taken.has(c.page_id)) continue;
          taken.add(c.page_id);
          const p = byId.get(c.page_id);
          if (!p || !hit.has(c.page_id)) continue;
          found.push(p);
          if (found.length === input.limit) {
            return ok({
              pages: found,
              nextCursor: encodeSearchCursor({ word: c.word, pageId: c.page_id }),
            });
          }
        }
      }
      if (chunk.length < CHUNK) return ok({ pages: found, nextCursor: null });
      if (examined >= MAX_CANDIDATES) {
        return ok({ pages: found, nextCursor: encodeSearchCursor(cursor) });
      }
    }
  },
});

/** Drift of the two word tables from their source: rows missing and rows extra. */
export async function pageSearchWordsDrift(
  tx: TransactionRunner,
): Promise<{ missing: number; extra: number }> {
  const rows = (await tx.execute(sql`
    WITH expected AS (SELECT * FROM caelo_page_search_words_expected()),
         maintained AS (
           SELECT 'live'::text AS t, NULL::uuid AS chat_branch_id, NULL::uuid AS snapshot_row_id,
                  word::text AS word, page_id FROM page_search_words
           UNION ALL
           SELECT 'draft', chat_branch_id, snapshot_row_id, word::text, page_id
             FROM draft_pending_page_words)
    SELECT (SELECT count(*)::int FROM (SELECT * FROM expected EXCEPT SELECT * FROM maintained) d) AS missing,
           (SELECT count(*)::int FROM (SELECT * FROM maintained EXCEPT SELECT * FROM expected) d) AS extra`)) as unknown as {
    missing: number;
    extra: number;
  }[];
  return { missing: rows[0]?.missing ?? 0, extra: rows[0]?.extra ?? 0 };
}

export const rebuildPageSearchWordsOp = defineOperation({
  name: "pages.rebuild_search_words",
  // Why human-only: system-only. Derived state the database maintains
  // itself; the rebuild is the repair path of rule 3
  // (docs/dev/state-and-changes.md), never part of editing.
  actorScope: ["system"],
  // Why site-wide: a rebuild re-derives the words of every page and every
  // pending page state.
  readScope: "site",
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** Rows both word tables hold after the rebuild. */
    rows: z.number().int().nonnegative(),
    /** Drift found before the rebuild (0/0 = the triggers were exact). */
    drift: z.object({
      missing: z.number().int().nonnegative(),
      extra: z.number().int().nonnegative(),
    }),
  }),
  handler: async (_ctx, _input, tx) => {
    const drift = await pageSearchWordsDrift(tx);
    const rows = (await tx.execute(
      sql`SELECT caelo_page_search_words_rebuild()::int AS n`,
    )) as unknown as { n: number }[];
    return ok({ rows: rows[0]?.n ?? 0, drift });
  },
});
