// SPDX-License-Identifier: MPL-2.0

/**
 * P13 — gateway admin ops.
 *   - gateway.list_recent_requests — request log surface for /security/gateway.
 *   - gateway.rotate_cookie_secret  — Owner-only HMAC secret rotation.
 *   - gateway.set_settings           — body cap + auto-redeploy + captcha provider knobs.
 *   - gateway.get_settings           — read singleton.
 *   - gateway.set_rate_limit_override— Owner-direct override.
 *   - gateway.propose_rate_limit     — AI propose (§11.A).
 *   - gateway.list_pending_rate_limit_proposals
 *   - gateway.execute_rate_limit_proposal
 *   - gateway.reject_rate_limit_proposal
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";

const captchaProvider = z.enum(["off", "pow", "turnstile", "hcaptcha"]);

const settingsShape = z.object({
  maxBodyBytes: z.number().int().min(512).max(1_048_576),
  autoRedeployEnabled: z.boolean(),
  autoRedeployDebounceMs: z.number().int().min(1000).max(600_000),
  autoRedeployOpKinds: z.array(z.string()),
  captchaProvider,
  captchaPowTargetPrefix: z.string().regex(/^[0-9a-f]{1,16}$/),
  cookieSecretSet: z.boolean(),
  updatedAt: z.string(),
});

export const getGatewaySettingsOp = defineOperation({
  name: "gateway.get_settings",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ settings: settingsShape }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        gateway_max_body_bytes     AS max_body_bytes,
        auto_redeploy_enabled      AS auto_redeploy_enabled,
        auto_redeploy_debounce_ms  AS auto_redeploy_debounce_ms,
        auto_redeploy_op_kinds     AS auto_redeploy_op_kinds,
        captcha_provider           AS captcha_provider,
        captcha_pow_target_prefix  AS captcha_pow_target_prefix,
        gateway_cookie_secret      AS gateway_cookie_secret,
        updated_at                 AS updated_at
      FROM site_settings WHERE id = 1 LIMIT 1
    `)) as unknown as Array<{
      max_body_bytes: number;
      auto_redeploy_enabled: boolean;
      auto_redeploy_debounce_ms: number;
      auto_redeploy_op_kinds: string[];
      captcha_provider: "off" | "pow" | "turnstile" | "hcaptcha";
      captcha_pow_target_prefix: string;
      gateway_cookie_secret: string | null;
      updated_at: string | Date;
    }>;
    const r = rows[0];
    if (!r) {
      return ok({
        settings: {
          maxBodyBytes: 65536,
          autoRedeployEnabled: false,
          autoRedeployDebounceMs: 12000,
          autoRedeployOpKinds: [],
          captchaProvider: "pow" as const,
          captchaPowTargetPrefix: "000fff",
          cookieSecretSet: false,
          updatedAt: new Date(0).toISOString(),
        },
      });
    }
    return ok({
      settings: {
        maxBodyBytes: r.max_body_bytes,
        autoRedeployEnabled: r.auto_redeploy_enabled,
        autoRedeployDebounceMs: r.auto_redeploy_debounce_ms,
        autoRedeployOpKinds: r.auto_redeploy_op_kinds ?? [],
        captchaProvider: r.captcha_provider,
        captchaPowTargetPrefix: r.captcha_pow_target_prefix,
        cookieSecretSet: r.gateway_cookie_secret !== null && r.gateway_cookie_secret !== "",
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      },
    });
  },
});

export const setGatewaySettingsOp = defineOperation({
  name: "gateway.set_settings",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      maxBodyBytes: z.number().int().min(512).max(1_048_576),
      autoRedeployEnabled: z.boolean(),
      autoRedeployDebounceMs: z.number().int().min(1000).max(600_000),
      autoRedeployOpKinds: z.array(z.string().min(1).max(120)).max(50),
      captchaProvider,
      captchaPowTargetPrefix: z.string().regex(/^[0-9a-f]{1,16}$/),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    // P13 audit fix #6 — never accept `deploy.trigger` in the
    // auto-redeploy allowlist. The orchestrator fires deploy.trigger;
    // adding it would cause an infinite redeploy loop.
    if (input.autoRedeployOpKinds.includes("deploy.trigger")) {
      return err({
        kind: "HandlerError",
        operation: "gateway.set_settings",
        message:
          "auto_redeploy_op_kinds must not include 'deploy.trigger' (would cause an infinite redeploy loop)",
      });
    }
    await tx.execute(sql`
      UPDATE site_settings SET
        gateway_max_body_bytes     = ${input.maxBodyBytes},
        auto_redeploy_enabled      = ${input.autoRedeployEnabled},
        auto_redeploy_debounce_ms  = ${input.autoRedeployDebounceMs},
        auto_redeploy_op_kinds     = ${input.autoRedeployOpKinds},
        captcha_provider           = ${input.captchaProvider},
        captcha_pow_target_prefix  = ${input.captchaPowTargetPrefix},
        updated_at                 = now()
      WHERE id = 1
    `);
    // P13 audit fix #2 — propagate the new settings to every gateway.
    await tx.execute(sql`SELECT pg_notify('caelo_gateway_settings', 'set')`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "gateway.set_settings",
      input,
      succeeded: true,
      resultSummary: `captcha=${input.captchaProvider} body=${input.maxBodyBytes}`,
    });
    return ok({});
  },
});

export const rotateCookieSecretOp = defineOperation({
  name: "gateway.rotate_cookie_secret",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({}),
  handler: async (ctx, _input, tx) => {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await tx.execute(sql`
      UPDATE site_settings SET gateway_cookie_secret = ${secret}, updated_at = now() WHERE id = 1
    `);
    // P13 audit fix #2 — wake every gateway replica's LISTEN on the
    // settings channel so the cached secret invalidates immediately.
    await tx.execute(sql`SELECT pg_notify('caelo_gateway_settings', 'rotate')`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "gateway.rotate_cookie_secret",
      input: {},
      succeeded: true,
      resultSummary: "rotated",
    });
    return ok({});
  },
});

export const listGatewayRequestsOp = defineOperation({
  name: "gateway.list_recent_requests",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(500).default(100),
      pluginSlug: z.string().optional(),
      onlyErrors: z.boolean().default(false),
    })
    .strict(),
  output: z.object({
    rows: z.array(
      z.object({
        id: z.string(),
        pluginSlug: z.string(),
        operation: z.string(),
        statusCode: z.number(),
        durationMs: z.number(),
        bodyBytes: z.number(),
        wasRateLimited: z.boolean(),
        wasHoneypotCaught: z.boolean(),
        captchaPassed: z.boolean(),
        errorKind: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const filters: ReturnType<typeof sql>[] = [];
    if (input.pluginSlug) filters.push(sql`plugin_slug = ${input.pluginSlug}`);
    if (input.onlyErrors) filters.push(sql`status_code >= 400`);
    const where = filters.length === 0 ? sql.raw("") : sql`WHERE ${sql.join(filters, sql` AND `)}`;
    const limitSql = sql.raw(`LIMIT ${input.limit}`);
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, plugin_slug, operation, status_code, duration_ms,
             body_bytes, was_rate_limited, was_honeypot_caught, captcha_passed,
             error_kind, created_at
      FROM gateway_request_log
      ${where}
      ORDER BY created_at DESC
      ${limitSql}
    `)) as unknown as Array<{
      id: string;
      plugin_slug: string;
      operation: string;
      status_code: number;
      duration_ms: number;
      body_bytes: number;
      was_rate_limited: boolean;
      was_honeypot_caught: boolean;
      captcha_passed: boolean;
      error_kind: string | null;
      created_at: string | Date;
    }>;
    return ok({
      rows: rows.map((r) => ({
        id: r.id,
        pluginSlug: r.plugin_slug,
        operation: r.operation,
        statusCode: r.status_code,
        durationMs: r.duration_ms,
        bodyBytes: r.body_bytes,
        wasRateLimited: r.was_rate_limited,
        wasHoneypotCaught: r.was_honeypot_caught,
        captchaPassed: r.captcha_passed,
        errorKind: r.error_kind,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

/**
 * P13 ideas-pass — rolling-window aggregations over `gateway_request_log`
 * for the live operator dashboard.
 *
 * Returns three layers:
 *   - overall: requests, p95 ms, error count, throttled count, honeypot count
 *   - perOp:   same five stats per (plugin, op) for the top-N busiest
 *   - timeBuckets: minute-grain request counts for the last `windowSec`
 *                  so the UI can sparkline traffic
 *
 * Single SQL roundtrip; results cached in-process for 10s by callers.
 */
