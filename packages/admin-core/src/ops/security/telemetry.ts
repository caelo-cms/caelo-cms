// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — opt-in telemetry settings. Off by default; the Owner toggles
 * `install_ping_enabled` and `error_reporting_enabled` from
 * `/security/ai/telemetry`. The first time either flag flips on, the op
 * mints a stable `install_id` UUID — never sent before opt-in.
 *
 * The `telemetry.test_send` op constructs the payload that WOULD be sent
 * and returns it as JSON so the Owner can audit what gets transmitted
 * before opting in. No actual outbound HTTP call until P17 wires the
 * collector endpoint.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";

const telemetrySettings = z.object({
  installPingEnabled: z.boolean(),
  errorReportingEnabled: z.boolean(),
  installId: z.string().nullable(),
  eventsSentCount: z.number().int().nonnegative(),
  lastSentAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const getTelemetryOp = defineOperation({
  name: "telemetry.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: telemetrySettings,
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT install_ping_enabled, error_reporting_enabled, install_id::text AS install_id,
             events_sent_count, last_sent_at, updated_at
      FROM telemetry_settings WHERE id = 1
    `)) as unknown as Array<{
      install_ping_enabled: boolean;
      error_reporting_enabled: boolean;
      install_id: string | null;
      events_sent_count: number | string | bigint;
      last_sent_at: string | Date | null;
      updated_at: string | Date;
    }>;
    const r = rows[0];
    if (!r) {
      return ok({
        installPingEnabled: false,
        errorReportingEnabled: false,
        installId: null,
        eventsSentCount: 0,
        lastSentAt: null,
        updatedAt: new Date(0).toISOString(),
      });
    }
    const toN = (v: number | string | bigint): number =>
      typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number.parseInt(v, 10) : v;
    return ok({
      installPingEnabled: r.install_ping_enabled,
      errorReportingEnabled: r.error_reporting_enabled,
      installId: r.install_id,
      eventsSentCount: toN(r.events_sent_count),
      lastSentAt: r.last_sent_at instanceof Date ? r.last_sent_at.toISOString() : r.last_sent_at,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    });
  },
});

export const setTelemetryOp = defineOperation({
  name: "telemetry.set",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      installPingEnabled: z.boolean(),
      errorReportingEnabled: z.boolean(),
    })
    .strict(),
  output: z.object({ installId: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    // Mint install_id the FIRST time either flag flips on. Doing it here
    // (not in the migration) keeps the "never sent before opt-in" promise:
    // a fresh install with both flags false carries no identifying token.
    const anyEnabled = input.installPingEnabled || input.errorReportingEnabled;
    const cur = (await tx.execute(sql`
      SELECT install_id::text AS install_id FROM telemetry_settings WHERE id = 1
    `)) as unknown as Array<{ install_id: string | null }>;
    const existing = cur[0]?.install_id ?? null;
    const installIdSql = existing
      ? sql`${existing}::uuid`
      : anyEnabled
        ? sql`gen_random_uuid()`
        : sql`NULL::uuid`;
    await tx.execute(sql`
      UPDATE telemetry_settings
        SET install_ping_enabled = ${input.installPingEnabled},
            error_reporting_enabled = ${input.errorReportingEnabled},
            install_id = ${installIdSql},
            updated_at = now()
      WHERE id = 1
    `);
    const after = (await tx.execute(sql`
      SELECT install_id::text AS install_id FROM telemetry_settings WHERE id = 1
    `)) as unknown as Array<{ install_id: string | null }>;
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      operation: "telemetry.set",
      input,
      succeeded: true,
      resultSummary: `install_ping=${input.installPingEnabled} error_reporting=${input.errorReportingEnabled}`,
      requestId: ctx.requestId,
    });
    return ok({ installId: after[0]?.install_id ?? null });
  },
});

/**
 * Print-the-payload helper. Returns the JSON that WOULD be sent to the
 * collector — no outbound HTTP call. Owner uses this from
 * `/security/ai/telemetry` to audit before opting in.
 */
export const testSendTelemetryOp = defineOperation({
  name: "telemetry.test_send",
  // v0.2.19 — pure preview op (no outbound HTTP, returns the payload
  // that WOULD be sent so the Owner can audit). Safe for AI to call
  // when the operator asks "what does telemetry actually send".
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    payload: z.record(z.string(), z.unknown()),
  }),
  handler: async (_ctx, _input, tx) => {
    // Aggregate counts for the test payload — same shape the real
    // collector would receive.
    const stats = (await tx.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL) AS pages,
        (SELECT COUNT(*) FROM modules WHERE deleted_at IS NULL) AS modules,
        (SELECT COUNT(*) FROM plugins WHERE status = 'active') AS active_plugins,
        (SELECT COALESCE(SUM(cost_estimate_microcents), 0) FROM ai_calls
          WHERE created_at > now() - interval '30 days')::bigint AS ai_spend_30d_microcents
    `)) as unknown as Array<{
      pages: number | string;
      modules: number | string;
      active_plugins: number | string;
      ai_spend_30d_microcents: bigint | string | number;
    }>;
    const settings = (await tx.execute(sql`
      SELECT install_id::text AS install_id FROM telemetry_settings WHERE id = 1
    `)) as unknown as Array<{ install_id: string | null }>;
    const toN = (v: number | string | bigint): number =>
      typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number.parseInt(v, 10) : v;
    const s = stats[0];
    return ok({
      payload: {
        kind: "test",
        installId: settings[0]?.install_id ?? "<not yet minted>",
        emittedAt: new Date().toISOString(),
        // Only counts; never page/module content, never user data, never
        // raw error stacks.
        counts: {
          pages: s ? toN(s.pages) : 0,
          modules: s ? toN(s.modules) : 0,
          activePlugins: s ? toN(s.active_plugins) : 0,
          aiSpend30dMicrocents: s ? toN(s.ai_spend_30d_microcents) : 0,
        },
      },
    });
  },
});
