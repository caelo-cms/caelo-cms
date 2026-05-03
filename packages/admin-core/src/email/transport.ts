// SPDX-License-Identifier: MPL-2.0

/**
 * P12 review pass — email transport factory.
 *
 * Constructs an `EmailTransport` (the shape consumed by @caelo/plugin-host's
 * `ctx.email.send`) from the singleton `email_config` row. Each transport
 * is a thin pass-through; we deliberately ship two:
 *   - `resend` — single fetch call to api.resend.com; zero deps.
 *   - `none`   — no-op stub (logs to stderr) used in dev or when Owner
 *                hasn't configured a real transport.
 *
 * SMTP + SES are listed in the migration but not implemented here; those
 * transports require a heavier dep (nodemailer / aws-sdk) and land in P15
 * cloud adapters where the dep is justified by the provisioning pipeline.
 */

import type { EmailTransport } from "@caelo/plugin-host";

export interface EmailConfigRow {
  readonly transport: "none" | "smtp" | "resend" | "ses";
  readonly fromAddress: string;
  readonly config: Record<string, unknown>;
}

export function buildEmailTransport(cfg: EmailConfigRow): EmailTransport | undefined {
  if (cfg.transport === "none") return undefined; // host falls back to stderr stub
  if (cfg.transport === "resend") return makeResendTransport(cfg);
  if (cfg.transport === "smtp") return makeUnimplementedTransport("smtp");
  if (cfg.transport === "ses") return makeUnimplementedTransport("ses");
  return undefined;
}

function makeResendTransport(cfg: EmailConfigRow): EmailTransport {
  const apiKey = (cfg.config as { apiKey?: string }).apiKey;
  if (!apiKey) {
    return makeUnimplementedTransport("resend (missing apiKey)");
  }
  return {
    send: async ({ to, subject, html, replyTo }) => {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: cfg.fromAddress,
          to: [to],
          subject,
          html,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`resend send failed (${res.status}): ${body.slice(0, 500)}`);
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { messageId: json.id ?? `resend-${Date.now()}` };
    },
  };
}

function makeUnimplementedTransport(name: string): EmailTransport {
  return {
    send: async () => {
      throw new Error(
        `email transport "${name}" is not yet implemented; configure 'resend' or 'none' under /security/email`,
      );
    },
  };
}
