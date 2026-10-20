// SPDX-License-Identifier: MPL-2.0

/**
 * `bug_forwarding.*` — sending AI bug reports to the Caelo team (epic #901).
 *
 * Consent: the Owner turns forwarding on (`bug_forwarding.set`, human-only).
 * From then on every new `ai_bug_reports` row is `queued`; reports filed
 * before stay `local_only` until the Owner sends them with
 * `bug_forwarding.queue_earlier`. Turning it off un-queues whatever has not
 * left yet.
 *
 * Outbox: the forwarding worker (bug-forwarding/worker.ts) claims due rows
 * with `claim_due` — which leases them by pushing `next_forward_at` forward,
 * so a second admin instance skips them — sends them OUTSIDE any
 * transaction, and records the outcome with `record_result`. The network
 * call never holds a pooled connection open (same rule as the release
 * check).
 *
 * Identity: `identity` mints the install's Ed25519 signing key on first use;
 * the private key is stored encrypted with the install KEK.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { bugIntakeClusterInfo, err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";
import { buildIntakeReport, type ForwardableBugReport } from "../../bug-forwarding/payload.js";
import { decryptSecret, encryptSecret } from "../../security/secret-box.js";

/** After this many failed sends a report stops retrying and is marked `failed`. */
export const MAX_FORWARD_ATTEMPTS = 8;

/** How long a claimed row is invisible to other workers while it is being sent. */
const CLAIM_LEASE_SECONDS = 300;

/** Retry delay after the n-th failed attempt: 1 min, 5 min, 30 min, 2 h, then 12 h. */
export function forwardRetryDelaySeconds(attempt: number): number {
  const steps = [60, 300, 1800, 7200];
  return steps[attempt - 1] ?? 43_200;
}

const reportColumns = sql`
  id::text AS id,
  fingerprint,
  source,
  severity,
  blocked_task AS "blockedTask",
  suspected_tool AS "suspectedTool",
  title,
  what_happened AS "whatHappened",
  expected,
  evidence`;

const countsSchema = z.object({
  localOnly: z.number(),
  queued: z.number(),
  sent: z.number(),
  failed: z.number(),
  /** `local_only` reports still open (new/triaged) that queue_earlier would send. */
  earlierUnsent: z.number(),
});

