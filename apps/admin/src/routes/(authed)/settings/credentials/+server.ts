// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #971 — the approver collects a credential an approval produced.
 *
 *   GET  ?kind=<kind>                → { handoffs, emailAvailable }
 *   POST { handoffId, via }          → { kind, label, secret } (via "reveal")
 *                                      { kind, label, emailedTo } (via "email")
 *
 * The AI never reaches this: its tool result only says where the operator
 * finds the credential. `credentials.issue` is human-only and bound (by RLS)
 * to the human who clicked Approve; it generates the password / token now and
 * returns it this once. Nothing secret is stored, so a reload cannot show it
 * again — the operator resets the password or mints a new token instead.
 */

import { deliverPasswordResetEmail, passwordResetEmailProblem } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import { assertJsonCsrf } from "#lib/server/agent-runs.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { getQueryContext } from "#lib/server/query.js";
import type { RequestHandler } from "./$types";

const NO_STORE = { "cache-control": "no-store" };

const kindParam = z.enum(["user_temporary_password", "mcp_token"]).optional();

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, "Not authenticated");
  const kind = kindParam.safeParse(url.searchParams.get("kind") ?? undefined);
  if (!kind.success) throw error(400, "Unknown credential kind");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "credentials.list_handoffs", {
    ...(kind.data ? { kind: kind.data } : {}),
  });
  if (!r.ok) throw error(500, opErrorMessage(r.error, "Could not list the waiting credentials."));
  const emailProblem = await passwordResetEmailProblem({ registry, adapter, ctx: locals.ctx });
  return json(
    { ...(r.value as object), emailAvailable: emailProblem === null },
    { headers: NO_STORE },
  );
};

const issueInput = z
  .object({ handoffId: z.string().uuid(), via: z.enum(["reveal", "email"]) })
  .strict();

export const POST: RequestHandler = async ({ request, locals, url }) => {
  await assertJsonCsrf(request, locals);
  const parsed = issueInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw error(400, "Expected { handoffId, via: 'reveal' | 'email' }");
  const { adapter, registry } = getQueryContext();
  if (parsed.data.via === "email") {
    // Checked before issuing: a token nobody can receive must not be minted.
    const problem = await passwordResetEmailProblem({ registry, adapter, ctx: locals.ctx });
    if (problem !== null) throw error(409, `This install cannot send email: ${problem}`);
  }
  const r = await execute(registry, adapter, locals.ctx, "credentials.issue", parsed.data);
  if (!r.ok) throw error(409, opErrorMessage(r.error, "Could not issue the credential."));
  const v = r.value as {
    kind: string;
    label: string;
    secret: string | null;
    emailDelivery: { email: string; displayName: string; token: string } | null;
  };
  if (v.emailDelivery) {
    const resetUrl = new URL(
      `/reset?token=${encodeURIComponent(v.emailDelivery.token)}`,
      url.origin,
    ).toString();
    await deliverPasswordResetEmail({
      registry,
      adapter,
      ctx: locals.ctx,
      to: v.emailDelivery.email,
      displayName: v.emailDelivery.displayName,
      resetUrl,
    });
    return json(
      { kind: v.kind, label: v.label, emailedTo: v.emailDelivery.email },
      { headers: NO_STORE },
    );
  }
  return json({ kind: v.kind, label: v.label, secret: v.secret }, { headers: NO_STORE });
};
