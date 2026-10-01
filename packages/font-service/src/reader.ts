// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import type { TransactionRunner } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { readFontOp, resolveFontOp } from "./ops.js";
import type { FontRef } from "./types.js";

/** Named Query API operations also serve in-transaction preview/build consumers. */
export function fontReader(tx: TransactionRunner, ctx: ExecutionContext) {
  return async (ref: FontRef) => {
    const resolved = await resolveFontOp.handler(
      ctx,
      { ...ref, use: "web", text: "", formats: ["ttf", "otf", "woff", "woff2"] },
      tx,
    );
    if (!resolved.ok) throw new Error("FontResolutionFailed");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < resolved.value.sizeBytes; offset += 262144) {
      const chunk = await readFontOp.handler(ctx, { ...ref, offset, length: 262144 }, tx);
      if (!chunk.ok) throw new Error("FontReadFailed");
      chunks.push(Buffer.from(chunk.value.dataBase64, "base64"));
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
      throw new Error("FontIntegrityMismatch");
    return { metadata: resolved.value, bytes };
  };
}
