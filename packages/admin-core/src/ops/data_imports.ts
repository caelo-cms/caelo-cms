// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the operations of one import run (docs/data-imports.md).
 * The pipeline that drives them is `data-imports/run.ts`; these are its
 * transactional steps and the reads people and the AI use.
 *
 *   data_imports.lookup        which source keys earlier imports hold, and
 *                              which pages the rows' page references name
 *   data_imports.open          start an import, or check one to add to
 *   data_imports.record        keep the rows a kind stored, and the report
 *   data_imports.list / .get   imports with where they stand
 *   data_imports.item_refs     what a kind stored per row, for an undo
 *   data_imports.mark_undone   end an import (after its kind removed rows)
 */

import {
  defineOperation,
  type TransactionRunner,
  textArray,
  uuidArray,
} from "@caelo-cms/query-api";
import {
  err,
  IMPORT_KIND_NAME,
  IMPORT_PROBLEM_REASONS,
  IMPORT_RELEASE_MODES,
  MAX_SOURCE_KEY_LENGTH,
  ok,
  redirectAddress,
} from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { importStateSql } from "../data-imports/release.js";
import { jsonbParam } from "../sql-helpers.js";

/** Most keys or references one lookup takes; the pipeline reads in chunks of it. */
export const LOOKUP_CHUNK = 1000;

/** Most rows one record call keeps. */
export const RECORD_CHUNK = 1000;

const ownerSchema = z.string().regex(/^(core|[a-z][a-z0-9-]{0,63})$/);
const kindSchema = z.string().regex(IMPORT_KIND_NAME);
const sourceKeySchema = z.string().min(1).max(MAX_SOURCE_KEY_LENGTH);
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The path forms a stored page path may have: with and without the trailing slash. */
function pathSpellings(path: string): string[] {
  if (path === "/") return ["/"];
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  return [bare, `${bare}/`];
}

/** The path a page reference names, decoded, or null for an id. */
function refPath(ref: string): string | null {
  if (UUID.test(ref)) return null;
  if (ref.startsWith("/")) return safeDecode(ref.split(/[?#]/)[0] ?? ref);
  try {
    return safeDecode(new URL(ref).pathname);
  } catch {
    return null;
  }
}

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Pages on main and on the caller's branch at these paths, by path (the branch's row wins). */
async function pagesAtPaths(
  tx: TransactionRunner,
  branchId: string | null,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const spellings = [...new Set(paths.flatMap(pathSpellings))];
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, current_path, chat_branch_id IS NOT NULL AS on_branch
    FROM pages
    WHERE current_path = ANY(${textArray(spellings)}) AND deleted_at IS NULL
      AND ${branchId ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)` : sql`chat_branch_id IS NULL`}
    ORDER BY on_branch
  `)) as unknown as { id: string; current_path: string; on_branch: boolean }[];
  // Ordered main first, so a branch row of the same path overwrites it.
  for (const r of rows) for (const p of pathSpellings(r.current_path)) out.set(p, r.id);
  return out;
}

/**
 * Resolves page references: an id, a path, or a URL of the old site. A
 * path that no page has may be an old address a redirect (live or pending)
 * or a site import knows; one hop, then the target's page.
 */
