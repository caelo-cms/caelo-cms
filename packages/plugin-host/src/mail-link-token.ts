// SPDX-License-Identifier: MPL-2.0

/**
 * The signed token of an unsubscribe link (issue #1432).
 *
 * A mail client's one-click unsubscribe (RFC 8058) is a POST without
 * cookies, an Origin or any way to solve a proof-of-work, so the token has
 * to be the whole proof. The host signs it, not the plugin: only a plugin's
 * declared `mailUnsubscribe` operation can be reached without a captcha,
 * and only with a token minted for that plugin, that operation and that
 * recipient. A manifest cannot open a captcha-free write by itself, and a
 * token for one recipient says nothing about another.
 *
 *   token = <recipient UUID> "_" base64url(HMAC-SHA256(key, scope))
 *
 * The key is one row per public database (`mail_link_keys`, cms_public
 * migration 0632), so the admin signs and the gateway checks without a
 * secret in either's environment. It lives there rather than beside the
 * gateway's cookie secret because it must outlive every rotation of that
 * secret: the links in sent mail do not expire. The gateway can read it, so
 * a compromised public side could forge a token, which lets it do what it
 * could do anyway: mark a row of its own database unsubscribed. The admin
 * reads the key from that side and uses it for this token only, so a
 * replaced key could not make the admin sign anything else.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { MAIL_UNSUBSCRIBE_TOKEN_RE } from "@caelo-cms/plugin-sdk";
import {
  defineOperation,
  execute,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

const MAIL_LINK_KEY_OP = "plugin_mail.link_key";

const linkKeyOp = defineOperation({
  name: MAIL_LINK_KEY_OP,
  readScope: "request",
  // Why plugin-only: the host reads the key on a plugin's behalf, to sign
  // or check that plugin's token; no other actor has a use for it.
  actorScope: ["plugin"],
  database: "cms_public",
  input: z.object({}).strict(),
  output: z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT encode(key, 'hex') AS key FROM mail_link_keys WHERE id = 1`,
    )) as unknown as { key: string }[];
    const key = rows[0]?.key;
    if (!key) {
      return err({
        kind: "HandlerError",
        operation: MAIL_LINK_KEY_OP,
        message: `${MAIL_LINK_KEY_OP}: mail_link_keys has no key; run the cms_public migrations (0632 seeds it)`,
      });
    }
    return ok({ key });
  },
});

function registerLinkKeyOp(registry: OperationRegistry): void {
  if (!registry.has(MAIL_LINK_KEY_OP)) {
    registry.register(linkKeyOp as unknown as OperationDefinition<unknown, unknown>);
  }
}

/** The key of the public database `infra.adapter` reaches: one primary-key read, not cached. */
async function linkKey(plugin: LoadedPlugin, infra: PluginHostInfra): Promise<Buffer> {
  registerLinkKeyOp(infra.registry);
  const r = await execute(
    infra.registry,
    infra.adapter,
    {
      actorId: plugin.pluginActorId,
      actorKind: "plugin",
      pluginId: plugin.pluginId,
      requestId: `plugin-${plugin.slug}-mail-link`,
    },
    MAIL_LINK_KEY_OP,
    {},
  );
  if (!r.ok) {
    throw new Error(
      `mail link key: ${"message" in r.error ? String(r.error.message) : r.error.kind}`,
    );
  }
  return Buffer.from((r.value as { key: string }).key, "hex");
}

/** The signature of a token: what it is for and whom, under the key. */
function signature(key: Buffer, plugin: LoadedPlugin, recipientId: string): string {
  const operation = plugin.definition.mailUnsubscribe?.operation;
  return createHmac("sha256", key)
    .update(`caelo-mail-unsubscribe\0${plugin.slug}\0${operation}\0${recipientId}`)
    .digest("base64url");
}

/**
 * The unsubscribe token of one recipient of `plugin`.
 *
 * @param recipientId a lower-case UUID the plugin finds the recipient by.
 */
export async function signMailUnsubscribeToken(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  recipientId: string,
): Promise<string> {
  const token = `${recipientId}_${signature(await linkKey(plugin, infra), plugin, recipientId)}`;
  if (!MAIL_UNSUBSCRIBE_TOKEN_RE.test(token)) {
    throw new Error("ctx.email.unsubscribeLink: recipientId must be a lower-case UUID");
  }
  return token;
}

/**
 * Whether `token` is one the host signed for `plugin`'s unsubscribe
 * operation. A value of any other shape is refused before the key is read.
 */
export async function verifyMailUnsubscribeToken(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  token: unknown,
): Promise<boolean> {
  if (typeof token !== "string" || !MAIL_UNSUBSCRIBE_TOKEN_RE.test(token)) return false;
  const given = Buffer.from(token.slice(37));
  const expected = Buffer.from(signature(await linkKey(plugin, infra), plugin, token.slice(0, 36)));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Why a visitor call of the unsubscribe operation may not run, or null when
 * its token is signed. Never throws: dispatch answers with a Result, and a
 * key that cannot be read is an operation failure, not an invalid link.
 */
export async function refuseMailUnsubscribeCall(
  plugin: LoadedPlugin,
  infra: PluginHostInfra | null,
  args: unknown,
): Promise<{ kind: "Rejected" | "OperationFailed"; message: string } | null> {
  if (!infra) return { kind: "OperationFailed", message: "plugin host not bootstrapped" };
  try {
    const token =
      args !== null && typeof args === "object" ? (args as { token?: unknown }).token : "";
    return (await verifyMailUnsubscribeToken(plugin, infra, token))
      ? null
      : { kind: "Rejected", message: "this unsubscribe link is invalid" };
  } catch (e) {
    return { kind: "OperationFailed", message: (e as Error).message };
  }
}
