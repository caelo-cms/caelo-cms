// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: files handed over for an import (docs/data-imports.md).
 * The bytes live in the private media store under `data-uploads/`; these
 * rows say whose they are, what they hold and when they go.
 *
 *   data_uploads.create_slot  an empty upload the operator fills on the
 *                             admin page (for agents that cannot read the
 *                             operator's disk: remote MCP, the chat)
 *   data_uploads.record       the bytes are stored: fill a slot or add one
 *   data_uploads.get          one upload's description
 *   data_uploads.forget       drop uploads (after an import used them, or
 *                             expired) and hand back their storage keys
 */

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { DATA_FILE_FORMATS, err, MAX_DATA_FILE_BYTES, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

/** How long an upload is kept. */
export const DATA_UPLOAD_TTL_DAYS = 7;

/** The storage key prefix of uploaded files; never served to visitors. */
export const DATA_UPLOAD_PREFIX = "data-uploads";

/** The admin page where the operator fills a slot. */
export function dataUploadLink(uploadId: string): string {
  return `/settings/data-imports/upload/${uploadId}`;
}

const uploadSchema = z.object({
  uploadId: z.string(),
  status: z.enum(["awaiting", "ready"]),
  filename: z.string().nullable(),
  format: z.enum(DATA_FILE_FORMATS).nullable(),
  byteSize: z.number().int().nullable(),
  storageKey: z.string().nullable(),
  link: z.string(),
  expiresAt: z.string(),
});

interface UploadRow {
  id: string;
  status: "awaiting" | "ready";
  filename: string | null;
  format: (typeof DATA_FILE_FORMATS)[number] | null;
  byte_size: number | null;
  storage_key: string | null;
  expires_at: string;
}

const UPLOAD_COLUMNS = sql`id::text AS id, status, filename, format, byte_size, storage_key,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at`;

function uploadOf(r: UploadRow): z.infer<typeof uploadSchema> {
  return {
    uploadId: r.id,
    status: r.status,
    filename: r.filename,
    format: r.format,
    byteSize: r.byte_size,
    storageKey: r.storage_key,
    link: dataUploadLink(r.id),
    expiresAt: r.expires_at,
  };
}

export const createDataUploadSlotOp = defineOperation({
  name: "data_uploads.create_slot",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ chatSessionId: z.string().uuid().optional() }).strict(),
  output: uploadSchema,
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO data_uploads (created_by, chat_session_id, status, expires_at)
      VALUES (${ctx.actorId}::uuid, ${input.chatSessionId ?? null}::uuid, 'awaiting',
              now() + make_interval(days => ${DATA_UPLOAD_TTL_DAYS}))
      RETURNING ${UPLOAD_COLUMNS}
    `)) as unknown as UploadRow[];
    const row = rows[0];
    if (!row) throw new Error("data_uploads.create_slot: insert returned no row");
    return ok(uploadOf(row));
  },
});

export const recordDataUploadOp = defineOperation({
  name: "data_uploads.record",
  readScope: "request",
  // Why human-only: the bytes reach the store only through the admin's
  // upload routes (the upload page, MCP `/api/mcp/data-uploads`), which run as the
  // signed-in person or the token's owner and record what they stored.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Fill this slot; omit to add a new upload. */
      uploadId: z.string().uuid().optional(),
      chatSessionId: z.string().uuid().optional(),
      filename: z.string().min(1).max(255),
      format: z.enum(DATA_FILE_FORMATS),
      byteSize: z.number().int().min(1).max(MAX_DATA_FILE_BYTES),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      storageKey: z.string().startsWith(`${DATA_UPLOAD_PREFIX}/`).max(300),
    })
    .strict(),
  output: uploadSchema,
  handler: async (ctx, input, tx) => {
    const op = "data_uploads.record";
    const rows = input.uploadId
      ? ((await tx.execute(sql`
          UPDATE data_uploads SET status = 'ready', filename = ${input.filename},
            format = ${input.format}, byte_size = ${input.byteSize}, sha256 = ${input.sha256},
            storage_key = ${input.storageKey}, uploaded_at = now()
          WHERE id = ${input.uploadId}::uuid AND status = 'awaiting' AND expires_at > now()
          RETURNING ${UPLOAD_COLUMNS}
        `)) as unknown as UploadRow[])
      : ((await tx.execute(sql`
          INSERT INTO data_uploads (created_by, chat_session_id, status, filename, format,
                                    byte_size, sha256, storage_key, uploaded_at, expires_at)
          VALUES (${ctx.actorId}::uuid, ${input.chatSessionId ?? null}::uuid, 'ready',
                  ${input.filename}, ${input.format}, ${input.byteSize}, ${input.sha256},
                  ${input.storageKey}, now(), now() + make_interval(days => ${DATA_UPLOAD_TTL_DAYS}))
          RETURNING ${UPLOAD_COLUMNS}
        `)) as unknown as UploadRow[]);
    const row = rows[0];
    if (!row)
      return err({
        kind: "HandlerError",
        operation: op,
        message: `upload ${input.uploadId} is filled already, expired or does not exist: ask for a new upload link`,
      });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input: { uploadId: row.id, filename: input.filename, byteSize: input.byteSize },
      succeeded: true,
      entityId: row.id,
      resultSummary: `${input.filename} (${input.byteSize} bytes)`,
    });
    return ok(uploadOf(row));
  },
});

export const getDataUploadOp = defineOperation({
  name: "data_uploads.get",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ uploadId: z.string().uuid() }).strict(),
  output: uploadSchema,
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${UPLOAD_COLUMNS} FROM data_uploads
      WHERE id = ${input.uploadId}::uuid AND expires_at > now()
    `)) as unknown as UploadRow[];
    const row = rows[0];
    if (!row)
      return err({
        kind: "HandlerError",
        operation: "data_uploads.get",
        message: `there is no upload ${input.uploadId} (uploads are kept ${DATA_UPLOAD_TTL_DAYS} days): upload the file again`,
      });
    return ok(uploadOf(row));
  },
});

export const forgetDataUploadsOp = defineOperation({
  name: "data_uploads.forget",
  readScope: "request",
  // Why human-only: the import pipeline drops the uploads it consumed and
  // the scheduler's sweep the expired ones; nobody deletes uploads by hand.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      /** These uploads; omit for every expired one (at most 500 per call). */
      uploadIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({ storageKeys: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM data_uploads WHERE id IN (
        SELECT id FROM data_uploads
        WHERE ${input.uploadIds ? sql`id = ANY(${uuidArray(input.uploadIds)})` : sql`expires_at <= now()`}
        LIMIT 500)
      RETURNING storage_key
    `)) as unknown as { storage_key: string | null }[];
    return ok({
      storageKeys: rows.flatMap((r) => (r.storage_key ? [r.storage_key] : [])),
    });
  },
});
