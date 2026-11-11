// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1595 — wire the incident capture (capture.ts) into a running
 * admin: database trouble from the adapter, the snapshot and report writes
 * through Query API operations as the `system` actor.
 */

import { hostname } from "node:os";
import {
  type DatabaseAdapter,
  execute,
  type OperationRegistry,
  SYSTEM_ACTOR_ID,
} from "@caelo-cms/query-api";
import { CAELO_VERSION, type ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import { INCIDENT_FORWARD_DELAY_MS, IncidentCapture, setIncidentCapture } from "./capture.js";
import type { DatabaseActivity } from "./evidence.js";

/** One capture per adapter, however often the boot runs. */
const installed = new WeakMap<
  DatabaseAdapter,
  { readonly capture: IncidentCapture; readonly uninstall: () => void }
>();

const FORWARD_AFTER_SECONDS = Math.ceil(INCIDENT_FORWARD_DELAY_MS / 1000);

const CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "incident-capture",
};

/**
 * Create the process's capture, subscribe it to the adapter's database
 * trouble and install it for the MCP gate and the build runner.
 *
 * @returns a function that uninstalls it (tests).
 */
export function installIncidentCapture(opts: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  /** Names this admin instance in the report (Cloud Run revision, else host name). */
  readonly instance?: string;
}): { readonly capture: IncidentCapture; readonly uninstall: () => void } {
  const { adapter, registry } = opts;
  const existing = installed.get(adapter);
  if (existing !== undefined) return existing;
  const run = async <T>(op: string, input: unknown): Promise<T> => {
    const r = await execute(registry, adapter, CTX, op, input);
    if (!r.ok) throw new Error(`${op}: ${describeError(r.error)}`);
    return r.value as T;
  };
  const capture = new IncidentCapture({
    now: Date.now,
    pressure: () => adapter.poolPressure("admin"),
    snapshot: () => run<DatabaseActivity>("diagnostics.database_activity", {}),
    file: async (draft) =>
      (
        await run<{ id: string }>("ai_bug_reports.create", {
          kind: "defect",
          source: "auto",
          chatSessionId: null,
          suspectedTool: null,
          forwardAfterSeconds: FORWARD_AFTER_SECONDS,
          ...draft,
        })
      ).id,
    update: async (reportId, draft) => {
      await run("ai_bug_reports.update_incident", {
        reportId,
        evidence: draft.evidence,
        severity: draft.severity,
        blockedTask: draft.blockedTask,
        forwardAfterSeconds: FORWARD_AFTER_SECONDS,
      });
    },
    detach: (work) => {
      adapter
        .deferUntilHeldTransactionEnds(async () => {
          work();
        })
        .catch((e: unknown) => {
          console.error("[incident] could not start the report write", e);
        });
    },
    instance: opts.instance ?? process.env.K_REVISION ?? hostname(),
    version: CAELO_VERSION,
  });
  const unsubscribe = adapter.onDatabaseTrouble((trouble) => {
    capture.note({ kind: "database", trouble });
  });
  setIncidentCapture(capture);
  const handle = {
    capture,
    uninstall: () => {
      unsubscribe();
      setIncidentCapture(null);
      installed.delete(adapter);
    },
  };
  installed.set(adapter, handle);
  return handle;
}
