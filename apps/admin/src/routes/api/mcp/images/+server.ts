// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { uploadMedia } from "$lib/server/media-upload.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

/** Bearer-only upload; cookies never grant access to this MCP surface. */
export const POST: RequestHandler = async ({ request, url }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");
  const { adapter, registry } = getQueryContext();
  const requestId = crypto.randomUUID();
  const auth = await execute(
    registry,
    adapter,
    {
      actorId: "00000000-0000-0000-0000-00000000ffff",
      actorKind: "system",
      requestId,
    },
    "mcp.authorize_upload",
    { plaintextToken: token },
  );
  if (!auth.ok) {
    const message = "message" in auth.error ? String(auth.error.message) : auth.error.kind;
    throw error(message.startsWith("permission_denied:") ? 403 : 401, message);
  }
  const { actorId } = auth.value as { actorId: string };
  if (request.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") {
    throw error(
      415,
      "Send image bytes as application/octet-stream; filename and alt are query parameters.",
    );
  }
  const metadata = z
    .object({ filename: z.string().min(1).max(512), alt: z.string().max(2048).optional() })
    .safeParse({
      filename: url.searchParams.get("filename") ?? "image",
      ...(url.searchParams.has("alt") ? { alt: url.searchParams.get("alt") } : {}),
    });
  if (!metadata.success) throw error(400, "Invalid image filename or alt text");
  return json(
    await uploadMedia(request, { actorId, actorKind: "human", requestId }, true, metadata.data),
  );
};
