// SPDX-License-Identifier: MPL-2.0

import { error } from "@sveltejs/kit";
import { z } from "zod";
import { privatePluginFiles } from "$lib/server/plugin-files.js";
import type { RequestHandler } from "./$types";

/** Generic private download: never serve plugin bytes as executable same-origin content. */
export const GET: RequestHandler = async ({ params, locals }) => {
  const input = z
    .object({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(params);
  if (!input.success) throw error(404, "Private file unavailable");
  const files = await privatePluginFiles(params.slug, locals);
  let size: number;
  try {
    const file = await files.stat({ id: input.data.id });
    if (file.status !== "ready" || file.sha256 !== input.data.sha256)
      throw new Error("Unavailable");
    size = file.sizeBytes;
  } catch {
    throw error(404, "Private file unavailable");
  }
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (offset >= size) {
          controller.close();
          return;
        }
        const chunk = await files.readChunk({ id: input.data.id, offset });
        const bytes = Buffer.from(chunk.base64, "base64");
        offset += bytes.length;
        controller.enqueue(bytes);
      } catch (cause) {
        controller.error(cause);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${input.data.id}"`,
      "content-length": String(size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
};
