// SPDX-License-Identifier: MPL-2.0

/**
 * How every admin-internal.ts transport reads the admin's HTTP answer, so a
 * refusal reads the same whichever provider carried the request.
 */

import type { AdminInternalCall, AdminInternalResult } from "./admin-internal.js";

/**
 * The admin's answer as a result: a 404 is an admin older than the endpoint
 * (fixed by `upgradeCommand`), a non-JSON body or `ok !== true` is a refusal
 * carrying the admin's own message.
 */
export function readAdminAnswer<T>(
  status: number,
  text: string,
  call: AdminInternalCall,
  upgradeCommand: string,
): AdminInternalResult<T> {
  if (status === 404) {
    return {
      ok: false,
      error: `the admin has no ${call.endpoint} yet (it runs a release from before ${call.introducedBy}). Run \`${upgradeCommand}\`, then run this command again.`,
    };
  }
  let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return {
      ok: false,
      error: `the admin answered HTTP ${status} with a non-JSON body: ${text.slice(0, 200)}`,
    };
  }
  if (status < 200 || status > 299 || parsed.ok !== true) {
    return {
      ok: false,
      error: `the admin refused (HTTP ${status}): ${parsed.error ?? text.slice(0, 300)}`,
    };
  }
  return { ok: true, value: parsed as unknown as T };
}