export const getBugForwardingOp = defineOperation({
  name: "bug_forwarding.get",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    enabled: z.boolean(),
    /** When the Owner answered the forwarding question; null = never asked. */
    decidedAt: z.string().nullable(),
    installId: z.string().nullable(),
    registered: z.boolean(),
    counts: countsSchema,
  }),
  handler: async (_ctx, _input, tx) => {
    const settings = (await tx.execute(sql`
      SELECT bug_forwarding_enabled AS enabled,
             bug_forwarding_decided_at::text AS "decidedAt",
             install_id::text AS "installId",
             bug_intake_registered_at IS NOT NULL AS registered
      FROM telemetry_settings WHERE id = 1
    `)) as unknown as Array<{
      enabled: boolean;
      decidedAt: string | null;
      installId: string | null;
      registered: boolean;
    }>;
    const s = settings[0];
    if (!s) throw new Error("telemetry_settings singleton row is missing (migration 0048)");
    const counts = (await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE forwarding_state = 'local_only')::int AS "localOnly",
        count(*) FILTER (WHERE forwarding_state = 'queued')::int AS queued,
        count(*) FILTER (WHERE forwarding_state = 'sent')::int AS sent,
        count(*) FILTER (WHERE forwarding_state = 'failed')::int AS failed,
        count(*) FILTER (WHERE forwarding_state = 'local_only'
                           AND status IN ('new', 'triaged'))::int AS "earlierUnsent"
      FROM ai_bug_reports
    `)) as unknown as Array<z.infer<typeof countsSchema>>;
    return ok({
      ...s,
      counts: counts[0] ?? { localOnly: 0, queued: 0, sent: 0, failed: 0, earlierUnsent: 0 },
    });
  },
});

export const setBugForwardingOp = defineOperation({
  name: "bug_forwarding.set",
  // Why human-only: turning this on is the Owner's consent to send reports
  // from this install to the Caelo project, given on the page that shows
  // what is sent. Same stance as telemetry.set — an AI-drafted proposal
  // approved in an unrelated chat is not that consent.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ enabled: z.boolean() }).strict(),
  output: z.object({ installId: z.string().nullable(), unqueued: z.number() }),
  handler: async (ctx, input, tx) => {
    // The install id is shared with telemetry (P16); minted on first opt-in
    // so nothing identifying exists before consent.
    const rows = (await tx.execute(sql`
      UPDATE telemetry_settings
         SET bug_forwarding_enabled = ${input.enabled},
             bug_forwarding_decided_at = now(),
             install_id = CASE
               WHEN install_id IS NULL AND ${input.enabled} THEN gen_random_uuid()
               ELSE install_id END,
             updated_at = now()
       WHERE id = 1
      RETURNING install_id::text AS "installId"
    `)) as unknown as Array<{ installId: string | null }>;
    if (!rows[0]) throw new Error("telemetry_settings singleton row is missing (migration 0048)");
    let unqueued = 0;
    if (!input.enabled) {
      // Withdrawn consent covers what has not left yet.
      const back = (await tx.execute(sql`
        UPDATE ai_bug_reports
           SET forwarding_state = 'local_only', next_forward_at = NULL
         WHERE forwarding_state = 'queued'
        RETURNING id
      `)) as unknown as unknown[];
      unqueued = back.length;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      operation: "bug_forwarding.set",
      input,
      succeeded: true,
      resultSummary: `bug_forwarding=${input.enabled}${unqueued ? ` unqueued=${unqueued}` : ""}`,
      requestId: ctx.requestId,
    });
    return ok({ installId: rows[0].installId, unqueued });
  },
});

export const queueEarlierBugReportsOp = defineOperation({
  name: "bug_forwarding.queue_earlier",
  // Why human-only: reports filed before the opt-in were not covered by it;
  // sending them is a separate, explicit Owner decision.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ queued: z.number() }),
  handler: async (ctx, _input, tx) => {
    const s = (await tx.execute(sql`
      SELECT bug_forwarding_enabled AS enabled FROM telemetry_settings WHERE id = 1
    `)) as unknown as Array<{ enabled: boolean }>;
    if (!s[0]?.enabled) {
      return err({
        kind: "HandlerError",
        operation: "bug_forwarding.queue_earlier",
        message:
          "Bug forwarding is off. Turn on 'Send detected bugs to the Caelo team' on /settings/bugs first.",
      });
    }
    const rows = (await tx.execute(sql`
      UPDATE ai_bug_reports
         SET forwarding_state = 'queued', next_forward_at = now()
       WHERE forwarding_state = 'local_only' AND status IN ('new', 'triaged')
      RETURNING id
    `)) as unknown as unknown[];
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      operation: "bug_forwarding.queue_earlier",
      input: {},
      succeeded: true,
      resultSummary: `queued=${rows.length}`,
      requestId: ctx.requestId,
    });
    return ok({ queued: rows.length });
  },
});

export const previewBugForwardingOp = defineOperation({
  name: "bug_forwarding.preview",
  // Pure read: the exact payload that would be sent for one report.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ reportId: z.string().uuid() }).strict(),
  output: z.object({ payload: z.record(z.string(), z.unknown()) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT ${reportColumns} FROM ai_bug_reports WHERE id = ${input.reportId}::uuid
    `)) as unknown as ForwardableBugReport[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "bug_forwarding.preview",
        message: `No bug report ${input.reportId}. List reports with ai_bug_reports.list.`,
      });
    }
    return ok({ payload: await buildIntakeReport(row) });
  },
});

