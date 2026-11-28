// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the stdio Power shim's caelo_upload_data posts a data file
 * here (docs/data-imports.md). Bearer-only, like `/api/mcp/images`: a
 * cookie never grants this MCP surface.
 */

import { mcpBusyFailureResponse } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { MAX_DATA_FILE_BYTES } from "@caelo-cms/shared";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { storeDataUpload } from "#lib/server/data-upload.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, url }) => {
  const token = request.headers.get("x-caelo-mcp-token");
  if (!token) throw error(401, "missing x-caelo-mcp-token header");
  const { adapter, registry } = getQueryContext();
  const requestId = crypto.randomUUID();
  const auth = await execute(
    registry,
    adapter,
    { actorId: "00000000-0000-0000-0000-00000000ffff", actorKind: "system", requestId },
    "mcp.authorize_upload",
    { plaintextToken: token },
  );
  if (!auth.ok) {
    const busy = mcpBusyFailureResponse(auth.error, url.pathname);
    if (busy) return busy;
    const message = "message" in auth.error ? String(auth.error.message) : auth.error.kind;
    throw error(message.startsWith("permission_denied:") ? 403 : 401, message);
  }
  const { actorId } = auth.value as { actorId: string };
  if (request.headers.get("content-type")?.split(";")[0] !== "application/octet-stream")
    throw error(
      415,
      "Send the file's bytes as application/octet-stream; its name is the filename query parameter.",
    );
  const filename = z.string().min(1).max(255).safeParse(url.searchParams.get("filename"));
  if (!filename.success)
    throw error(400, "the filename query parameter is required (e.g. comments.csv)");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_DATA_FILE_BYTES)
    throw error(413, `the file is ${declared} bytes, at most ${MAX_DATA_FILE_BYTES}: split it`);
  const stored = await storeDataUpload({
    bytes: new Uint8Array(await request.arrayBuffer()),
    filename: filename.data,
    ctx: { actorId, actorKind: "human", requestId },
  });
  if (!stored.ok) throw error(stored.status, stored.message);
  return json(stored.upload);
};
