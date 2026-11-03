// SPDX-License-Identifier: MPL-2.0

/**
 * #1373 — where the converge job (#819) opens its database queue, and whom
 * it trusts there, BEFORE the install's database TLS step (#1338) ran.
 *
 * The job writes the update timeline and the request's end through that
 * queue. Its code connects with verify-full only, which needs the
 * instance's DNS name, and on an install whose services still dial the
 * instance's IP the DNS name exists only once the TLS step has run. When
 * the job ran that step before opening the queue, a failure of the step
 * reached only the job's log: Settings → Updates showed "Interrupted" and
 * nothing else. So the job first opens the queue on the host the install
 * dials today and runs the TLS step as a timeline step of its own
 * (converge-job.ts `secureDatabase`).
 *
 * Dialling an IP, the host-name half of verify-full cannot hold (the
 * certificate names no IP). The connection must still authenticate the
 * server: the job's password is the provisioner's access token, worth far
 * more than a database password, so `sslmode=require` (encrypted, server
 * unchecked) is not an option. The trust comes from the Cloud SQL Admin
 * API, over an authenticated channel, about this one instance:
 *
 *   - per-instance CA (`GOOGLE_MANAGED_INTERNAL_CA`, the default before
 *     #1338, or the shared CA not rotated in yet): the instance's own server
 *     CA (`serverCaCert`). Nobody else holds a certificate from it, so a
 *     verified chain is this instance.
 *   - shared CA with its certificate active: Google's shared-CA bundle (the
 *     one every image ships), AND the server certificate's SHA-1
 *     fingerprint must be one the API lists for this instance — the shared
 *     CA signs other customers' instances too.
 *
 * No input but the metadata server's placement and the APIs: the job's
 * scrubbed-environment contract (§11.C) is unchanged.
 */

import { readFileSync } from "node:fs";
import { CLOUD_SQL_CA_BUNDLE, isIpLiteral } from "@caelo-cms/shared";
import { describeInstance, listServerCertificates } from "./cloudsql-tls.js";
import { findSqlInstance } from "./gateway-credentials.js";
import { gcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { GCP_STACK_ENV } from "./gcp-names.js";
import type { HttpFetch } from "./runtime-secrets.js";
import { CLOUD_SQL_SERVER_CA_MODE } from "./stack-contract.js";
import { type UpgraderPlacement, upgraderDatabaseHost } from "./upgrader-gcp.js";

/** How the converge job reaches the database. */
export type ConvergeDatabaseTarget =
  /** The services dial the DNS name already: verify-full, nothing to set up. */
  | { readonly kind: "dns"; readonly host: string }
  /**
   * The services dial the instance's IP: connect there, verify the chain
   * against `caPem` and, when `pinnedSha1` is set, the certificate's
   * fingerprint (lower-case hex, no colons) against it.
   */
  | {
      readonly kind: "ip";
      readonly host: string;
      readonly caPem: string;
      readonly pinnedSha1: readonly string[] | null;
    };

export interface ConvergeDatabaseTargetDeps {
  readonly run?: GcloudRunner;
  readonly http?: HttpFetch;
  /** The shipped shared-CA bundle (tests pass their own). */
  readonly readSharedCaBundle?: () => string;
}

/** A SHA-1 fingerprint as hex without separators, lower case (`AB:CD…` and `abcd…` compare equal). */
export function normalizedSha1(fingerprint: string): string {
  return fingerprint.replace(/[^0-9a-f]/gi, "").toLowerCase();
}

/**
 * The host the install dials today and, when it is the instance's IP, the
 * server identity the converge job's connection must verify there. Throws
 * with what could not be read: without it the job must not connect.
 */
export async function convergeDatabaseTarget(
  placement: Pick<UpgraderPlacement, "projectId" | "region">,
  deps: ConvergeDatabaseTargetDeps = {},
): Promise<ConvergeDatabaseTarget> {
  const run = deps.run ?? gcloud;
  const host = await upgraderDatabaseHost(placement, run);
  if (!isIpLiteral(host)) return { kind: "dns", host };
  const install = { projectId: placement.projectId, env: GCP_STACK_ENV };
  const lookup = await findSqlInstance(install, { run });
  if (lookup.status !== "found") {
    throw new Error(`could not find the install's Cloud SQL instance (${lookup.status})`);
  }
  const target = { ...install, sqlInstance: lookup.name };
  const described = await describeInstance(target, run);
  if (!described.ok) throw new Error(described.error);
  const d = described.d;
  if (d.settings?.ipConfiguration?.serverCaMode === CLOUD_SQL_SERVER_CA_MODE) {
    const certs = await listServerCertificates(
      target,
      run,
      deps.http ?? (fetch as unknown as HttpFetch),
    );
    if (!certs.ok) throw new Error(certs.error);
    const active = certs.activeVersion;
    if (active !== null && certs.fingerprints.includes(active)) {
      const read = deps.readSharedCaBundle ?? (() => readFileSync(CLOUD_SQL_CA_BUNDLE, "utf8"));
      return {
        kind: "ip",
        host,
        caPem: read(),
        pinnedSha1: certs.fingerprints.map(normalizedSha1),
      };
    }
    // Moved to the shared CA, its certificate not rotated in yet: the
    // server still presents the one from its own CA (below).
  }
  const caPem = d.serverCaCert?.cert?.trim();
  if (!caPem) {
    throw new Error(
      `${lookup.name} names no server CA certificate (serverCaCert), so the connection to ${host} could not be verified`,
    );
  }
  return { kind: "ip", host, caPem, pinnedSha1: null };
}

/**
 * Why a server certificate with `fingerprint` (as `node:tls` prints it) is
 * not the instance `target` names, or null when it is. Only for an `ip`
 * target; the chain itself is checked against `caPem` by the TLS layer.
 */
export function serverIdentityProblem(
  target: Extract<ConvergeDatabaseTarget, { kind: "ip" }>,
  fingerprint: string,
): string | null {
  if (target.pinnedSha1 === null) return null;
  return target.pinnedSha1.includes(normalizedSha1(fingerprint))
    ? null
    : `the database at ${target.host} presented a certificate (SHA-1 ${normalizedSha1(fingerprint)}) that the Cloud SQL Admin API does not list for this install's instance`;
}
