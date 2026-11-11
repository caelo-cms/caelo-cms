// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — `static_files.*`: small data files at a chosen path on the
 * site's domain, the way robots.txt is served (rules in @caelo-cms/shared
 * `static-files.ts`, overview in docs/dev/static-files.md).
 *
 * Reads are open to the AI. Writes are human + system: the AI goes through
 * `static_files.propose_*` (static_files_pending.ts), because a file at a
 * chosen path can prove domain ownership to a third party (CLAUDE.md §11.A).
 *
 * The rows are authoring state. Nothing here reaches a visitor: the static
 * generator reads the rows at Stage and a human Publish live copies that
 * build. Each write snapshots with no branch, like an approved template
 * update, whatever the caller's chat is bound to: the table has no branch
 * column and the build is the draft boundary (migration 0625).
 */

import {
  defineOperation,
  type ErrorDetail,
  handlerErrorFromDetails,
  type TransactionRunner,
  textArray,
} from "@caelo-cms/query-api";
import {
  err,
  ok,
  redirectAddress,
  STATIC_FILE_CONTENT_TYPES,
  STATIC_FILE_MAX_BATCH,
  STATIC_FILE_MAX_BYTES,
  STATIC_FILE_MAX_COUNT,
  STATIC_FILE_MAX_PATH_LENGTH,
  type StaticFileContentType,
  type StaticFileInput,
  staticFileByteLength,
  staticFileCollisions,
  staticFileInputSchema,
  staticFileIssues,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { emitSnapshot, type SnapshotEntity } from "../snapshots/index.js";
import type { StaticFileState } from "../snapshots/state.js";
import { requiresApproverPermission } from "./_approver-permission.js";

/**
 * Input of a write: one transaction, so a batch lands whole or not at all.
 * The rules that need no data are part of the shape, so the approval
 * preflight refuses such a call before it costs the Owner a click.
 */
export const staticFilesSetInput = z
  .object({ files: z.array(staticFileInputSchema).min(1).max(STATIC_FILE_MAX_BATCH) })
  .strict()
  .superRefine((input, ctx) => {
    for (const [i, file] of input.files.entries()) {
      for (const message of staticFileIssues(file)) {
        ctx.addIssue({ code: "custom", path: ["files", i], message: `${file.path}: ${message}` });
      }
    }
  });

/** Input of a delete. */
export const staticFilesDeleteInput = z
  .object({
    paths: z
      .array(z.string().min(2).max(STATIC_FILE_MAX_PATH_LENGTH))
      .min(1)
      .max(STATIC_FILE_MAX_BATCH),
  })
  .strict();

/** A file without its text: every list reads these, a body only when it is asked for. */
interface FileMetaRow {
  id: string;
  path: string;
  content_type: StaticFileContentType;
  purpose: string;
  size_bytes: number;
  version: number | string;
  updated_at: string | Date;
}

interface FileRow extends Omit<FileMetaRow, "size_bytes"> {
  body: string;
  deleted_at: string | Date | null;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

/** Every file of the site. Bounded by {@link STATIC_FILE_MAX_COUNT}, so the table is the request's size. */
async function liveFiles(tx: TransactionRunner): Promise<FileMetaRow[]> {
  return (await tx.execute(sql`
    SELECT id::text AS id, path, content_type, purpose, octet_length(body) AS size_bytes,
           version, updated_at
    FROM static_files WHERE deleted_at IS NULL ORDER BY path
  `)) as unknown as FileMetaRow[];
}

function stateOf(r: FileRow): StaticFileState {
  return {
    schemaVersion: 1,
    path: r.path,
    contentType: r.content_type,
    body: r.body,
    purpose: r.purpose,
    version: Number(r.version),
    deletedAt: r.deleted_at === null ? null : iso(r.deleted_at),
  };
}

/** The URL forms a page or redirect at a file's path could be stored under. */
const urlForms = (paths: readonly string[]): string[] => paths.flatMap((p) => [p, `${p}/`]);

/**
 * Everything wrong with a write, without changing anything: the file rules,
 * the site's file cap and the collisions. Run when the AI proposes (so an
 * inapplicable proposal never costs a click) and again when it applies (a
 * page may have taken the path since).
 *
 * The check here covers exact URLs. A page below a new extension-less file
 * and a collision with a page on another chat's branch cannot be read here
 * cheaply; the generator refuses those at Stage.
 */
export async function staticFileWriteProblems(
  tx: TransactionRunner,
  files: readonly StaticFileInput[],
): Promise<ErrorDetail[]> {
  const out: ErrorDetail[] = [];
  const existing = await liveFiles(tx);
  const paths = files.map((f) => f.path);
  const pages = (await tx.execute(sql`
    SELECT DISTINCT current_path FROM pages
    WHERE current_path = ANY(${textArray(urlForms(paths))}) AND deleted_at IS NULL
  `)) as unknown as { current_path: string }[];
  // #1550 — a pending rule (Draft or Staged) takes the path too: it goes
  // live with a Publish live or Go live now.
  const redirects = (await tx.execute(sql`
    SELECT from_path FROM redirects WHERE from_path = ANY(${textArray(urlForms(paths))})
    UNION
    SELECT from_path FROM pending_redirects
    WHERE address = ANY(${textArray(paths.map((p) => redirectAddress(p)))}) AND to_path IS NOT NULL
  `)) as unknown as { from_path: string }[];
  const allPaths = new Set([...existing.map((f) => f.path), ...paths]);
  for (const [i, file] of files.entries()) {
    const at = ["files", i];
    if (paths.indexOf(file.path) !== i) {
      out.push({
        path: [...at, "path"],
        message: `${file.path} appears twice in this call; send each path once`,
      });
      continue;
    }
    for (const message of staticFileIssues(file)) {
      out.push({ path: at, message: `${file.path}: ${message}` });
    }
    for (const message of staticFileCollisions(file.path, {
      pagePaths: pages.map((p) => p.current_path),
      redirectFromPaths: redirects.map((r) => r.from_path),
      filePaths: allPaths,
    })) {
      out.push({
        path: [...at, "path"],
        message: `${file.path}: ${message}. Choose another path, or move that first (update_pages_many, bulk_delete_redirects, propose_delete_static_files)`,
      });
    }
  }
  if (allPaths.size > STATIC_FILE_MAX_COUNT) {
    out.push({
      path: ["files"],
      message: `the site would have ${allPaths.size} static files; it may have at most ${STATIC_FILE_MAX_COUNT}. Delete files it no longer needs first (list_static_files, propose_delete_static_files)`,
    });
  }
  return out;
}

/**
 * The version each path holds now, null where it has no file. A proposal
 * records this and its approval compares it, so an approved change never
 * overwrites a change made after the AI read the file.
 */
export async function staticFileVersions(
  tx: TransactionRunner,
  paths: readonly string[],
): Promise<Record<string, number | null>> {
  const rows = await liveFiles(tx);
  return Object.fromEntries(
    paths.map((p) => {
      const row = rows.find((r) => r.path === p);
      return [p, row ? Number(row.version) : null];
    }),
  );
}

/** The paths of `paths` that have no file, as refusals. */
export async function missingStaticFiles(
  tx: TransactionRunner,
  paths: readonly string[],
): Promise<ErrorDetail[]> {
  const known = new Set((await liveFiles(tx)).map((f) => f.path));
  return paths.flatMap((path, i) =>
    known.has(path)
      ? []
      : [
          {
            path: ["paths", i],
            message: `there is no static file at ${path}; list_static_files shows the ones that exist`,
          },
        ],
  );
}

/**
 * Write a state onto its row (`snapshots.revert_site`). The path is part of
 * the row for good, so a restore cannot collide with another file.
 */
export async function applyStaticFileState(
  tx: TransactionRunner,
  actorId: string,
  id: string,
  state: StaticFileState,
): Promise<void> {
  await tx.execute(sql`
    UPDATE static_files
    SET content_type = ${state.contentType}, body = ${state.body}, purpose = ${state.purpose},
        version = version + 1, updated_at = now(), updated_by = ${actorId}::uuid,
        deleted_at = ${state.deletedAt}::timestamptz
    WHERE id = ${id}::uuid
  `);
}

const fileMetaSchema = z.object({
  id: z.string(),
  path: z.string(),
  contentType: z.enum(STATIC_FILE_CONTENT_TYPES),
  purpose: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
  /**
   * Where the current text stands: `not_staged` until a Stage built it,
   * `staged` once staging serves it, `live` once a Publish live shipped it.
   */
  releaseState: z.enum(["not_staged", "staged", "live"]),
});

/**
 * When the builds that staging and the live site serve were started. A
 * promote or a rollback records no build of its own: its run's `build_id`
 * names the Stage run whose files it serves, so that run's start is what a
 * file's last change is compared with. A display value: the deploy log
 * remains the record.
 */
async function servedBuildTimes(
  tx: TransactionRunner,
): Promise<{ stagedFrom: string | null; liveFrom: string | null }> {
  const rows = (await tx.execute(sql`
    WITH served AS (
      SELECT DISTINCT ON (t.env) t.env, r.build_id
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.status = 'succeeded' AND r.build_kind = 'site' AND r.build_id IS NOT NULL
        AND t.env IN ('staging', 'production')
      ORDER BY t.env, r.started_at DESC
    )
    SELECT s.env, source.started_at
    FROM served s
    JOIN deploy_runs source ON source.id = CASE
      WHEN s.build_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN s.build_id::uuid END
  `)) as unknown as { env: string; started_at: string | Date }[];
  const from = (env: string): string | null => {
    const r = rows.find((x) => x.env === env);
    return r ? iso(r.started_at) : null;
  };
  return { stagedFrom: from("staging"), liveFrom: from("production") };
}

function releaseState(
  updatedAt: string,
  built: { stagedFrom: string | null; liveFrom: string | null },
): "not_staged" | "staged" | "live" {
  if (built.liveFrom !== null && updatedAt <= built.liveFrom) return "live";
  if (built.stagedFrom !== null && updatedAt <= built.stagedFrom) return "staged";
  return "not_staged";
}

// ─── static_files.list ───────────────────────────────────────────────

export const listStaticFilesOp = defineOperation({
  name: "static_files.list",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Free-text match on path and purpose. */
      query: z.string().min(1).max(200).optional(),
      contentType: z.enum(STATIC_FILE_CONTENT_TYPES).optional(),
    })
    .strict(),
  output: z.object({
    files: z.array(fileMetaSchema),
    totalCount: z.number().int().nonnegative(),
    maxCount: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = await liveFiles(tx);
    const built = await servedBuildTimes(tx);
    const q = input.query?.toLowerCase();
    return ok({
      files: rows
        .filter((r) => input.contentType === undefined || r.content_type === input.contentType)
        .filter((r) => q === undefined || `${r.path} ${r.purpose}`.toLowerCase().includes(q))
        .map((r) => {
          const updatedAt = iso(r.updated_at);
          return {
            id: r.id,
            path: r.path,
            contentType: r.content_type,
            purpose: r.purpose,
            sizeBytes: Number(r.size_bytes),
            version: Number(r.version),
            updatedAt,
            releaseState: releaseState(updatedAt, built),
          };
        }),
      totalCount: rows.length,
      maxCount: STATIC_FILE_MAX_COUNT,
      maxBytes: STATIC_FILE_MAX_BYTES,
    });
  },
});

// ─── static_files.get ────────────────────────────────────────────────

export const getStaticFileOp = defineOperation({
  name: "static_files.get",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ path: z.string().min(2).max(STATIC_FILE_MAX_PATH_LENGTH) }).strict(),
  output: fileMetaSchema.extend({ body: z.string() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, path, content_type, body, purpose, version, updated_at, deleted_at
      FROM static_files WHERE path = ${input.path} AND deleted_at IS NULL
    `)) as unknown as FileRow[];
    const r = rows[0];
    if (!r) {
      const known = (await liveFiles(tx)).map((f) => f.path);
      return err({
        kind: "HandlerError",
        operation: "static_files.get",
        message: `there is no static file at ${input.path}. The site has ${known.join(", ") || "none"}.`,
      });
    }
    const updatedAt = iso(r.updated_at);
    return ok({
      id: r.id,
      path: r.path,
      contentType: r.content_type,
      purpose: r.purpose,
      sizeBytes: staticFileByteLength(r.body),
      version: Number(r.version),
      updatedAt,
      releaseState: releaseState(updatedAt, await servedBuildTimes(tx)),
      body: r.body,
    });
  },
});

// ─── static_files.set_many ───────────────────────────────────────────

const setManyOutput = z.object({
  files: z.array(
    z.object({ id: z.string(), path: z.string(), version: z.number().int().positive() }),
  ),
});

const setStaticFilesDefinition = defineOperation({
  name: "static_files.set_many",
  readScope: "request",
  // Why human-only: a file at a chosen path can prove domain ownership to a
  // third party (CLAUDE.md §11.A). The AI proposes through
  // static_files.propose_set; only an Owner's click writes.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: staticFilesSetInput,
  output: setManyOutput,
  handler: async (ctx, input, tx) => {
    const op = "static_files.set_many";
    // The site's file cap holds across parallel approvals only when they
    // check and write one after another.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('static_files.set_many'))`);
    const problems = await staticFileWriteProblems(tx, input.files);
    if (problems.length > 0) {
      return {
        ok: false,
        error: handlerErrorFromDetails(op, problems, { lead: "No file was written." }),
      };
    }
    const written: FileRow[] = [];
    for (const f of input.files) {
      // One row per path for good: writing a deleted path brings its row back.
      const rows = (await tx.execute(sql`
        INSERT INTO static_files (path, content_type, body, purpose, updated_by)
        VALUES (${f.path}, ${f.contentType}, ${f.body}, ${f.purpose}, ${ctx.actorId}::uuid)
        ON CONFLICT (path) DO UPDATE
          SET content_type = EXCLUDED.content_type, body = EXCLUDED.body,
              purpose = EXCLUDED.purpose, version = static_files.version + 1,
              updated_at = now(), updated_by = EXCLUDED.updated_by, deleted_at = NULL
        RETURNING id::text AS id, path, content_type, body, purpose, version, updated_at, deleted_at
      `)) as unknown as FileRow[];
      const row = rows[0];
      if (!row) throw new Error(`static_files.set_many: the write of ${f.path} returned no row`);
      written.push(row);
    }
    await snapshot(tx, ctx, op, written);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      // Bodies stay in the snapshot; the audit log names what changed.
      input: { paths: written.map((r) => r.path) },
      succeeded: true,
      resultSummary: written.map((r) => `${r.path} v${Number(r.version)}`).join(", "),
    });
    return ok({
      files: written.map((r) => ({ id: r.id, path: r.path, version: Number(r.version) })),
    });
  },
});

