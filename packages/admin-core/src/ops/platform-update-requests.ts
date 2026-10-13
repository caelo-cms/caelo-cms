// SPDX-License-Identifier: MPL-2.0

/**
 * Installing a Caelo release from Settings → Updates (epic #696 Phase 2).
 *
 *   platform_updates.request         the Owner asks for the newest release
 *   platform_updates.cancel          …and withdraws it before the job ran
 *   platform_updates.record_trigger  the admin notes whether it could start
 *                                    the upgrader job
 *   platform_updates.list / .get     history + one run's timeline (AI-readable)
 *
 * The admin never installs anything itself. A request is a row the upgrader
 * job (packages/provisioning/src/upgrader-job.ts, its own service account)
 * picks up; the job decides — from the signed release manifest, not from
 * this row — whether the release may be installed, and narrates its run into
 * `platform_update_events`.
 *
 * The writes are human-only (CLAUDE.md §2: deployment is locked from the
 * AI; #696 maintainer decision 3: the AI only informs) and each needs the
 * `platform.update` permission plus a fresh Google sign-in from the same
 * browser session (security/step-up/gate.ts), consumed by the action.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import {
  CAELO_VERSION,
  err,
  isNewerVersion,
  ok,
  PLATFORM_UPDATE_EVENT_LEVELS,
  PLATFORM_UPDATE_PHASES,
  PLATFORM_UPDATE_STATUSES,
  PLATFORM_UPDATE_TRIGGERS,
  releaseVersionSchema,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditFromCtx } from "../audit.js";
import {
  consumeStepUp,
  guardedActionRefusal,
  sessionHashSchema,
} from "../security/step-up/gate.js";

const handlerError = (operation: string, message: string) =>
  err({ kind: "HandlerError" as const, operation, message });

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

export const platformUpdateRequestSchema = z.object({
  id: z.string(),
  targetVersion: z.string(),
  fromVersion: z.string(),
  trigger: z.enum(PLATFORM_UPDATE_TRIGGERS),
  /** Email of the Owner who asked; null for automatic installs. */
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  status: z.enum(PLATFORM_UPDATE_STATUSES),
  statusReason: z.string().nullable(),
  refusalCodes: z.array(z.string()),
  execution: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  manifestSecurity: z.boolean().nullable(),
  contractMigrations: z.boolean().nullable(),
  infraContractRequired: z.number().nullable(),
  infraContractInstalled: z.number().nullable(),
  backupId: z.string().nullable(),
});
/** One update request as the page and the AI see it. */
export type PlatformUpdateRequest = z.infer<typeof platformUpdateRequestSchema>;

export const platformUpdateEventSchema = z.object({
  id: z.number(),
  at: z.string(),
  phase: z.enum(PLATFORM_UPDATE_PHASES),
  level: z.enum(PLATFORM_UPDATE_EVENT_LEVELS),
  message: z.string(),
});
/** One timeline line of an upgrader run. */
export type PlatformUpdateEvent = z.infer<typeof platformUpdateEventSchema>;

interface RequestRow {
  id: string;
  target_version: string;
  from_version: string;
  trigger: PlatformUpdateRequest["trigger"];
  requested_by_email: string | null;
  requested_at: Date | string;
  status: PlatformUpdateRequest["status"];
  status_reason: string | null;
  refusal_codes: string[] | null;
  execution: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  manifest_security: boolean | null;
  contract_migrations: boolean | null;
  infra_contract_required: number | null;
  infra_contract_installed: number | null;
  backup_id: string | null;
}

const REQUEST_COLUMNS = sql`
  r.id::text AS id, r.target_version, r.from_version, r.trigger,
  u.email AS requested_by_email, r.requested_at, r.status, r.status_reason,
  r.refusal_codes, r.execution, r.started_at, r.finished_at, r.manifest_security,
  r.contract_migrations, r.infra_contract_required, r.infra_contract_installed, r.backup_id
`;

function toRequest(r: RequestRow): PlatformUpdateRequest {
  return {
    id: r.id,
    targetVersion: r.target_version,
    fromVersion: r.from_version,
    trigger: r.trigger,
    requestedBy: r.requested_by_email,
    requestedAt: iso(r.requested_at) as string,
    status: r.status,
    statusReason: r.status_reason,
    refusalCodes: r.refusal_codes ?? [],
    execution: r.execution,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    manifestSecurity: r.manifest_security,
    contractMigrations: r.contract_migrations,
    infraContractRequired: r.infra_contract_required,
    infraContractInstalled: r.infra_contract_installed,
    backupId: r.backup_id,
  };
}

