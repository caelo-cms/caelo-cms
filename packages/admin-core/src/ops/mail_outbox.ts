// SPDX-License-Identifier: MPL-2.0

/**
 * The operations behind the public mail outboxes (issue #1337, epic #763
 * M7). The drain (`email/outbox.ts`) runs them on every scheduler tick:
 *
 * 1. `mail_outbox.claim` (each public database) leases the oldest rows of
 *    that database's `mail_outbox`, so no other drain takes them meanwhile;
 *    `mail_outbox.complete` deletes them once the drain is done. A drain
 *    that dies mid-way loses nothing: the lease runs out and the next tick
 *    takes the rows again (at least once).
 * 2. `public_mail_deliveries.reserve_many` (cms_admin) decides, from state
 *    the public side cannot touch, which of them may be sent: the staging
 *    rule (only addresses of cms_admin users), the per-recipient cap and
 *    the site-wide cap per environment (the Owner's `mail_delivery_caps`,
 *    `mail_caps.ts`). It records a ledger row for each
 *    allowed mail and returns the environment's link host.
 * 3. `public_mail_deliveries.finish_many` records what the transport said.
 *
 * All three are system-only: nothing but the drain sends visitor mail.
 */

import { defineOperation, textArray } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { readMailCaps } from "./mail_caps.js";

/** Most outbox rows one claim takes. */
export const MAIL_OUTBOX_CLAIM_MAX = 200;

/** How long a claimed row stays with the drain that took it (the task's lease is 5 minutes). */
const MAIL_OUTBOX_LEASE_MINUTES = 10;

/** The window of the per-recipient cap (the cap itself: `mail_delivery_caps`). */
export const RECIPIENT_WINDOW_HOURS = 24;

/** Ledger rows older than this are collected (longer than every cap window). */
const LEDGER_RETENTION_HOURS = 48;

const environment = z.enum(["live", "staging"]);

export const claimMailOutboxOp = defineOperation({
  name: "mail_outbox.claim",
  readScope: "request",
  // Why system-only: only the admin's drain takes mail out of an outbox;
  // a row it takes is deleted, so another caller would lose mail.
  actorScope: ["system"],
  database: "cms_public",
  input: z
    .object({
      limit: z.number().int().min(0).max(MAIL_OUTBOX_CLAIM_MAX),
      /** Rows older than this are deleted unsent first. */
      ttlMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60),
    })
    .strict(),
  // The rows are attacker-writable: the drain validates each one
  // (parseUntrustedRows) before anything of it is used.
  output: z.object({ rows: z.array(z.unknown()), expired: z.number().int(), pending: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const expired = (await tx.execute(sql`
      DELETE FROM mail_outbox
      WHERE id IN (
        SELECT id FROM mail_outbox
        WHERE created_at < now() - make_interval(mins => ${input.ttlMinutes})
        ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `)) as unknown as unknown[];
    if (input.limit === 0) {
      // Only asking whether mail waits (no transport to send it with).
      const left = (await tx.execute(
        sql`SELECT EXISTS (SELECT 1 FROM mail_outbox) AS pending`,
      )) as unknown as { pending: boolean }[];
      return ok({ rows: [], expired: expired.length, pending: Boolean(left[0]?.pending) });
    }
    // A lease, not a delete: a drain that dies before it is done leaves the
    // rows to the next tick once the lease ran out (`mail_outbox.complete`
    // deletes them when the drain is done).
    const rows = (await tx.execute(sql`
      UPDATE mail_outbox SET claimed_until = now() + make_interval(mins => ${MAIL_OUTBOX_LEASE_MINUTES})
      WHERE id IN (
        SELECT id FROM mail_outbox
        WHERE claimed_until IS NULL OR claimed_until < now()
        ORDER BY id LIMIT ${input.limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id, plugin_id::text AS plugin_id, template, recipient, token, created_at
    `)) as unknown as unknown[];
    return ok({ rows: [...rows], expired: expired.length, pending: false });
  },
});