export const listGatewayAnalyticsOp = defineOperation({
  name: "gateway.list_analytics",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      windowSec: z.number().int().min(60).max(86400).default(3600),
      topN: z.number().int().min(1).max(50).default(10),
    })
    .strict(),
  output: z.object({
    windowSec: z.number(),
    overall: z.object({
      requests: z.number(),
      p95Ms: z.number(),
      errorCount: z.number(),
      throttledCount: z.number(),
      honeypotCount: z.number(),
    }),
    perOp: z.array(
      z.object({
        pluginSlug: z.string(),
        operation: z.string(),
        requests: z.number(),
        p95Ms: z.number(),
        errorCount: z.number(),
        throttledCount: z.number(),
      }),
    ),
    timeBuckets: z.array(
      z.object({
        bucketAt: z.string(),
        requests: z.number(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const since = sql.raw(`now() - interval '${input.windowSec} seconds'`);
    const overallRows = (await tx.execute(sql`
      SELECT
        COUNT(*)::int                                                         AS requests,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
        COUNT(*) FILTER (WHERE status_code >= 400)::int                       AS error_count,
        COUNT(*) FILTER (WHERE was_rate_limited)::int                         AS throttled_count,
        COUNT(*) FILTER (WHERE was_honeypot_caught)::int                      AS honeypot_count
      FROM gateway_request_log
      WHERE created_at > ${since}
    `)) as unknown as Array<{
      requests: number;
      p95_ms: number;
      error_count: number;
      throttled_count: number;
      honeypot_count: number;
    }>;
    const overall = overallRows[0] ?? {
      requests: 0,
      p95_ms: 0,
      error_count: 0,
      throttled_count: 0,
      honeypot_count: 0,
    };
    const perOpLimit = sql.raw(`LIMIT ${input.topN}`);
    const perOpRows = (await tx.execute(sql`
      SELECT
        plugin_slug,
        operation,
        COUNT(*)::int                                                         AS requests,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
        COUNT(*) FILTER (WHERE status_code >= 400)::int                       AS error_count,
        COUNT(*) FILTER (WHERE was_rate_limited)::int                         AS throttled_count
      FROM gateway_request_log
      WHERE created_at > ${since}
      GROUP BY plugin_slug, operation
      ORDER BY COUNT(*) DESC
      ${perOpLimit}
    `)) as unknown as Array<{
      plugin_slug: string;
      operation: string;
      requests: number;
      p95_ms: number;
      error_count: number;
      throttled_count: number;
    }>;
    // Per-minute buckets — `date_trunc` keeps PG happy; UI just plots them.
    const bucketRows = (await tx.execute(sql`
      SELECT date_trunc('minute', created_at) AS bucket_at, COUNT(*)::int AS requests
      FROM gateway_request_log
      WHERE created_at > ${since}
      GROUP BY 1
      ORDER BY 1 ASC
    `)) as unknown as Array<{ bucket_at: string | Date; requests: number }>;
    return ok({
      windowSec: input.windowSec,
      overall: {
        requests: overall.requests,
        p95Ms: overall.p95_ms,
        errorCount: overall.error_count,
        throttledCount: overall.throttled_count,
        honeypotCount: overall.honeypot_count,
      },
      perOp: perOpRows.map((r) => ({
        pluginSlug: r.plugin_slug,
        operation: r.operation,
        requests: r.requests,
        p95Ms: r.p95_ms,
        errorCount: r.error_count,
        throttledCount: r.throttled_count,
      })),
      timeBuckets: bucketRows.map((r) => ({
        bucketAt: r.bucket_at instanceof Date ? r.bucket_at.toISOString() : String(r.bucket_at),
        requests: r.requests,
      })),
    });
  },
});

export const setRateLimitOverrideOp = defineOperation({
  name: "gateway.set_rate_limit_override",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      pluginSlug: z.string().min(1).max(120),
      operation: z.string().min(1).max(120),
      perVisitorMax: z.number().int().min(1).max(100_000),
      windowSeconds: z.number().int().min(1).max(3600),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds, updated_by)
      VALUES (${input.pluginSlug}, ${input.operation}, ${input.perVisitorMax}, ${input.windowSeconds}, ${ctx.actorId}::uuid)
      ON CONFLICT (plugin_slug, operation) DO UPDATE SET
        per_visitor_max = EXCLUDED.per_visitor_max,
        window_seconds  = EXCLUDED.window_seconds,
        updated_at      = now(),
        updated_by      = EXCLUDED.updated_by
    `);
    // P13 audit re-pass — bust the gateway's per-spec cache via the
    // shared LISTEN channel so the new limit takes effect immediately
    // on every replica.
    await tx.execute(sql`SELECT pg_notify('caelo_gateway_settings', 'rate_limit')`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "gateway.set_rate_limit_override",
      input,
      succeeded: true,
      resultSummary: `${input.pluginSlug}.${input.operation}=${input.perVisitorMax}/${input.windowSeconds}s`,
    });
    return ok({});
  },
});

/**
 * §11.A propose half. AI calls this to suggest a per-(plugin, op) rate
 * limit; row lands at status='pending'; Owner approves at
 * /security/gateway/pending. AI cannot bypass this gate (executor op
 * is human+system only).
 */
export const proposeRateLimitOp = defineOperation({
  name: "gateway.propose_rate_limit",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pluginSlug: z.string().min(1).max(120),
      operation: z.string().min(1).max(120),
      proposedMax: z.number().int().min(1).max(100_000),
      proposedWindowSec: z.number().int().min(1).max(3600),
    })
    .strict(),
  output: z.object({ proposalId: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO plugin_rate_limit_proposals (
        plugin_slug, operation, proposed_max, proposed_window_sec, proposed_by
      ) VALUES (
        ${input.pluginSlug}, ${input.operation}, ${input.proposedMax},
        ${input.proposedWindowSec}, ${ctx.actorId}::uuid
      )
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (!id) {
      return err({
        kind: "HandlerError",
        operation: "gateway.propose_rate_limit",
        message: "no row returned",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "gateway.propose_rate_limit",
      input,
      succeeded: true,
      resultSummary: `proposal ${id}: ${input.pluginSlug}.${input.operation}=${input.proposedMax}/${input.proposedWindowSec}s`,
    });
    return ok({ proposalId: id });
  },
});

export const listPendingRateLimitProposalsOp = defineOperation({
  name: "gateway.list_pending_rate_limit_proposals",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    proposals: z.array(
      z.object({
        id: z.string(),
        pluginSlug: z.string(),
        operation: z.string(),
        proposedMax: z.number(),
        proposedWindowSec: z.number(),
        proposedBy: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, plugin_slug, operation, proposed_max, proposed_window_sec,
             proposed_by::text AS proposed_by, created_at
      FROM plugin_rate_limit_proposals
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 100
    `)) as unknown as Array<{
      id: string;
      plugin_slug: string;
      operation: string;
      proposed_max: number;
      proposed_window_sec: number;
      proposed_by: string;
      created_at: string | Date;
    }>;
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        pluginSlug: r.plugin_slug,
        operation: r.operation,
        proposedMax: r.proposed_max,
        proposedWindowSec: r.proposed_window_sec,
        proposedBy: r.proposed_by,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});

