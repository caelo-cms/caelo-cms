// SPDX-License-Identifier: MPL-2.0

/**
 * The drain of the public mail outboxes (issue #1337, epic #763 M7, E12).
 *
 * The public gateways queue mail (`ctx.email.queue`) into their own
 * database's `mail_outbox` and hold no transport. On every scheduler tick
 * (`core:mail-outbox`) the admin drains each public database — live, then
 * staging — and sends what passes through the site's configured transport.
 *
 * Every outbox row is attacker-writable (docs/dev/public-admin-boundary.md),
 * so the drain decides everything a recipient reads from trusted state:
 *
 * - the row is validated (`parseUntrustedRows`) and names a plugin this
 *   admin loaded and runs, and one of that plugin's `mailTemplates`;
 * - subject, text and link label come from that template (the signed
 *   manifest as the admin loaded it); the row only adds a token of a fixed
 *   charset to the link's query;
 * - the link's origin comes from cms_admin: the site's base URL on live,
 *   the staging host on staging (`public_mail_deliveries.reserve_many`);
 * - on staging only addresses of cms_admin users are mailed (#1330 → here);
 * - the per-recipient and site-wide caps count a ledger in cms_admin, so a
 *   forged outbox gets no more delivered than the caps;
 * - a row older than {@link MAIL_OUTBOX_TTL_MINUTES} is dropped: the
 *   tokens it carries are short-lived, and a mail an hour late confuses.
 *
 * A row is taken out of the outbox when it is read (deleted in the claim),
 * so no mail is sent twice; a transport failure is recorded and the mail is
 * not retried (the visitor asks again). Nothing is logged with an address.
 */

import { createHash } from "node:crypto";
import { isPluginDisabled, loadedPlugins } from "@caelo-cms/plugin-host";
import {
  MAIL_RECIPIENT_MAX,
  MAIL_RECIPIENT_RE,
  MAIL_TEMPLATE_NAME_RE,
  MAIL_TOKEN_RE,
  mailLinkPath,
  type PluginMailTemplate,
} from "@caelo-cms/plugin-sdk";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { MAIL_OUTBOX_CLAIM_MAX } from "../ops/mail_outbox.js";
import { parseUntrustedRows, untrustedTimestamp } from "../untrusted/public-data.js";
import { buildEmailTransport, type EmailConfigRow, emailDeliveryProblem } from "./transport.js";

/** A queued mail older than this is dropped instead of sent. */
export const MAIL_OUTBOX_TTL_MINUTES = 60;

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mail-outbox",
};

/** An outbox row as it may legitimately look (mirrors cms_public 0610's CHECKs). */
const outboxRow = z
  .object({
    id: z.string().regex(/^[0-9]{1,19}$/),
    plugin_id: z.string().uuid(),
    template: z.string().regex(MAIL_TEMPLATE_NAME_RE),
    recipient: z.string().max(MAIL_RECIPIENT_MAX).regex(MAIL_RECIPIENT_RE),
    token: z.string().regex(MAIL_TOKEN_RE).nullable(),
    created_at: untrustedTimestamp,
  })
  .strict();

type OutboxRow = z.infer<typeof outboxRow>;

/** What one environment's drain did, in counts (no addresses). */
export interface OutboxDrainReport {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  /** Dropped before any cap: invalid, unknown plugin or template, expired. */
  readonly invalid: number;
  readonly expired: number;
  /** Refused by a rule: staging non-team address, a cap, no link origin. */
  readonly refused: Readonly<Record<string, number>>;
}

