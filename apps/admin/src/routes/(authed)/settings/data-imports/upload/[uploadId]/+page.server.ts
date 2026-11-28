// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: the page an agent's upload link opens (request_data_upload,
 * docs/data-imports.md). The operator drops the file; the agent, which
 * cannot read the operator's disk, imports it by the upload's id.
 */

import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { z } from "zod";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { storeDataUpload } from "#lib/server/data-upload.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

function uploadIdOf(raw: string): string {
  const id = z.string().uuid().safeParse(raw);
  if (!id.success) throw error(404, "There is no such upload link.");
  return id.data;
}

export const load: PageServerLoad = async ({ locals, params }) => {
  requirePermission(locals, "content.write");
  const uploadId = uploadIdOf(params.uploadId);
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "data_uploads.get", { uploadId });
  if (!r.ok)
    throw error(404, "This upload link expired or does not exist. Ask the AI for a new one.");
  const v = r.value as { status: "awaiting" | "ready"; filename: string | null; expiresAt: string };
  return { uploadId, status: v.status, filename: v.filename, expiresAt: v.expiresAt };
};

export const actions: Actions = {
  default: async ({ request, locals, params }) => {
    requirePermission(locals, "content.write");
    const uploadId = uploadIdOf(params.uploadId);
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      return fail(400, { error: "choose a file to upload" });
    const stored = await storeDataUpload({
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      ctx: locals.ctx,
      uploadId,
    });
    if (!stored.ok) return fail(stored.status, { error: stored.message });
    return {
      ok: true,
      message: `${stored.upload.filename} is uploaded: ${stored.upload.rows} rows. Go back to the chat and tell the AI it is there.`,
    };
  },
};
