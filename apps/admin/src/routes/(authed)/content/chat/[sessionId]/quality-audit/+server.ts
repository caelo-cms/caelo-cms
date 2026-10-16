// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — the chat's view of the quality gate.
 *
 * GET  → the newest audit of THIS chat's Stages, the message the chat
 *        should get about it, and the site-wide Publish gate. The chat panel
 *        and the toolbar poll it.
 * POST {action:"claim", auditRunId} → take the delivery of the audit's
 *        message (a short lease, so two tabs never post it twice). A status
 *        note is appended and marked delivered in one transaction. A fix
 *        offer (#685) is claimed ONLY when the operator clicked its "Fix
 *        with AI" — or, #771, when the offer says `autoContinue` (the next
 *        round of a fix-all the operator started): its prompt comes back as
 *        `send`, the panel sends it as a turn and then acknowledges it.
 * POST {action:"ack", auditRunId} → that acknowledgement. Without it the
 *        lease runs out and the card offers the fix again.
 * POST {action:"release", auditRunId} → the clicked fix request started no
 *        turn (refused or failed): give the claim back so the card works
 *        again at once.
 * POST {action:"dismiss", auditRunId} → the operator's "Not now" on a fix
 *        offer: a status note records it and the offer is settled; nothing
 *        runs, and Publish live stays blocked as the gate says.
 * POST {action:"retry"} → re-run a failed / missing check of the staged build.
 *
 * #727 — the card groups the open problems by rule across pages:
 * POST {action:"claim", auditRunId, fixSelection} → a fix request for only
 *        the picked groups / pages (the prompt is still built server-side).
 * POST {action:"accept", auditRunId, groups, reason} → the operator's own
 *        bulk acceptance of the picked groups (every open page, or the
 *        picked ones): proposed and applied as THIS human in one click, on
 *        the same propose/execute engine the AI's approval card uses. The AI
 *        is not involved, so there is nothing to approve twice. Answers
 *        with the chat's status after the acceptance (`status`), so the
 *        card never re-renders the groups it just accepted.
 */

import { describeError, verifyCsrfToken } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

/** The status note "Not now" leaves in the chat (#685). */
const NOT_NOW_NOTE =
  "Not now — the AI was not asked to fix the quality findings. Publish live stays blocked until they are fixed or accepted; ask the AI in this chat whenever you want them fixed.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChatStatus {
  audit: { id: string; status: string; chatSessionId: string | null } | null;
  notified: boolean;
  feedback:
    | { kind: "note"; text: string }
    | {
        kind: "offer";
        text: string;
        actionLabel: string;
        prompt: string;
        autoContinue: boolean;
        groups: {
          key: string;
          ref: { auditId: string } | { category: string } | { ruleId: string };
          pages: { pagePath: string }[];
        }[];
      }
    | null;
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

/** A card selection: group keys, optionally narrowed to some pages. */
interface GroupSelection {
  key: string;
  pagePaths?: string[];
}

/** The body's selection, shape-checked (the op validates it again). */
function parseSelection(v: unknown): GroupSelection[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 100) return null;
  const out: GroupSelection[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object") return null;
    const { key, pagePaths } = item as { key?: unknown; pagePaths?: unknown };
    if (typeof key !== "string" || key.length === 0) return null;
    if (pagePaths === undefined) {
      out.push({ key });
      continue;
    }
    if (!Array.isArray(pagePaths) || !pagePaths.every((p) => typeof p === "string")) return null;
    out.push({ key, pagePaths: pagePaths as string[] });
  }
  return out;
}

