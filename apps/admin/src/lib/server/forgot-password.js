// SPDX-License-Identifier: MPL-2.0
/**
 * #769 — the body of the `/forgot` action, outside the route so its
 * no-enumeration guarantee can be tested with the delivery step swapped.
 *
 * The answer must not depend on whether the address belongs to an account.
 * Only an existing account gets a token and a delivery attempt, so anything
 * that delivery does differently — a send that fails, a mail config that
 * flipped to "none" between the up-front check and the send, a database
 * error reading that config — must end in the same outcome an unknown
 * address gets. A 500 for known addresses next to a 200 for unknown ones is
 * an oracle for which addresses have accounts. The failure is logged without
 * the reset link or token: that is a credential, and on a cloud install the
 * log is the project's Cloud Logging.
 */
import { deliverPasswordResetEmail, passwordResetEmailProblem, } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
/**
 * Issue a reset token for `email` if it has an account and try to email it.
 * Never throws for a known address where it would not for an unknown one.
 */
export async function requestPasswordResetLink(deps, email) {
    const { registry, adapter, ctx } = deps;
    const emailProblem = deps.emailProblem ?? passwordResetEmailProblem;
    const deliver = deps.deliver ?? deliverPasswordResetEmail;
    // A form posted before the page knew (or by a script) must not issue a
    // token nobody can receive.
    if ((await emailProblem({ registry, adapter, ctx })) !== null) {
        return { kind: "email-unavailable" };
    }
    const result = await execute(registry, adapter, ctx, "auth.request_password_reset", { email });
    if (!result.ok)
        return { kind: "sent" };
    const { delivery } = result.value;
    if (!delivery)
        return { kind: "sent" };
    const resetUrl = new URL(`/reset?token=${encodeURIComponent(delivery.token)}`, deps.origin).toString();
    try {
        await deliver({
            registry,
            adapter,
            ctx,
            to: delivery.email,
            displayName: delivery.displayName,
            resetUrl,
        });
    }
    catch (e) {
        const reason = (e instanceof Error ? e.message : String(e))
            .replaceAll(resetUrl, "[reset link]")
            .replaceAll(delivery.token, "[token]");
        console.error(`[password-reset] a reset link could not be emailed: ${reason}. Check Settings -> Email; a locked-out Owner recovers with \`cms-provision owner-reset\`.`);
    }
    return { kind: "sent" };
}
