// SPDX-License-Identifier: MPL-2.0

/**
 * A plugin's private immutable files as named Query API operations
 * (CMS_REQUIREMENTS §14.5 `private_files`, §14.7). Bytes travel in fixed
 * base64 chunks below the sandbox's message limit; a file becomes
 * readable only after its SHA-256 verifies, and a ready file never
 * changes — its SHA-256 is its revision.
 *
 * Every operation runs as the plugin (forced RLS scopes metadata and
 * bytes to it) and first checks, in its own transaction, that the plugin
 * is active and — for an installed artifact — holds an unrevoked
 * `private_files` receipt for exactly the artifact that runs. Writes
 * also serialise per plugin, so concurrent uploads cannot both pass the
 * quota check.
 *
 * Files have no chat branch. Uploading from a chat is fine — an
 * unreferenced file changes nothing a visitor sees, and the rows that
 * reference it are branched. Removing is not: it would delete bytes the
 * published state may still reference, so `remove` is refused on a
 * branch.
 */

import { createHash } from "node:crypto";
import {
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { privateGrantRefusal } from "./private-storage.js";

const CHUNK = 262_144;
const QUOTA = 1_073_741_824;
const MAX_SIZE = 20_971_520;

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ id: uuid }).strict();
const chunkAt = identity.extend({
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_SIZE - 1)
    .multipleOf(CHUNK),
});
const metadata = identity.extend({
  mediaType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  sizeBytes: z.number().int().min(1).max(MAX_SIZE),
  sha256,
});
const fileOut = z.object({
  id: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  status: z.enum(["pending", "ready", "deleted"]),
});

interface Row {
  id: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  status: "pending" | "ready" | "deleted";
}
const toFile = (row: Row) => ({
  id: row.id,
  mediaType: row.media_type,
  sizeBytes: row.size_bytes,
  sha256: row.sha256,
  status: row.status,
});

/** Operation names, for the host broker. */
export const FILE_OPS = {
  begin: "plugin_files.begin",
  writeChunk: "plugin_files.write_chunk",
  commit: "plugin_files.commit",
  stat: "plugin_files.stat",
  readChunk: "plugin_files.read_chunk",
  remove: "plugin_files.remove",
} as const;

type Tx = Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2];

function fail(operation: string, message: string) {
  return err({ kind: "HandlerError" as const, operation, message });
}