export const claimDueBugReportsOp = defineOperation({
  name: "bug_forwarding.claim_due",
  // Why system-only: worker plumbing; the lease it takes is meaningless to a person or the AI.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.object({
    reports: z.array(z.object({ id: z.string(), attempt: z.number(), payload: z.unknown() })),
  }),
  handler: async (_ctx, input, tx) => {
    // SKIP LOCKED + the lease keep two admin instances off the same row.
    const rows = (await tx.execute(sql`
      UPDATE ai_bug_reports r
         SET next_forward_at = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS}),
             forward_attempts = r.forward_attempts + 1
       WHERE r.id IN (
         SELECT id FROM ai_bug_reports
          WHERE forwarding_state = 'queued'
            AND (next_forward_at IS NULL OR next_forward_at <= now())
          ORDER BY next_forward_at NULLS FIRST, created_at
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING ${reportColumns}, forward_attempts AS attempt
    `)) as unknown as Array<ForwardableBugReport & { attempt: number }>;
    const reports = [];
    for (const row of rows) {
      try {
        reports.push({ id: row.id, attempt: row.attempt, payload: await buildIntakeReport(row) });
      } catch (e) {
        // A row that cannot become a valid payload would fail every claim
        // forever; it stops here with the reason, the rest go out.
        await tx.execute(sql`
          UPDATE ai_bug_reports
             SET forwarding_state = 'failed', next_forward_at = NULL,
                 forward_error = ${`Could not build the report to send: ${(e as Error).message}`.slice(0, 1000)}
           WHERE id = ${row.id}::uuid
        `);
      }
    }
    return ok({ reports });
  },
});

export const recordBugForwardResultOp = defineOperation({
  name: "bug_forwarding.record_result",
  // Why system-only: written by the forwarding worker from the intake's answer.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      reportId: z.string().uuid(),
      outcome: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("sent"), cluster: bugIntakeClusterInfo }).strict(),
        z.object({ kind: z.literal("retry"), error: z.string().max(1000) }).strict(),
        z.object({ kind: z.literal("failed"), error: z.string().max(1000) }).strict(),
      ]),
    })
    .strict(),
  output: z.object({ state: z.enum(["sent", "queued", "failed"]) }),
  handler: async (_ctx, input, tx) => {
    const o = input.outcome;
    if (o.kind === "sent") {
      await tx.execute(sql`
        UPDATE ai_bug_reports
           SET forwarding_state = 'sent', forwarded_at = now(), next_forward_at = NULL,
               forward_error = NULL,
               upstream_cluster_id = ${o.cluster.clusterId},
               upstream_status = ${o.cluster.status},
               upstream_issue_url = ${o.cluster.issueUrl},
               upstream_fixed_in = ${o.cluster.fixedInVersion},
               upstream_checked_at = now()
         WHERE id = ${input.reportId}::uuid
      `);
      return ok({ state: "sent" as const });
    }
    const rows = (await tx.execute(sql`
      SELECT forward_attempts AS attempts FROM ai_bug_reports WHERE id = ${input.reportId}::uuid
    `)) as unknown as Array<{ attempts: number }>;
    const attempts = rows[0]?.attempts ?? MAX_FORWARD_ATTEMPTS;
    const giveUp = o.kind === "failed" || attempts >= MAX_FORWARD_ATTEMPTS;
    // Only a still-queued row moves: the Owner may have withdrawn consent
    // while the send was in flight, and that answer wins.
    await tx.execute(sql`
      UPDATE ai_bug_reports
         SET forwarding_state = ${giveUp ? "failed" : "queued"},
             forward_error = ${o.error},
             next_forward_at = ${
               giveUp
                 ? null
                 : sql`now() + make_interval(secs => ${forwardRetryDelaySeconds(attempts)})`
             }
       WHERE id = ${input.reportId}::uuid AND forwarding_state = 'queued'
    `);
    return ok({ state: giveUp ? ("failed" as const) : ("queued" as const) });
  },
});

