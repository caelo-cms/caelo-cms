// SPDX-License-Identifier: MPL-2.0

/**
 * #678 — POST /api/internal/staging/provision
 *
 * What `cms-provision staging-domain enable` calls (as the operator's own
 * cloud identity, through the admin's IAP) so the operator never has to
 * repeat in the admin what they just told the CLI:
 *
 *   {"mode":"inspect"}  → the stored staging host + gate state (no change),
 *                         so the CLI maps the host the admin actually uses.
 *   {"mode":"apply", host?, rotateBasicAuth?, revealBasicAuth?}
 *                       → `staging_access.provision`: sets the host (when
 *                         given), turns on basic auth with a generated
 *                         credential when none ever existed, and returns
 *                         the password only when it was generated/rotated
 *                         now or explicitly asked for. The response is the
 *                         only place the password travels; the CLI prints
 *                         it and never stores it.
 *
 * Bearer-authed with the internal HMAC token (scope `staging.provision`),
 * read from `x-caelo-internal-token` because `Authorization` carries the
 * IAP credential. The op is `actorScope: ["system"]`; every call is
 * audited with its source.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireInternalAuth } from "#lib/server/internal-jwt.js";
import { getQueryContext } from "#lib/server/query.js";

/** Token scope; the CLI signs the same string (packages/provisioning staging-admin.ts). */
const SCOPE = "staging.provision";
const SOURCE = "cms-provision staging-domain enable";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "internal-staging-provision",
};

const body = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inspect") }).strict(),
  z
    .object({
      mode: z.literal("apply"),
      host: z.string().min(1).max(253).optional(),
      rotateBasicAuth: z.boolean().optional(),
      revealBasicAuth: z.boolean().optional(),
    })
    .strict(),
]);

function messageOf(e: { kind: string } & Record<string, unknown>): string {
  if (typeof e.message === "string") return e.message;
  if (Array.isArray(e.issues)) return `invalid input: ${JSON.stringify(e.issues)}`;
  return e.kind;
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
  const r =
    parsed.mode === "inspect"
      ? await execute(registry, adapter, SYSTEM_CTX, "staging_access.get", {})
      : await execute(registry, adapter, SYSTEM_CTX, "staging_access.provision", {
          ...(parsed.host !== undefined ? { host: parsed.host } : {}),
          rotateBasicAuth: parsed.rotateBasicAuth ?? false,
          revealBasicAuth: parsed.revealBasicAuth ?? false,
          source: SOURCE,
        });
  if (!r.ok) {
    const status =
      r.error.kind === "ValidationFailed" || r.error.kind === "HandlerError" ? 422 : 500;
    return json(
      { ok: false, error: messageOf(r.error as { kind: string } & Record<string, unknown>) },
      { status },
    );
  }
  return json({ ok: true, ...(r.value as object) });
};