/** Plugin-only, grant held; writes also take the per-plugin upload lock. */
async function refusal(
  tx: Tx,
  ctx: ExecutionContext,
  operation: string,
  write: boolean,
): Promise<string | null> {
  if (ctx.actorKind !== "plugin" || !ctx.pluginId) {
    return `${operation}: only a plugin can use its own files`;
  }
  const refused = await privateGrantRefusal(tx, ctx, "private_files");
  if (refused) return `${operation}: ${refused}`;
  if (write) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.pluginId}, 219))`);
  }
  return null;
}

async function readRow(tx: Tx, pluginId: string, id: string): Promise<Row | undefined> {
  const rows = (await tx.execute(sql`
    SELECT id::text, media_type, size_bytes, sha256, status
    FROM plugin_private_files WHERE plugin_id = ${pluginId}::uuid AND id = ${id}::uuid
  `)) as unknown as Row[];
  return rows[0];
}

const beginOp = defineOperation({
  name: FILE_OPS.begin,
  // Why plugin-only: a plugin's own files; RLS scopes them by plugin id.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: metadata,
  output: fileOut,
  handler: async (ctx, input, tx) => {
    const op = FILE_OPS.begin;
    const refused = await refusal(tx, ctx, op, true);
    if (refused) return fail(op, refused);
    const pluginId = ctx.pluginId as string;
    const existing = await readRow(tx, pluginId, input.id);
    if (existing) {
      if (existing.status === "deleted") return fail(op, "PrivateFileIdentityRetired");
      if (
        existing.sha256 !== input.sha256 ||
        existing.size_bytes !== input.sizeBytes ||
        existing.media_type !== input.mediaType
      ) {
        return fail(op, "PrivateFileIdentityConflict");
      }
      return ok(toFile(existing));
    }
    const usage = (await tx.execute(sql`
      SELECT coalesce(sum(size_bytes), 0)::bigint AS bytes
      FROM plugin_private_files WHERE plugin_id = ${pluginId}::uuid AND status <> 'deleted'
    `)) as unknown as { bytes: string | number }[];
    if (Number(usage[0]?.bytes ?? 0) + input.sizeBytes > QUOTA) {
      return fail(op, "PrivateFileQuotaExceeded");
    }
    await tx.execute(sql`
      INSERT INTO plugin_private_files (plugin_id, id, media_type, size_bytes, sha256)
      VALUES (${pluginId}::uuid, ${input.id}::uuid, ${input.mediaType}, ${input.sizeBytes}, ${input.sha256})
    `);
    return ok({ ...input, status: "pending" as const });
  },
});

const writeChunkOp = defineOperation({
  name: FILE_OPS.writeChunk,
  // Why plugin-only: see begin.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: chunkAt.extend({ base64: z.string().min(4).max(349_528) }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const op = FILE_OPS.writeChunk;
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== input.base64) {
      return fail(op, "PrivateFileInvalidBase64");
    }
    const refused = await refusal(tx, ctx, op, true);
    if (refused) return fail(op, refused);
    const pluginId = ctx.pluginId as string;
    const row = await readRow(tx, pluginId, input.id);
    if (!row || row.status === "deleted") return fail(op, "PrivateFileNotFound");
    if (
      input.offset >= row.size_bytes ||
      bytes.length !== Math.min(CHUNK, row.size_bytes - input.offset)
    ) {
      return fail(op, "PrivateFileChunkSizeMismatch");
    }
    const chunks = (await tx.execute(sql`
      SELECT encode(bytes, 'base64') AS bytes FROM plugin_private_file_chunks
      WHERE plugin_id = ${pluginId}::uuid AND file_id = ${input.id}::uuid
        AND offset_bytes = ${input.offset}
    `)) as unknown as { bytes: string }[];
    if (chunks[0]) {
      // Idempotent retry of the same chunk; different bytes conflict.
      if (!Buffer.from(chunks[0].bytes, "base64").equals(bytes)) {
        return fail(op, "PrivateFileChunkConflict");
      }
      return ok({});
    }
    if (row.status === "ready") return fail(op, "PrivateFileImmutable");
    await tx.execute(sql`
      INSERT INTO plugin_private_file_chunks (plugin_id, file_id, offset_bytes, bytes)
      VALUES (${pluginId}::uuid, ${input.id}::uuid, ${input.offset}, decode(${input.base64}, 'base64'))
    `);
    return ok({});
  },
});

const commitOp = defineOperation({
  name: FILE_OPS.commit,
  // Why plugin-only: see begin.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: identity,
  output: fileOut,
  handler: async (ctx, input, tx) => {
    const op = FILE_OPS.commit;
    const refused = await refusal(tx, ctx, op, true);
    if (refused) return fail(op, refused);
    const pluginId = ctx.pluginId as string;
    const row = await readRow(tx, pluginId, input.id);
    if (!row || row.status === "deleted") return fail(op, "PrivateFileNotFound");
    if (row.status === "ready") return ok(toFile(row));
    const chunks = (await tx.execute(sql`
      SELECT offset_bytes, encode(bytes, 'base64') AS bytes FROM plugin_private_file_chunks
      WHERE plugin_id = ${pluginId}::uuid AND file_id = ${input.id}::uuid
      ORDER BY offset_bytes
    `)) as unknown as { offset_bytes: number; bytes: string }[];
    const hash = createHash("sha256");
    let length = 0;
    for (const chunk of chunks) {
      if (chunk.offset_bytes !== length) return fail(op, "PrivateFileIncomplete");
      const bytes = Buffer.from(chunk.bytes, "base64");
      hash.update(bytes);
      length += bytes.length;
    }
    if (length !== row.size_bytes) return fail(op, "PrivateFileIncomplete");
    if (hash.digest("hex") !== row.sha256) return fail(op, "PrivateFileDigestMismatch");
    await tx.execute(sql`
      UPDATE plugin_private_files SET status = 'ready'
      WHERE plugin_id = ${pluginId}::uuid AND id = ${input.id}::uuid
    `);
    return ok(toFile({ ...row, status: "ready" }));
  },
});

const statOp = defineOperation({
  name: FILE_OPS.stat,
  // Why plugin-only: see begin.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: identity,
  output: fileOut,
  handler: async (ctx, input, tx) => {
    const op = FILE_OPS.stat;
    const refused = await refusal(tx, ctx, op, false);
    if (refused) return fail(op, refused);
    const row = await readRow(tx, ctx.pluginId as string, input.id);
    if (!row) return fail(op, "PrivateFileNotFound");
    return ok(toFile(row));
  },
});

const readChunkOp = defineOperation({
  name: FILE_OPS.readChunk,
  // Why plugin-only: see begin.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: chunkAt.strict(),
  output: z.object({ base64: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = FILE_OPS.readChunk;
    const refused = await refusal(tx, ctx, op, false);
    if (refused) return fail(op, refused);
    const pluginId = ctx.pluginId as string;
    const row = await readRow(tx, pluginId, input.id);
    if (!row) return fail(op, "PrivateFileNotFound");
    if (row.status !== "ready") return fail(op, "PrivateFileNotReady");
    if (input.offset >= row.size_bytes) return fail(op, "PrivateFileOffsetOutsideFile");
    const chunks = (await tx.execute(sql`
      SELECT encode(bytes, 'base64') AS bytes FROM plugin_private_file_chunks
      WHERE plugin_id = ${pluginId}::uuid AND file_id = ${input.id}::uuid
        AND offset_bytes = ${input.offset}
    `)) as unknown as { bytes: string }[];
    if (!chunks[0]) return fail(op, "PrivateFileIncomplete");
    return ok({ base64: chunks[0].bytes.replaceAll("\n", "") });
  },
});

const removeOp = defineOperation({
  name: FILE_OPS.remove,
  // Why plugin-only: see begin.
  actorScope: ["plugin"],
  database: "cms_admin",
  input: identity.extend({ sha256 }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const op = FILE_OPS.remove;
    if (ctx.chatBranchId) {
      return fail(
        op,
        `${op}: files have no chat branch — removing one from a chat would delete bytes the published state may still use. Remove it from the Owner panel after publishing`,
      );
    }
    const refused = await refusal(tx, ctx, op, true);
    if (refused) return fail(op, refused);
    const pluginId = ctx.pluginId as string;
    const row = await readRow(tx, pluginId, input.id);
    if (!row) return fail(op, "PrivateFileNotFound");
    if (row.sha256 !== input.sha256) return fail(op, "PrivateFileIdentityConflict");
    await tx.execute(sql`
      DELETE FROM plugin_private_file_chunks
      WHERE plugin_id = ${pluginId}::uuid AND file_id = ${input.id}::uuid
    `);
    // The identity is retired, not freed: a referenced version can
    // disappear but can never come back with different bytes.
    await tx.execute(sql`
      UPDATE plugin_private_files SET status = 'deleted'
      WHERE plugin_id = ${pluginId}::uuid AND id = ${input.id}::uuid
    `);
    return ok({});
  },
});

const ALL = [beginOp, writeChunkOp, commitOp, statOp, readChunkOp, removeOp];

/** Register the private-file operations (idempotent, like the storage ops). */
export function registerPluginFileOps(registry: OperationRegistry): void {
  if (registry.has(FILE_OPS.begin)) return;
  // The registry stores every op as OperationDefinition<unknown, unknown>.
  for (const op of ALL) registry.register(op as OperationDefinition<unknown, unknown>);
}
