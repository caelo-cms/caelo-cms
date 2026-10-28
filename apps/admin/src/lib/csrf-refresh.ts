// SPDX-License-Identifier: MPL-2.0

/**
 * Keeps an open tab's CSRF form token valid. The root layout's server load
 * signs the token (routes/+layout.server.ts, 1h lifetime), and SvelteKit
 * reruns that load only on a full page load or after an enhanced form
 * submit: a tab used for hours through client-side navigation kept a token
 * past its lifetime, and the next form submit landed on the 403
 * "CSRF token mismatch" error page instead of doing its work.
 *
 * How the refresh works, and why this way:
 * - `+layout.svelte` runs {@link keepCsrfTokenFresh} on the token it has: at
 *   half its lifetime (and right away when a tab that slept past that point
 *   becomes visible) it fetches a new token from {@link CSRF_TOKEN_PATH}.
 * - The new token goes into page data through the root UNIVERSAL load
 *   (routes/+layout.ts), which declares {@link CSRF_DEPENDENCY} and swaps in
 *   {@link freshestCsrfToken}. Invalidating that dependency reruns only that
 *   in-browser load: no server load runs again and no request is made.
 * - The network request is ours, not SvelteKit's: a failed refresh (a laptop
 *   waking up before its wifi) is retried a minute later. Invalidating a
 *   server load instead would replace the page with the error page whenever
 *   that request failed, losing whatever the editor had typed.
 */

import { z } from "zod";

/** The dependency the root universal load declares; invalidating it swaps in the newest token. */
export const CSRF_DEPENDENCY = "caelo:csrf";

/** The endpoint that signs a new form token for the signed-in session. */
export const CSRF_TOKEN_PATH = "/_caelo/csrf-token";

/** How long a failed refresh waits before it tries again. */
export const CSRF_REFRESH_RETRY_MS = 60_000;

/** When a token was signed (ms since epoch, server clock), from its `<ts>.<nonce>.<hmac>` shape. */
export function csrfTokenIssuedAt(token: string): number | null {
  const ts = Number(token.split(".")[0]);
  return token.length > 0 && Number.isFinite(ts) ? ts : null;
}

/** The newest token this tab fetched; browser only (a server module is shared by every request). */
let fetchedToken: string | null = null;

/** Remember a token fetched from {@link CSRF_TOKEN_PATH}. Browser only. */
export function rememberFetchedCsrfToken(token: string): void {
  fetchedToken = token;
}

/**
 * The token page data should carry: the one the server load signed, or the
 * one this tab fetched since, whichever was signed later. Signed out (`""`)
 * stays signed out and forgets the fetched token, so it can never outlive
 * its session into the next sign-in.
 */
export function freshestCsrfToken(serverToken: string): string {
  if (serverToken === "") {
    fetchedToken = null;
    return serverToken;
  }
  if (fetchedToken === null) return serverToken;
  const fetchedAt = csrfTokenIssuedAt(fetchedToken);
  const serverAt = csrfTokenIssuedAt(serverToken);
  return fetchedAt !== null && serverAt !== null && fetchedAt > serverAt
    ? fetchedToken
    : serverToken;
}

const TokenResponse = z.object({ token: z.string().min(1) });

/**
 * Fetch a new token and hand it to the root load.
 *
 * @returns `false` when the session is gone (nothing to refresh; the next
 *   page load goes to the login), `true` once the new token is applied.
 * @throws when the request failed, so {@link keepCsrfTokenFresh} retries.
 */
export async function fetchFreshCsrfToken(
  fetchFn: typeof fetch,
  applyToken: () => Promise<void>,
): Promise<boolean> {
  const res = await fetchFn(CSRF_TOKEN_PATH, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`CSRF token refresh failed: HTTP ${res.status}`);
  rememberFetchedCsrfToken(TokenResponse.parse(await res.json()).token);
  await applyToken();
  return true;
}

/** What {@link keepCsrfTokenFresh} needs from the browser (injectable for tests). */
export interface CsrfRefreshEnv {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (id: unknown) => void;
  readonly document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

const browserEnv = (): CsrfRefreshEnv => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
  document,
});

/**
 * Run `refresh` once `refreshAfterMs` passed, and right away when the tab
 * becomes visible past that point: browsers throttle timers in background
 * tabs and stop them while a laptop sleeps, so the timer alone can fire
 * late. A refresh that throws is retried after {@link CSRF_REFRESH_RETRY_MS};
 * one that applied a token checks again after that long too, in case a
 * navigation overtook the update (the caller restarts this for every new
 * token, and its cleanup cancels the check). `false` stops.
 *
 * @returns the cleanup that cancels the timer and the listener.
 */
export function keepCsrfTokenFresh(
  refreshAfterMs: number,
  refresh: () => Promise<boolean>,
  env: CsrfRefreshEnv = browserEnv(),
): () => void {
  let dueAt = env.now() + refreshAfterMs;
  let timer: unknown = null;
  let running = false;
  let stopped = false;

  const schedule = (ms: number) => {
    env.clearTimeout(timer);
    dueAt = env.now() + ms;
    timer = env.setTimeout(() => void attempt(), ms);
  };
  const attempt = async () => {
    if (running || stopped) return;
    running = true;
    env.clearTimeout(timer);
    try {
      if (await refresh()) {
        if (!stopped) schedule(CSRF_REFRESH_RETRY_MS);
      } else {
        stopped = true;
      }
    } catch (e) {
      console.warn("[csrf] token refresh failed; retrying", e);
      if (!stopped) schedule(CSRF_REFRESH_RETRY_MS);
    } finally {
      running = false;
    }
  };
  const onVisible = () => {
    if (env.document.visibilityState === "visible" && env.now() >= dueAt) void attempt();
  };

  timer = env.setTimeout(() => void attempt(), Math.max(0, refreshAfterMs));
  env.document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    env.clearTimeout(timer);
    env.document.removeEventListener("visibilitychange", onVisible);
  };
}
