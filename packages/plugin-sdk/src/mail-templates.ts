// SPDX-License-Identifier: MPL-2.0

/**
 * Mail templates a plugin may queue (issue #1337, epic #763 M7, E12).
 *
 * A plugin that mails visitors (a double opt-in, a password reset) does
 * not send mail itself on the public side: the public gateway has no
 * mail transport and must not hold one. Its operation queues a row in the
 * public database's mail outbox naming one of these templates, a
 * recipient and at most one token; the admin drains the outbox and sends
 * the mail with the site's transport.
 *
 * The outbox is attacker-writable (docs/dev/public-admin-boundary.md), so
 * everything a recipient reads comes from here, from the plugin's signed
 * manifest as the admin loaded it, and from cms_admin: the subject, the
 * paragraphs, the link's label and target operation, and the link's host.
 * A row only chooses which declared template, to whom, and a token of a
 * fixed charset that becomes part of the link's query string. It cannot
 * add text, a link or a host.
 *
 * The link opens the gateway's confirmation page
 * (`/api/_caelo/mail-link/<slug>/<operation>?token=…`), which asks the
 * recipient to click (plus the declared `fields`, e.g. a new password)
 * and then calls the public operation with `{ token, …fields }`. A GET
 * never changes anything, so a mail scanner that opens links confirms
 * nothing.
 *
 * @example
 * ```ts
 * definePlugin({
 *   slug: "newsletter", requires: ["email"], requestedCapabilities: ["email"],
 *   mailTemplates: {
 *     confirm_subscription: {
 *       subject: "Confirm your newsletter subscription",
 *       body: ["Please confirm that you want to receive our newsletter."],
 *       link: { operation: "confirm", label: "Confirm subscription", done: "You are subscribed." },
 *     },
 *   },
 *   operations: {
 *     subscribe: async (ctx, args) => {
 *       await ctx.email?.queue({ template: "confirm_subscription", to: email, token });
 *       return { awaitingConfirm: true };
 *     },
 *   },
 * });
 * ```
 */

import { z } from "zod";

/** A template's name: what an outbox row names (`mail_outbox.template`). */
export const MAIL_TEMPLATE_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** A token an outbox row may carry; mirrored by `mail_outbox.token`'s CHECK. */
export const MAIL_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** A recipient address an outbox row may carry; mirrored by `mail_outbox.recipient`'s CHECK. */
export const MAIL_RECIPIENT_RE =
  /^[^\s@<>",;:\\()[\]]+@[^\s@<>",;:\\()[\]]+\.[^\s@<>",;:\\()[\]]+$/;

/** The longest recipient address (RFC 5321 path limit). */
export const MAIL_RECIPIENT_MAX = 254;

const fieldName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);

/** A field the confirmation page asks for before it calls the operation. */
export const mailLinkField = z
  .object({
    /** The operation's input key the value is sent as. */
    name: fieldName,
    label: z.string().min(1).max(80),
    /** Only passwords: anything else would be content the visitor writes. */
    type: z.literal("password"),
  })
  .strict();

/** The link of a template: what the recipient confirms. */
export const mailTemplateLink = z
  .object({
    /** A public `write` operation of the plugin whose input takes `token`. */
    operation: z.string().regex(/^[a-z_][a-z0-9_]{0,119}$/),
    /** The link text in the mail and the button on the confirmation page. */
    label: z.string().min(1).max(80),
    /** What the confirmation page says once the operation succeeded. */
    done: z.string().min(1).max(200),
    fields: z.array(mailLinkField).max(4).optional(),
  })
  .strict();

/** One mail a plugin may queue. Plain text only; the admin renders it. */
export const pluginMailTemplate = z
  .object({
    subject: z.string().min(1).max(200),
    /** Paragraphs, rendered as escaped text. */
    body: z.array(z.string().min(1).max(1000)).min(1).max(10),
    link: mailTemplateLink.optional(),
  })
  .strict();

/** One mail a plugin may queue. */
export type PluginMailTemplate = z.infer<typeof pluginMailTemplate>;

/** Template name → template. */
export const pluginMailTemplates = z
  .record(z.string().regex(MAIL_TEMPLATE_NAME_RE), pluginMailTemplate)
  .refine((t) => Object.keys(t).length <= 16, "at most 16 mail templates");

/** Template name → template. */
export type PluginMailTemplates = z.infer<typeof pluginMailTemplates>;

/**
 * The manifest checks of the mail templates: a plugin that queues mail
 * says it needs a transport, and every link targets one of its public
 * write operations that takes the token and each declared field.
 */
export function checkMailTemplates(
  m: {
    readonly mailTemplates?: PluginMailTemplates;
    readonly requires?: ReadonlyArray<string>;
    readonly requestedCapabilities?: ReadonlyArray<string>;
    readonly publicOperations?: ReadonlyArray<{
      readonly name: string;
      readonly kind: string;
      readonly inputJsonSchema: Record<string, unknown>;
    }>;
  },
  addIssue: (path: (string | number)[], message: string) => void,
): void {
  const templates = m.mailTemplates ?? {};
  if (Object.keys(templates).length === 0) return;
  if (!(m.requires ?? []).includes("email")) {
    addIssue(["mailTemplates"], 'a plugin with mail templates must declare requires: ["email"]');
  }
  if (!(m.requestedCapabilities ?? []).includes("email")) {
    addIssue(["mailTemplates"], 'a plugin with mail templates must request the "email" capability');
  }
  for (const [name, t] of Object.entries(templates)) {
    if (!t.link) continue;
    const op = (m.publicOperations ?? []).find((o) => o.name === t.link?.operation);
    if (op?.kind !== "write") {
      addIssue(
        ["mailTemplates", name, "link", "operation"],
        `the link of mail template "${name}" must target a public write operation; "${t.link.operation}" is none`,
      );
      continue;
    }
    const props = (op.inputJsonSchema.properties ?? {}) as Record<string, unknown>;
    for (const key of ["token", ...(t.link.fields ?? []).map((f) => f.name)]) {
      if (!(key in props)) {
        addIssue(
          ["mailTemplates", name, "link"],
          `public operation "${op.name}" does not take "${key}", which the link of mail template "${name}" sends`,
        );
      }
    }
  }
}

/**
 * The gateway path of a template link's confirmation page. The admin
 * puts the environment's host in front of it; the token is the query.
 */
export function mailLinkPath(slug: string, operation: string): string {
  return `/api/_caelo/mail-link/${slug}/${operation}`;
}
