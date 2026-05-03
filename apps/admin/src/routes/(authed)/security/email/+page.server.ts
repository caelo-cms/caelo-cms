// SPDX-License-Identifier: MPL-2.0

/**
 * P12 review pass — Owner-only email transport config.
 * Edits the singleton `email_config` row consumed by hooks.server at
 * boot to build the plugin host's `ctx.email.send` transport. SMTP +
 * SES are placeholders today; resend + none are fully wired.
 */

import { buildEmailTransport, type EmailConfigRow } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "email_config.get", {});
  if (!r.ok) {
    return {
      config: {
        transport: "none" as const,
        fromAddress: "",
        config: {} as Record<string, unknown>,
        updatedAt: new Date(0).toISOString(),
      },
      error: r.error.kind,
    };
  }
  return {
    config: (
      r.value as {
        config: {
          transport: "none" | "smtp" | "resend" | "ses";
          fromAddress: string;
          config: Record<string, unknown>;
          updatedAt: string;
        };
      }
    ).config,
    error: null,
  };
};

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const transport = form.get("transport");
    const fromAddress = form.get("fromAddress");
    const apiKey = form.get("apiKey");
    const smtpHost = form.get("smtpHost");
    const smtpPort = form.get("smtpPort");
    const smtpUser = form.get("smtpUser");
    const smtpPass = form.get("smtpPass");
    const smtpSecure = form.get("smtpSecure") === "on";
    if (typeof transport !== "string" || !["none", "smtp", "resend", "ses"].includes(transport)) {
      return fail(400, { error: "transport must be one of none/smtp/resend/ses" });
    }
    let cfg: Record<string, unknown> = {};
    if (transport === "resend") {
      if (typeof apiKey !== "string" || apiKey.length < 8) {
        return fail(400, { error: "Resend API key required" });
      }
      cfg = { apiKey };
    } else if (transport === "smtp") {
      const portNum = Number.parseInt(typeof smtpPort === "string" ? smtpPort : "0", 10);
      if (typeof smtpHost !== "string" || smtpHost.length === 0 || Number.isNaN(portNum)) {
        return fail(400, { error: "SMTP host + port required" });
      }
      cfg = {
        host: smtpHost,
        port: portNum,
        secure: smtpSecure,
        ...(typeof smtpUser === "string" && smtpUser ? { user: smtpUser } : {}),
        ...(typeof smtpPass === "string" && smtpPass ? { pass: smtpPass } : {}),
      };
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "email_config.set", {
      transport,
      fromAddress: typeof fromAddress === "string" ? fromAddress : "",
      config: cfg,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Email config saved. Restart admin process to take effect." };
  },
  testSend: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const to = form.get("to");
    if (typeof to !== "string" || !to.includes("@")) {
      return fail(400, { error: "Provide a valid 'to' address." });
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "email_config.get", {});
    if (!r.ok) return fail(500, { error: `Could not load email config: ${r.error.kind}` });
    const cfg = (r.value as { config: EmailConfigRow }).config;
    if (cfg.transport === "none") {
      return fail(400, {
        error: "Transport is `none` — sends are no-ops. Pick `resend` and save before testing.",
      });
    }
    const transport = buildEmailTransport(cfg);
    if (!transport) {
      return fail(400, {
        error: "Transport not implemented (SMTP/SES land in P15). Pick `resend`.",
      });
    }
    try {
      const result = await transport.send({
        to,
        subject: "Caelo email transport test",
        html: "<p>If you're reading this, the configured transport works.</p>",
      });
      return { ok: true, message: `Sent test email (id ${result.messageId}).` };
    } catch (e) {
      return fail(500, { error: `Send failed: ${(e as Error).message}` });
    }
  },
};
