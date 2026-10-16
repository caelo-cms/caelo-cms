// SPDX-License-Identifier: MPL-2.0

/**
 * Delivery of a password-reset link. Kept separate from the `auth.reset_*` ops
 * because sending mail is a side effect that must NOT run inside the DB
 * transaction: the op stores the token hash and returns the raw token, and the
 * route calls this afterwards with the built `/reset?token=…` URL.
 *
 * #769 — the link is never written to a log. It is a credential, and on a
 * cloud install the logs are the project's Cloud Logging. When the install
 * cannot send mail, `/forgot` asks {@link passwordResetEmailProblem} first,
 * says so and issues no token; the operator recovers through
 * `cms-provision owner-reset`. A send that fails anyway is logged without the
 * link and not surfaced, so it can't be used to probe whether an address exists.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { buildEmailTransport, type EmailConfigRow, emailDeliveryProblem } from "./transport.js";

/** The registry handles the reset helpers read `email_config` through. */
export interface ResetEmailContext {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly ctx: ExecutionContext;
}

export interface DeliverResetEmailArgs extends ResetEmailContext {
  readonly to: string;
  readonly displayName: string;
  /** The fully-qualified `/reset?token=…` URL the recipient clicks. */
  readonly resetUrl: string;
}

/** Minimal HTML body for the reset email (no external assets). */
function passwordResetEmailHtml(displayName: string, resetUrl: string): string {
  const greeting = displayName.trim().length > 0 ? `Hi ${escapeHtml(displayName)},` : "Hi,";
  const safeUrl = escapeHtml(resetUrl);
  return [
    `<p>${greeting}</p>`,
    "<p>We received a request to reset your Caelo password. Click the link below to choose a new one — it expires in one hour and can be used once.</p>",
    `<p><a href="${safeUrl}">Reset your password</a></p>`,
    `<p>If the link doesn't work, paste this into your browser:<br>${safeUrl}</p>`,
    "<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadEmailConfig(args: ResetEmailContext): Promise<EmailConfigRow> {
  const res = await execute(args.registry, args.adapter, args.ctx, "email_config.get", {});
  if (!res.ok) throw new Error(`email_config.get: ${JSON.stringify(res.error)}`);
  const c = (res.value as { config: EmailConfigRow }).config;
  return { transport: c.transport, fromAddress: c.fromAddress, config: c.config };
}

/**
 * Why this install cannot email a reset link, or null when it can. Says
 * nothing about any account, so showing it reveals no addresses.
 */
export async function passwordResetEmailProblem(args: ResetEmailContext): Promise<string | null> {
  return emailDeliveryProblem(await loadEmailConfig(args));
}

/**
 * Email the reset link. Callers check {@link passwordResetEmailProblem}
 * first; a config that cannot deliver throws (it can change between that
 * check and this call), so a caller answering an unauthenticated request
 * catches and answers as it would for an unknown address (the `/forgot`
 * route does, in apps/admin `requestPasswordResetLink`).
 */
export async function deliverPasswordResetEmail(args: DeliverResetEmailArgs): Promise<void> {
  const { to, displayName, resetUrl } = args;
  const cfg = await loadEmailConfig(args);
  const problem = emailDeliveryProblem(cfg);
  const transport = buildEmailTransport(cfg);
  if (problem !== null || !transport) {
    throw new Error(
      `deliverPasswordResetEmail: ${problem ?? "no transport"}; check passwordResetEmailProblem before issuing a token`,
    );
  }

  try {
    await transport.send({
      to,
      subject: "Reset your Caelo password",
      html: passwordResetEmailHtml(displayName, resetUrl),
    });
  } catch (e) {
    // Don't fail the request (or leak existence via an error). The link stays
    // out of the log; the operator recovers with `cms-provision owner-reset`.
    console.error(
      `[password-reset] send to ${to} failed: ${(e as Error).message}. Check Settings -> Email; a locked-out Owner recovers with \`cms-provision owner-reset\`.`,
    );
  }
}
