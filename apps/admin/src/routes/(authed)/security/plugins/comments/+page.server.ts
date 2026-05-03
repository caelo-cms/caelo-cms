// SPDX-License-Identifier: MPL-2.0

import { runPluginOperation } from "@caelo/plugin-host";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { Actions, PageServerLoad } from "./$types";

interface CommentRow {
  id: string;
  page_id: string;
  locale: string;
  parent_id: string | null;
  author_name: string;
  content: string;
  status: string;
  submitted_at: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const r = await runPluginOperation({
    pluginSlug: "comments",
    operationName: "list_pending",
    args: {},
  });
  const comments = r.ok ? ((r.value as { comments: CommentRow[] }).comments ?? []) : [];
  return { comments, error: r.ok ? null : r.error.message };
};

export const actions: Actions = {
  moderate: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("commentId");
    const decision = form.get("decision");
    if (typeof id !== "string" || typeof decision !== "string") {
      return fail(400, { error: "commentId + decision required" });
    }
    if (decision !== "approved" && decision !== "rejected" && decision !== "spam") {
      return fail(400, { error: "decision must be approved/rejected/spam" });
    }
    const r = await runPluginOperation({
      pluginSlug: "comments",
      operationName: "moderate",
      args: { commentId: id, decision },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    return { ok: true, message: `Marked ${decision}.` };
  },
  bulkModerate: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const idsRaw = form.get("commentIds");
    const decision = form.get("decision");
    if (typeof idsRaw !== "string" || typeof decision !== "string") {
      return fail(400, { error: "commentIds + decision required" });
    }
    const commentIds = idsRaw.split(",").filter((s) => s.length > 0);
    if (commentIds.length === 0) return fail(400, { error: "no comments selected" });
    const r = await runPluginOperation({
      pluginSlug: "comments",
      operationName: "bulk_moderate",
      args: { commentIds, decision },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    const v = r.value as { updated: number };
    return { ok: true, message: `Bulk ${decision}: ${v.updated} comments.` };
  },
  aiModerate: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const id = form.get("commentId");
    if (typeof id !== "string") return fail(400, { error: "commentId required" });
    const r = await runPluginOperation({
      pluginSlug: "comments",
      operationName: "ai_moderate",
      args: { commentId: id },
    });
    if (!r.ok) return fail(400, { error: r.error.message });
    const v = r.value as { status: string; verdict: string };
    return { ok: true, message: `AI verdict: ${v.verdict} → ${v.status}.` };
  },
};