async function resolvePageRefs(
  tx: TransactionRunner,
  branchId: string | null,
  refs: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = refs.filter((r) => UUID.test(r));
  if (ids.length > 0) {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id FROM pages
      WHERE id = ANY(${uuidArray(ids)}) AND deleted_at IS NULL
        AND ${branchId ? sql`(chat_branch_id IS NULL OR chat_branch_id = ${branchId}::uuid)` : sql`chat_branch_id IS NULL`}
    `)) as unknown as { id: string }[];
    const found = new Set(rows.map((r) => r.id.toLowerCase()));
    for (const id of ids) if (found.has(id.toLowerCase())) out.set(id, id.toLowerCase());
  }
  const byPath = new Map<string, string>();
  for (const ref of refs) {
    const p = refPath(ref);
    if (p !== null) byPath.set(ref, p);
  }
  const pages = await pagesAtPaths(tx, branchId, [...byPath.values()]);
  const open: string[] = [];
  for (const [ref, p] of byPath) {
    const id = pages.get(p);
    if (id) out.set(ref, id);
    else open.push(ref);
  }
  if (open.length === 0) return out;
  // An old address: a redirect's target, live or pending.
  const addresses = [...new Set(open.map((ref) => redirectAddress(byPath.get(ref) ?? "/")))];
  const hops = (await tx.execute(sql`
    SELECT address, to_path FROM redirects WHERE address = ANY(${textArray(addresses)})
    UNION ALL
    SELECT address, to_path FROM pending_redirects
    WHERE address = ANY(${textArray(addresses)}) AND to_path IS NOT NULL
  `)) as unknown as { address: string; to_path: string }[];
  const target = new Map<string, string>();
  for (const h of hops) target.set(h.address, h.to_path);
  const hopPages = await pagesAtPaths(tx, branchId, [...new Set(target.values())]);
  const stillOpen: string[] = [];
  for (const ref of open) {
    const to = target.get(redirectAddress(byPath.get(ref) ?? "/"));
    const id = to ? hopPages.get(to) : undefined;
    if (id) out.set(ref, id);
    else stillOpen.push(ref);
  }
  // A URL a site import crawled and built a page from.
  const urls = stillOpen.filter((r) => /^https?:\/\//i.test(r));
  if (urls.length > 0) {
    const built = (await tx.execute(sql`
      SELECT ip.source_url, ip.accepted_page_id::text AS page_id
      FROM import_pages ip JOIN pages p ON p.id = ip.accepted_page_id
      WHERE ip.source_url = ANY(${textArray(urls)}) AND p.deleted_at IS NULL
    `)) as unknown as { source_url: string; page_id: string }[];
    for (const b of built) out.set(b.source_url, b.page_id);
  }
  return out;
}

export const lookupDataImportOp = defineOperation({
  name: "data_imports.lookup",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      owner: ownerSchema,
      kind: kindSchema,
      sourceKeys: z.array(sourceKeySchema).max(LOOKUP_CHUNK),
      pageRefs: z.array(z.string().min(1).max(2000)).max(LOOKUP_CHUNK),
    })
    .strict(),
  output: z.object({
    held: z.array(
      z.object({
        sourceKey: z.string(),
        rowId: z.string(),
        importId: z.string(),
        digest: z.string(),
      }),
    ),
    pages: z.array(z.object({ ref: z.string(), pageId: z.string() })),
  }),
  handler: async (ctx, input, tx) => {
    const held =
      input.sourceKeys.length === 0
        ? []
        : ((await tx.execute(sql`
            SELECT source_key, row_id::text AS row_id, import_id::text AS import_id, digest
            FROM data_import_items
            WHERE owner = ${input.owner} AND kind = ${input.kind} AND active
              AND source_key = ANY(${textArray(input.sourceKeys)})
          `)) as unknown as {
            source_key: string;
            row_id: string;
            import_id: string;
            digest: string;
          }[]);
    const pages = await resolvePageRefs(tx, ctx.chatBranchId ?? null, [...new Set(input.pageRefs)]);
    return ok({
      held: held.map((h) => ({
        sourceKey: h.source_key,
        rowId: h.row_id,
        importId: h.import_id,
        digest: h.digest,
      })),
      pages: [...pages].map(([ref, pageId]) => ({ ref, pageId })),
    });
  },
});

export const openDataImportOp = defineOperation({
  name: "data_imports.open",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      owner: ownerSchema,
      kind: kindSchema,
      release: z.enum(IMPORT_RELEASE_MODES),
      sourceLabel: z.string().trim().min(1).max(120),
      /** Add to this import instead of starting one. */
      importId: z.string().uuid().optional(),
      chatSessionId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({ importId: z.string(), created: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const op = "data_imports.open";
    if (input.importId) {
      const rows = (await tx.execute(sql`
        SELECT owner, kind, undone_at IS NOT NULL AS undone, merged_at IS NOT NULL AS merged
        FROM data_imports WHERE id = ${input.importId}::uuid FOR UPDATE
      `)) as unknown as { owner: string; kind: string; undone: boolean; merged: boolean }[];
      const row = rows[0];
      const problem = !row
        ? "does not exist; omit importId to start a new import"
        : row.owner !== input.owner || row.kind !== input.kind
          ? `is an import of ${row.kind}, not ${input.kind}`
          : row.undone
            ? "was undone; omit importId to start a new import"
            : row.merged
              ? "was already shipped by a Stage; rows added now would reach visitors without one. Omit importId to start a new import"
              : null;
      if (problem)
        return err({
          kind: "HandlerError",
          operation: op,
          message: `import ${input.importId} ${problem}`,
        });
      return ok({ importId: input.importId, created: false });
    }
    const rows = (await tx.execute(sql`
      INSERT INTO data_imports (owner, kind, release, source_label, created_by, chat_session_id)
      VALUES (${input.owner}, ${input.kind}, ${input.release}, ${input.sourceLabel},
              ${ctx.actorId}::uuid, ${input.chatSessionId ?? null}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const importId = rows[0]?.id;
    if (!importId) throw new Error("data_imports.open: insert returned no id");
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { owner: input.owner, kind: input.kind, sourceLabel: input.sourceLabel },
      succeeded: true,
      entityId: importId,
      resultSummary: `${input.kind} from ${input.sourceLabel}`,
    });
    return ok({ importId, created: true });
  },
});