/** The Owner's write. The approver check also covers a panel save. */
export const setStaticFilesOp = requiresApproverPermission(
  ["settings.write"],
  setStaticFilesDefinition,
);

// ─── static_files.delete_many ────────────────────────────────────────

const deleteStaticFilesDefinition = defineOperation({
  name: "static_files.delete_many",
  readScope: "request",
  // Why human-only: see static_files.set_many. Deleting a verification file
  // can end an ownership proof, so the AI proposes this too.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: staticFilesDeleteInput,
  output: z.object({ deleted: z.array(z.string()) }),
  handler: async (ctx, input, tx) => {
    const op = "static_files.delete_many";
    const paths = [...new Set(input.paths)];
    const missing = await missingStaticFiles(tx, paths);
    if (missing.length > 0) {
      return {
        ok: false,
        error: handlerErrorFromDetails(op, missing, { lead: "No file was deleted." }),
      };
    }
    const rows = (await tx.execute(sql`
      UPDATE static_files
      SET deleted_at = now(), version = version + 1, updated_at = now(),
          updated_by = ${ctx.actorId}::uuid
      WHERE path = ANY(${textArray(paths)}) AND deleted_at IS NULL
      RETURNING id::text AS id, path, content_type, body, purpose, version, updated_at, deleted_at
    `)) as unknown as FileRow[];
    await snapshot(tx, ctx, op, rows);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { paths },
      succeeded: true,
      resultSummary: paths.join(", "),
    });
    return ok({ deleted: rows.map((r) => r.path) });
  },
});

/** The Owner's delete. */
export const deleteStaticFilesOp = requiresApproverPermission(
  ["settings.write"],
  deleteStaticFilesDefinition,
);

/** Snapshot the written rows on main (see the file header). */
async function snapshot(
  tx: TransactionRunner,
  ctx: { actorId: string; chatTaskId?: string },
  op: "static_files.set_many" | "static_files.delete_many",
  rows: readonly FileRow[],
): Promise<void> {
  await emitSnapshot(tx, {
    actorId: ctx.actorId,
    opKind: op,
    description: `${op} ${rows.map((r) => r.path).join(", ")}`,
    chatTaskId: ctx.chatTaskId ?? null,
    chatBranchId: null,
    entities: rows.map(
      (r): SnapshotEntity => ({ kind: "staticFile", entityId: r.id, state: stateOf(r) }),
    ),
  });
}
