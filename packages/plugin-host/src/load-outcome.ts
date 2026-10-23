// SPDX-License-Identifier: MPL-2.0

/**
 * Loading one plugin, with retries and a record of the outcome (issue #1008).
 *
 * Every path that brings a plugin up in this process — boot, an Owner's
 * activation, a reviewed external package — goes through
 * {@link loadReported}:
 *
 *   - a transient failure (connection loss, lock timeout, two instances
 *     creating the same catalog object) is retried with backoff;
 *   - before a retry and after the last failure the plugin is removed from
 *     every registry, so a load that failed halfway (tools registered,
 *     skills not) never leaves a half-running plugin behind;
 *   - the final failure is written to `plugin_errors` and, if the Owner
 *     wants the plugin running, this instance's `plugin_runtime` row says
 *     it failed here — the plugin's status is never touched;
 *   - a success marks the plugin loaded on this instance.
 *
 * The caller still gets the failure: its report, its activation screen and
 * its logs say what went wrong.
 */

import { sql } from "drizzle-orm";
import type { PluginHostInfra } from "./dispatch.js";
import { deregisterPlugin } from "./lifecycle.js";
import { describeLoadError } from "./load-error.js";
import { noteLocalLoadOutcome } from "./local-availability.js";
import {
  classifyPluginError,
  phaseOf,
  recordPluginError,
  recordPluginRuntime,
} from "./runtime-health.js";

/** Delays before the 2nd and 3rd attempt. Three attempts in all. */
const RETRY_DELAYS_MS: readonly number[] = [500, 2000];

/** What {@link loadReported} needs to know about the plugin being loaded. */
export interface LoadSubject {
  readonly infra: PluginHostInfra;
  readonly systemActorId: string;
  readonly slug: string;
}

/**
 * Run `load`, retrying transient failures; record the outcome.
 *
 * @param isLoaded whether `load`'s result means the plugin now runs here
 *   (an inactive plugin returns normally without loading).
 * @throws the last failure, after it was recorded.
 */
export async function loadReported<T>(
  subject: LoadSubject,
  load: () => Promise<T>,
  isLoaded: (outcome: T) => boolean,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await load();
      if (isLoaded(outcome)) {
        noteLocalLoadOutcome(subject.slug, true, null);
        await recordPluginRuntime({ ...subject, state: "loaded", errorId: null });
      }
      return outcome;
    } catch (error) {
      deregisterPlugin(subject.slug);
      const delay = RETRY_DELAYS_MS[attempt];
      const transient = classifyPluginError(phaseOf(error), error) === "transient";
      if (transient && delay !== undefined) {
        console.warn(
          `[plugin-host] ${subject.slug}: transient load failure, retrying in ${delay} ms (attempt ${attempt + 2} of ${RETRY_DELAYS_MS.length + 1})`,
        );
        await Bun.sleep(delay);
        continue;
      }
      await reportLoadFailure(subject, error);
      throw error;
    }
  }
}

/**
 * Record a final load failure: `plugin_errors` always; this instance's
 * `plugin_runtime` row too when the Owner wants the plugin running. Also
 * used directly for failures that happen before a load can start (an
 * unreadable manifest).
 */
export async function reportLoadFailure(subject: LoadSubject, error: unknown): Promise<void> {
  // Its tools are gone from this process, so are its skills (local-availability.ts).
  noteLocalLoadOutcome(subject.slug, false, describeLoadError(error));
  let row: { id: string; status: string } | undefined;
  try {
    row = await subject.infra.adapter.withAdminTransaction(
      {
        actorId: subject.systemActorId,
        actorKind: "system",
        requestId: `plugin-load-failed-${subject.slug}`,
      },
      async (tx) =>
        (
          (await tx.execute(sql`
            SELECT id::text AS id, status FROM plugins WHERE slug = ${subject.slug}
          `)) as unknown as { id: string; status: string }[]
        )[0],
    );
  } catch {
    // The record below still goes in by slug; recordPluginError logs it.
  }
  const recorded = await recordPluginError({
    ...subject,
    pluginId: row?.id ?? null,
    phase: phaseOf(error),
    error,
  });
  // Only a plugin the Owner wants running counts as "failed here"; a
  // discovered plugin that does not verify is an error in the log, not a
  // runtime state.
  if (recorded && row?.status === "active") {
    await recordPluginRuntime({ ...subject, state: "error", errorId: recorded.errorId });
  }
}
