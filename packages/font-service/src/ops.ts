// SPDX-License-Identifier: MPL-2.0
import { createHash, randomUUID } from "node:crypto";
import { defineOperation, recordAuditFromCtx, type TransactionRunner } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { inspectFontBytes, missingCharacters } from "./inspect.js";
import {
  type FontRef,
  fontFindInput,
  fontImportInput,
  fontMetadata,
  fontReadInput,
  fontRef,
  fontResolveInput,
} from "./types.js";

async function readAsset(tx: TransactionRunner, ref: FontRef) {
  const rows = (await tx.execute(
    sql`SELECT metadata, encode(bytes,'base64') AS data FROM font_assets WHERE id=${ref.id}::uuid AND sha256=${ref.sha256}`,
  )) as unknown as { metadata: unknown; data: string }[];
  if (!rows[0]) throw new Error("FontRevisionNotFound");
  const bytes = Buffer.from(rows[0].data, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
    throw new Error("FontIntegrityMismatch");
  return { metadata: fontMetadata.parse(rows[0].metadata), bytes };
}

export const importFontOp = defineOperation({
  name: "fonts.import",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: fontImportInput,
  output: fontMetadata,
  async handler(ctx, input, tx) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64))
      throw new Error("FontBase64Invalid");
    const bytes = Buffer.from(input.dataBase64, "base64");
    const inspected = inspectFontBytes(bytes, input.license);
    const metadata = fontMetadata.parse({
      ...inspected,
      id: randomUUID(),
      license: input.license,
      source: input.source,
      createdAt: new Date().toISOString(),
    });
    await tx.execute(
      sql`INSERT INTO font_assets(id,sha256,metadata,bytes,created_by) VALUES (${metadata.id}::uuid,${metadata.sha256},${JSON.stringify(metadata)}::text::jsonb,decode(${input.dataBase64},'base64'),${ctx.actorId}::uuid)`,
    );
    await recordAuditFromCtx(tx, ctx, {
      operation: "fonts.import",
      input: { sha256: metadata.sha256, license: input.license, source: input.source },
      succeeded: true,
      entityId: metadata.id,
    });
    return ok(metadata);
  },
});
export const findFontsOp = defineOperation({
  name: "fonts.find",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: fontFindInput,
  output: z.object({ fonts: z.array(fontMetadata), hasMore: z.boolean() }),
  async handler(_ctx, input, tx) {
    const rows = (await tx.execute(
      sql`SELECT metadata FROM font_assets WHERE position(lower(${input.query}) in lower(metadata->>'family'))>0 ORDER BY created_at DESC,id LIMIT ${input.limit}`,
    )) as unknown as { metadata: unknown }[];
    const fonts: z.infer<typeof fontMetadata>[] = [];
    let responseBytes = 0;
    for (const row of rows) {
      const font = fontMetadata.parse(row.metadata);
      responseBytes += Buffer.byteLength(JSON.stringify(font));
      if (responseBytes > 600_000) break;
      fonts.push(font);
    }
    return ok({ fonts, hasMore: fonts.length < rows.length || rows.length === input.limit });
  },
});
export const inspectFontOp = defineOperation({
  name: "fonts.inspect",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: fontRef,
  output: fontMetadata,
  async handler(_ctx, input, tx) {
    return ok((await readAsset(tx, input)).metadata);
  },
});
export const resolveFontOp = defineOperation({
  name: "fonts.resolve",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: fontResolveInput,
  output: fontMetadata,
  async handler(_ctx, input, tx) {
    const { metadata, bytes } = await readAsset(tx, input);
    if (!metadata.embedding[input.use]) throw new Error(`FontEmbeddingNotPermitted:${input.use}`);
    if (!input.formats.includes(metadata.format))
      throw new Error(`FontFormatNotSupportedByConsumer:${metadata.format}`);
    const missing = missingCharacters(bytes, input.text);
    if (missing.length) throw new Error(`FontMissingCharacters:${missing.slice(0, 30).join("")}`);
    return ok(metadata);
  },
});
export const readFontOp = defineOperation({
  name: "fonts.read_chunk",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: fontReadInput,
  output: z.object({ dataBase64: z.string(), sizeBytes: z.number(), eof: z.boolean() }),
  async handler(_ctx, input, tx) {
    const rows = (await tx.execute(sql`SELECT octet_length(bytes) AS size,
      encode(substring(bytes FROM ${input.offset + 1} FOR ${input.length}), 'base64') AS data
      FROM font_assets WHERE id=${input.id}::uuid AND sha256=${input.sha256}`)) as unknown as {
      size: number;
      data: string;
    }[];
    const row = rows[0];
    if (!row) throw new Error("FontRevisionNotFound");
    if (input.offset > row.size) throw new Error("FontOffsetInvalid");
    return ok({
      dataBase64: row.data.replaceAll("\n", ""),
      sizeBytes: row.size,
      eof: input.offset + input.length >= row.size,
    });
  },
});
export const fontOperations = [
  importFontOp,
  findFontsOp,
  inspectFontOp,
  resolveFontOp,
  readFontOp,
] as const;
