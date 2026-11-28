// SPDX-License-Identifier: MPL-2.0

/**
 * Settings → Data imports (docs/data-imports.md): every import with where
 * it stands, its last report, Undo, and a file upload whose id the operator
 * hands to the AI. Imports themselves run in the chat (import_<kind>).
 */

import { getMediaStorage, undoDataImport } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { storeDataUpload } from "#lib/server/data-upload.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface ImportRow {
  importId: string;
  kind: string;
  sourceLabel: string;
  state: string;
  itemCount: number;
  createdAt: string;
  createdBy: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "data_imports.list", { limit: 100 });
  if (!r.ok) throw new Error(`data_imports.list failed: ${JSON.stringify(r.error)}`);
  return { imports: (r.value as { imports: ImportRow[] }).imports };
};

export const actions: Actions = {
  undo: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const importId = String(form.get("importId") ?? "");
    const { adapter, registry } = getQueryContext();
    const r = await undoDataImport(
      { registry, adapter, storage: getMediaStorage },
      { ctx: locals.ctx, invocation: { origin: "owner-panel", actorId: locals.ctx.actorId } },
      importId,
    );
    if (!r.ok) return fail(400, { error: r.message });
    return { ok: true, message: r.undo.message };
  },
  upload: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      return fail(400, { error: "choose a file to upload" });
    const stored = await storeDataUpload({
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name,
      ctx: locals.ctx,
    });
    if (!stored.ok) return fail(stored.status, { error: stored.message });
    return {
      ok: true,
      message: `Uploaded ${stored.upload.filename}: ${stored.upload.rows} rows, columns ${stored.upload.columns.join(", ")}. Tell the AI in the chat: "import upload ${stored.upload.uploadId}".`,
    };
  },
};