async function readRequests(
  tx: TransactionRunner,
  where: ReturnType<typeof sql>,
  limit: number,
): Promise<PlatformUpdateRequest[]> {
  const rows = (await tx.execute(sql`
    SELECT ${REQUEST_COLUMNS}
      FROM platform_update_requests r
      LEFT JOIN users u ON u.id = r.requested_by
     WHERE ${where}
     ORDER BY r.requested_at DESC
     LIMIT ${limit}
  `)) as unknown as RequestRow[];
  return rows.map(toRequest);
}

async function appendEvent(
  tx: TransactionRunner,
  requestId: string,
  phase: PlatformUpdateEvent["phase"],
  level: PlatformUpdateEvent["level"],
  message: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO platform_update_events (request_id, phase, level, message)
    VALUES (${requestId}::uuid, ${phase}, ${level}, ${message.slice(0, 4000)})
  `);
}

export const platformUpdatesRequestOp = defineOperation({
  name: "platform_updates.request",
  // Why human-only: installing a Caelo release is a deployment (CLAUDE.md
  // §2, deployment locked from the AI; #696 decision 3: the AI only informs).
  // Owner permission + a fresh Google sign-in, checked in the handler.
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ targetVersion: releaseVersionSchema, sessionHash: sessionHashSchema }).strict(),
  output: z.object({ requestId: z.string() }),
  handler: async (ctx, input, tx) => {
    const op = "platform_updates.request";
    const refuse = async (message: string) => {
      await recordAuditFromCtx(tx, ctx, {
        operation: op,
        input: { targetVersion: input.targetVersion },
        succeeded: false,
        resultSummary: message.slice(0, 200),
      });
      return handlerError(op, message);
    };
    const refusal = await guardedActionRefusal(tx, ctx, {
      operation: "install a Caelo update",
      permission: "platform.update",
      sessionHash: input.sessionHash,
    });
    if (refusal) return refuse(refusal);

    // Only the newest release the release check found: the dialog showed
    // the Owner exactly that version and its notes.
    const latest = (
      (await tx.execute(sql`
        SELECT latest_version FROM release_check_cache WHERE id = 1
      `)) as unknown as { latest_version: string | null }[]
    )[0]?.latest_version;
    if (!latest) {
      return refuse(
        "The newest Caelo release is not known yet (the hourly release check has not reached GitHub). Try again later.",
      );
    }
    if (input.targetVersion !== latest) {
      return refuse(
        `Only the newest release can be installed (${latest}); ${input.targetVersion} is not it. Reload the page.`,
      );
    }
    if (!isNewerVersion(input.targetVersion, CAELO_VERSION)) {
      return refuse(
        `This install already runs ${CAELO_VERSION}; ${input.targetVersion} is not newer.`,
      );
    }
    const active = await readRequests(tx, sql`r.status IN ('pending', 'running')`, 1);
    if (active[0]) {
      return refuse(
        `An update to ${active[0].targetVersion} is already ${active[0].status === "running" ? "being installed" : "waiting to start"}. Wait for it to finish (or cancel it while it waits).`,
      );
    }

    const inserted = (await tx.execute(sql`
      INSERT INTO platform_update_requests (target_version, from_version, trigger, requested_by)
      VALUES (${input.targetVersion}, ${CAELO_VERSION}, 'manual', ${ctx.actorId}::uuid)
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const requestId = inserted[0]?.id as string;
    await appendEvent(
      tx,
      requestId,
      "queued",
      "info",
      `Update to ${input.targetVersion} requested (confirmed with a fresh Google sign-in).`,
    );
    await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { targetVersion: input.targetVersion },
      succeeded: true,
      entityId: requestId,
      resultSummary: `requested ${CAELO_VERSION} → ${input.targetVersion}`,
    });
    return ok({ requestId });
  },
});

export const platformUpdatesCancelOp = defineOperation({
  name: "platform_updates.cancel",
  // Why human-only: withdraws the Owner's own deployment request (same gate
  // as platform_updates.request: Owner permission + fresh Google sign-in).
  actorScope: ["human"],
  database: "cms_admin",
  input: z.object({ requestId: z.string().uuid(), sessionHash: sessionHashSchema }).strict(),
  output: z.object({ cancelled: z.literal(true) }),
  handler: async (ctx, input, tx) => {
    const op = "platform_updates.cancel";
    const refusal = await guardedActionRefusal(tx, ctx, {
      operation: "cancel a Caelo update",
      permission: "platform.update",
      sessionHash: input.sessionHash,
    });
    if (refusal) return handlerError(op, refusal);
    const rows = (await tx.execute(sql`
      UPDATE platform_update_requests
         SET status = 'cancelled', cancelled_by = ${ctx.actorId}::uuid, cancelled_at = now(),
             finished_at = now(), status_reason = 'Cancelled by the Owner before it started.'
       WHERE id = ${input.requestId}::uuid AND status = 'pending'
       RETURNING id
    `)) as unknown as { id: string }[];
    if (rows.length === 0) {
      return handlerError(
        op,
        "Only an update that has not started yet can be cancelled. A running update finishes — or rolls back — on its own.",
      );
    }
    await appendEvent(tx, input.requestId, "finish", "warn", "Cancelled by the Owner.");
    await consumeStepUp(tx, ctx.actorId, input.sessionHash);
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { requestId: input.requestId },
      succeeded: true,
      entityId: input.requestId,
    });
    return ok({ cancelled: true as const });
  },
});

