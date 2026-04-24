// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import type { Handle } from "@sveltejs/kit";
import { adapter, registry } from "$lib/server/query.js";

const SESSION_COOKIE = "caelo_session";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "hooks",
};

/**
 * Per-request middleware:
 *   1. Read session cookie.
 *   2. Resolve the session → user + permissions (query runs as `system`
 *      because we don't know the user yet).
 *   3. Populate `locals.user` (null when anonymous) and `locals.ctx` (for any
 *      subsequent op the route wants to run under the user's identity).
 *
 * Route guards live inside `+page.server.ts` / `+server.ts` files; this hook
 * only *populates* identity, it does not deny access.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const token = event.cookies.get(SESSION_COOKIE);
  let user: App.Locals["user"] = null;

  if (token) {
    const requestCtx: ExecutionContext = {
      ...SYSTEM_CTX,
      requestId: event.request.headers.get("x-request-id") ?? crypto.randomUUID(),
    };
    const result = await execute(registry, adapter, requestCtx, "auth.resolve_session", { token });
    if (result.ok) {
      const v = result.value as {
        userId: string;
        email: string;
        csrfToken: string;
        permissions: string[];
        roles: string[];
      };
      user = {
        id: v.userId,
        email: v.email,
        roles: v.roles,
        permissions: new Set(v.permissions),
        csrfToken: v.csrfToken,
      };
    } else {
      // Expired / revoked — drop the cookie.
      event.cookies.delete(SESSION_COOKIE, { path: "/" });
    }
  }

  event.locals.user = user;
  event.locals.ctx = user
    ? { actorId: user.id, actorKind: "human", requestId: crypto.randomUUID() }
    : { ...SYSTEM_CTX, requestId: crypto.randomUUID() };

  return resolve(event);
};
