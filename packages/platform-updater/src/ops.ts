// SPDX-License-Identifier: MPL-2.0

/**
 * The update jobs' Query API ops (epic #696, #819). Registered only in
 * the jobs' own registry, run as a `system` actor over the
 * `platform_updater` database role (migration 0267): that role can read
 * requests and the policy, move a request through its run columns, append
 * events, set the policy's pause and write its own audit rows — which is
 * exactly what these ops do. Two jobs use them, each for its own route
 * (`platform_update_requests.route`, migration 0318): the upgrader job and
 * the self-hosted agent claim `app_roll` requests, the converge job
 * `converge` ones. The admin's ops (request, cancel, list, get, policy)
 * live in admin-core.
 */

import { defineOperation, recordAudit, SYSTEM_ACTOR_ID, textArray } from "@caelo-cms/query-api";
import {
  AUTO_UPDATE_BASES,
  type AutoUpdateBasis,
  ok,
  PLATFORM_UPDATE_EVENT_LEVELS,
  PLATFORM_UPDATE_EVENT_MAX,
  PLATFORM_UPDATE_PHASES,
  PLATFORM_UPDATE_ROUTES,
  PLATFORM_UPDATE_STALE_MINUTES,
  PLATFORM_UPDATE_STALE_REASON,
  PLATFORM_UPDATE_TRIGGERS,
  type StoredUpdatePolicy,
  UPDATE_POLICY_CHANNELS,
  UPDATE_POLICY_MODES,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

const policySchema = z.object({
  mode: z.enum(UPDATE_POLICY_MODES),
  autoSecurity: z.boolean(),
  autoPatch: z.boolean(),
  autoMinor: z.boolean(),
  autoConverge: z.boolean(),
  channel: z.enum(UPDATE_POLICY_CHANNELS),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  windowTimezone: z.string(),
  soakHours: z.number(),
  securitySoakHours: z.number(),
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  pausedAt: z.string().nullable(),
  pausedUntil: z.string().nullable(),
  pausedByOwner: z.boolean(),
  updatedAt: z.string(),
});

const claimOutput = z.object({
  /** Requests a dead run left `running`, now ended as failed. */
  recovered: z.array(z.string()),
  claimed: z
    .object({
      id: z.string(),
      targetVersion: z.string(),
      trigger: z.enum(PLATFORM_UPDATE_TRIGGERS),
      autoBasis: z.enum(AUTO_UPDATE_BASES).nullable(),
      policy: policySchema,
      /**
       * The request was already running (converge route only): a stage-1
       * run handed it over, or a run that died left it to be continued.
       */
      resume: z.boolean(),
      /** The execution the request names now. */
      execution: z.string().nullable(),
    })
    .nullable(),
});

export const jobClaimOp = defineOperation({
  name: "platform_updates.job_claim",
  readScope: "request",
  // Why system-only: an update job's own claim of the next request; the
  // admin writes requests through platform_updates.request.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      execution: z.string().min(1).max(200).nullable(),
      /** Which job claims (#819). Default `app_roll`: the upgrader job and the agent. */
      route: z.enum(PLATFORM_UPDATE_ROUTES).default("app_roll"),
    })
    .strict(),
  output: claimOutput,
  handler: async (_ctx, input, tx) => {
    const stale = (await tx.execute(sql`
      UPDATE platform_update_requests
         SET status = 'failed', finished_at = now(),
             status_reason = ${PLATFORM_UPDATE_STALE_REASON}, refusal_codes = ARRAY['stale']
       WHERE status = 'running'
         AND started_at < now() - make_interval(mins => ${PLATFORM_UPDATE_STALE_MINUTES})
       RETURNING id::text AS id, trigger, target_version
    `)) as unknown as { id: string; trigger: string; target_version: string }[];
    for (const s of stale) {
      await tx.execute(sql`
        INSERT INTO platform_update_events (request_id, phase, level, message)
        VALUES (${s.id}::uuid, 'finish', 'error', ${PLATFORM_UPDATE_STALE_REASON})
      `);
    }
    // A dead automatic install may have left the site half-rolled: no
    // further unattended installs until the Owner looked (like a failed one).
    const deadAuto = stale.find((s) => s.trigger === "auto");
    if (deadAuto) {
      await tx.execute(sql`
        UPDATE platform_update_policy
           SET paused = true, paused_at = now(),
               paused_reason = ${`The automatic install of ${deadAuto.target_version} stopped before it finished.`}
         WHERE id = 1
      `);
    }
    type Row = {
      id: string;
      target_version: string;
      trigger: "manual" | "auto";
      auto_basis: AutoUpdateBasis | null;
      execution: string | null;
    };
    // #819 — the converge job continues the converge request that is still
    // running (handed over by its stage 1, or left by a run that died); it
    // decides itself, from Cloud Run and the state lock, whether it may.
    // The row is not changed here: platform_updates.job_handover does that.
    const running =
      input.route === "converge"
        ? ((await tx.execute(sql`
            SELECT id::text AS id, target_version, trigger, auto_basis, execution
              FROM platform_update_requests
             WHERE status = 'running' AND route = 'converge'
             ORDER BY requested_at
             LIMIT 1
          `)) as unknown as Row[])
        : [];
    const resumed = running[0];
    const claimed = resumed
      ? []
      : ((await tx.execute(sql`
          UPDATE platform_update_requests
             SET status = 'running', started_at = now(), execution = ${input.execution}
           WHERE id = (
             SELECT id FROM platform_update_requests
              WHERE status = 'pending' AND route = ${input.route}
              ORDER BY requested_at
              LIMIT 1
              FOR UPDATE SKIP LOCKED
           )
           RETURNING id::text AS id, target_version, trigger, auto_basis, execution
        `)) as unknown as Row[]);
    const row = resumed ?? claimed[0];
    if (!row) return ok({ recovered: stale.map((s) => s.id), claimed: null });
    const policies = (await tx.execute(sql`
      SELECT mode, auto_security, auto_patch, auto_minor, auto_converge, channel,
             to_char(window_start, 'HH24:MI') AS window_start,
             to_char(window_end, 'HH24:MI') AS window_end,
             window_timezone, soak_hours, security_soak_hours, paused, paused_reason,
             paused_at, paused_until, paused_by IS NOT NULL AS paused_by_owner, updated_at
        FROM platform_update_policy WHERE id = 1
    `)) as unknown as {
      mode: StoredUpdatePolicy["mode"];
      auto_security: boolean;
      auto_patch: boolean;
      auto_minor: boolean;
      auto_converge: boolean;
      channel: StoredUpdatePolicy["channel"];
      window_start: string | null;
      window_end: string | null;
      window_timezone: string;
      soak_hours: number;
      security_soak_hours: number;
      paused: boolean;
      paused_reason: string | null;
      paused_at: Date | string | null;
      paused_until: Date | string | null;
      paused_by_owner: boolean;
      updated_at: Date | string;
    }[];
    const p = policies[0];
    if (!p) {
      throw new Error(
        "platform_update_policy has no row (id = 1); migration 0267 seeds it — re-run the database migrations.",
      );
    }
    return ok({
      recovered: stale.map((s) => s.id),
      claimed: {
        id: row.id,
        targetVersion: row.target_version,
        trigger: row.trigger,
        autoBasis: row.auto_basis,
        resume: resumed !== undefined,
        execution: row.execution,
        policy: {
          mode: p.mode,
          autoSecurity: p.auto_security,
          autoPatch: p.auto_patch,
          autoMinor: p.auto_minor,
          autoConverge: p.auto_converge,
          channel: p.channel,
          windowStart: p.window_start,
          windowEnd: p.window_end,
          windowTimezone: p.window_timezone,
          soakHours: p.soak_hours,
          securitySoakHours: p.security_soak_hours,
          paused: p.paused,
          pausedReason: p.paused_reason,
          pausedAt: p.paused_at === null ? null : new Date(p.paused_at).toISOString(),
          pausedUntil: p.paused_until === null ? null : new Date(p.paused_until).toISOString(),
          pausedByOwner: p.paused_by_owner,
          updatedAt: new Date(p.updated_at).toISOString(),
        },
      },
    });
  },
});

