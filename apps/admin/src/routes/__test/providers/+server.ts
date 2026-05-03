// SPDX-License-Identifier: MPL-2.0

/**
 * Test-only fixture-provider registration endpoint. Playwright POSTs:
 *   { name: "edit-module", events: [...] | [[...], [...]] }
 * The named provider lives in process memory and is matched by the SSE
 * endpoint via the `x-caelo-test-provider` header. Refuses to do
 * anything when NODE_ENV='production' so a deployed instance cannot be
 * coerced into using a fake AI.
 *
 * Replaces the P5.1 `/tmp/caelo-ai-fixture.json` channel which forced
 * Playwright to run with workers:1 (filesystem race between specs).
 */

import {
  clearAllTestProviders,
  clearTestProvider,
  isTestRegistryEnabled,
  registerTestProvider,
} from "@caelo-cms/admin-core";
import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

function ensureEnabled(): void {
  if (!isTestRegistryEnabled()) throw error(404, "Not Found");
}

export const POST: RequestHandler = async ({ request }) => {
  ensureEnabled();
  const body = (await request.json()) as { name?: string; events?: unknown };
  if (!body.name || typeof body.name !== "string") throw error(400, "name required");
  if (!Array.isArray(body.events)) throw error(400, "events must be an array");
  registerTestProvider(body.name, body.events as never);
  return json({ ok: true, name: body.name });
};

export const DELETE: RequestHandler = async ({ url }) => {
  ensureEnabled();
  const name = url.searchParams.get("name");
  if (name) clearTestProvider(name);
  else clearAllTestProviders();
  return json({ ok: true });
};
