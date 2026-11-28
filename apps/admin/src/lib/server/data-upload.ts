// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: storing an uploaded data file (docs/data-imports.md), for
 * the MCP route (`/api/mcp/data-uploads`) and the admin's upload page. The file is
 * checked enough to fail early (UTF-8, a known format, readable as a
 * whole), put in the private media store under `data-uploads/`, and
 * recorded. Its rows are read only by the import that names it.
 */

import { createHash, randomUUID } from "node:crypto";
import { getMediaStorage } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import {
  decodeDataFile,
  detectDataFileFormat,
  type ExecutionContext,
  MAX_DATA_FILE_BYTES,
  parseDataFile,
} from "@caelo-cms/shared";
import { getQueryContext } from "./query.js";

/** What an upload holds, for the agent: never its rows. */
export interface StoredDataUpload {
  readonly uploadId: string;
  readonly filename: string;
  readonly format: string;
  readonly byteSize: number;
  readonly columns: readonly string[];
  readonly rows: number;
  readonly unreadableRows: number;
  readonly expiresAt: string;
}

export type StoreDataUploadResult =
  | { readonly ok: true; readonly upload: StoredDataUpload }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** Check, store and record one data file. `uploadId` fills a slot. */
export async function storeDataUpload(input: {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly ctx: ExecutionContext;
  readonly uploadId?: string;
}): Promise<StoreDataUploadResult> {
  if (input.bytes.byteLength > MAX_DATA_FILE_BYTES)
    return {
      ok: false,
      status: 413,
      message: `the file is ${input.bytes.byteLength} bytes, at most ${MAX_DATA_FILE_BYTES}: split it`,
    };
  const decoded = decodeDataFile(input.bytes);
  if (!decoded.ok) return { ok: false, status: 400, message: decoded.error };
  const format = detectDataFileFormat(input.filename, decoded.text);
  if (!format)
    return {
      ok: false,
      status: 400,
      message: "name the file .csv, .jsonl or .json so its format is clear",
    };
  const parsed = parseDataFile(decoded.text, format);
  if (!parsed.ok) return { ok: false, status: 400, message: `${input.filename}: ${parsed.error}` };
  const day = new Date().toISOString().slice(0, 10);
  const storageKey = `data-uploads/${day}/${randomUUID()}`;
  await getMediaStorage().put(storageKey, input.bytes, "application/octet-stream");
  const { adapter, registry } = getQueryContext();
  const recorded = await execute(registry, adapter, input.ctx, "data_uploads.record", {
    ...(input.uploadId ? { uploadId: input.uploadId } : {}),
    filename: input.filename.slice(0, 255),
    format,
    byteSize: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    storageKey,
  });
  if (!recorded.ok) {
    await getMediaStorage().delete(storageKey);
    const message =
      "message" in recorded.error ? String(recorded.error.message) : recorded.error.kind;
    return { ok: false, status: 400, message };
  }
  const v = recorded.value as { uploadId: string; expiresAt: string };
  return {
    ok: true,
    upload: {
      uploadId: v.uploadId,
      filename: input.filename,
      format,
      byteSize: input.bytes.byteLength,
      columns: parsed.columns,
      rows: parsed.records.length,
      unreadableRows: parsed.unreadable.length,
      expiresAt: v.expiresAt,
    },
  };
}