export const completeMailOutboxOp = defineOperation({
  name: "mail_outbox.complete",
  readScope: "request",
  // Why system-only: the drain removes the rows it is done with.
  actorScope: ["system"],
  database: "cms_public",
  input: z
    .object({ ids: z.array(z.string().regex(/^[0-9]{1,19}$/)).max(MAIL_OUTBOX_CLAIM_MAX) })
    .strict(),
  output: z.object({ deleted: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    if (input.ids.length === 0) return ok({ deleted: 0 });
    const rows = (await tx.execute(sql`
      DELETE FROM mail_outbox
      WHERE id = ANY(ARRAY(SELECT jsonb_array_elements_text((${JSON.stringify(input.ids)}::text)::jsonb)::bigint))
      RETURNING id
    `)) as unknown as unknown[];
    return ok({ deleted: rows.length });
  },
});

const reserveInput = z
  .object({
    environment,
    mails: z
      .array(
        z
          .object({
            /** The normalised address (staging: matched against cms_admin users). */
            recipient: z.string().min(3).max(254),
            recipientHash: z.string().regex(/^[0-9a-f]{64}$/),
            pluginId: z.string().uuid(),
            template: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            /** The template links: refused before a reservation when no origin is set. */
            needsLink: z.boolean(),
          })
          .strict(),
      )
      .max(MAIL_OUTBOX_CLAIM_MAX),
  })
  .strict();

const refusal = z.enum(["not_a_team_member", "recipient_cap", "site_cap", "no_link_origin"]);

export const reserveMailDeliveriesOp = defineOperation({
  name: "public_mail_deliveries.reserve_many",
  readScope: "request",
  // Why system-only: the delivery caps are the drain's own bookkeeping.
  actorScope: ["system"],
  database: "cms_admin",
  input: reserveInput,
  output: z.object({
    /** One entry per mail, in order: the ledger id to finish, or why not. */
    decisions: z.array(
      z.union([
        z.object({ deliveryId: z.string() }).strict(),
        z.object({ refused: refusal }).strict(),
      ]),
    ),
    /** The origin links in this environment's mails point at; null when not set up. */
    linkOrigin: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    // One reservation at a time per environment, so two drains cannot both
    // take the last slot of a cap (the tick's lease normally keeps it one).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`public_mail_deliveries:${input.environment}`}))`,
    );
    await tx.execute(sql`
      DELETE FROM public_mail_deliveries
      WHERE id IN (
        SELECT id FROM public_mail_deliveries
        WHERE created_at < now() - make_interval(hours => ${LEDGER_RETENTION_HOURS})
        ORDER BY created_at LIMIT 1000
      )
    `);
    const siteRows = (await tx.execute(sql`
      SELECT count(*)::int AS n FROM public_mail_deliveries
      WHERE environment = ${input.environment} AND created_at > now() - interval '1 hour'
    `)) as unknown as { n: number }[];
    let siteUsed = siteRows[0]?.n ?? 0;
    // The Owner's caps (#1337, migration 0611): stored, never defaulted here.
    const caps = await readMailCaps(tx);
    const siteCap = input.environment === "live" ? caps.livePerHour : caps.stagingPerHour;

    const hashes = [...new Set(input.mails.map((m) => m.recipientHash))];
    const perRecipient = new Map<string, number>();
    if (hashes.length > 0) {
      const counted = (await tx.execute(sql`
        SELECT recipient_hash, count(*)::int AS n FROM public_mail_deliveries
        WHERE environment = ${input.environment}
          AND recipient_hash = ANY(${textArray(hashes)})
          AND created_at > now() - make_interval(hours => ${RECIPIENT_WINDOW_HOURS})
        GROUP BY recipient_hash
      `)) as unknown as { recipient_hash: string; n: number }[];
      for (const r of counted) perRecipient.set(r.recipient_hash, r.n);
    }

    // #1337 (moved from #1330): mail from the staging site's outbox goes
    // only to the team — the addresses of cms_admin users. The staging
    // database is written by whoever passes the staging gate, so any other
    // address in it is dropped, never mailed.
    const team = new Set<string>();
    if (input.environment === "staging" && input.mails.length > 0) {
      const recipients = [...new Set(input.mails.map((m) => m.recipient))];
      const found = (await tx.execute(sql`
        SELECT lower(email) AS email FROM users WHERE lower(email) = ANY(${textArray(recipients)})
      `)) as unknown as { email: string }[];
      for (const r of found) team.add(r.email);
    }

    // Before any reservation: a mail whose link has no origin would only
    // use up a cap slot for nothing.
    const linkOrigin = await linkOriginOf(tx, input.environment);
    const decisions: Array<{ deliveryId: string } | { refused: z.infer<typeof refusal> }> = [];
    for (const m of input.mails) {
      if (m.needsLink && linkOrigin === null) {
        decisions.push({ refused: "no_link_origin" });
        continue;
      }
      if (input.environment === "staging" && !team.has(m.recipient)) {
        decisions.push({ refused: "not_a_team_member" });
        continue;
      }
      const used = perRecipient.get(m.recipientHash) ?? 0;
      if (used >= caps.perRecipientPerDay) {
        decisions.push({ refused: "recipient_cap" });
        continue;
      }
      if (siteUsed >= siteCap) {
        decisions.push({ refused: "site_cap" });
        continue;
      }
      const inserted = (await tx.execute(sql`
        INSERT INTO public_mail_deliveries (environment, recipient_hash, plugin_id, template)
        VALUES (${input.environment}, ${m.recipientHash}, ${m.pluginId}::uuid, ${m.template})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const id = inserted[0]?.id;
      if (!id) {
        return err({
          kind: "HandlerError",
          operation: "public_mail_deliveries.reserve_many",
          message: "the delivery ledger row was not written",
        });
      }
      perRecipient.set(m.recipientHash, used + 1);
      siteUsed += 1;
      decisions.push({ deliveryId: id });
    }

    return ok({ decisions, linkOrigin });
  },
});

export const mailLinkConfigOp = defineOperation({
  name: "public_mail_deliveries.link_config",
  readScope: "request",
  // Why system-only: the plugin host asks on a plugin's behalf for the host
  // and the signing key of mail the admin sends (#1432); a plugin only ever
  // gets the finished link.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ origin: z.string().nullable(), key: z.string().nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT mail_link_key FROM site_settings WHERE id = 1`,
    )) as unknown as { mail_link_key: string | null }[];
    return ok({
      origin: await linkOriginOf(tx, "live"),
      key: rows[0]?.mail_link_key ?? null,
    });
  },
});

/**
 * The origin an environment's mail links point at, from cms_admin, never
 * from an outbox row: live the site's base URL, staging the staging host.
 */
async function linkOriginOf(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  env: "live" | "staging",
): Promise<string | null> {
  if (env === "live") {
    const rows = (await tx.execute(sql`SELECT site_base_url FROM site_defaults WHERE id = 1`)) as {
      site_base_url: string | null;
    }[];
    const raw = rows[0]?.site_base_url;
    if (!raw) return null;
    try {
      const u = new URL(raw);
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
      return null;
    }
  }
  const rows = (await tx.execute(sql`SELECT staging_host FROM staging_access WHERE id = 1`)) as {
    staging_host: string | null;
  }[];
  const host = rows[0]?.staging_host;
  return host && /^[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(host) ? `https://${host.toLowerCase()}` : null;
}

export const finishMailDeliveriesOp = defineOperation({
  name: "public_mail_deliveries.finish_many",
  readScope: "request",
  // Why system-only: the drain records its own outcomes.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      outcomes: z
        .array(
          z
            .object({
              deliveryId: z.string().regex(/^[0-9]{1,19}$/),
              outcome: z.enum(["sent", "failed"]),
              messageId: z.string().max(200).nullable(),
            })
            .strict(),
        )
        .max(MAIL_OUTBOX_CLAIM_MAX),
    })
    .strict(),
  output: z.object({ updated: z.number().int() }),
  handler: async (_ctx, input, tx) => {
    let updated = 0;
    for (const o of input.outcomes) {
      const r = (await tx.execute(sql`
        UPDATE public_mail_deliveries SET outcome = ${o.outcome}, message_id = ${o.messageId}
        WHERE id = ${o.deliveryId}::bigint AND outcome = 'reserved'
        RETURNING id
      `)) as unknown as unknown[];
      updated += r.length;
    }
    return ok({ updated });
  },
});