export const executeRateLimitProposalOp = defineOperation({
  name: "gateway.execute_rate_limit_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT plugin_slug, operation, proposed_max, proposed_window_sec, status
      FROM plugin_rate_limit_proposals
      WHERE id = ${input.proposalId}::uuid
      LIMIT 1
    `)) as unknown as Array<{
      plugin_slug: string;
      operation: string;
      proposed_max: number;
      proposed_window_sec: number;
      status: string;
    }>;
    const p = rows[0];
    if (!p) {
      return err({
        kind: "HandlerError",
        operation: "gateway.execute_rate_limit_proposal",
        message: "proposal not found",
      });
    }
    if (p.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: "gateway.execute_rate_limit_proposal",
        message: `proposal is ${p.status}, not pending`,
      });
    }
    await tx.execute(sql`
      INSERT INTO plugin_rate_limit_overrides (plugin_slug, operation, per_visitor_max, window_seconds, updated_by)
      VALUES (${p.plugin_slug}, ${p.operation}, ${p.proposed_max}, ${p.proposed_window_sec}, ${ctx.actorId}::uuid)
      ON CONFLICT (plugin_slug, operation) DO UPDATE SET
        per_visitor_max = EXCLUDED.per_visitor_max,
        window_seconds  = EXCLUDED.window_seconds,
        updated_at      = now(),
        updated_by      = EXCLUDED.updated_by
    `);
    await tx.execute(sql`
      UPDATE plugin_rate_limit_proposals
         SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
       WHERE id = ${input.proposalId}::uuid
    `);
    // P13 audit re-pass — invalidate gateway rate-limit-spec caches.
    await tx.execute(sql`SELECT pg_notify('caelo_gateway_settings', 'rate_limit')`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "gateway.execute_rate_limit_proposal",
      input,
      succeeded: true,
      resultSummary: `applied: ${p.plugin_slug}.${p.operation}`,
    });
    return ok({});
  },
});

/**
 * P13 ideas-pass — Owner-defined named rate-limit profiles.
 * One profile maps to many (plugin, op) overrides via
 * `plugin_rate_limit_overrides.profile_name`. Tightening a profile
 * updates every referencing override in one Owner action.
 */
export const listRateLimitProfilesOp = defineOperation({
  name: "gateway.list_rate_limit_profiles",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    profiles: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        perVisitorMax: z.number(),
        windowSeconds: z.number(),
        usedBy: z.number(),
        updatedAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT
        p.name, p.description, p.per_visitor_max, p.window_seconds, p.updated_at,
        COUNT(o.plugin_slug)::int AS used_by
      FROM rate_limit_profiles p
      LEFT JOIN plugin_rate_limit_overrides o ON o.profile_name = p.name
      GROUP BY p.name, p.description, p.per_visitor_max, p.window_seconds, p.updated_at
      ORDER BY p.name ASC
    `)) as unknown as Array<{
      name: string;
      description: string;
      per_visitor_max: number;
      window_seconds: number;
      used_by: number;
      updated_at: string | Date;
    }>;
    return ok({
      profiles: rows.map((r) => ({
        name: r.name,
        description: r.description,
        perVisitorMax: r.per_visitor_max,
        windowSeconds: r.window_seconds,
        usedBy: r.used_by,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      })),
    });
  },
});