const reportSchema = z
  .object({
    dryRun: z.boolean(),
    written: z.boolean(),
    counts: z.object({
      rows: z.number().int(),
      imported: z.number().int(),
      updated: z.number().int(),
      unchanged: z.number().int(),
      invalid: z.number().int(),
    }),
    problems: z.array(
      z.object({
        reason: z.enum(IMPORT_PROBLEM_REASONS),
        count: z.number().int(),
        examples: z.array(
          z.object({ sourceKey: z.string().nullable(), at: z.string(), detail: z.string() }),
        ),
      }),
    ),
  })
  .strict();

export const recordDataImportOp = defineOperation({
  name: "data_imports.record",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      importId: z.string().uuid(),
      items: z
        .array(
          z
            .object({
              rowId: z.string().uuid(),
              sourceKey: sourceKeySchema,
              parentRowId: z.string().uuid().nullable(),
              pageId: z.string().uuid().nullable(),
              values: z.record(z.string(), valueSchema),
              digest: z.string().regex(/^[0-9a-f]{64}$/),
              /** What the kind calls the stored row (a redirect's address). */
              targetRef: z.string().max(2000).nullable(),
            })
            .strict(),
        )
        .max(RECORD_CHUNK),
      /** The call's report: set on the last record call of a call. */
      report: reportSchema.optional(),
    })
    .strict(),
  output: z.object({ itemCount: z.number().int() }),
  handler: async (ctx, input, tx) => {
    const op = "data_imports.record";
    const head = (await tx.execute(sql`
      SELECT owner, kind, undone_at IS NOT NULL AS undone
      FROM data_imports WHERE id = ${input.importId}::uuid FOR UPDATE
    `)) as unknown as { owner: string; kind: string; undone: boolean }[];
    const imp = head[0];
    if (!imp || imp.undone)
      return err({
        kind: "HandlerError",
        operation: op,
        message: `import ${input.importId} ${imp ? "was undone" : "does not exist"}`,
      });
    if (input.items.length > 0) {
      const items = input.items.map((i) => ({
        row_id: i.rowId,
        source_key: i.sourceKey,
        parent_row_id: i.parentRowId,
        page_id: i.pageId,
        values: i.values,
        digest: i.digest,
        target_ref: i.targetRef,
      }));
      // A row's id belongs to this import (ids.ts), so the conflict is this
      // import's own row: a retried call, or `mode: "update"`.
      await tx.execute(sql`
        INSERT INTO data_import_items
          (row_id, import_id, owner, kind, source_key, parent_row_id, page_id, "values", digest,
           target_ref)
        SELECT x.row_id, ${input.importId}::uuid, ${imp.owner}, ${imp.kind}, x.source_key,
               x.parent_row_id, x.page_id, x."values", x.digest, x.target_ref
        FROM jsonb_to_recordset(${jsonbParam(items)}) AS x(
          row_id uuid, source_key text, parent_row_id uuid, page_id uuid, "values" jsonb,
          digest text, target_ref text)
        ON CONFLICT (row_id) DO UPDATE SET
          parent_row_id = EXCLUDED.parent_row_id, page_id = EXCLUDED.page_id,
          "values" = EXCLUDED."values", digest = EXCLUDED.digest,
          target_ref = EXCLUDED.target_ref, updated_at = now()
        WHERE data_import_items.import_id = EXCLUDED.import_id
      `);
    }
    const counted = (await tx.execute(sql`
      UPDATE data_imports SET
        item_count = (SELECT count(*)::int FROM data_import_items WHERE import_id = ${input.importId}::uuid),
        ${input.report ? sql`last_report = ${jsonbParam(input.report)},` : sql``}
        updated_at = now()
      WHERE id = ${input.importId}::uuid
      RETURNING item_count
    `)) as unknown as { item_count: number }[];
    if (input.report) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: { importId: input.importId, counts: input.report.counts },
        succeeded: true,
        entityId: input.importId,
        resultSummary: `imported=${input.report.counts.imported} updated=${input.report.counts.updated} invalid=${input.report.counts.invalid}`,
      });
    }
    return ok({ itemCount: counted[0]?.item_count ?? 0 });
  },
});

