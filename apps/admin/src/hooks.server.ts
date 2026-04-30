// SPDX-License-Identifier: MPL-2.0

import {
  makeProvider,
  resetStuckTranslationUnits,
  setMode2Provider,
  setTranslationProvider,
  startTranslationWorker,
} from "@caelo/admin-core";
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

// P10 — one-time translation worker bootstrap. Runs at module load
// (i.e. once when SvelteKit boots). The worker polls for queued
// translation_job_units and dispatches Mode 1 / Mode 2 sequentially.
// Provider is the configured Anthropic adapter; if no key, the
// worker still runs but units fail with a clear "provider not
// configured" message (the dashboard surfaces it).
let translationBootstrapped = false;
async function bootstrapTranslationWorker(): Promise<void> {
  if (translationBootstrapped) return;
  translationBootstrapped = true;
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey) {
    const provider = makeProvider({
      name: "anthropic",
      apiKey,
      model: "claude-opus-4-7",
    });
    setTranslationProvider({ provider });
    setMode2Provider({ provider });
  }
  const { adapter, registry } = getQueryContext();
  await resetStuckTranslationUnits({ adapter, registry, systemCtx: SYSTEM_CTX });
  startTranslationWorker({ adapter, registry, systemCtx: SYSTEM_CTX });
}

/**
 * Per-request middleware: resolve session cookie → populate `locals.user` +
 * `locals.ctx`. The `csrfSecret` field is the long-lived per-session secret —
 * forms use a derived per-render token via `signCsrfToken`.
 */
export const handle: Handle = async ({ event, resolve }) => {
  void bootstrapTranslationWorker();
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
        onboardedAt: string | null;
      };
      user = {
        id: v.userId,
        email: v.email,
        roles: v.roles,
        permissions: new Set(v.permissions),
        csrfSecret: v.csrfToken, // op output is the long-lived secret
        onboardedAt: v.onboardedAt,
      };
    } else {
      event.cookies.delete(SESSION_COOKIE, { path: "/" });
    }
  }

  event.locals.user = user;
  event.locals.ctx = user
    ? { actorId: user.id, actorKind: "human", requestId: crypto.randomUUID() }
    : { ...SYSTEM_CTX, requestId: crypto.randomUUID() };

  const response = await resolve(event);

  // P6.7.5 — fallback redirect lookup on a 404. In production Caddy
  // serves redirects from `_redirects.caddy`; the admin / smoke server
  // consults the `redirects` table directly so dev paths and tests see
  // the same behaviour without Caddy in front. We only check on 404 to
  // keep the happy path single-query.
  if (response.status === 404 && event.request.method === "GET") {
    try {
      const lookup = await execute(registry, adapter, SYSTEM_CTX, "redirects.lookup", {
        fromPath: event.url.pathname,
      });
      if (lookup.ok) {
        const m = (
          lookup.value as {
            match: { toPath: string; statusCode: number } | null;
          }
        ).match;
        if (m) {
          return new Response(null, {
            status: m.statusCode,
            headers: { Location: m.toPath },
          });
        }
      }
    } catch {
      // best-effort; never let a redirect lookup fail the original 404.
    }
  }

  return response;
};
