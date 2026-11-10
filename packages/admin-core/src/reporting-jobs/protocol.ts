// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 (#1140 category A) — the wire format between a reporting job
 * and the admin.
 *
 * A reporting job is long, bounded work started by the admin (a Stage's
 * quality audit; the site-import crawl in #1360) that runs in a container of
 * its own and holds no database credential and no secret. It talks to the
 * admin only by reports: one JSON POST to `/api/internal/jobs/<kind>/report`
 * per step, which the admin answers. A report is how the job asks for its
 * inputs (the run to work on, the sources a check reads) and how it hands
 * over progress and its result; the request gives the admin the CPU to
 * answer and record it (CLAUDE.md §11.B Tier 5).
 *
 * Every report carries the attempt's token: a random value the admin minted
 * when it started that attempt and stores only as a SHA-256. On Google
 * Cloud the request also passes the admin's IAP as the job's own service
 * account, and the admin checks that identity per kind
 * (apps/admin lib/server/reporting-jobs.ts). Neither alone admits a report.
 *
 * This file is shared by both sides and changes only together with them:
 * the job runs the admin's image, and a job on another version than the
 * admin that started it defers (job-entry.ts) instead of speaking a
 * protocol the admin may not have. The envelope and the `defer` action are
 * the parts that must stay readable across versions.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** The kinds of reporting job. #1360 adds the site-import crawl. */
export const REPORTING_JOB_KINDS = ["quality_audit"] as const;

export type ReportingJobKind = (typeof REPORTING_JOB_KINDS)[number];

/** How long each kind's attempts may run silent, and how often they try. */
export interface JobTiming {
  /** How long a new attempt has for its first report: start-up and a cold image pull. */
  readonly firstLeaseSeconds: number;
  /** How far ahead every admitted report keeps the lease. */
  readonly leaseSeconds: number;
  /** How often the job renews its lease while it works (well below `leaseSeconds`). */
  readonly renewEverySeconds: number;
  /** Attempts before the work is given up (the tick's backstop starts the rest). */
  readonly maxAttempts: number;
  /** The most one execution may run (its task timeout). */
  readonly maxRunSeconds: number;
}

/** Both sides read the same timings: the admin leases, the job renews. */
export const JOB_TIMING: Readonly<Record<ReportingJobKind, JobTiming>> = {
  // A Stage's audit: the findings checks over every page plus up to two
  // batches of Lighthouse runs of 5 minutes each.
  quality_audit: {
    firstLeaseSeconds: 15 * 60,
    leaseSeconds: 5 * 60,
    renewEverySeconds: 60,
    maxAttempts: 3,
    maxRunSeconds: 60 * 60,
  },
};

/** The env var a job execution's {@link JobOrder} arrives in. */
export const JOB_ORDER_ENV_VAR = "CAELO_REPORTING_JOB_ORDER";

/**
 * The header the attempt's token rides in. Not `Authorization`: through IAP
 * that header carries the job's IAP credential.
 */
export const JOB_TOKEN_HEADER = "x-caelo-job-token";

/** Where a job of `kind` reports, under the admin's origin. */
export function reportPath(kind: ReportingJobKind): string {
  return `/api/internal/jobs/${kind}/report`;
}

/** Whether `value` names a reporting-job kind. */
export function isReportingJobKind(value: string): value is ReportingJobKind {
  return (REPORTING_JOB_KINDS as readonly string[]).includes(value);
}

/** A token: 32 random bytes, base64url without padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The admin's origin as a job may report to it: https (http only on
 * loopback, for tests), no credentials, path, query or fragment. The job
 * signs its IAP credential for exactly this origin.
 */
export function reportOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`the admin URL ${JSON.stringify(raw)} is not a URL`);
  }
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (
    (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) ||
    u.username ||
    u.password ||
    (u.pathname !== "/" && u.pathname !== "") ||
    u.search ||
    u.hash
  ) {
    throw new Error(`the admin URL ${JSON.stringify(raw)} is not a plain https origin`);
  }
  return u.origin;
}