export const setRateLimitProfileOp = defineOperation({
  name: "gateway.set_rate_limit_profile",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      name: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z][a-z0-9-]*$/),
      description: z.string().max(500).default(""),
      perVisitorMax: z.number().int().min(1).max(100_000),
      windowSeconds: z.number().int().min(1).max(3600),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO rate_limit_profiles (name, description, per_visitor_max, window_seconds, updated_by)
      VALUES (${input.name}, ${input.description}, ${input.perVisitorMax}, ${input.windowSeconds}, ${ctx.actorId}::uuid)
      ON CONFLICT (name) DO UPDATE SET
        description     = EXCLUDED.description,
        per_visitor_max = EXCLUDED.per_visitor_max,
        window_seconds  = EXCLUDED.window_seconds,
        updated_at      = now(),
        updated_by      = EXCLUDED.updated_by
    `);
    // Invalidate cached spec lookups so the new profile values take effect.
    await tx.execute(sql`SELECT pg_notify('caelo_gateway_settings', 'profile')`);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "gateway.set_rate_limit_profile",
      input,
      succeeded: true,
      resultSummary: `${input.name}=${input.perVisitorMax}/${input.windowSeconds}s`,
    });
    return ok({});
  },
});

export const rejectRateLimitProposalOp = defineOperation({
  name: "gateway.reject_rate_limit_proposal",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE plugin_rate_limit_proposals
         SET status = 'rejected',
             reason = ${input.reason ?? ""},
             decided_at = now(),
             decided_by = ${ctx.actorId}::uuid
       WHERE id = ${input.proposalId}::uuid
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "gateway.reject_rate_limit_proposal",
      input,
      succeeded: true,
      resultSummary: `rejected proposal ${input.proposalId}`,
    });
    return ok({});
  },
});
