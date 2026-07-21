// SPDX-License-Identifier: MPL-2.0

/**
 * Delivery of a password-reset link. Kept separate from the `auth.reset_*` ops
 * because sending mail is a side effect that must NOT run inside the DB
 * transaction: the op stores the token hash and returns the raw token, and the
 * route calls this afterwards with the built `/reset?token=…` URL.
 *
 * When no real transport is configured (the dev default is `none`), the link is
 * logged to stderr instead of emailed — so the reset flow is fully exercisable
 * locally without a mail provider. This never throws into the request path: a
 * send failure is logged (with the link) rather than surfaced, so it can't be
 * used to probe whether an address exists.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { buildEmailTransport, type EmailConfigRow } from "./transport.js";

export interface DeliverResetEmailArgs {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly ctx: ExecutionContext;
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

export async function deliverPasswordResetEmail(args: DeliverResetEmailArgs): Promise<void> {
  const { registry, adapter, ctx, to, displayName, resetUrl } = args;

  let cfg: EmailConfigRow = { transport: "none", fromAddress: "", config: {} };
  const res = await execute(registry, adapter, ctx, "email_config.get", {});
  if (res.ok) {
    const c = (res.value as { config: EmailConfigRow }).config;
    cfg = { transport: c.transport, fromAddress: c.fromAddress, config: c.config };
  }

  const transport = buildEmailTransport(cfg);
  if (!transport) {
    // Dev / unconfigured: surface the link in the logs so a reset is still
    // completable locally. Same fallback the hooks warn about at boot.
    console.error(
      `[password-reset] no email transport configured — reset link for ${to}: ${resetUrl}`,
    );
    return;
  }

  try {
    await transport.send({
      to,
      subject: "Reset your Caelo password",
      html: passwordResetEmailHtml(displayName, resetUrl),
    });
  } catch (e) {
    // Don't fail the request (or leak existence via an error) — log with the
    // link so the operator can recover a stuck send.
    console.error(
      `[password-reset] send to ${to} failed: ${(e as Error).message}. Link: ${resetUrl}`,
    );
  }
}
