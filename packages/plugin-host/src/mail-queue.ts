// SPDX-License-Identifier: MPL-2.0

/**
 * `ctx.email` (issue #1337, epic #763 M7): queueing a declared mail
 * template into the public database's mail outbox.
 *
 * On the public side there is no mail transport: `queue` writes one row
 * of `mail_outbox` (cms_public migration 0610) through the named operation
 * below, under the plugin's own id, and `send` refuses. The admin drains
 * the outbox on its scheduler tick (admin-core `email/outbox.ts`). On the
 * admin side `send` delivers through the configured transport (an approved
 * newsletter campaign), and `queue` writes to the live outbox, so both
 * paths share the same caps.
 *
 * Nothing about delivery comes back: a visitor's operation cannot tell
 * whether the mail went out, so it cannot tell a visitor either.
 */

import {
  MAIL_RECIPIENT_MAX,
  MAIL_RECIPIENT_RE,
  MAIL_TEMPLATE_NAME_RE,
  MAIL_TOKEN_RE,
  type PluginEmail,
} from "@caelo-cms/plugin-sdk";
import {
  type DatabaseAdapter,
  defineOperation,
  execute,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

/** The operation that writes one outbox row. */
export const MAIL_QUEUE_OP = "plugin_mail.queue";

const queueInput = z
  .object({
    template: z.string().regex(MAIL_TEMPLATE_NAME_RE),
    recipient: z.string().max(MAIL_RECIPIENT_MAX).regex(MAIL_RECIPIENT_RE),
    token: z.string().regex(MAIL_TOKEN_RE).nullable(),
  })
  .strict();

const queueOp = defineOperation({
  name: MAIL_QUEUE_OP,
  readScope: "request",
  // Why plugin-only: the row is queued under the calling plugin's id (the
  // outbox policy checks it is an active published plugin); no other actor
  // queues visitor mail.
  actorScope: ["plugin"],
  database: "cms_public",
  input: queueInput,
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    if (ctx.actorKind !== "plugin" || !ctx.pluginId) {
      return err({
        kind: "HandlerError",
        operation: MAIL_QUEUE_OP,
        message: `${MAIL_QUEUE_OP}: only a plugin queues mail`,
      });
    }
    // No RETURNING: the visitor role may insert, never read the queue.
    await tx.execute(sql`
      INSERT INTO mail_outbox (plugin_id, template, recipient, token)
      VALUES (${ctx.pluginId}::uuid, ${input.template}, ${input.recipient}, ${input.token})
    `);
    return ok({});
  },
});

/** Register the queue operation on a registry (idempotent). */
export function registerMailQueueOp(registry: OperationRegistry): void {
  if (!registry.has(MAIL_QUEUE_OP)) {
    registry.register(queueOp as unknown as OperationDefinition<unknown, unknown>);
  }
}

/**
 * Normalise an address the way the outbox and the delivery caps count it:
 * Unicode NFC, trimmed, lower case. Two spellings of one address are one
 * recipient.
 */
export function normaliseMailAddress(address: string): string {
  return address.normalize("NFC").trim().toLowerCase();
}

/**
 * The `ctx.email` handle of one call. `publicAdapter` is the adapter whose
 * public database the call's outbox row goes to (the gateway's own; the
 * admin's live one).
 *
 * @param publicSide whether the call runs in a public gateway, which has
 *   no transport: `send` refuses there.
 */
export function makePluginEmail(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  publicAdapter: DatabaseAdapter,
  publicSide: boolean,
): PluginEmail {
  const templates = plugin.definition.mailTemplates ?? {};
  return {
    send: async (args) => {
      if (publicSide) {
        throw new Error(
          `ctx.email.send: plugin "${plugin.slug}" cannot send mail from a visitor call — the public side has no mail transport; queue one of its mailTemplates with ctx.email.queue`,
        );
      }
      const transport = infra.emailTransport;
      if (!transport) {
        // #1337 — the address stays out of the log (#763 M7: PII in logs).
        throw new Error(
          `ctx.email.send: no mail transport is set up — configure one at Settings → Email (or propose_set_email_config), then retry`,
        );
      }
      return transport.send(args);
    },
    queue: async ({ template, to, token }) => {
      if (!Object.hasOwn(templates, template)) {
        throw new Error(
          `ctx.email.queue: plugin "${plugin.slug}" declares no mail template "${template}" (mailTemplates)`,
        );
      }
      const recipient = normaliseMailAddress(to);
      if (recipient.length > MAIL_RECIPIENT_MAX || !MAIL_RECIPIENT_RE.test(recipient)) {
        throw new Error("ctx.email.queue: the recipient is not a deliverable address");
      }
      if (token !== undefined && !MAIL_TOKEN_RE.test(token)) {
        throw new Error("ctx.email.queue: the token must be 16–128 of A–Z a–z 0–9 _ -");
      }
      registerMailQueueOp(infra.registry);
      const r = await execute(
        infra.registry,
        publicAdapter,
        {
          actorId: plugin.pluginActorId,
          actorKind: "plugin",
          pluginId: plugin.pluginId,
          requestId: `plugin-${plugin.slug}-mail`,
        },
        MAIL_QUEUE_OP,
        { template, recipient, token: token ?? null },
      );
      if (!r.ok) {
        throw new Error(
          `ctx.email.queue: ${"message" in r.error ? String(r.error.message) : r.error.kind}`,
        );
      }
    },
  };
}
