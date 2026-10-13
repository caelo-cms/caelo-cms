// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job's {@link UpgradeReporter}: every line the app-roll
 * (upgrade/app-roll.ts) reports becomes a `platform_update_events` row the
 * admin renders as a live timeline, and a structured Cloud Logging entry.
 *
 * The reporter interface is synchronous (the CLI's spinners are), but each
 * event is a database write, so writes are chained in order and the job
 * awaits {@link EventReporter.flush} before it finishes. A failed event
 * write never fails the upgrade — the roll matters more than its narration —
 * but it lands in the job log.
 */

import {
  PLATFORM_UPDATE_EVENT_MAX,
  type PlatformUpdateEventLevel,
  type PlatformUpdatePhase,
} from "@caelo-cms/shared";
import type { ReportStep, UpgradeReporter } from "./upgrade/reporter.js";

/** Appends one timeline line (the job's database queue). */
export type EventSink = (
  phase: PlatformUpdatePhase,
  level: PlatformUpdateEventLevel,
  message: string,
) => Promise<void>;

/** One structured Cloud Logging line. */
export type JobLog = (entry: {
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly message: string;
  readonly [field: string]: unknown;
}) => void;

export interface EventReporter extends UpgradeReporter {
  /** Set the phase following lines belong to (the job's own stages). */
  phase(phase: PlatformUpdatePhase): void;
  /** Wait until every event so far is written. */
  flush(): Promise<void>;
}

/**
 * The phase an app-roll step belongs to, from its label (app-roll.ts names
 * its steps). Unknown labels keep the current phase.
 */
export function phaseOfStep(label: string): PlatformUpdatePhase | null {
  if (label.startsWith("Checking the health check")) return "health-baseline";
  if (label.startsWith("Applying DB migrations")) return "migrations";
  if (label.startsWith("Rolling ")) return "roll";
  if (label.startsWith("Deep health check")) return "health";
  return null;
}

const SEVERITY: Record<PlatformUpdateEventLevel, "INFO" | "WARNING" | "ERROR"> = {
  info: "INFO",
  success: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

/** Build the reporter for one request. */
export function eventReporter(sink: EventSink, log: JobLog, requestId: string): EventReporter {
  let current: PlatformUpdatePhase = "start";
  let chain: Promise<void> = Promise.resolve();
  const emit = (level: PlatformUpdateEventLevel, message: string, phase = current) => {
    const text = message.trim().slice(0, PLATFORM_UPDATE_EVENT_MAX) || "(no message)";
    log({ severity: SEVERITY[level], message: text, requestId, phase });
    chain = chain.then(() =>
      sink(phase, level, text).catch((e: unknown) => {
        log({
          severity: "ERROR",
          message: `could not record a timeline event: ${e instanceof Error ? e.message : String(e)}`,
          requestId,
        });
      }),
    );
  };
  return {
    phase(p) {
      current = p;
    },
    async flush() {
      await chain;
    },
    step(label): ReportStep {
      const p = phaseOfStep(label);
      if (p) current = p;
      emit("info", label);
      return {
        done: (m) => emit("success", m),
        failed: (m) => emit("error", m),
        warned: (m) => emit("warn", m),
      };
    },
    info: (m) => emit("info", m),
    warn: (m) => {
      // app-roll announces a rollback with a warning before it starts.
      if (m.startsWith("Rolling back")) current = "rollback";
      emit("warn", m);
    },
    error: (m) => emit("error", m),
    success: (m) => emit("success", m),
  };
}
