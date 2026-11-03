// SPDX-License-Identifier: MPL-2.0

/**
 * The converge job's database (#819), and how it moves once the install's
 * database TLS step ran (#1373).
 *
 * The queue opens on the host the install dials today
 * (provisioning converge-db-trust.ts): the DNS name with verify-full, or,
 * on an install the TLS step (#1338) has not reached yet, the instance's IP
 * with the server identity the Cloud SQL Admin API names. That way the
 * job claims its request and writes its timeline before the step, and the
 * step is a timeline step of its own (converge-job.ts `secureDatabase`):
 * its failure reaches Settings → Updates and ends the request, instead of
 * stopping the job before the database was opened.
 *
 * After the step, every new pool dials the DNS name with verify-full. When
 * the step fails, the target is read again: it may have rotated the
 * server certificate or moved the services before it stopped, and the job
 * still has to record its end. When that read fails too, the pool already
 * open stays.
 */

import {
  type ConvergeDatabaseTarget,
  type ConvergeQueue,
  type SecureDatabaseResult,
  serverIdentityProblem,
} from "@caelo-cms/provisioning";
import type { DatabaseTlsOptions } from "@caelo-cms/query-api";
import { type AccessToken, type OpenedQueue, tokenRefreshingConvergeQueue } from "./token-queue.js";

/** The parts the converge job's database is built from (converge-main.ts wires the real ones). */
export interface ConvergeDatabaseDeps {
  /** Where and how to connect now (converge-db-trust.ts `convergeDatabaseTarget`). */
  readonly resolveTarget: () => Promise<ConvergeDatabaseTarget>;
  /** The TLS step (upgrader-gcp.ts `convergeDatabaseHost`); resolves to the DNS host. */
  readonly runTlsStep: () => Promise<string>;
  /** Open a pool on `target` with `token` as the password. */
  readonly open: (target: ConvergeDatabaseTarget, token: string) => OpenedQueue<ConvergeQueue>;
  readonly fetchToken: () => Promise<AccessToken>;
  readonly now: () => number;
  /** Told what went wrong where the job carries on (a retired pool's close, a re-read). */
  readonly warn: (message: string) => void;
}

/**
 * The adapter's TLS checks for an `ip` target (#1373): the chain against
 * the instance's CA, the certificate against the instance's fingerprints.
 */
export function ipTargetTls(
  target: Extract<ConvergeDatabaseTarget, { kind: "ip" }>,
): DatabaseTlsOptions {
  return {
    ca: target.caPem,
    checkServerIdentity: (_hostname, cert) => {
      const problem = serverIdentityProblem(target, cert.fingerprint);
      return problem ? new Error(problem) : undefined;
    },
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The converge job's queue, plus `secureDatabase` for converge-job.ts
 * (null when the queue dials the DNS name already).
 *
 * @throws when the first target cannot be resolved: without it the job
 *   must not connect at all
 */
export async function convergeDatabase(deps: ConvergeDatabaseDeps): Promise<{
  readonly queue: ConvergeQueue;
  readonly secureDatabase: (() => Promise<SecureDatabaseResult>) | null;
  close(): Promise<void>;
}> {
  let target = await deps.resolveTarget();
  const db = tokenRefreshingConvergeQueue({
    fetchToken: deps.fetchToken,
    open: (token) => deps.open(target, token),
    now: deps.now,
    onCloseError: (e) => deps.warn(`could not close a database pool: ${errorText(e)}`),
  });
  const secureDatabase =
    target.kind === "dns"
      ? null
      : async (): Promise<SecureDatabaseResult> => {
          let host: string;
          try {
            host = await deps.runTlsStep();
          } catch (e) {
            // Reconnect only on a target read after the step: without one,
            // the pool already open is the best chance to record the end
            // (its connections survive unless the step rotated the
            // certificate, and a new handshake with the old data would not).
            let reread: ConvergeDatabaseTarget | null = null;
            try {
              reread = await deps.resolveTarget();
            } catch (again) {
              deps.warn(
                `after the failed database TLS step, where to reach the database could not be read again (${errorText(again)}); keeping the open connection`,
              );
            }
            if (reread) {
              target = reread;
              await db.reopen();
            }
            return { ok: false, error: errorText(e) };
          }
          target = { kind: "dns", host };
          await db.reopen();
          return { ok: true, host };
        };
  return { queue: db.queue, secureDatabase, close: db.close };
}
