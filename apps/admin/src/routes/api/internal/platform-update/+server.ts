// SPDX-License-Identifier: MPL-2.0

/**
 * POST /api/internal/platform-update
 *
 * What `cms-provision request-update` calls (as the operator's own cloud
 * identity, through the admin's IAP, #818) to install a Caelo release with
 * the install's own upgrader — the same request + job start as the Owner's
 * "Install update", without the browser. The release workflow's real-GCP
 * upgrader smoke test drives every release candidate through it; an
 * operator can use it to install a release candidate, which Settings →
 * Updates never offers.
 *
 *   { action: "request", version, requestedBy }
 *       queue the request (platform_updates.operator_request) and start the
 *       upgrader; answers `{ ok, requestId, execution }`.
 *   { action: "status", requestId }
 *       the request and its timeline (platform_updates.get), so the CLI can
 *       wait for the end and print it.
 *
 * Authed like owner-reset: IAP first, then the internal HMAC token with
 * scope `platform_updates.operator` in `x-caelo-internal-token`.
 * `requestedBy` is self-asserted (see owner-reset/+server.ts); Google's
 * Data Access audit log of the operator's signJwt + AccessSecretVersion
 * calls is the authoritative record of who it was.
 */

import { startUpgraderFor } from "@caelo-cms/admin-core";
import { execute, SYSTEM_ACTOR_ID } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  type PlatformUpdateAgentStatus,
  releaseVersionSchema,
} from "@caelo-cms/shared";
import { json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireInternalAuth } from "#lib/server/internal-jwt.js";
import { getQueryContext } from "#lib/server/query.js";
import { upgraderTrigger } from "#lib/server/upgrader.js";

/** Token scope; the CLI signs the same string (packages/provisioning request-update.ts). */
const SCOPE = "platform_updates.operator";
const SOURCE = "cms-provision request-update";

/** A gcloud account, bounded like owner-reset's (no whitespace or markup into the timeline). */
const requestedBy = z
  .string()
  .min(3)
  .max(320)
  .regex(/^[A-Za-z0-9._%+@:/=-]+$/, "must be the gcloud account the command ran as");

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), version: releaseVersionSchema, requestedBy }).strict(),
  z.object({ action: z.literal("status"), requestId: z.string().uuid() }).strict(),
]);

function systemCtx(): ExecutionContext {
  return {
    actorId: SYSTEM_ACTOR_ID,
    actorKind: "system",
    requestId: `internal-platform-update-${Date.now()}`,
  };
}

/** An op error as the endpoint's answer: a refusal is 422, anything else 500. */
function opError(error: { kind: string } & Record<string, unknown>): Response {
  const message = typeof error.message === "string" ? error.message : error.kind;
  return json({ ok: false, error: message }, { status: error.kind === "HandlerError" ? 422 : 500 });
}

export const POST: RequestHandler = async ({ request }) => {
  await requireInternalAuth(request, SCOPE);
  let parsed: z.infer<typeof body>;
  try {
    const r = body.safeParse(await request.json());
    if (!r.success) {
      return json({ ok: false, error: `invalid body: ${r.error.message}` }, { status: 400 });
    }
    parsed = r.data;
  } catch {
    return json({ ok: false, error: "body is not valid JSON" }, { status: 400 });
  }

  const { adapter, registry } = getQueryContext();
  const ctx = systemCtx();

  if (parsed.action === "status") {
    const r = await execute(registry, adapter, ctx, "platform_updates.get", {
      requestId: parsed.requestId,
    });
    if (!r.ok) return opError(r.error as { kind: string });
    return json({ ok: true, ...(r.value as object) });
  }

  // The same upgrader the Owner's button hands updates to; resolved before
  // the request is written so a missing one changes nothing.
  const upgrader = upgraderTrigger(process.env, async () => {
    const a = await execute(registry, adapter, ctx, "platform_updates.agent_status", {});
    if (!a.ok) throw new Error("could not read the update agent's status");
    return (a.value as { agent: PlatformUpdateAgentStatus | null }).agent;
  });
  if (!upgrader.ok) {
    return json({ ok: false, error: `${upgrader.error} ${upgrader.nextStep}` }, { status: 500 });
  }
  if (!upgrader.trigger) {
    return json(
      {
        ok: false,
        error:
          "This install has no upgrader yet; run `cms-provision upgrade` once (it sets the upgrader up).",
      },
      { status: 409 },
    );
  }
  const r = await execute(registry, adapter, ctx, "platform_updates.operator_request", {
    targetVersion: parsed.version,
    source: `${SOURCE} by gcloud account ${parsed.requestedBy} (self-asserted)`,
  });
  if (!r.ok) return opError(r.error as { kind: string });
  const requestId = (r.value as { requestId: string }).requestId;
  const started = await startUpgraderFor(registry, adapter, ctx, requestId, upgrader.trigger);
  if (!started.ok) {
    return json(
      {
        ok: false,
        requestId,
        error: `The upgrader could not be started: ${started.error} ${started.nextStep}`,
      },
      { status: 502 },
    );
  }
  return json({ ok: true, requestId, execution: started.execution });
};