async function chatStatus(
  locals: App.Locals,
  chatSessionId: string,
  fixSelection?: GroupSelection[],
): Promise<ChatStatus> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "quality_audits.chat_status", {
    chatSessionId,
    ...(fixSelection ? { fixSelection } : {}),
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
    fixSelection?: unknown;
    groups?: unknown;
    reason?: unknown;
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

  if (body?.action === "release" && typeof body.auditRunId === "string") {
    const r = await execute(
      registry,
      adapter,
      locals.ctx,
      "quality_audits.release_chat_notification",
      { auditRunId: body.auditRunId },
    );
    if (!r.ok) throw error(500, describeError(r.error));
    return json({ ok: true });
  }

  if (body?.action === "dismiss" && typeof body.auditRunId === "string") {
    const status = await chatStatus(locals, params.sessionId);
    if (
      !status.audit ||
      status.audit.id !== body.auditRunId ||
      status.feedback?.kind !== "offer" ||
      status.notified
    ) {
      return json({ ok: true, dismissed: false });
    }
    const claimed = await execute(
      registry,
      adapter,
      locals.ctx,
      "quality_audits.claim_chat_notification",
      {
        auditRunId: body.auditRunId,
        note: { chatSessionId: params.sessionId, text: NOT_NOW_NOTE },
      },
    );
    if (!claimed.ok) throw error(500, describeError(claimed.error));
    const dismissed = (claimed.value as { claimed: boolean }).claimed;
    return json({ ok: true, dismissed, ...(dismissed ? { note: NOT_NOW_NOTE } : {}) });
  }

  if (body?.action === "accept" && typeof body.auditRunId === "string") {
    const selection = parseSelection(body.groups);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!selection) return json({ ok: false, error: "choose at least one group" }, { status: 400 });
    // Re-read: only the open groups of the chat's current offer can be
    // accepted, named by what the server says they are.
    const status = await chatStatus(locals, params.sessionId);
    if (!status.audit || status.audit.id !== body.auditRunId || status.feedback?.kind !== "offer") {
      return json(
        {
          ok: false,
          error: "This quality check is no longer open — the card shows the current one.",
        },
        { status: 409 },
      );
    }
    const groups = [];
    for (const sel of selection) {
      const group = status.feedback.groups.find((g) => g.key === sel.key);
      if (!group) {
        return json(
          { ok: false, error: `'${sel.key}' is no longer open (fixed or accepted meanwhile).` },
          { status: 409 },
        );
      }
      groups.push({ ...group.ref, ...(sel.pagePaths ? { pagePaths: sel.pagePaths } : {}) });
    }
    const proposed = await execute(registry, adapter, locals.ctx, "quality_audits.propose_accept", {
      auditRunId: body.auditRunId,
      groups,
      reason,
    });
    if (!proposed.ok) {
      return json({ ok: false, error: describeError(proposed.error) }, { status: 409 });
    }
    const proposalId = (proposed.value as { proposalId: string }).proposalId;
    const applied = await execute(
      registry,
      adapter,
      locals.ctx,
      "quality_audits.execute_proposal",
      {
        proposalId,
      },
    );
    if (!applied.ok) {
      // Leave no pending card behind for a decision that did not apply.
      await execute(registry, adapter, locals.ctx, "quality_audits.reject_proposal", {
        proposalId,
        reason: "the operator's acceptance from the chat card could not be applied",
      });
      return json({ ok: false, error: describeError(applied.error) }, { status: 409 });
    }
    // The status after the acceptance rides along: the card renders it at
    // once instead of its pre-accept groups until the next read lands.
    return json({
      ok: true,
      accepted: (applied.value as { accepted?: number }).accepted ?? 0,
      status: await chatStatus(locals, params.sessionId),
    });
  }

  if (body?.action === "claim" && typeof body.auditRunId === "string") {
    // Re-read: only the chat's own newest audit can be claimed here, and the
    // message is computed server-side (never trusted from the client). #727:
    // a picked fix narrows the prompt to the picked groups / pages.
    const fixSelection =
      body.fixSelection === undefined ? undefined : parseSelection(body.fixSelection);
    if (fixSelection === null) {
      return json({ ok: false, error: "invalid fix selection" }, { status: 400 });
    }
    const status = await chatStatus(locals, params.sessionId, fixSelection);
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
          : { fixScope: fixSelection ? "picked" : "all" }),
      },
    );
    if (!claimed.ok) throw error(500, describeError(claimed.error));
    if (!(claimed.value as { claimed: boolean }).claimed) return json({ ok: true, send: null });
    return status.feedback.kind === "note"
      ? json({ ok: true, send: null, note: status.feedback.text })
      : json({ ok: true, send: status.feedback.prompt });
  }

  throw error(400, "unknown action");
};
