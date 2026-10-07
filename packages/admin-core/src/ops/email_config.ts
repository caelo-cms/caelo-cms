// SPDX-License-Identifier: MPL-2.0

/**
 * P12 review pass — email transport singleton.
 *
 * The plugin host's `ctx.email.send` is dispatched to whatever transport
 * this row names. v1 supports `none` (no-op stub), `smtp`, `resend`.
 * `ses` is a placeholder for P15. Owner-only writes; reads open to
 * everyone (the system needs to read it at boot to construct the
 * transport).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { buildEmailTransport } from "../email/transport.js";

const transportEnum = z.enum(["none", "smtp", "resend", "ses"]);

const emailConfigShape = z.object({
  transport: transportEnum,
  fromAddress: z.string(),
  config: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});

export const getEmailConfigOp = defineOperation({
  name: "email_config.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ config: emailConfigShape }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT transport, from_address, config_json, updated_at
      FROM email_config WHERE id = 1 LIMIT 1
    `)) as unknown as {
      transport: "none" | "smtp" | "resend" | "ses";
      from_address: string;
      config_json: Record<string, unknown>;
      updated_at: string | Date;
    }[];
    const r = rows[0];
    if (!r) {
      // Migration seeds the row, but if a fresh DB skips that we still
      // return the safe default so callers don't crash.
      return ok({
        config: {
          transport: "none" as const,
          fromAddress: "",
          config: {},
          updatedAt: new Date(0).toISOString(),
        },
      });
    }
    return ok({
      config: {
        transport: r.transport,
        fromAddress: r.from_address,
        config: r.config_json,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      },
    });
  },
});

export const setEmailConfigOp = defineOperation({
  name: "email_config.set",
  // Why human-only: transport credentials (API key / SMTP password); the AI reaches it through
  // propose_set_email_config, whose secrets the Owner supplies at approval.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      transport: transportEnum,
      fromAddress: z.string().max(254),
      config: z.record(z.string(), z.unknown()),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    if (input.transport !== "none" && input.fromAddress.trim() === "") {
      return err({
        kind: "HandlerError",
        operation: "email_config.set",
        message: "fromAddress is required for non-`none` transports",
      });
    }
    if (input.transport === "smtp") {
      const cfg = input.config as { host?: unknown; port?: unknown };
      if (typeof cfg.host !== "string" || typeof cfg.port !== "number") {
        return err({
          kind: "HandlerError",
          operation: "email_config.set",
          message: "smtp transport requires { host: string, port: number, ... }",
        });
      }
    }
    if (input.transport === "resend") {
      const cfg = input.config as { apiKey?: unknown };
      if (typeof cfg.apiKey !== "string" || cfg.apiKey.length < 8) {
        return err({
          kind: "HandlerError",
          operation: "email_config.set",
          message: "resend transport requires { apiKey: string }",
        });
      }
    }
    // The migration seeds row id=1 with `transport='none'`, so an UPDATE
    // is the right path. INSERT (with implicit id from the IDENTITY
    // generator) is the fresh-DB fallback. Postgres rejects explicit id
    // writes on `GENERATED ALWAYS AS IDENTITY` columns; sticking to
    // UPDATE + INSERT(no-id) sidesteps that entirely.
    // Bind config as a JSON string + cast to jsonb. Drizzle binds raw
    // JS objects as Postgres jsonb arrays sometimes; the explicit
    // string + cast is safer + matches the existing site_defaults
    // pattern.
    const configJson = sql.raw(`'${JSON.stringify(input.config).replace(/'/g, "''")}'::jsonb`);
    const updated = (await tx.execute(sql`
      UPDATE email_config SET
        transport    = ${input.transport},
        from_address = ${input.fromAddress},
        config_json  = ${configJson},
        updated_at   = now(),
        updated_by   = ${ctx.actorId}::uuid
      WHERE id = 1
      RETURNING id
    `)) as unknown as Array<{ id: number }>;
    if (updated.length === 0) {
      await tx.execute(sql`
        INSERT INTO email_config (transport, from_address, config_json, updated_by)
        VALUES (
          ${input.transport},
          ${input.fromAddress},
          ${configJson},
          ${ctx.actorId}::uuid
        )
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "email_config.set",
      input: { transport: input.transport, fromAddress: input.fromAddress }, // omit secrets
      succeeded: true,
      resultSummary: `transport=${input.transport}`,
    });
    return ok({});
  },
});

/** Subject of the transport self-test — fixed so the op cannot carry content. */
export const EMAIL_TEST_SUBJECT = "Caelo email transport test";
const EMAIL_TEST_HTML = "<p>If you're reading this, the configured transport works.</p>";

function emailDomain(address: string): string {
  // `Name <a@b.c>` and bare `a@b.c` both reduce to `b.c`.
  const bare = address.match(/<([^>]+)>/)?.[1] ?? address;
  return bare
    .slice(bare.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase();
}

/**
 * Send the fixed transport self-test email through the CURRENTLY stored
 * config (the panel's "Send test" button and the AI's `send_test_email`).
 * Built per call from the row — not the boot-time transport — so a test
 * right after a config change exercises the new settings.
 *
 * AI actors may only mail an address on the sender's own domain (the
 * `fromAddress` domain): the subject and body are fixed, but an
 * unrestricted AI-triggered send would still let injected instructions use
 * the site's mail reputation against third parties. The Owner can test any
 * recipient from Security → Email.
 */
export const sendTestEmailOp = defineOperation({
  name: "email_config.send_test",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ to: z.string().email().max(254) }).strict(),
  output: z.object({ messageId: z.string(), transport: transportEnum }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT transport, from_address, config_json
      FROM email_config WHERE id = 1 LIMIT 1
    `)) as unknown as {
      transport: "none" | "smtp" | "resend" | "ses";
      from_address: string;
      config_json: Record<string, unknown> | string;
    }[];
    const row = rows[0];
    const fail = (message: string) =>
      err({ kind: "HandlerError" as const, operation: "email_config.send_test", message });
    if (!row || row.transport === "none") {
      return fail(
        "email transport is `none` — sends are no-ops. Configure a transport first (propose_set_email_config, transport 'resend'), then test again.",
      );
    }
    if (ctx.actorKind === "ai" && emailDomain(input.to) !== emailDomain(row.from_address)) {
      return fail(
        `the AI can only send the test to an address on the sender's domain (@${emailDomain(row.from_address)}). ` +
          "Pick such an address, or ask the operator to test other recipients from Security → Email.",
      );
    }
    const transport = buildEmailTransport({
      transport: row.transport,
      fromAddress: row.from_address,
      config:
        typeof row.config_json === "string"
          ? (JSON.parse(row.config_json) as Record<string, unknown>)
          : row.config_json,
    });
    if (!transport) {
      return fail(`transport \`${row.transport}\` is not implemented yet — use \`resend\`.`);
    }
    let messageId: string;
    try {
      ({ messageId } = await transport.send({
        to: input.to,
        subject: EMAIL_TEST_SUBJECT,
        html: EMAIL_TEST_HTML,
      }));
    } catch (e) {
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: "email_config.send_test",
        input: { toDomain: emailDomain(input.to) },
        succeeded: false,
        resultSummary: `transport=${row.transport} failed`,
      });
      return fail(`send failed: ${(e as Error).message}`);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "email_config.send_test",
      input: { toDomain: emailDomain(input.to) },
      succeeded: true,
      resultSummary: `transport=${row.transport} messageId=${messageId}`,
    });
    return ok({ messageId, transport: row.transport });
  },
});
