// SPDX-License-Identifier: MPL-2.0

/**
 * Core building blocks for visitors' mail addresses (#1340):
 *
 *   double-opt-in.subscribe   store the address unconfirmed and mail a
 *                             confirmation link (#1337 outbox), one answer
 *                             for every address
 *   double-opt-in.confirm     redeem the link before it expires
 *   mail.unsubscribe          the signed link of a mail the plugin sent
 *                             (#1432): set the row's unsubscribed column
 *
 * The newsletter is the first user; any plugin that collects addresses
 * activates the same blocks on a visitor-state table of its own, which the
 * SDK's block contract describes (`PUBLIC_BLOCK_CONTRACTS`).
 */

import {
  mailUnsubscribeRecipient,
  type PluginContextTier1,
  PublicOperationError,
} from "@caelo-cms/plugin-sdk";

/** The honeypot field the component kit's forms send (`HONEYPOT_FIELD_NAME`). */
const HONEYPOT_FIELD = "hp_address";

/** `subscribe`'s one answer for every address (P6, #1336). */
const SUBSCRIBE_ANSWER = Object.freeze({ awaitingConfirm: true as const });

function honeypotTripped(args: unknown): boolean {
  const v = (args as Record<string, unknown> | null)?.[HONEYPOT_FIELD];
  return typeof v === "string" && v.trim() !== "";
}

/**
 * The address's lookup key: a deterministic 64-bit hash of the trimmed,
 * lower-cased address (the newsletter's since P12; changing it would
 * orphan every stored row).
 */
export function optInEmailHash(email: string): string {
  const normalised = email.trim().toLowerCase();
  let h = 0n;
  for (let i = 0; i < normalised.length; i++) {
    h = (h * 31n + BigInt(normalised.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

interface OptInRow {
  id: string;
  confirmed_at: string | null;
  confirm_token: string;
  confirm_expires_at: string | null;
}

function option(options: Readonly<Record<string, unknown>>, key: string): string {
  const v = options[key];
  if (typeof v !== "string" || v === "") throw new Error(`block option "${key}" is missing`);
  return v;
}

async function subscribe(
  ctx: PluginContextTier1,
  args: unknown,
  options: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const table = option(options, "table");
  const template = option(options, "template");
  const ttlMs = Number(options.hours) * 60 * 60 * 1000;
  const email = String((args as { email: string }).email).trim();
  // A filled honeypot gets the same answer as a real sign-up: nothing is
  // stored or mailed, and the bot learns nothing.
  if (honeypotTripped(args)) return SUBSCRIBE_ANSWER;
  const hash = optInEmailHash(email);
  const existing = await ctx.query.list<typeof table, OptInRow>(table, {
    email_hash: hash,
    limit: 1,
  });
  if (existing[0]?.confirmed_at) return SUBSCRIBE_ANSWER;
  if (!ctx.email) throw new Error("double-opt-in: the email capability is not attached");
  // #1337 — a repeated sign-up mails the link that is still valid: a fresh
  // one would void the link already in the inbox, and if the per-recipient
  // cap refused the new mail nobody could confirm until the cap window
  // passed. Only an expired (or pre-#1337) link is replaced.
  const pending = existing[0];
  if (
    pending?.confirm_expires_at &&
    new Date(pending.confirm_expires_at) > new Date() &&
    typeof pending.confirm_token === "string"
  ) {
    await ctx.email.queue({ template, to: email, token: pending.confirm_token });
    return SUBSCRIBE_ANSWER;
  }
  const confirmToken = crypto.randomUUID();
  const confirmExpiresAt = new Date(Date.now() + ttlMs).toISOString();
  if (pending) {
    await ctx.query.update(table, pending.id, {
      confirm_token: confirmToken,
      confirm_expires_at: confirmExpiresAt,
    });
  } else {
    await ctx.query.insert(table, {
      email,
      email_hash: hash,
      confirm_token: confirmToken,
      confirm_expires_at: confirmExpiresAt,
      unsub_token: crypto.randomUUID(),
    });
  }
  await ctx.email.queue({ template, to: email, token: confirmToken });
  return SUBSCRIBE_ANSWER;
}

async function confirm(
  ctx: PluginContextTier1,
  args: unknown,
  options: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const table = option(options, "table");
  const token = String((args as { token: string }).token);
  const matches = await ctx.query.list<
    typeof table,
    { id: string; confirm_expires_at: string | null }
  >(table, { confirm_token: token, limit: 1 });
  if (!matches[0]) throw new PublicOperationError("confirm: invalid token");
  // A row from before #1337 has no expiry: it signs up again for a new link.
  const expires = matches[0].confirm_expires_at;
  if (!expires || new Date(expires) < new Date()) {
    throw new PublicOperationError("confirm: the link has expired");
  }
  await ctx.query.update(table, matches[0].id, { confirmed_at: new Date().toISOString() });
  return { confirmed: true };
}

async function unsubscribe(
  ctx: PluginContextTier1,
  args: unknown,
  options: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const table = option(options, "table");
  const column = option(options, "column");
  // The host already checked the signature (dispatch refuses the operation
  // without one), so a link stays good to press again and for a recipient
  // who is gone: both are unsubscribed.
  const recipientId = mailUnsubscribeRecipient(String((args as { token: string }).token));
  if (!recipientId) throw new PublicOperationError("unsubscribe: invalid token");
  // Compare-and-swap: of two concurrent POSTs only the first sets the date;
  // a gone recipient swaps nothing and is still a success.
  await ctx.query.compareAndSwap(
    table,
    recipientId,
    { [column]: null },
    { [column]: new Date().toISOString() },
  );
  return { unsubscribed: true };
}

/** The mail blocks. */
export const MAIL_BLOCKS = {
  "double-opt-in.subscribe": subscribe,
  "double-opt-in.confirm": confirm,
  "mail.unsubscribe": unsubscribe,
} as const;
