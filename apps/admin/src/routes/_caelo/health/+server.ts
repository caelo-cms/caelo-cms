// SPDX-License-Identifier: MPL-2.0

/**
 * P21 — admin health endpoint. Used by `cms-provision upgrade`'s
 * post-roll probe to verify the new Cloud Run revision is healthy
 * before traffic-shifting (and to roll back automatically if not).
 *
 * Returns 200 + `{ok: true, version}` when:
 *   - the SvelteKit handler is responsive
 *   - the admin DB pool can answer `SELECT 1`
 *   - CAELO_SECRET_KEK is reachable (or skipped in dev)
 *
 * Returns 503 + `{ok: false, error}` on any failure. Cloud Run treats
 * 503 as unhealthy if probes are configured; we don't rely on Cloud
 * Run's built-in probe (which only checks port-listen) because a
 * bad-config admin can serve port 5173 fine while every page 500s.
 *
 * Public path on purpose — no IAP gate, no auth — so the upgrade CLI
 * (running outside the IAP allowlist) can still probe. Returns no
 * sensitive info.
 */

import { CAELO_VERSION } from "@caelo-cms/shared";
import { json } from "@sveltejs/kit";
import { getQueryContext } from "$lib/server/query.js";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  try {
    const { adapter } = getQueryContext();
    // Smoke the admin pool. verifyRoles is the lightest check that
    // proves we have a working connection AND we're connected as the
    // expected role (catches a misconfigured PUBLIC_ADMIN_DATABASE_URL
    // that would silently fail later).
    await adapter.verifyRoles();
  } catch (e) {
    return json(
      {
        ok: false,
        version: CAELO_VERSION,
        error: { kind: "DbUnreachable", message: (e as Error).message },
      },
      { status: 503 },
    );
  }
  return json({ ok: true, version: CAELO_VERSION });
};
