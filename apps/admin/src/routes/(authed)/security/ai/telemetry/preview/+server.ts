// SPDX-License-Identifier: MPL-2.0

/**
 * P16 hardening — telemetry test-payload preview as a server-rendered
 * text/plain response, NOT a form-action return.
 *
 * Why: SvelteKit form-action returns are JSON-stringified into the
 * page's hydration payload (visible in `data-sveltekit-fetch`). For
 * P16's count-only payload that's harmless, but the moment P17 wires
 * the real collector with error-stack snippets the same surface
 * becomes a privacy-claim violation in transit. Routing the preview
 * through this endpoint keeps the payload on the server roundtrip
 * and out of the client hydration cache.
 */

import { execute } from "@caelo/query-api";
import { error, json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "telemetry.test_send", {});
  if (!r.ok) throw error(500, "could not build test payload");
  const v = r.value as { payload: Record<string, unknown> };
  // text/plain response — Owner sees the JSON in the network tab and
  // can copy it without it ever being hydrated into client state.
  return new Response(JSON.stringify(v.payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

// json import retained for future polymorphic handlers.
void json;
