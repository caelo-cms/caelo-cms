// SPDX-License-Identifier: MPL-2.0

/**
 * The delivery caps of the public mail outboxes (#1337, maintainer decision
 * 2026-11-04): how many mails one recipient gets per 24 hours and how many
 * the site sends per hour, live and staging (migration 0611,
 * `mail_delivery_caps`). The drain counts its ledger against them
 * (`public_mail_deliveries.reserve_many`).
 *
 * They are money and abuse knobs: a raised cap spends the provider's quota
 * and the sending domain's reputation before anyone notices. So
 * `mail_caps.set` is human+system (the Owner's Settings → Email), and the
 * AI proposes through the owner-settings §11.A gate
 * (`owner_settings.propose_set_mail_caps` → `owner_settings.execute_proposal`,
 * which applies the queued payload through `mail_caps.set`'s handler).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  errorMessage,
  handlerError,
  proposeOutput,
  queueProposal,
  type Tx,
} from "./owner_settings_queue.js";

/** The caps as the ops read and write them (bounds = migration 0611's CHECKs). */
export const mailCapsShape = z
  .object({
    perRecipientPerDay: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("Mails one recipient gets per environment within 24 hours."),
    livePerHour: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .describe("Mails the live site sends per hour, all recipients together."),
    stagingPerHour: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .describe("Mails the staging site sends per hour (only to team members)."),
  })
  .strict();

export type MailCaps = z.infer<typeof mailCapsShape>;

/**
 * The stored caps. The row is seeded by migration 0611; a missing one is a
 * broken install, reported loudly (CLAUDE.md §2: no default at read time).
 */
export async function readMailCaps(tx: Tx): Promise<MailCaps> {
  const rows = (await tx.execute(sql`
    SELECT per_recipient_per_day, live_per_hour, staging_per_hour
    FROM mail_delivery_caps WHERE id = 1
  `)) as unknown as {
    per_recipient_per_day: number;
    live_per_hour: number;
    staging_per_hour: number;
  }[];
  const r = rows[0];
  if (!r) {
    throw new Error(
      "mail_delivery_caps row missing — migration 0611 seeds it; run the database migrations",
    );
  }
  return {
    perRecipientPerDay: r.per_recipient_per_day,
    livePerHour: r.live_per_hour,
    stagingPerHour: r.staging_per_hour,
  };
}

export const getMailCapsOp = defineOperation({
  name: "mail_caps.get",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ caps: mailCapsShape }),
  handler: async (_ctx, _input, tx) => ok({ caps: await readMailCaps(tx) }),
});

export const setMailCapsOp = defineOperation({
  name: "mail_caps.set",
  readScope: "request",
  // Why human-only: a raised cap spends the mail provider's quota and the
  // sending domain's reputation before anyone notices (CLAUDE.md §11.A);
  // the AI proposes with owner_settings.propose_set_mail_caps.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: mailCapsShape,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const updated = (await tx.execute(sql`
      UPDATE mail_delivery_caps SET
        per_recipient_per_day = ${input.perRecipientPerDay},
        live_per_hour         = ${input.livePerHour},
        staging_per_hour      = ${input.stagingPerHour},
        updated_at            = now(),
        updated_by            = ${ctx.actorId}::uuid
      WHERE id = 1
      RETURNING id
    `)) as unknown as unknown[];
    if (updated.length === 0) {
      return err({
        kind: "HandlerError",
        operation: "mail_caps.set",
        message: "mail_delivery_caps row missing — run the database migrations (0611 seeds it)",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "mail_caps.set",
      input,
      succeeded: true,
      resultSummary: `per recipient ${input.perRecipientPerDay}/24h, live ${input.livePerHour}/h, staging ${input.stagingPerHour}/h`,
    });
    return ok({});
  },
});

/** A proposal: only the named caps change, merged onto the row at approve time. */
export const proposeMailCapsInput = mailCapsShape
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "name at least one cap to change" });

export const proposeSetMailCapsOp = defineOperation({
  name: "owner_settings.propose_set_mail_caps",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: proposeMailCapsInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "owner_settings.propose_set_mail_caps";
    const current = await readMailCaps(tx);
    const changes: Record<string, { from: number; to: number }> = {};
    for (const key of Object.keys(input) as (keyof MailCaps)[]) {
      const to = input[key];
      if (to !== undefined && to !== current[key]) changes[key] = { from: current[key], to };
    }
    if (Object.keys(changes).length === 0) {
      return handlerError(op, "the mail caps already have these values — nothing to propose.");
    }
    const summary = `mail caps: ${Object.entries(changes)
      .map(([k, c]) => `${k} ${c.from} → ${c.to}`)
      .join(", ")}`;
    return queueProposal(tx, ctx, "set_mail_caps", input, { changes, summary }, op, summary);
  },
});

/**
 * Apply an approved `set_mail_caps` proposal inside the approving
 * transaction: the patch merged onto the caps as they are now, through
 * `mail_caps.set`. Returns an error message, or null when applied.
 */
export async function applyMailCapsProposal(
  ctx: ExecutionContext,
  tx: Tx,
  payload: unknown,
): Promise<string | null> {
  const patch = proposeMailCapsInput.parse(payload);
  const merged = { ...(await readMailCaps(tx)), ...patch };
  const r = await setMailCapsOp.handler(ctx, merged, tx);
  return r.ok ? null : `mail_caps.set failed: ${errorMessage(r.error)}`;
}
