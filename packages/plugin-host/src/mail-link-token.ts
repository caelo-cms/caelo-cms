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
 * The admin creates and holds the key in cms_admin (`site_settings`,
 * migration 0635) and signs with it; each environment has its own. It
 * publishes that key one way into `published_gateway_settings`, and the
 * gateway checks with the published copy, so the admin never reads it from
 * the public side. It is not the cookie secret because that rotates and the
 * links in sent mail do not expire. A compromised public side can read its
 * copy and forge a token, which lets it do what it could do anyway: mark a
 * row of its own database unsubscribed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { MAIL_UNSUBSCRIBE_TOKEN_RE } from "@caelo-cms/plugin-sdk";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";

/** This side's key (cms_admin, or the gateway's published copy), or a loud error. */
async function linkKey(infra: PluginHostInfra): Promise<Buffer> {
  const key = (await infra.mailLinks?.())?.key;
  if (!key || !/^[0-9a-f]{64}$/.test(key)) {
    throw new Error(
      "mail link key: no valid signing key here; run the database migrations (cms_admin 0635 creates it, the run publishes it)",
    );
  }
  return Buffer.from(key, "hex");
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
  const token = `${recipientId}_${signature(await linkKey(infra), plugin, recipientId)}`;
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
  const expected = Buffer.from(signature(await linkKey(infra), plugin, token.slice(0, 36)));
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