export const jobHandoverOp = defineOperation({
  name: "platform_updates.job_handover",
  readScope: "request",
  // Why system-only: the converge job (#819) points its running request at
  // the execution that continues it — stage 1 releases it for its stage 2,
  // which adopts it, as does a run continuing a request whose run died.
  // Never the admin's to move.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      requestId: z.string().uuid(),
      /** The execution the request must still name (null: none). */
      from: z.string().min(1).max(200).nullable(),
      /** The execution that continues it; null releases it for the next run to adopt. */
      to: z.string().min(1).max(200).nullable(),
    })
    .strict(),
  output: z.object({ handedOver: z.boolean() }),
  handler: async (ctx, input, tx) => {
    // started_at restarts too: the stale-run window (90 minutes) is per run,
    // so a continued update is not ended under the run continuing it.
    const rows = (await tx.execute(sql`
      UPDATE platform_update_requests
         SET execution = ${input.to}, started_at = now()
       WHERE id = ${input.requestId}::uuid AND status = 'running' AND route = 'converge'
         AND execution IS NOT DISTINCT FROM ${input.from}
       RETURNING id
    `)) as unknown as { id: string }[];
    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "platform_updates.job_handover",
      input: { requestId: input.requestId, from: input.from, to: input.to },
      succeeded: rows.length > 0,
      entityId: input.requestId,
      resultSummary:
        rows.length > 0
          ? input.to === null
            ? "released for the next run"
            : `run ${input.to}`
          : "not handed over (moved on)",
    });
    return ok({ handedOver: rows.length > 0 });
  },
});