const importSummary = z.object({
  importId: z.string(),
  owner: z.string(),
  kind: z.string(),
  sourceLabel: z.string(),
  state: z.string(),
  itemCount: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  chatSessionId: z.string().nullable(),
  undoneAt: z.string().nullable(),
});

const SUMMARY_COLUMNS = sql`
  di.id::text AS import_id, di.owner, di.kind, di.source_label, di.item_count,
  ${importStateSql()} AS state,
  to_char(di.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
  a.display_name AS created_by, di.chat_session_id::text AS chat_session_id,
  to_char(di.undone_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS undone_at`;

interface SummaryRow {
  import_id: string;
  owner: string;
  kind: string;
  source_label: string;
  item_count: number;
  state: string;
  created_at: string;
  created_by: string | null;
  chat_session_id: string | null;
  undone_at: string | null;
}

function summaryOf(r: SummaryRow): z.infer<typeof importSummary> {
  return {
    importId: r.import_id,
    owner: r.owner,
    kind: r.kind,
    sourceLabel: r.source_label,
    state: r.state,
    itemCount: r.item_count,
    createdAt: r.created_at,
    createdBy: r.created_by,
    chatSessionId: r.chat_session_id,
    undoneAt: r.undone_at,
  };
}

export const listDataImportsOp = defineOperation({
  name: "data_imports.list",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      kind: kindSchema.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      /** `createdAt` of the last import a previous call returned: the next ones are older. */
      before: z.string().datetime().optional(),
    })
    .strict(),
  output: z.object({ imports: z.array(importSummary) }),
  handler: async (_ctx, input, tx) => {
    const filters: SQL[] = [];
    if (input.kind) filters.push(sql`di.kind = ${input.kind}`);
    if (input.before) filters.push(sql`di.created_at < ${input.before}::timestamptz`);
    const rows = (await tx.execute(sql`
      SELECT ${SUMMARY_COLUMNS}
      FROM data_imports di LEFT JOIN actors a ON a.id = di.created_by
      ${filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``}
      ORDER BY di.created_at DESC
      LIMIT ${input.limit ?? 25}
    `)) as unknown as SummaryRow[];
    return ok({ imports: rows.map(summaryOf) });
  },
});

