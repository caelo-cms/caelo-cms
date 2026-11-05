// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — Settings → Static files: the site's small data files at a
 * chosen address, written here by an Owner or approved from what the AI
 * proposed. Same `?/approve` + `?/reject` actions as a pending queue page, so
 * the chat's pending strip posts here.
 */

import { execute } from "@caelo-cms/query-api";
import { STATIC_FILE_CONTENT_TYPES, type StaticFileContentType } from "@caelo-cms/shared";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requireApproverPermission, requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface FileRow {
  id: string;
  path: string;
  contentType: StaticFileContentType;
  purpose: string;
  sizeBytes: number;
  updatedAt: string;
  releaseState: "not_staged" | "staged" | "live";
}

interface EditedFile {
  path: string;
  contentType: StaticFileContentType;
  purpose: string;
  body: string;
}

interface Proposal {
  id: string;
  kind: "set" | "delete";
  payload: {
    files?: { path: string; contentType: string; body: string; purpose: string }[];
    paths?: string[];
  };
  createdAt: string;
}

function messageOf(error: unknown, fallback: string): string {
  return typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const listed = await execute(registry, adapter, locals.ctx, "static_files.list", {});
  if (!listed.ok) throw new Error(`static_files.list failed: ${JSON.stringify(listed.error)}`);
  const pending = await execute(registry, adapter, locals.ctx, "static_files.list_pending", {});
  if (!pending.ok) {
    throw new Error(`static_files.list_pending failed: ${JSON.stringify(pending.error)}`);
  }
  const editPath = url.searchParams.get("edit");
  const got = editPath
    ? await execute(registry, adapter, locals.ctx, "static_files.get", { path: editPath })
    : null;
  const editing = got?.ok ? (got.value as EditedFile) : null;
  const value = listed.value as { files: FileRow[]; maxCount: number; maxBytes: number };
  return {
    files: value.files,
    maxCount: value.maxCount,
    maxBytes: value.maxBytes,
    contentTypes: STATIC_FILE_CONTENT_TYPES,
    proposals: (pending.value as { proposals: Proposal[] }).proposals,
    editing,
  };
};

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const path = String(form.get("path") ?? "").trim();
    const r = await execute(registry, adapter, locals.ctx, "static_files.set_many", {
      files: [
        {
          path,
          contentType: String(form.get("contentType") ?? ""),
          body: String(form.get("body") ?? ""),
          purpose: String(form.get("purpose") ?? ""),
        },
      ],
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "save failed") });
    return {
      ok: true,
      message: `${path} saved. It goes live with the next Stage and Publish live.`,
    };
  },
  delete: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const path = String(form.get("path") ?? "");
    const r = await execute(registry, adapter, locals.ctx, "static_files.delete_many", {
      paths: [path],
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "delete failed") });
    return {
      ok: true,
      message: `${path} removed. It stays on the live site until the next Stage and Publish live.`,
    };
  },
  approve: async ({ request, locals }) => {
    requireApproverPermission(locals, getQueryContext().registry, "static_files.execute_proposal");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "static_files.execute_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "approve failed") });
    return { ok: true, message: "Approved. It goes live with the next Stage and Publish live." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const reason = String(form.get("reason") ?? "").trim();
    const r = await execute(registry, adapter, locals.ctx, "static_files.reject_proposal", {
      proposalId: String(form.get("proposalId") ?? ""),
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: messageOf(r.error, "reject failed") });
    return { ok: true, message: "Proposal rejected." };
  },
};
