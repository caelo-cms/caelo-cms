// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports, the plugin host's part (docs/data-imports.md): which
 * imported rows a read may show, and `ctx.imports`, through which a plugin
 * reads the rows of its own kinds that keep their rows in core.
 *
 * Visibility follows the release pointers. An environment shows an import
 * while the run its pointer names started at or after the run that stamped
 * the import (`staged_since`), and stops at the run that stamped its undo.
 * A rollback moves the pointer, which takes the rolled-back imports with it.
 */

import type { PluginImportedRow, PluginImports, PluginInvocation } from "@caelo-cms/plugin-sdk";
import { defineOperation, execute, type OperationRegistry, uuidArray } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

/** Which imports a read may show. */
export type ImportView =
  /** Everything not undone: the editors' shared draft. */
  | "draft"
  /** What a build being made now carries: stamped, undo not stamped. */
  | "build"
  /** What an environment's release pointer shows. */
  | "staging"
  | "live";

export const IMPORT_VIEWS = ["draft", "build", "staging", "live"] as const;

/** The start of the run an environment's release pointer names, as SQL. */
function pointerStart(env: "staging" | "live"): SQL {
  return sql`(SELECT r.started_at FROM projection_release_pointers p
              JOIN deploy_runs r ON r.id = p.run_id WHERE p.environment = ${env})`;
}

/**
 * A boolean SQL expression: the import aliased `di` is shown in `view`.
 * Callers join `data_imports di` themselves. With no pointer yet (nothing
 * staged or published), `staging` and `live` show nothing.
 */
export function importShownSql(view: ImportView): SQL {
  switch (view) {
    case "draft":
      return sql`di.undone_at IS NULL`;
    case "build":
      return sql`(di.staged_since IS NOT NULL AND di.undo_staged_since IS NULL)`;
    case "staging":
    case "live": {
      const start = pointerStart(view);
      return sql`(di.staged_since <= ${start}
                  AND (di.undo_staged_since IS NULL OR di.undo_staged_since > ${start}))`;
    }
  }
}

/**
 * The view a plugin call reads its imports in: what the public database it
 * writes shows. A staging run reads what staging shows; a build's render
 * what the build carries; every other admin-side call (a worker, a chat
 * tool, the Owner's panel) writes the live public database, so it reads
 * what the live release shows. Drafts are the editors' to see, through
 * core's own tools, never a plugin's to publish.
 */
export function importViewOf(
  invocation: PluginInvocation,
  publicTarget: "live" | "staging" | undefined,
): ImportView {
  if (publicTarget === "staging") return "staging";
  if (invocation.origin === "render" && invocation.importView) return invocation.importView;
  return "live";
}

const MAX_ROWS = 1000;

const pluginRowsInput = z
  .object({
    kind: z.string().min(1).max(40),
    view: z.enum(IMPORT_VIEWS),
    pageIds: z.array(z.string().uuid()).min(1).max(MAX_ROWS).optional(),
    afterRowId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(MAX_ROWS).optional(),
  })
  .strict();

const importedRow = z.object({
  rowId: z.string(),
  sourceKey: z.string(),
  parentRowId: z.string().nullable(),
  pageId: z.string().nullable(),
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

/**
 * `data_imports.plugin_rows` — the calling plugin's imported rows of one of
 * its kinds, as `view` shows them, ordered by row id. Only the plugin's
 * own kinds: the owner is the calling plugin, never an input.
 */
export const pluginImportRowsOp = defineOperation({
  name: "data_imports.plugin_rows",
  pluginAccess: "read",
  readScope: "request",
  // Why human-only: no person or AI reads through it; the plugin host's
  // `ctx.imports` handle calls it as the plugin (and tests as the system).
  actorScope: ["plugin", "system"],
  database: "cms_admin",
  input: pluginRowsInput,
  output: z.object({ rows: z.array(importedRow) }),
  handler: async (ctx, input, tx) => {
    if (!ctx.pluginId) {
      return err({
        kind: "HandlerError",
        operation: "data_imports.plugin_rows",
        message: "only a plugin reads its imported rows (ctx.imports)",
      });
    }
    const owner = (await tx.execute(sql`
      SELECT slug FROM plugins WHERE id = ${ctx.pluginId}::uuid
    `)) as unknown as { slug: string }[];
    const slug = owner[0]?.slug;
    if (!slug) {
      return err({
        kind: "HandlerError",
        operation: "data_imports.plugin_rows",
        message: `no plugin row for ${ctx.pluginId}`,
      });
    }
    const rows = (await tx.execute(sql`
      SELECT i.row_id::text AS row_id, i.source_key, i.parent_row_id::text AS parent_row_id,
             i.page_id::text AS page_id, i."values"
      FROM data_import_items i
      JOIN data_imports di ON di.id = i.import_id
      WHERE i.owner = ${slug} AND i.kind = ${input.kind}
        AND ${importShownSql(input.view)}
        ${input.pageIds ? sql`AND i.page_id = ANY(${uuidArray(input.pageIds)})` : sql``}
        ${input.afterRowId ? sql`AND i.row_id > ${input.afterRowId}::uuid` : sql``}
      ORDER BY i.row_id
      LIMIT ${input.limit ?? MAX_ROWS}
    `)) as unknown as {
      row_id: string;
      source_key: string;
      parent_row_id: string | null;
      page_id: string | null;
      values: Record<string, string | number | boolean | null>;
    }[];
    return ok({
      rows: rows.map((r) => ({
        rowId: r.row_id,
        sourceKey: r.source_key,
        parentRowId: r.parent_row_id,
        pageId: r.page_id,
        values: r.values,
      })),
    });
  },
});

/** Registers the op the `ctx.imports` handle calls (idempotent). */
export function registerImportRowOps(registry: OperationRegistry): void {
  if (!registry.has(pluginImportRowsOp.name)) registry.register(pluginImportRowsOp);
}

/** What {@link makePluginImports} needs of the host. */
export interface ImportsHandleDeps {
  readonly registry: OperationRegistry;
  readonly adapter: Parameters<typeof execute>[1];
  readonly pluginActorId: string;
  readonly pluginId: string;
  readonly slug: string;
}

/** `ctx.imports` for one call, reading in `view`. */
export function makePluginImports(deps: ImportsHandleDeps, view: ImportView): PluginImports {
  return Object.freeze({
    rows: async (
      kind: string,
      opts: {
        readonly pageIds?: readonly string[];
        readonly afterRowId?: string;
        readonly limit?: number;
      } = {},
    ) => {
      registerImportRowOps(deps.registry);
      const r = await execute(
        deps.registry,
        deps.adapter,
        {
          actorId: deps.pluginActorId,
          actorKind: "plugin",
          requestId: `plugin-${deps.slug}`,
          pluginId: deps.pluginId,
        },
        "data_imports.plugin_rows",
        {
          kind,
          view,
          ...(opts.pageIds ? { pageIds: [...opts.pageIds] } : {}),
          ...(opts.afterRowId ? { afterRowId: opts.afterRowId } : {}),
          ...(opts.limit ? { limit: opts.limit } : {}),
        },
      );
      if (!r.ok) {
        const reason = "message" in r.error ? String(r.error.message) : r.error.kind;
        throw new Error(`ctx.imports.rows("${kind}") failed: ${reason}`);
      }
      return (r.value as { rows: PluginImportedRow[] }).rows;
    },
  });
}
