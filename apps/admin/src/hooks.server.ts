// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import type { Handle } from "@sveltejs/kit";
import { SESSION_COOKIE } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "hooks",
};

/**
 * Per-request middleware: resolve session cookie → populate `locals.user` +
 * `locals.ctx`. The `csrfSecret` field is the long-lived per-session secret —
 * forms use a derived per-render token via `signCsrfToken`.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const { adapter, registry } = getQueryContext();
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
        csrfSecret: v.csrfToken, // op output is the long-lived secret
      };
    } else {
      event.cookies.delete(SESSION_COOKIE, { path: "/" });
    }
  }

  event.locals.user = user;
  event.locals.ctx = user
    ? { actorId: user.id, actorKind: "human", requestId: crypto.randomUUID() }
    : { ...SYSTEM_CTX, requestId: crypto.randomUUID() };

  return resolve(event);
};
