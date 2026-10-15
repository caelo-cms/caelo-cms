// SPDX-License-Identifier: MPL-2.0

/**
 * POST /api/internal/owner-reset
 *
 * What `cms-provision owner-reset` calls (as the operator's own cloud
 * identity, through the admin's IAP) when an Owner is locked out and the
 * install cannot email a reset link. Body `{ email?, requestedBy }`; the answer carries
 * the raw reset token, which the CLI turns into the `/reset?token=…` link
 * and prints. The response is the only place the token travels: it is never
 * logged, so it does not end up in the project's Cloud Logging.
 *
 * Bearer-authed with the internal HMAC token (scope `auth.owner_reset`),
 * read from `x-caelo-internal-token` because `Authorization` carries the IAP
 * credential. The op is `actorScope: ["system"]` and audits every call.
 *
 * `requestedBy` is the gcloud account the CLI ran as, recorded in the audit
 * row's source so the row names a human and not only the system actor. It is
 * self-asserted: the request reaches here as the shared `caelo-mcp` service
 * account (IAP) with the shared internal secret, so nothing on this side can
 * prove which operator sent it. The audit row labels it that way; the
 * authoritative record is Google's Data Access audit log for the
 * iamcredentials `signJwt` and secretmanager `AccessSecretVersion` calls the
 * CLI makes as the operator (docs-site install-gcp, "Owner reset").
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireInternalAuth } from "#lib/server/internal-jwt.js";
import { getQueryContext } from "#lib/server/query.js";

/** Token scope; the CLI signs the same string (packages/provisioning owner-reset.ts). */
const SCOPE = "auth.owner_reset";
const SOURCE = "cms-provision owner-reset";

/**
 * A gcloud account: a user or service-account email, or a workforce-identity
 * principal. Bounded and restricted to the characters those use, so the
 * self-asserted value cannot carry whitespace, control characters or markup
 * into the audit log and the screens that show it.
 */
const requestedBy = z
  .string()
  .min(3)
  .max(254)
  .regex(/^[A-Za-z0-9._%+@:/=-]+$/, "must be the gcloud account the command ran as");

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "internal-owner-reset",
};

const body = z.object({ email: z.string().email().max(254).optional(), requestedBy }).strict();

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
  const r = await execute(registry, adapter, SYSTEM_CTX, "auth.issue_owner_reset", {
    ...(parsed.email !== undefined ? { email: parsed.email } : {}),
    source: `${SOURCE} by gcloud account ${parsed.requestedBy} (self-asserted)`,
  });
  if (!r.ok) {
    const message =
      "message" in r.error && typeof r.error.message === "string" ? r.error.message : r.error.kind;
    return json(
      { ok: false, error: message },
      { status: r.error.kind === "HandlerError" ? 422 : 500 },
    );
  }
  return json({ ok: true, ...(r.value as object) });
};