/** The public databases the drain reads, live first. */
export interface OutboxTargets {
  readonly live: DatabaseAdapter;
  /** cms_public_staging; null in tooling without one. */
  readonly staging: DatabaseAdapter | null;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** SHA-256 of the normalised address: how the caps count a recipient. */
export function recipientHash(recipient: string): string {
  return createHash("sha256").update(recipient.normalize("NFC").trim().toLowerCase()).digest("hex");
}

/**
 * The mail of one template. Plain text paragraphs escaped; the link (when
 * the template has one) is `<origin>/api/_caelo/mail-link/<slug>/<op>` with
 * the token as its only query parameter.
 */
export function renderOutboxMail(opts: {
  readonly slug: string;
  readonly template: PluginMailTemplate;
  readonly token: string | null;
  readonly linkOrigin: string | null;
  readonly environment: "live" | "staging";
}): { subject: string; html: string } | { problem: string } {
  const { template } = opts;
  const parts = template.body.map((p) => `<p>${escapeHtml(p)}</p>`);
  if (template.link) {
    if (!opts.token) return { problem: "the template links, but the row carries no token" };
    if (!opts.linkOrigin) return { problem: "no link origin" };
    const url = `${opts.linkOrigin}${mailLinkPath(opts.slug, template.link.operation)}?token=${encodeURIComponent(opts.token)}`;
    parts.push(`<p><a href="${escapeHtml(url)}">${escapeHtml(template.link.label)}</a></p>`);
    parts.push(
      `<p style="font-size:12px">If the link does not open, copy this address into your browser:<br>${escapeHtml(url)}</p>`,
    );
  }
  if (opts.environment === "staging") {
    parts.push(
      `<p style="font-size:12px">Sent from the staging site: only members of the site's team receive it.</p>`,
    );
  }
  return {
    subject: opts.environment === "staging" ? `[Staging] ${template.subject}` : template.subject,
    html: parts.join("\n"),
  };
}

/** The template a valid row names, if a running plugin declares it. */
function templateOf(row: OutboxRow): { slug: string; template: PluginMailTemplate } | null {
  const plugin = loadedPlugins.byId(row.plugin_id);
  if (!plugin || isPluginDisabled(plugin.slug)) return null;
  const templates = plugin.definition.mailTemplates ?? {};
  if (!Object.hasOwn(templates, row.template)) return null;
  const template = templates[row.template];
  return template ? { slug: plugin.slug, template } : null;
}

async function run<T>(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  op: string,
  input: unknown,
): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM_CTX, op, input);
  if (!r.ok) throw new Error(`${op}: ${"message" in r.error ? r.error.message : r.error.kind}`);
  return r.value as T;
}

async function loadEmailConfig(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
): Promise<EmailConfigRow> {
  const v = await run<{ config: EmailConfigRow }>(registry, adapter, "email_config.get", {});
  return {
    transport: v.config.transport,
    fromAddress: v.config.fromAddress,
    config: v.config.config,
  };
}

/**
 * Drain one public database's outbox once: up to {@link MAIL_OUTBOX_CLAIM_MAX}
 * rows. Returns counts only.
 */