/** What one job execution is told to do (its env, {@link JOB_ORDER_ENV_VAR}). */
export const jobOrderSchema = z
  .object({
    /**
     * The admin's Caelo version. The job runs the admin's image, which the
     * upgrade moves together with the admin; a job on another version
     * defers instead of reporting.
     */
    version: z.string().min(1).max(64),
    kind: z.enum(REPORTING_JOB_KINDS),
    /** The audit run / import run to work on. */
    subjectId: z.string().uuid(),
    attempt: z.number().int().min(1).max(20),
    token: z.string().regex(TOKEN),
    /** The admin's origin behind IAP; absent when the job runs inside the admin. */
    adminUrl: z
      .string()
      .max(300)
      .refine(
        (v) => {
          try {
            reportOrigin(v);
            return true;
          } catch {
            return false;
          }
        },
        { message: "not a plain https origin" },
      )
      .optional(),
  })
  .strict();

export type JobOrder = z.infer<typeof jobOrderSchema>;

/** The most bytes one report may carry; larger inputs go in parts. */
export const MAX_REPORT_BODY_BYTES = 6 * 1024 * 1024;

/**
 * Inputs whose JSON is longer than this go in parts. Inline, the JSON is
 * the envelope's own: at most 3 UTF-8 bytes per UTF-16 unit, 3 MiB.
 */
export const INLINE_PAYLOAD_CHARS = 1024 * 1024;

/**
 * Characters of JSON per part. A part travels as a JSON string, so it
 * grows on the wire: a `"` or `\` doubles, a unit of U+0800..U+FFFF takes
 * 3 UTF-8 bytes, a surrogate pair 4 for two units. JSON text holds no raw
 * control character or lone surrogate (JSON.stringify escapes both), so 3
 * bytes per unit is the most: a full part is at most 3 MiB plus the
 * envelope, half of {@link MAX_REPORT_BODY_BYTES}.
 */
export const UPLOAD_PART_CHARS = 1024 * 1024;

/** The most parts one upload may have (the parts table's limit). */
export const MAX_UPLOAD_PARTS = 128;

/** The most characters a run may hold in uploads at once. */
export const MAX_UPLOAD_CHARS_PER_RUN = 128 * 1024 * 1024;

/** An action name: what a report asks the admin to do. */
const actionName = z.string().regex(/^[a-z][a-z-]{0,39}$/);

/** One report: the body of a POST to {@link reportPath}. */
export const reportEnvelopeSchema = z
  .object({
    subjectId: z.string().uuid(),
    attempt: z.number().int().min(1).max(20),
    action: actionName,
    /** The action's input, when it fits one request. */
    payload: z.unknown().optional(),
    /** The action's input sent before in parts (`upload-part`). */
    upload: z
      .object({
        uploadId: z.string().uuid(),
        parts: z.number().int().min(1).max(MAX_UPLOAD_PARTS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((e) => !(e.payload !== undefined && e.upload !== undefined), {
    message: "send the input inline (payload) or in parts (upload), not both",
  });

export type ReportEnvelope = z.infer<typeof reportEnvelopeSchema>;

/**
 * The actions every kind has, besides its own:
 *
 *   - `heartbeat`: nothing but the lease (the job renews it while it works);
 *   - `upload-part`: one part of a large input (see {@link UPLOAD_PART_CHARS});
 *   - `defer`: give the attempt back now with a reason, so the next tick
 *     starts the next one (a job on another version than the admin).
 */
export const FOUNDATION_ACTIONS = ["heartbeat", "upload-part", "defer"] as const;

export const uploadPartSchema = z
  .object({
    uploadId: z.string().uuid(),
    part: z
      .number()
      .int()
      .min(0)
      .max(MAX_UPLOAD_PARTS - 1),
    data: z.string().min(1).max(UPLOAD_PART_CHARS),
  })
  .strict();

export const deferSchema = z.object({ reason: z.string().min(1).max(1000) }).strict();

/** Reports one run may send per minute; past it the admin answers 429. */
export const REPORTS_PER_MINUTE = 600;

/** How the admin answers a report: the value, or why not. */
export type ReportAnswer =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
      /** Set on 429: when to send the report again. */
      readonly retryAfterSeconds?: number;
    };

/** A new attempt's token (32 random bytes). */
export function mintJobToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the admin stores of a token. */
export function hashJobToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Split JSON text into parts of at most `size` characters, never between
 * the two halves of a surrogate pair (a lone half is no valid text, and the
 * database would replace it).
 */
export function splitIntoParts(text: string, size: number = UPLOAD_PART_CHARS): string[] {
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}
