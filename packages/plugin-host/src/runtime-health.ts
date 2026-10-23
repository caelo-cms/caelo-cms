// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin runtime health (issue #1008): what the host writes when a plugin
 * fails, and where each instance says what it is running.
 *
 * The invariant this module exists for: **the host never writes a plugin's
 * status.** `plugins.status` is the Owner's (or the review's) decision; a
 * load that throws on one instance used to overwrite it with `failed`,
 * which switched the plugin off for every instance and had no way back.
 * Now a problem lands in two places instead:
 *
 *   - `plugin_errors` — one row per plugin and fingerprint, counting how
 *     often and when, with the phase it happened in and whose fault it is
 *     (`transient` / `plugin` / `core`). A core problem is reported to the
 *     bug intake the first time its fingerprint is seen.
 *   - `plugin_runtime` — per instance and plugin: loaded, or failed to load
 *     (pointing at the error). Each instance heartbeats its rows; health
 *     readers only count recent heartbeats, so a stopped instance drops
 *     out without anyone cleaning up after it.
 *
 * Recording is best effort in one direction only: if the database cannot
 * take the record (it may be the very thing that is failing), the problem
 * is still logged loudly to the process log and the caller's own error
 * still propagates. Recording never turns a failure into a success.
 */

import { createHash, randomUUID } from "node:crypto";
import { execute } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { PluginHostInfra } from "./dispatch.js";
import { describeLoadError } from "./load-error.js";

/** Where in a plugin's life a problem happened. */
export type PluginPhase =
  | "verify"
  | "register"
  | "provision"
  | "activate"
  | "operation"
  | "worker"
  | "render";

/**
 * Whose fault a problem is: a passing infrastructure hiccup (retried), the
 * plugin's own code, or Caelo's host code (reported to the bug intake).
 */
export type PluginErrorClass = "transient" | "plugin" | "core";

/** A load failure tagged with the phase it happened in. */
export class PluginLoadError extends Error {
  readonly phase: PluginPhase;
  constructor(phase: PluginPhase, cause: unknown) {
    super(describeLoadError(cause), { cause });
    this.name = "PluginLoadError";
    this.phase = phase;
  }
}

/**
 * Run `fn`, tagging anything it throws with `phase`. A failure already
 * tagged by an inner phase keeps the inner (more precise) tag.
 */
export async function inPhase<T>(phase: PluginPhase, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw e instanceof PluginLoadError ? e : new PluginLoadError(phase, e);
  }
}

/** The phase a thrown load failure belongs to; untagged failures are host code. */
export function phaseOf(error: unknown): PluginPhase {
  return error instanceof PluginLoadError ? error.phase : "register";
}

/**
 * SQLSTATEs that say "try again", not "this is broken": connection loss,
 * serialization / deadlock, lock timeouts, server shutdown, and too many
 * connections — the conditions a burst of instances booting at once runs
 * into.
 */
const TRANSIENT_SQLSTATE = /^(08...|40001|40P01|55P03|57P01|57P02|57P03|53300|53400)$/;

/** Bun SQL / socket error codes for a connection that went away. */
const TRANSIENT_CONNECTION_CODE =
  /^(ERR_POSTGRES_CONNECTION_CLOSED|ERR_POSTGRES_CONNECTION_TIMEOUT|ERR_POSTGRES_IDLE_TIMEOUT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)$/;