export const platformUpdatesRecordTriggerOp = defineOperation({
  name: "platform_updates.record_trigger",
  // Why human-only: the admin's bookkeeping right after the Owner's own
  // request — whether the upgrader job could be started for it.
  actorScope: ["human"],
  database: "cms_admin",
  input: z
    .object({
      requestId: z.string().uuid(),
      outcome: z.discriminatedUnion("started", [
        z.object({ started: z.literal(true), execution: z.string().min(1).max(200) }),
        z.object({
          started: z.literal(false),
          error: z.string().min(1).max(1500),
          nextStep: z.string().min(1).max(1500),
        }),
      ]),
    })
    .strict(),
  output: z.object({ recorded: z.literal(true) }),
  handler: async (ctx, input, tx) => {
    const op = "platform_updates.record_trigger";
    const own = (await tx.execute(sql`
      SELECT status FROM platform_update_requests
       WHERE id = ${input.requestId}::uuid AND requested_by = ${ctx.actorId}::uuid
    `)) as unknown as { status: string }[];
    if (!own[0]) return handlerError(op, "No such update request of yours.");
    if (input.outcome.started) {
      await appendEvent(
        tx,
        input.requestId,
        "queued",
        "info",
        `Upgrader started (run ${input.outcome.execution}).`,
      );
    } else {
      // The job never ran, so nothing changed; end the request so it does
      // not block the next attempt.
      const reason = `The upgrader could not be started: ${input.outcome.error} ${input.outcome.nextStep}`;
      await tx.execute(sql`
        UPDATE platform_update_requests
           SET status = 'failed', status_reason = ${reason.slice(0, 4000)}, finished_at = now()
         WHERE id = ${input.requestId}::uuid AND status = 'pending'
      `);
      await appendEvent(tx, input.requestId, "finish", "error", reason);
    }
    await recordAuditFromCtx(tx, ctx, {
      operation: op,
      input: { requestId: input.requestId, started: input.outcome.started },
      succeeded: input.outcome.started,
      entityId: input.requestId,
    });
    return ok({ recorded: true as const });
  },
});

export const platformUpdatesListOp = defineOperation({
  name: "platform_updates.list",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      status: z.enum(PLATFORM_UPDATE_STATUSES).optional(),
    })
    .strict(),
  output: z.object({ requests: z.array(platformUpdateRequestSchema) }),
  handler: async (_ctx, input, tx) => {
    const where = input.status ? sql`r.status = ${input.status}` : sql`true`;
    return ok({ requests: await readRequests(tx, where, input.limit ?? 20) });
  },
});

export const platformUpdatesGetOp = defineOperation({
  name: "platform_updates.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Omit for the most recent request. */
      requestId: z.string().uuid().optional(),
    })
    .strict(),
  output: z.object({
    request: platformUpdateRequestSchema.nullable(),
    events: z.array(platformUpdateEventSchema),
  }),
  handler: async (_ctx, input, tx) => {
    const where = input.requestId ? sql`r.id = ${input.requestId}::uuid` : sql`true`;
    const [request] = await readRequests(tx, where, 1);
    if (!request) {
      if (input.requestId) {
        return handlerError("platform_updates.get", `No update request ${input.requestId}.`);
      }
      return ok({ request: null, events: [] });
    }
    const events = (await tx.execute(sql`
      SELECT id, at, phase, level, message FROM platform_update_events
       WHERE request_id = ${request.id}::uuid
       ORDER BY id
       LIMIT 1000
    `)) as unknown as {
      id: number | string;
      at: Date | string;
      phase: PlatformUpdateEvent["phase"];
      level: PlatformUpdateEvent["level"];
      message: string;
    }[];
    return ok({
      request,
      events: events.map((e) => ({
        id: Number(e.id),
        at: iso(e.at) as string,
        phase: e.phase,
        level: e.level,
        message: e.message,
      })),
    });
  },
});