export const jobEventOp = defineOperation({
  name: "platform_updates.job_event",
  readScope: "request",
  // Why system-only: the upgrader job's own timeline lines.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      requestId: z.string().uuid(),
      phase: z.enum(PLATFORM_UPDATE_PHASES),
      level: z.enum(PLATFORM_UPDATE_EVENT_LEVELS),
      message: z.string().min(1).max(PLATFORM_UPDATE_EVENT_MAX),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO platform_update_events (request_id, phase, level, message)
      VALUES (${input.requestId}::uuid, ${input.phase}, ${input.level}, ${input.message})
    `);
    return ok({});
  },
});

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const jobRecordOp = defineOperation({
  name: "platform_updates.job_record",
  readScope: "request",
  // Why system-only: facts the upgrader job verified (signed manifest, backup).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      requestId: z.string().uuid(),
      facts: z
        .object({
          manifestSecurity: z.boolean().optional(),
          contractMigrations: z.boolean().optional(),
          infraContractRequired: z.number().int().optional(),
          infraContractInstalled: z.number().int().optional(),
          adminDigest: digest.optional(),
          gatewayDigest: digest.optional(),
          opsDigest: digest.optional(),
          backupId: z.string().min(1).max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    const f = input.facts;
    await tx.execute(sql`
      UPDATE platform_update_requests SET
        manifest_security = COALESCE(${f.manifestSecurity ?? null}::boolean, manifest_security),
        contract_migrations = COALESCE(${f.contractMigrations ?? null}::boolean, contract_migrations),
        infra_contract_required = COALESCE(${f.infraContractRequired ?? null}::integer, infra_contract_required),
        infra_contract_installed = COALESCE(${f.infraContractInstalled ?? null}::integer, infra_contract_installed),
        admin_digest = COALESCE(${f.adminDigest ?? null}::text, admin_digest),
        gateway_digest = COALESCE(${f.gatewayDigest ?? null}::text, gateway_digest),
        ops_digest = COALESCE(${f.opsDigest ?? null}::text, ops_digest),
        backup_id = COALESCE(${f.backupId ?? null}::text, backup_id)
      WHERE id = ${input.requestId}::uuid AND status = 'running'
    `);
    return ok({});
  },
});

export const jobFinishOp = defineOperation({
  name: "platform_updates.job_finish",
  readScope: "request",
  // Why system-only: the upgrader job ends the request it claimed.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      requestId: z.string().uuid(),
      status: z.enum(["succeeded", "rolled_back", "failed", "refused", "needs_cloud_shell"]),
      reason: z.string().min(1).max(4000).nullable(),
      codes: z.array(z.string().min(1).max(64)).max(20),
      pauseAutoUpdates: z.boolean(),
    })
    .strict(),
  output: z.object({ finished: z.boolean() }),
  handler: async (ctx, input, tx) => {
    // drizzle expands a JS array into a parameter list, so build the array literal.
    const codes = textArray(input.codes);
    const rows = (await tx.execute(sql`
      UPDATE platform_update_requests
         SET status = ${input.status}, status_reason = ${input.reason},
             refusal_codes = ${codes}, finished_at = now()
       WHERE id = ${input.requestId}::uuid AND status = 'running'
       RETURNING target_version
    `)) as unknown as { target_version: string }[];
    if (input.pauseAutoUpdates) {
      await tx.execute(sql`
        UPDATE platform_update_policy
           SET paused = true, paused_at = now(),
               paused_reason = ${`Automatic install of ${rows[0]?.target_version ?? "a release"} ended ${input.status}: ${input.reason ?? ""}`.slice(0, 2000)}
         WHERE id = 1
      `);
    }
    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "platform_updates.job_finish",
      input: { requestId: input.requestId, status: input.status },
      succeeded: input.status === "succeeded",
      entityId: input.requestId,
      resultSummary: `${input.status}${input.codes.length ? ` (${input.codes.join(",")})` : ""}`,
    });
    return ok({ finished: rows.length > 0 });
  },
});

export const agentHeartbeatOp = defineOperation({
  name: "platform_updates.agent_heartbeat",
  readScope: "request",
  // Why system-only: the self-hosted host agent's own check-in (#696 Phase
  // 4c); the admin only reads it (platform_updates.agent_status).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      agentVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/),
      host: z.string().min(1).max(255),
      problem: z.string().min(1).max(2000).nullable(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      INSERT INTO platform_update_agent (id, agent_version, host, last_seen_at, problem)
      VALUES (1, ${input.agentVersion}, ${input.host}, now(), ${input.problem})
      ON CONFLICT (id) DO UPDATE
        SET agent_version = EXCLUDED.agent_version, host = EXCLUDED.host,
            last_seen_at = EXCLUDED.last_seen_at, problem = EXCLUDED.problem
    `);
    return ok({});
  },
});
