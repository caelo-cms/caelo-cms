// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the chat's view of the quality gate.
 *
 * GET  → the newest audit of THIS chat's Stages, the message the chat
 *        should get about it, and the site-wide Publish gate. The chat panel
 *        and the toolbar poll it.
 * POST {action:"claim", auditRunId} → take the delivery of the audit's
 *        message (a short lease, so two tabs never post it twice). A status
 *        note is appended and marked delivered in one transaction; an AI turn
 *        comes back as `send` — the panel sends it as a system-origin turn
 *        (which starts the AI's fix round) and then acknowledges it.
 * POST {action:"ack", auditRunId} → that acknowledgement. Without it the
 *        lease runs out and the next poll delivers the nudge again.
 * POST {action:"retry"} → re-run a failed / missing check of the staged build.
 */

import { describeError, verifyCsrfToken } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChatStatus {
  audit: { id: string; status: string; chatSessionId: string | null } | null;
  notified: boolean;
  feedback: { kind: "note" | "ai-turn"; text: string } | null;
  deployRunId: string | null;
  gate: {
    open: boolean;
    state: string;
    auditRunId: string | null;
    message: string;
    canPublishAnyway: boolean;
    openProblemCount: number;
  } | null;
}

async function chatStatus(locals: App.Locals, chatSessionId: string): Promise<ChatStatus> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "quality_audits.chat_status", {
    chatSessionId,
  });
  if (!r.ok) throw error(500, describeError(r.error));
  return r.value as ChatStatus;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  if (!locals.user) throw error(401, "Not authenticated");
  if (!UUID_RE.test(params.sessionId)) throw error(400, "invalid chat session id");
  return json(await chatStatus(locals, params.sessionId));
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  requirePermission(locals, "content.write");
  if (!locals.user) throw error(401, "Not authenticated");
  if (!(await verifyCsrfToken(locals.user.csrfSecret, request.headers.get("x-csrf-token") ?? ""))) {
    throw error(403, "CSRF token mismatch");
  }
  if (!UUID_RE.test(params.sessionId)) throw error(400, "invalid chat session id");
  const body = (await request.json().catch(() => null)) as {
    action?: string;
    auditRunId?: string;
  } | null;
  const { adapter, registry } = getQueryContext();

  if (body?.action === "retry") {
    const r = await execute(registry, adapter, locals.ctx, "quality_audits.retry", {});
    if (!r.ok) return json({ ok: false, error: describeError(r.error) }, { status: 409 });
    return json({ ok: true, ...(r.value as object) });
  }

  if (body?.action === "ack" && typeof body.auditRunId === "string") {
    const r = await execute(registry, adapter, locals.ctx, "quality_audits.ack_chat_notification", {
      auditRunId: body.auditRunId,
    });
    if (!r.ok) throw error(500, describeError(r.error));
    return json({ ok: true });
  }

  if (body?.action === "claim" && typeof body.auditRunId === "string") {
    // Re-read: only the chat's own newest audit can be claimed here, and the
    // message is computed server-side (never trusted from the client).
    const status = await chatStatus(locals, params.sessionId);
    if (!status.audit || status.audit.id !== body.auditRunId || !status.feedback) {
      return json({ ok: true, send: null });
    }
    const isNote = status.feedback.kind === "note";
    const claimed = await execute(
      registry,
      adapter,
      locals.ctx,
      "quality_audits.claim_chat_notification",
      {
        auditRunId: body.auditRunId,
        ...(isNote
          ? { note: { chatSessionId: params.sessionId, text: status.feedback.text } }
          : {}),
      },
    );
    if (!claimed.ok) throw error(500, describeError(claimed.error));
    if (!(claimed.value as { claimed: boolean }).claimed) return json({ ok: true, send: null });
    return isNote
      ? json({ ok: true, send: null, note: status.feedback.text })
      : json({ ok: true, send: status.feedback.text });
  }

  throw error(400, "unknown action");
};