export async function drainOutboxOnce(opts: {
  readonly registry: OperationRegistry;
  /** The admin's adapter (cms_admin: caps, users, link origin, transport). */
  readonly adapter: DatabaseAdapter;
  /** The public database to drain. */
  readonly publicAdapter: DatabaseAdapter;
  readonly environment: "live" | "staging";
  readonly now?: Date;
}): Promise<OutboxDrainReport> {
  const { registry, adapter, environment } = opts;
  const cfg = await loadEmailConfig(registry, adapter);
  const problem = emailDeliveryProblem(cfg);
  const transport = problem === null ? buildEmailTransport(cfg) : undefined;
  const refused: Record<string, number> = {};
  const count = (why: string) => {
    refused[why] = (refused[why] ?? 0) + 1;
  };
  if (!transport) {
    // Nothing is taken out of the outbox: rows wait (and expire) until a
    // transport exists. A plugin that queues mail cannot be activated
    // without one (`requires: ["email"]`), and the transport cannot be
    // switched off while such a plugin runs (email_config.set), so mail
    // waiting here means the transport broke — loud, on the task's row.
    const peek = await run<{ pending: boolean; expired: number }>(
      registry,
      opts.publicAdapter,
      "mail_outbox.claim",
      { limit: 0, ttlMinutes: MAIL_OUTBOX_TTL_MINUTES },
    );
    if (peek.pending) {
      throw new Error(
        `${environment} mail is queued but cannot be sent: ${problem ?? "no transport"} — set one up at Settings → Email`,
      );
    }
    return { claimed: 0, sent: 0, failed: 0, invalid: 0, expired: peek.expired, refused };
  }

  const claimed = await run<{ rows: unknown[]; expired: number }>(
    registry,
    opts.publicAdapter,
    "mail_outbox.claim",
    { limit: MAIL_OUTBOX_CLAIM_MAX, ttlMinutes: MAIL_OUTBOX_TTL_MINUTES },
  );
  const { rows, dropped } = parseUntrustedRows(
    `mail_outbox (${environment})`,
    outboxRow,
    claimed.rows,
  );
  const now = (opts.now ?? new Date()).getTime();
  let invalid = dropped;
  let expired = claimed.expired;
  const candidates: Array<{ row: OutboxRow; slug: string; template: PluginMailTemplate }> = [];
  for (const row of rows) {
    if (now - new Date(row.created_at).getTime() > MAIL_OUTBOX_TTL_MINUTES * 60_000) {
      expired += 1;
      continue;
    }
    const found = templateOf(row);
    if (!found) {
      invalid += 1;
      continue;
    }
    candidates.push({ row, ...found });
  }

  let sent = 0;
  let failed = 0;
  if (candidates.length > 0) {
    const reserved = await run<{
      decisions: Array<{ deliveryId: string } | { refused: string }>;
      linkOrigin: string | null;
    }>(registry, adapter, "public_mail_deliveries.reserve_many", {
      environment,
      mails: candidates.map((c) => ({
        recipient: c.row.recipient.normalize("NFC").trim().toLowerCase(),
        recipientHash: recipientHash(c.row.recipient),
        pluginId: c.row.plugin_id,
        template: c.row.template,
      })),
    });
    const outcomes: Array<{
      deliveryId: string;
      outcome: "sent" | "failed";
      messageId: string | null;
    }> = [];
    for (const [i, c] of candidates.entries()) {
      const decision = reserved.decisions[i];
      if (!decision || "refused" in decision) {
        count(decision?.refused ?? "no_decision");
        continue;
      }
      const mail = renderOutboxMail({
        slug: c.slug,
        template: c.template,
        token: c.row.token,
        linkOrigin: reserved.linkOrigin,
        environment,
      });
      if ("problem" in mail) {
        count(mail.problem === "no link origin" ? "no_link_origin" : "no_token");
        outcomes.push({ deliveryId: decision.deliveryId, outcome: "failed", messageId: null });
        continue;
      }
      try {
        const r = await transport.send({
          to: c.row.recipient,
          subject: mail.subject,
          html: mail.html,
        });
        sent += 1;
        outcomes.push({
          deliveryId: decision.deliveryId,
          outcome: "sent",
          messageId: r.messageId.slice(0, 200),
        });
      } catch (e) {
        failed += 1;
        // The transport's words, never the address.
        console.error(
          `[mail-outbox] ${environment}: ${c.slug}.${c.row.template} not sent: ${(e as Error).message.slice(0, 300)}`,
        );
        outcomes.push({ deliveryId: decision.deliveryId, outcome: "failed", messageId: null });
      }
    }
    if (outcomes.length > 0) {
      await run(registry, adapter, "public_mail_deliveries.finish_many", { outcomes });
    }
  }
  return { claimed: claimed.rows.length, sent, failed, invalid, expired, refused };
}

/** One line for the scheduler's task row, or undefined when nothing happened. */
export function describeDrain(
  reports: Readonly<Record<string, OutboxDrainReport>>,
): string | undefined {
  const parts: string[] = [];
  for (const [env, r] of Object.entries(reports)) {
    if (r.claimed === 0 && r.expired === 0) continue;
    const refusedText = Object.entries(r.refused)
      .map(([why, n]) => `${n} ${why}`)
      .join(", ");
    parts.push(
      `${env}: ${r.sent} sent, ${r.failed} failed, ${r.invalid} invalid, ${r.expired} expired${refusedText ? `, refused ${refusedText}` : ""}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * Drain every public outbox once (the `core:mail-outbox` task). A
 * database whose outbox is empty costs one claim. A missing link origin is
 * reported loudly: the mails it refused carried links nobody could open.
 */
export async function drainPublicOutboxes(opts: {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly targets: OutboxTargets;
}): Promise<Record<string, OutboxDrainReport>> {
  const reports: Record<string, OutboxDrainReport> = {};
  const envs: Array<["live" | "staging", DatabaseAdapter | null]> = [
    ["live", opts.targets.live],
    ["staging", opts.targets.staging],
  ];
  for (const [environment, publicAdapter] of envs) {
    if (!publicAdapter) continue;
    reports[environment] = await drainOutboxOnce({
      registry: opts.registry,
      adapter: opts.adapter,
      publicAdapter,
      environment,
    });
  }
  return reports;
}
