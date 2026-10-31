// SPDX-License-Identifier: MPL-2.0
/**
 * A form action that throws (`ActionResult` of type `error`, e.g. a CSRF
 * token that no longer verifies) makes SvelteKit replace the whole page with
 * its error page. A password dialog shows it in place instead: these helpers
 * turn it into the message and the form failure the dialog already knows how
 * to show.
 */
/**
 * The words for a form submit the server answered with a thrown error.
 *
 * @example thrownErrorMessage({ message: "CSRF token mismatch" })
 * // → "This could not be sent (CSRF token mismatch). Reload the page and try again."
 */
export function thrownErrorMessage(error) {
    const message = error?.message;
    const detail = typeof message === "string" && message.length > 0 ? message : "the request failed";
    return `This could not be sent (${detail}). Reload the page and try again.`;
}
/**
 * A thrown error as a `failure` ActionResult for `applyAction`: it lands in
 * `form` like a wrong password does, so the dialog of `action` stays open
 * with the message (and the toast and the submit button's loading state
 * settle as for any answered submit). A request that never reached the
 * server (offline) carries no status and no location: it reads as 500 on
 * the page it was sent from.
 */
export function thrownErrorAsFailure(result, action, extra = {}) {
    return {
        type: "failure",
        status: result.status ?? 500,
        location: result.location ?? `${globalThis.location.pathname}${globalThis.location.search}`,
        data: { error: thrownErrorMessage(result.error), thrownError: true, action, ...extra },
    };
}
