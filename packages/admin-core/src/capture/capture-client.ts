// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — the admin's side of one capture on a GCP install: write the
 * input (if any), sign it, start one execution of the capture job with the
 * order, wait for the result, delete what the capture left in the bucket.
 *
 * The admin may run the job WITH overrides (it passes the order), read its
 * executions, and read/write/delete in the capture bucket. The job's own
 * identity reads nothing: it gets its input through the signed URL in the
 * order and may only create objects under `out/` (capture-job-setup.ts).
 */

import { CAELO_VERSION } from "@caelo-cms/shared";
import {
  defaultGoogleDeps,
  type GoogleDeps,
  googleCall,
} from "../security/operator-access/google-iam.js";
import {
  CAPTURE_ORDER_ENV_VAR,
  type CaptureOp,
  type CaptureOrder,
  type CaptureResult,
  captureOrderSchema,
  captureResultSchema,
} from "./capture-protocol.js";
import type { CaptureStore } from "./capture-store.js";

/** The admin env var naming the capture job (`projects/<p>/locations/<r>/jobs/<j>`). */
export const CAPTURE_JOB_ENV_VAR = "CAELO_CAPTURE_JOB";

const JOB_NAME = /^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/;

/**
 * How long one capture may take, job start included. Cloud Run starts a job
 * task in ~5–20 s; the render itself is capped at ~30 s by the screenshotter.
 */
export const CAPTURE_TIMEOUT_MS = 120_000;

/** The task timeout passed with each execution, a little above ours. */
const TASK_TIMEOUT = `${Math.round(CAPTURE_TIMEOUT_MS / 1000) + 30}s`;

/** Starts and watches one execution of the capture job. */
export interface CaptureLauncher {
  readonly label: string;
  /** Start one execution with `order`; returns the execution's name. */
  start(order: CaptureOrder): Promise<string>;
  /** Whether the execution has ended, and whether it failed. */
  status(execution: string): Promise<{ readonly finished: boolean; readonly failed: boolean }>;
}

/** The launcher for a Cloud Run capture job. */
export function gcpCaptureLauncher(
  job: string,
  deps: GoogleDeps = defaultGoogleDeps(),
): CaptureLauncher {
  if (!JOB_NAME.test(job)) {
    throw new Error(`${CAPTURE_JOB_ENV_VAR} is not a Cloud Run job name: ${job}`);
  }
  return {
    label: `Cloud Run job ${job.split("/").pop()}`,
    async start(order) {
      const op = (await googleCall(deps, `https://run.googleapis.com/v2/${job}:run`, "POST", {
        overrides: {
          taskCount: 1,
          timeout: TASK_TIMEOUT,
          containerOverrides: [
            { env: [{ name: CAPTURE_ORDER_ENV_VAR, value: JSON.stringify(order) }] },
          ],
        },
      })) as { metadata?: { name?: string } };
      const name = op.metadata?.name;
      if (!name) throw new Error("Cloud Run started the capture but returned no execution name");
      return name;
    },
    async status(execution) {
      const e = (await googleCall(deps, `https://run.googleapis.com/v2/${execution}`, "GET")) as {
        succeededCount?: number;
        failedCount?: number;
        cancelledCount?: number;
        completionTime?: string;
      };
      const failed = (e.failedCount ?? 0) + (e.cancelledCount ?? 0) > 0;
      return {
        failed,
        finished: e.completionTime !== undefined || failed || (e.succeededCount ?? 0) > 0,
      };
    },
  };
}

/** A capture that ended without a result (job failed, timed out, refused to start). */
export class CaptureJobError extends Error {
  constructor(
    message: string,
    readonly code: "start-failed" | "task-failed" | "timeout" | "bad-result",
  ) {
    super(message);
    this.name = "CaptureJobError";
  }
}

/** Runs captures through the job. */
export interface CaptureClient {
  /**
   * Run one capture. `input` (a JSON value) is written to the bucket and
   * handed over by signed URL; ops that need it get the URL as `inputUrl`.
   *
   * @throws CaptureJobError when no result arrives; a result of kind
   *   `error` is returned, not thrown.
   */
  run(
    op: (inputUrl: string | null) => CaptureOp,
    input?: { readonly text: string },
  ): Promise<CaptureResult>;
  readonly store: CaptureStore;
}

export interface CaptureClientDeps {
  readonly launcher: CaptureLauncher;
  readonly store: CaptureStore;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly version?: string;
}

/** The capture client over a launcher and a store. */
export function createCaptureClient(deps: CaptureClientDeps): CaptureClient {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 1000;
  const version = deps.version ?? CAELO_VERSION;
  const { launcher, store } = deps;

  return {
    store,
    async run(makeOp, input) {
      const captureId = crypto.randomUUID();
      const inputKey = `in/${captureId}.json`;
      const resultKey = `out/${captureId}.json`;
      try {
        let inputUrl: string | null = null;
        if (input) {
          await store.writeInput(inputKey, input.text);
          inputUrl = await store.signInput(inputKey);
        }
        const order = captureOrderSchema.parse({
          version,
          captureId,
          resultKey,
          op: makeOp(inputUrl),
        });
        let execution: string;
        try {
          execution = await launcher.start(order);
        } catch (e) {
          throw new CaptureJobError(
            `could not start the capture job (${launcher.label}): ${e instanceof Error ? e.message : String(e)} — run \`cms-provision upgrade\` if the job is missing`,
            "start-failed",
          );
        }
        const deadline = now() + timeoutMs;
        for (;;) {
          const text = await store.readResult(resultKey);
          if (text !== null) return parseResult(text, captureId);
          const st = await launcher.status(execution);
          if (st.finished) {
            // The task may have written its result just before it ended.
            const last = await store.readResult(resultKey);
            if (last !== null) return parseResult(last, captureId);
            throw new CaptureJobError(
              `the capture job ended without a result (execution ${execution.split("/").pop()}${st.failed ? ", failed" : ""}); its log in Cloud Run says why`,
              "task-failed",
            );
          }
          if (now() >= deadline) {
            throw new CaptureJobError(
              `the capture job did not finish within ${Math.round(timeoutMs / 1000)} s (execution ${execution.split("/").pop()})`,
              "timeout",
            );
          }
          await sleep(pollMs);
        }
      } finally {
        // One capture, one input: the signed URL points at nothing afterwards.
        await Promise.all([
          input ? store.remove(inputKey).catch(logCleanup(inputKey)) : undefined,
          store.remove(resultKey).catch(logCleanup(resultKey)),
        ]);
      }
    },
  };
}

function logCleanup(key: string): (e: unknown) => void {
  return (e) =>
    console.error(
      `[capture] could not delete ${key} (the bucket's lifecycle removes it within a day):`,
      e instanceof Error ? e.message : e,
    );
}

function parseResult(text: string, captureId: string): CaptureResult {
  let parsed: CaptureResult;
  try {
    parsed = captureResultSchema.parse(JSON.parse(text));
  } catch (e) {
    throw new CaptureJobError(
      `the capture job wrote a result the admin cannot read: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
      "bad-result",
    );
  }
  if (parsed.captureId !== captureId) {
    throw new CaptureJobError("the capture job's result names another capture", "bad-result");
  }
  return parsed;
}