export const bugForwardingIdentityOp = defineOperation({
  name: "bug_forwarding.identity",
  // Why system-only: returns the decrypted signing key for the worker.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    installId: z.string(),
    publicKey: z.string(),
    privateKeyPkcs8: z.string(),
    registered: z.boolean(),
  }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT bug_forwarding_enabled AS enabled,
             install_id::text AS "installId",
             bug_intake_public_key AS "publicKey",
             bug_intake_private_key_ciphertext AS ciphertext,
             bug_intake_private_key_iv AS iv,
             bug_intake_private_key_kek_fp AS "kekFp",
             bug_intake_registered_at IS NOT NULL AS registered
      FROM telemetry_settings WHERE id = 1
      FOR UPDATE
    `)) as unknown as Array<{
      enabled: boolean;
      installId: string | null;
      publicKey: string | null;
      ciphertext: string | null;
      iv: string | null;
      kekFp: string | null;
      registered: boolean;
    }>;
    const s = rows[0];
    if (!s?.enabled || !s.installId) {
      return err({
        kind: "HandlerError",
        operation: "bug_forwarding.identity",
        message: "Bug forwarding is off; there is no identity to sign with.",
      });
    }
    if (s.publicKey && s.ciphertext && s.iv && s.kekFp) {
      const privateKeyPkcs8 = await decryptSecret({
        ciphertext: Buffer.from(s.ciphertext, "base64"),
        iv: Buffer.from(s.iv, "base64"),
        kekFingerprint: s.kekFp,
      });
      return ok({
        installId: s.installId,
        publicKey: s.publicKey,
        privateKeyPkcs8,
        registered: s.registered,
      });
    }
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
      "base64",
    );
    const privateKeyPkcs8 = Buffer.from(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ).toString("base64");
    const enc = await encryptSecret(privateKeyPkcs8);
    // A new key is unknown to the intake, so registration starts over.
    await tx.execute(sql`
      UPDATE telemetry_settings
         SET bug_intake_public_key = ${publicKey},
             bug_intake_private_key_ciphertext = ${Buffer.from(enc.ciphertext).toString("base64")},
             bug_intake_private_key_iv = ${Buffer.from(enc.iv).toString("base64")},
             bug_intake_private_key_kek_fp = ${enc.kekFingerprint},
             bug_intake_registered_at = NULL
       WHERE id = 1
    `);
    return ok({ installId: s.installId, publicKey, privateKeyPkcs8, registered: false });
  },
});

export const markBugIntakeRegisteredOp = defineOperation({
  name: "bug_forwarding.mark_registered",
  // Why system-only: recorded by the worker once the intake pinned the key.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ publicKey: z.string() }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    // Bound to the key that was registered, so a key minted meanwhile is not marked.
    await tx.execute(sql`
      UPDATE telemetry_settings SET bug_intake_registered_at = now()
       WHERE id = 1 AND bug_intake_public_key = ${input.publicKey}
    `);
    return ok({});
  },
});

export const bugClustersToRefreshOp = defineOperation({
  name: "bug_forwarding.clusters_to_refresh",
  // Why system-only: worker plumbing for the upstream status refresh.
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      staleAfterSeconds: z.number().int().min(60),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  output: z.object({ clusterIds: z.array(z.string()) }),
  handler: async (_ctx, input, tx) => {
    // Open and regression clusters can still change; a fixed one only
    // until its release is known.
    const rows = (await tx.execute(sql`
      SELECT upstream_cluster_id AS id
        FROM ai_bug_reports
       WHERE forwarding_state = 'sent'
         AND upstream_cluster_id IS NOT NULL
         AND (upstream_status IN ('open', 'regression')
              OR (upstream_status = 'fixed' AND upstream_fixed_in IS NULL))
       GROUP BY upstream_cluster_id
      HAVING max(upstream_checked_at) IS NULL
          OR max(upstream_checked_at) < now() - make_interval(secs => ${input.staleAfterSeconds})
       LIMIT ${input.limit}
    `)) as unknown as Array<{ id: string }>;
    return ok({ clusterIds: rows.map((r) => r.id) });
  },
});

export const recordBugClusterStatusOp = defineOperation({
  name: "bug_forwarding.record_cluster_status",
  // Why system-only: written by the worker from the intake's answer.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({ clusters: z.array(bugIntakeClusterInfo).max(100) }).strict(),
  output: z.object({ updated: z.number() }),
  handler: async (_ctx, input, tx) => {
    let updated = 0;
    for (const c of input.clusters) {
      const rows = (await tx.execute(sql`
        UPDATE ai_bug_reports
           SET upstream_status = ${c.status},
               upstream_issue_url = ${c.issueUrl},
               upstream_fixed_in = ${c.fixedInVersion},
               upstream_checked_at = now()
         WHERE upstream_cluster_id = ${c.clusterId}
        RETURNING id
      `)) as unknown as unknown[];
      updated += rows.length;
    }
    return ok({ updated });
  },
});