function isTransient(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const e = current as { errno?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.errno === "string" && TRANSIENT_SQLSTATE.test(e.errno)) return true;
    if (typeof e.code === "string" && TRANSIENT_CONNECTION_CODE.test(e.code)) return true;
    // Two transactions creating the same catalog object at once — the
    // retry finds it created.
    if (e.errno === "23505" && typeof e.message === "string" && /"pg_[a-z_]+"/.test(e.message)) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * Whose fault `error` is. Infrastructure hiccups are transient wherever
 * they happen. Otherwise the phase decides: a definition the host refuses
 * to register, an `onActivate` that throws, and anything the plugin's own
 * operations, workers or render hooks throw are the plugin's; verifying a
 * release and provisioning its schema are Caelo's.
 */
export function classifyPluginError(phase: PluginPhase, error: unknown): PluginErrorClass {
  if (isTransient(error)) return "transient";
  switch (phase) {
    case "register":
    case "activate":
    case "operation":
    case "worker":
    case "render":
      return "plugin";
    case "verify":
    case "provision":
      return "core";
  }
}

/**
 * The identity of a problem: the same defect on another boot, another
 * instance or with another row id must fold into one row. Ids, digests and
 * numbers vary per occurrence, so they are blanked before hashing.
 */
export function pluginErrorFingerprint(
  slug: string,
  phase: PluginPhase,
  errorClass: PluginErrorClass,
  message: string,
): string {
  // A SQLSTATE (`[23505]`) is the defect's identity, not an incidental
  // number: the message is split around them, and only the text between
  // them is normalized.
  const normalized = message
    .split(/(\[[0-9A-Z]{5}\])/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
            .replace(/\b[0-9a-f]{32,}\b/gi, "<hex>")
            .replace(/\d+/g, "#"),
    )
    .join("");
  return createHash("sha256")
    .update(JSON.stringify([slug, phase, errorClass, normalized]))
    .digest("hex");
}

/**
 * This process's identity in `plugin_runtime`. Cloud Run sets K_REVISION;
 * the random suffix tells apart instances of one revision (and restarts).
 */
const INSTANCE_ID = `${process.env.K_REVISION ?? "local"}/${randomUUID().slice(0, 8)}`;
const REVISION = process.env.K_REVISION ?? null;

/** This process's instance id (exported for tests and logs). */
export function hostInstanceId(): string {
  return INSTANCE_ID;
}

/**
 * How long a bug-intake claim holds before another occurrence may take it
 * over. Filing a report takes milliseconds; a claim this old belongs to an
 * instance that died between claiming and linking, and the defect must not
 * stay unreported because of it.
 */
const BUG_INTAKE_CLAIM_LEASE = "10 minutes";

/**
 * A recorded problem. `firstOccurrence` is true when its fingerprint is new;
 * `reported` once it is linked to a bug-intake report.
 */
export interface RecordedPluginError {
  readonly errorId: string;
  readonly errorClass: PluginErrorClass;
  readonly firstOccurrence: boolean;
  readonly reported: boolean;
}

function systemCtx(systemActorId: string, requestId: string) {
  return { actorId: systemActorId, actorKind: "system" as const, requestId };
}

/**
 * Write one problem to `plugin_errors` (folding repeats into one row) and,
 * while a core problem has no linked report, file it with the bug intake —
 * exactly one occurrence at a time, however many instances hit it at once.
 * Always logs to the process log. Returns null when the database could not
 * take the record.
 */
export async function recordPluginError(opts: {
  infra: PluginHostInfra;
  systemActorId: string;
  slug: string;
  pluginId: string | null;
  phase: PluginPhase;
  error: unknown;
}): Promise<RecordedPluginError | null> {
  const message = describeLoadError(opts.error).slice(0, 4000) || "unknown error";
  const errorClass = classifyPluginError(opts.phase, opts.error);
  console.error(
    `[plugin-host] ${opts.slug} ${opts.phase} failed (${errorClass}) on ${INSTANCE_ID}: ${message}`,
  );
  const fingerprint = pluginErrorFingerprint(opts.slug, opts.phase, errorClass, message);
  // Only a core problem goes to the bug intake, so only it claims the filing.
  const claim = errorClass === "core" ? randomUUID() : null;
  // The SET expressions all read the row as it was, so both columns take
  // the claim under the same condition: nobody holds it (or the holder's
  // lease lapsed) and no report is linked yet.
  const takeClaim = sql`(plugin_errors.bug_report_id IS NULL
    AND EXCLUDED.bug_intake_claim IS NOT NULL
    AND (plugin_errors.bug_intake_claim IS NULL
         OR plugin_errors.bug_intake_claimed_at < now() - ${BUG_INTAKE_CLAIM_LEASE}::interval))`;
  let recorded: RecordedPluginError & { readonly claimed: boolean };
  try {
    recorded = await opts.infra.adapter.withAdminTransaction(
      systemCtx(opts.systemActorId, `plugin-error-${opts.slug}`),
      async (tx) => {
        // A plugin row may not exist (broken manifest before the upsert),
        // or the id the caller holds may be gone; reference it only if it
        // is still there.
        const rows = (await tx.execute(sql`
          INSERT INTO plugin_errors
            (plugin_slug, plugin_id, fingerprint, phase, error_class, message,
             last_instance, last_revision, bug_intake_claim, bug_intake_claimed_at)
          VALUES (
            ${opts.slug},
            (SELECT id FROM plugins WHERE id = ${opts.pluginId}::uuid),
            ${fingerprint}, ${opts.phase}, ${errorClass}, ${message},
            ${INSTANCE_ID}, ${REVISION},
            ${claim}::uuid, CASE WHEN ${claim}::uuid IS NOT NULL THEN now() END
          )
          ON CONFLICT (plugin_slug, fingerprint) DO UPDATE SET
            occurrences = plugin_errors.occurrences + 1,
            last_seen_at = now(),
            last_instance = EXCLUDED.last_instance,
            last_revision = EXCLUDED.last_revision,
            message = EXCLUDED.message,
            plugin_id = coalesce(EXCLUDED.plugin_id, plugin_errors.plugin_id),
            -- Concurrent upserts of one fingerprint serialise on this row,
            -- so exactly one occurrence takes a free (or abandoned) claim.
            bug_intake_claim = CASE WHEN ${takeClaim} THEN EXCLUDED.bug_intake_claim
                                    ELSE plugin_errors.bug_intake_claim END,
            bug_intake_claimed_at = CASE WHEN ${takeClaim} THEN EXCLUDED.bug_intake_claimed_at
                                         ELSE plugin_errors.bug_intake_claimed_at END
          RETURNING id::text AS id, occurrences, bug_report_id IS NOT NULL AS reported,
                    coalesce(bug_intake_claim = ${claim}::uuid, false) AS claimed
        `)) as unknown as {
          id: string;
          occurrences: number;
          reported: boolean;
          claimed: boolean;
        }[];
        const row = rows[0];
        if (!row) throw new Error("plugin_errors upsert returned no row");
        return {
          errorId: row.id,
          errorClass,
          firstOccurrence: row.occurrences === 1,
          reported: row.reported,
          claimed: row.claimed,
        };
      },
    );
  } catch (e) {
    console.error(
      `[plugin-host] could not record the ${opts.slug} ${opts.phase} failure: ${describeLoadError(e)}`,
    );
    return null;
  }
  const { claimed, ...result } = recorded;
  // Until a report is linked, every occurrence that wins the claim tries
  // again: a bug intake that refused the first one must not drop the defect
  // for good. An occurrence that lost the claim leaves the filing to the
  // one that holds it.
  if (claim !== null && claimed && !result.reported) {
    const reported = await fileCoreBug(opts, result.errorId, claim, message);
    return { ...result, reported };
  }
  return result;
}

/**
 * File a core plugin-host problem with the bug intake (`ai_bug_reports`,
 * forwarded when the Owner opted in) and link it to the error row.
 *
 * @returns whether the report is now linked.
 */
async function fileCoreBug(
  opts: { infra: PluginHostInfra; systemActorId: string; slug: string; phase: PluginPhase },
  errorId: string,
  claim: string,
  message: string,
): Promise<boolean> {
  const r = await execute(
    opts.infra.registry,
    opts.infra.adapter,
    systemCtx(opts.systemActorId, `plugin-error-bug-${opts.slug}`),
    "ai_bug_reports.create",
    {
      title: `Plugin host: ${opts.slug} failed in ${opts.phase}`,
      whatHappened:
        `The plugin host could not ${opts.phase} the plugin "${opts.slug}" on instance ${INSTANCE_ID}: ${message}`.slice(
          0,
          4000,
        ),
      expected: `"${opts.slug}" ${opts.phase === "verify" ? "verifies" : "provisions"} and loads like on every other boot.`,
      suspectedTool: `plugin-host:${opts.phase}`,
      severity: "blocking",
      source: "auto",
    },
  );
  if (!r.ok) {
    console.error(
      `[plugin-host] bug report for ${opts.slug} not filed (retried on the next occurrence): ${"message" in r.error ? r.error.message : r.error.kind}`,
    );
    await releaseBugIntakeClaim(opts, errorId, claim);
    return false;
  }
  const reportId = (r.value as { id: string }).id;
  try {
    await opts.infra.adapter.withAdminTransaction(
      systemCtx(opts.systemActorId, `plugin-error-bug-link-${opts.slug}`),
      async (tx) => {
        await tx.execute(sql`
          UPDATE plugin_errors
          SET bug_report_id = ${reportId}::uuid,
              bug_intake_claim = NULL, bug_intake_claimed_at = NULL
          WHERE id = ${errorId}::uuid AND bug_intake_claim = ${claim}::uuid
            AND bug_report_id IS NULL
        `);
      },
    );
    return true;
  } catch (e) {
    console.error(
      `[plugin-host] bug report link for ${opts.slug} not saved: ${describeLoadError(e)}`,
    );
    return false;
  }
}

/**
 * Give up this occurrence's bug-intake claim after the intake refused the
 * report, so the next occurrence files it instead of waiting out the lease.
 */
async function releaseBugIntakeClaim(
  opts: { infra: PluginHostInfra; systemActorId: string; slug: string },
  errorId: string,
  claim: string,
): Promise<void> {
  try {
    await opts.infra.adapter.withAdminTransaction(
      systemCtx(opts.systemActorId, `plugin-error-bug-release-${opts.slug}`),
      async (tx) => {
        await tx.execute(sql`
          UPDATE plugin_errors SET bug_intake_claim = NULL, bug_intake_claimed_at = NULL
          WHERE id = ${errorId}::uuid AND bug_intake_claim = ${claim}::uuid
        `);
      },
    );
  } catch (e) {
    // The claim then lapses after BUG_INTAKE_CLAIM_LEASE instead.
    console.error(
      `[plugin-host] bug intake claim for ${opts.slug} not released: ${describeLoadError(e)}`,
    );
  }
}

/** What this instance runs for one plugin, as `plugin_runtime` records it. */
interface RuntimeOutcome {
  readonly state: "loaded" | "error";
  readonly errorId: string | null;
}

/**
 * Outcomes this instance decided but could not write (the database refused
 * the transaction). The heartbeat only refreshes rows that exist, so a lost
 * write would leave the plugin "unreported" here for the whole process
 * lifetime; each beat writes these again until they land. A newer write
 * for the same plugin replaces the entry.
 */
const unsavedOutcomes = new Map<string, RuntimeOutcome>();

/**
 * Say what this instance runs for `slug`: loaded, or failed to load with
 * `errorId`. When the database refuses, the outcome is kept and the next
 * heartbeat writes it again — the load outcome itself is already decided
 * and logged.
 */
export async function recordPluginRuntime(opts: {
  infra: PluginHostInfra;
  systemActorId: string;
  slug: string;
  state: "loaded" | "error";
  errorId: string | null;
}): Promise<void> {
  const outcome: RuntimeOutcome = { state: opts.state, errorId: opts.errorId };
  unsavedOutcomes.set(opts.slug, outcome);
  await writeOutcome(opts.infra, opts.systemActorId, opts.slug, outcome);
}

/**
 * Write one outcome; forget it once written (unless a newer one replaced it
 * meanwhile). An error row that is gone (its plugin was uninstalled) has
 * nothing left to report, so that outcome is dropped instead of retried.
 */
async function writeOutcome(
  infra: PluginHostInfra,
  systemActorId: string,
  slug: string,
  outcome: RuntimeOutcome,
): Promise<void> {
  try {
    await infra.adapter.withAdminTransaction(
      systemCtx(systemActorId, `plugin-runtime-${slug}`),
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO plugin_runtime (instance_id, plugin_slug, revision, state, error_id)
          SELECT ${INSTANCE_ID}, ${slug}, ${REVISION}, ${outcome.state}, ${outcome.errorId}::uuid
          WHERE ${outcome.errorId}::uuid IS NULL
             OR EXISTS (SELECT 1 FROM plugin_errors WHERE id = ${outcome.errorId}::uuid)
          ON CONFLICT (instance_id, plugin_slug) DO UPDATE SET
            state = EXCLUDED.state,
            error_id = EXCLUDED.error_id,
            updated_at = now(),
            heartbeat_at = now()
        `);
      },
    );
    if (unsavedOutcomes.get(slug) === outcome) unsavedOutcomes.delete(slug);
  } catch (e) {
    console.error(
      `[plugin-host] could not record the runtime state of ${slug} (retried on the next heartbeat): ${describeLoadError(e)}`,
    );
  }
}

/** The plugins whose runtime state is still waiting to be written (tests). */
export function unsavedRuntimeSlugs(): string[] {
  return [...unsavedOutcomes.keys()];
}

/** How often an instance confirms its rows are still current. */
export const HEARTBEAT_MS = 30_000;
/** Rows older than this belong to stopped instances and are deleted. */
const STALE_ROW_RETENTION = "1 day";

let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Start this instance's heartbeat (idempotent). Each beat writes the
 * outcomes the database refused earlier, refreshes this instance's rows and
 * deletes rows of instances that stopped long ago.
 */
export function startRuntimeHeartbeat(infra: PluginHostInfra, systemActorId: string): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    void runtimeHeartbeatOnce(infra, systemActorId);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

/** Stop the heartbeat and forget unwritten outcomes (tests, shutdown). */
export function stopRuntimeHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  unsavedOutcomes.clear();
}

/** One heartbeat; exported so tests need not wait {@link HEARTBEAT_MS}. */
export async function runtimeHeartbeatOnce(
  infra: PluginHostInfra,
  systemActorId: string,
): Promise<void> {
  for (const [slug, outcome] of [...unsavedOutcomes]) {
    await writeOutcome(infra, systemActorId, slug, outcome);
  }
  try {
    await infra.adapter.withAdminTransaction(
      systemCtx(systemActorId, "plugin-runtime-heartbeat"),
      async (tx) => {
        await tx.execute(sql`
          UPDATE plugin_runtime SET heartbeat_at = now() WHERE instance_id = ${INSTANCE_ID}
        `);
        await tx.execute(sql`
          DELETE FROM plugin_runtime
          WHERE heartbeat_at < now() - ${STALE_ROW_RETENTION}::interval
        `);
      },
    );
  } catch (e) {
    console.error(`[plugin-host] plugin runtime heartbeat failed: ${describeLoadError(e)}`);
  }
}
