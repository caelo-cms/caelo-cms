// SPDX-License-Identifier: MPL-2.0

/**
 * P15.1 — POST /api/internal/provisioning-outputs/sync
 *
 * Bearer-authed (signed-JWT, scope `provisioning-outputs.sync`). Pulumi
 * post-deploy step calls this with the rendered `pulumi stack output
 * --json` payload; we forward to `provisioning_outputs.set` (system
 * scope) which upserts on (provider, environment).
 *
 * Body: `{provider, environment, outputs}`. The op handler computes
 * the SHA-256 hash; the bearer token authenticates, the op's actorScope
 * + the migration 0046 RLS policy authorize.
 */

import { execute } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { json, type RequestHandler } from "@sveltejs/kit";
import { requireInternalAuth } from "$lib/server/internal-jwt.js";
import { getQueryContext } from "$lib/server/query.js";

const SCOPE = "provisioning-outputs.sync";
const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "internal-provisioning-sync",
};

interface RequestBody {
  provider: "self-hosted" | "gcp" | "aws" | "azure";
  environment: "dev" | "staging" | "production";
  outputs: Record<string, unknown>;
}

export const POST: RequestHandler = async ({ request }) => {
  await requireInternalAuth(request, SCOPE);

  const body = (await request.json()) as RequestBody;
  if (
    !body ||
    typeof body !== "object" ||
    !["self-hosted", "gcp", "aws", "azure"].includes(body.provider) ||
    !["dev", "staging", "production"].includes(body.environment) ||
    typeof body.outputs !== "object"
  ) {
    return json(
      { ok: false, error: "missing or invalid provider / environment / outputs" },
      { status: 400 },
    );
  }

  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, SYSTEM_CTX, "provisioning_outputs.set", {
    provider: body.provider,
    environment: body.environment,
    outputs: body.outputs,
  });
  if (!r.ok) {
    return json({ ok: false, error: r.error.kind }, { status: 500 });
  }
  return json({ ok: true, ...(r.value as object) });
};