export const getDataImportOp = defineOperation({
  name: "data_imports.get",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ importId: z.string().uuid() }).strict(),
  output: importSummary.extend({
    release: z.enum(IMPORT_RELEASE_MODES),
    merged: z.boolean(),
    stamped: z.boolean(),
    lastReport: reportSchema.nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${SUMMARY_COLUMNS}, di.release, di.merged_at IS NOT NULL AS merged,
             di.staged_since IS NOT NULL AS stamped, di.last_report
      FROM data_imports di LEFT JOIN actors a ON a.id = di.created_by
      WHERE di.id = ${input.importId}::uuid
    `)) as unknown as (SummaryRow & {
      release: "stage" | "target";
      merged: boolean;
      stamped: boolean;
      last_report: z.infer<typeof reportSchema> | null;
    })[];
    const row = rows[0];
    if (!row)
      return err({
        kind: "HandlerError",
        operation: "data_imports.get",
        message: `there is no import ${input.importId}; list_data_imports names them`,
      });
    return ok({
      ...summaryOf(row),
      release: row.release,
      merged: row.merged,
      stamped: row.stamped,
      lastReport: row.last_report,
    });
  },
});

/** Most references one `item_refs` call returns. */
const REFS_PAGE = 1000;

export const dataImportItemRefsOp = defineOperation({
  name: "data_imports.item_refs",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({ importId: z.string().uuid(), afterRowId: z.string().uuid().optional() })
    .strict(),
  output: z.object({
    refs: z.array(z.object({ rowId: z.string(), targetRef: z.string().nullable() })),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT row_id::text AS row_id, target_ref FROM data_import_items
      WHERE import_id = ${input.importId}::uuid
        ${input.afterRowId ? sql`AND row_id > ${input.afterRowId}::uuid` : sql``}
      ORDER BY row_id LIMIT ${REFS_PAGE}
    `)) as unknown as { row_id: string; target_ref: string | null }[];
    return ok({ refs: rows.map((r) => ({ rowId: r.row_id, targetRef: r.target_ref })) });
  },
});

export const markDataImportUndoneOp = defineOperation({
  name: "data_imports.mark_undone",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      importId: z.string().uuid(),
      chatSessionId: z.string().uuid().optional(),
      /** The kind removed the import's rows (never staged, or release `target`): forget them too. */
      rowsRemoved: z.boolean(),
    })
    .strict(),
  output: z.object({ state: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "data_imports.mark_undone";
    const rows = (await tx.execute(sql`
      UPDATE data_imports SET undone_at = now(), undone_by = ${ctx.actorId}::uuid,
        undo_chat_session_id = ${input.chatSessionId ?? null}::uuid, updated_at = now()
      WHERE id = ${input.importId}::uuid AND undone_at IS NULL
        -- Removing the rows is right only while no build carries them.
        AND (${!input.rowsRemoved} OR release = 'target' OR staged_since IS NULL)
      RETURNING id
    `)) as unknown as unknown[];
    if (rows.length === 0)
      return err({
        kind: "HandlerError",
        operation: op,
        message: `import ${input.importId} does not exist, was already undone, or a build took it meanwhile: call undo_data_import again`,
      });
    if (input.rowsRemoved) {
      await tx.execute(
        sql`DELETE FROM data_import_items WHERE import_id = ${input.importId}::uuid`,
      );
      await tx.execute(
        sql`UPDATE data_imports SET item_count = 0 WHERE id = ${input.importId}::uuid`,
      );
    } else {
      // The rows stay for the environments that still show them; the keys
      // are free for a new import.
      await tx.execute(sql`
        UPDATE data_import_items SET active = false, updated_at = now()
        WHERE import_id = ${input.importId}::uuid
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.importId,
      resultSummary: input.rowsRemoved
        ? "rows removed"
        : "rows withdrawn with the next Stage and Publish live",
    });
    const state = (await tx.execute(sql`
      SELECT ${importStateSql()} AS state FROM data_imports di WHERE di.id = ${input.importId}::uuid
    `)) as unknown as { state: string }[];
    return ok({ state: state[0]?.state ?? "undone" });
  },
});
