// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — request body size cap.
 *
 * Default 64 KB ceiling; per-plugin manifest override (`gateway.maxBodyBytes`)
 * can raise it up to a 1 MB hard ceiling. Plugin handlers don't need to
 * worry about hostile payloads — anything over the cap is rejected before
 * dispatch.
 *
 * Bun's `req.text()` / `req.json()` will happily buffer multi-MB bodies;
 * we instead read the stream manually with a running counter so the
 * connection short-circuits at the first byte over the cap.
 */

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const HARD_MAX_BODY_BYTES = 1024 * 1024;

export interface BodyCapResult {
  readonly ok: true;
  readonly body: ArrayBuffer;
  readonly bytes: number;
}

export interface BodyCapTooLarge {
  readonly ok: false;
  readonly bytes: number;
  readonly limit: number;
}

/**
 * Read req.body up to `limit` bytes. If the body exceeds the limit, abort
 * the read and return `{ok: false}` so the handler can emit 413.
 */
export async function readBodyWithCap(
  req: Request,
  limit: number = DEFAULT_MAX_BODY_BYTES,
): Promise<BodyCapResult | BodyCapTooLarge> {
  const cap = Math.min(limit, HARD_MAX_BODY_BYTES);
  // Cheap pre-check on Content-Length when present.
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > cap) {
      return { ok: false, bytes: declared, limit: cap };
    }
  }

  if (!req.body) {
    return { ok: true, body: new ArrayBuffer(0), bytes: 0 };
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel(); // signal upstream to stop sending
        return { ok: false, bytes: total, limit: cap };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, body: buf.buffer as ArrayBuffer, bytes: total };
}
